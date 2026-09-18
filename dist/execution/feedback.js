import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { invariant, errorMessage } from '../domain/errors.js';
import { environment, redact, runProcess } from './process.js';
import { failureExcerpt } from '../engine/diagnostic.js';
/** A session-scoped MCP endpoint. Only the controller's frozen gate argv may execute.
 * Results are development feedback, never validation receipts. Local-trusted execution applies.
 */
export async function startFeedback(options) {
    const policy = options.config.feedback;
    invariant(policy?.gateIds.length, 'CONFIG', 'Feedback needs an explicit gate allowlist');
    const gates = policy.gateIds.map(id => {
        const gate = options.config.gates.find(g => g.id === id);
        invariant(gate && gate.dependsOn.length === 0 && gate.command.every(a => !a.includes('{{')), 'CONFIG', `Unsupported feedback check ${id}`);
        return structuredClone(gate);
    });
    const token = randomBytes(32).toString('hex');
    const controller = new AbortController();
    const signal = AbortSignal.any([options.signal, controller.signal]);
    let calls = 0;
    let spentMs = 0;
    let active = null;
    const forbiddenEnv = new Set(options.config.agent.passEnv);
    async function check(args) {
        invariant(args !== null && typeof args === 'object' && !Array.isArray(args) && Object.keys(args).length === 1 && Object.hasOwn(args, 'gateId'), 'FEEDBACK', 'Only {gateId} is accepted; commands and arguments cannot be supplied');
        const gate = gates.find(g => g.id === args.gateId);
        invariant(gate, 'FEEDBACK', 'Check is not allowlisted');
        invariant(!active && !signal.aborted, 'FEEDBACK', 'A check is running or the session has ended');
        invariant(calls < policy.maxCalls && spentMs < policy.maxTotalMs, 'FEEDBACK', 'Feedback quota exhausted');
        calls++;
        const env = environment([...options.config.environment.passEnv, ...gate.passEnv]
            .filter(name => !forbiddenEnv.has(name) && !/TOKEN|KEY|PASSWORD|SECRET|CREDENTIAL|CODEX_HOME|CLAUDE_CONFIG_DIR/i.test(name)));
        options.emit('feedback.started', { gateId: gate.id, call: calls });
        const started = performance.now();
        try {
            const result = await runProcess({ command: gate.command, cwd: options.workspace, env,
                timeoutMs: Math.min(gate.timeoutMs, policy.maxTotalMs - spentMs), signal, ...options.hooks, maxOutputBytes: 32000 });
            const answer = { gateId: gate.id, status: result.status, exitCode: result.exitCode, durationMs: result.durationMs,
                diagnostic: redact(failureExcerpt(gate.id, result.stderr, result.stdout, 10000), env),
                authoritative: false, remainingCalls: policy.maxCalls - calls };
            options.emit('feedback.finished', { ...answer, stdoutHash: result.stdoutHash, stderrHash: result.stderrHash });
            return answer;
        }
        finally {
            spentMs += performance.now() - started;
        }
    }
    const server = createServer(async (req, res) => {
        const respond = (status, data) => {
            res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            res.end(data === undefined ? undefined : JSON.stringify(data));
        };
        // Block browser/DNS rebinding access as well as unauthenticated clients.
        if (req.headers.host !== address || req.headers.origin || req.headers.authorization !== `Bearer ${token}`) {
            respond(403);
            return;
        }
        if (req.url !== '/mcp') {
            respond(404);
            return;
        }
        if (req.method !== 'POST') {
            respond(405);
            return;
        }
        let id = null;
        try {
            let body = '';
            for await (const chunk of req) {
                body += String(chunk);
                if (Buffer.byteLength(body) > 8192) {
                    respond(413);
                    return;
                }
            }
            const message = JSON.parse(body);
            invariant(message && typeof message === 'object' && !Array.isArray(message) && message.jsonrpc === '2.0', 'FEEDBACK', 'Invalid JSON-RPC request');
            if (typeof message.id === 'string' || typeof message.id === 'number')
                id = message.id;
            if (id === null && typeof message.method === 'string' && message.method.startsWith('notifications/')) {
                respond(202);
                return;
            }
            let result;
            switch (message.method) {
                case 'initialize':
                    result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'apv2-checks', version: '1.0.0' } };
                    break;
                case 'ping':
                    result = {};
                    break;
                case 'tools/list':
                    result = { tools: [{ name: 'run_check', description: 'Run one preconfigured project check on current edits. No shell arguments accepted. Results are feedback; final validation runs separately.',
                                inputSchema: { type: 'object', properties: { gateId: { type: 'string', enum: gates.map(g => g.id) } }, required: ['gateId'], additionalProperties: false },
                                annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } }] };
                    break;
                case 'tools/call': {
                    invariant(message.params?.['name'] === 'run_check', 'FEEDBACK', 'Unknown tool');
                    try {
                        invariant(!active, 'FEEDBACK', 'A check is already running');
                        const pending = check(message.params['arguments']);
                        active = pending;
                        try {
                            result = { content: [{ type: 'text', text: JSON.stringify(await pending) }] };
                        }
                        finally {
                            active = null;
                        }
                    }
                    catch (error) {
                        result = { isError: true, content: [{ type: 'text', text: errorMessage(error) }] };
                    }
                    break;
                }
                default:
                    respond(200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
                    return;
            }
            respond(200, { jsonrpc: '2.0', id, result });
        }
        catch {
            respond(400, { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid request' } });
        }
    });
    server.requestTimeout = 10000;
    server.headersTimeout = 10000;
    let address = '';
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const bound = server.address();
    invariant(bound && typeof bound === 'object', 'FEEDBACK', 'No bound endpoint');
    address = `127.0.0.1:${bound.port}`;
    return { url: `http://${address}/mcp`, token, async close() {
            controller.abort();
            await active?.catch(() => { });
            await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
        } };
}
//# sourceMappingURL=feedback.js.map