import test from 'node:test';
import assert from 'node:assert/strict';
import { startFeedback } from '../dist/execution/feedback.js';
import { claudeCommand } from '../dist/adapters/claude.js';
import { providerProfile } from '../dist/adapters/providers.js';
import { agentOutputSchema } from '../dist/domain/contracts.js';
import { cfg, fixture, worker } from './helpers.mjs';

async function rpc(connection, method, params, headers = {}) {
  const response = await fetch(connection.url, { method: 'POST', headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return { status: response.status, body: response.status === 200 ? await response.json() : null };
}

test('feedback enforces authentication, command allowlist, arguments, quotas and credential separation', async t => {
  const events = [];
  const previous = process.env.TEST_PROVIDER_SECRET; process.env.TEST_PROVIDER_SECRET = 'never-inherit-provider-credentials';
  t.after(() => { if (previous === undefined) delete process.env.TEST_PROVIDER_SECRET; else process.env.TEST_PROVIDER_SECRET = previous; });
  const config = cfg({ agent: { type: 'command', command: ['unused'], passEnv: ['TEST_PROVIDER_SECRET'] },
    environment: { id: 'feedback-test', passEnv: ['PATH', 'TEST_PROVIDER_SECRET'] },
    gates: [{ id: 'probe', command: [process.execPath, '-e', 'if(process.env.TEST_PROVIDER_SECRET) process.exit(7); console.log("observed")'] }], feedback: { gateIds: ['probe'], maxCalls: 1, maxTotalMs: 5000 } });
  const connection = await startFeedback({ config, workspace: process.cwd(), signal: new AbortController().signal, emit: (type, data) => events.push({ type, data }) });
  t.after(() => connection.close());
  assert.equal((await rpc(connection, 'tools/list', {}, { authorization: 'forged' })).status, 403);
  assert.equal((await rpc(connection, 'tools/list', {}, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await rpc(connection, 'initialize', {})).body.result.capabilities.tools != null, true);
  const tools = (await rpc(connection, 'tools/list', {})).body.result.tools;
  assert.deepEqual(tools.map(t => t.name), ['run_check']);
  for (const args of [{ gateId: 'unknown' }, { gateId: 'probe', command: ['arbitrary'] }])
    assert.equal((await rpc(connection, 'tools/call', { name: 'run_check', arguments: args })).body.result.isError, true);
  const answer = (await rpc(connection, 'tools/call', { name: 'run_check', arguments: { gateId: 'probe' } })).body.result;
  const data = JSON.parse(answer.content[0].text);
  assert.equal(data.status, 'passed'); assert.equal(data.authoritative, false);
  assert.equal((await rpc(connection, 'tools/call', { name: 'run_check', arguments: { gateId: 'probe' } })).body.result.isError, true);
  assert.deepEqual(events.map(e => e.type), ['feedback.started', 'feedback.finished']);
  assert.throws(() => cfg({ feedback: { gateIds: ['missing'] } }), /Feedback/);
  assert.throws(() => cfg({ gates: [{ id: 'diff', command: ['git', 'diff', '{{candidateSha}}'] }], feedback: { gateIds: ['diff'] } }), /Feedback/);
});

test('feedback cancels running checks when the agent session closes', async () => {
  const events = [];
  const config = cfg({ gates: [{ id: 'slow', command: [process.execPath, '-e', 'setTimeout(()=>{},30000)'] }], feedback: { gateIds: ['slow'], maxTotalMs: 60000 } });
  let started; const onStart = new Promise(resolve => { started = resolve; });
  const connection = await startFeedback({ config, workspace: process.cwd(), signal: new AbortController().signal, emit: (type, data) => { events.push({ type, data }); if (type === 'feedback.started') started(); } });
  const pending = rpc(connection, 'tools/call', { name: 'run_check', arguments: { gateId: 'slow' } }).catch(() => null);
  await onStart;
  const concurrent = await rpc(connection, 'tools/call', { name: 'run_check', arguments: { gateId: 'slow' } });
  assert.equal(concurrent.body.result.isError, true);
  await connection.close(); await pending;
  assert.equal(events.at(-1).data.status, 'cancelled');
});

test('Claude receives exactly one check tool and read-only roles cannot receive it', () => {
  const connection = { url: 'http://127.0.0.1:1234/mcp', token: 'session-token' };
  const command = claudeCommand(providerProfile('claude'), agentOutputSchema.json, false, connection);
  assert.equal(command[command.indexOf('--tools') + 1], 'Read,Glob,Grep,Edit,Write');
  assert.equal(command[command.indexOf('--allowedTools') + 1], 'Read,Glob,Grep,Edit,Write,mcp__pipeline__run_check');
  const config = JSON.parse(command[command.indexOf('--mcp-config') + 1]);
  assert.deepEqual(Object.keys(config.mcpServers), ['pipeline']);
  assert.equal(command[command.indexOf('--disallowedTools') + 1].includes('Bash'), true);
  assert.throws(() => claudeCommand(providerProfile('claude'), agentOutputSchema.json, true, connection), /Read-only/);
});

test('Implementer fixes an observed red check in one call, then receives independent final receipts', async t => {
  const code = `
const response = await fetch(request.feedback.url, {method:'POST',headers:{authorization:'Bearer '+request.feedback.token,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'run_check',arguments:{gateId:'unit'}}})});
const observed = JSON.parse((await response.json()).result.content[0].text);
if(observed.status !== 'failed') throw new Error('Expected a real red check');
writeFileSync('src/math.mjs','export const add = (a,b) => a + b;\\n');
`;
  const f = fixture(t, { config: { agent: { type: 'command', command: worker(code) }, feedback: { gateIds: ['unit'], maxCalls: 2, maxTotalMs: 5000 } } });
  const run = await f.start();
  assert.equal(run.state, 'awaiting_review', JSON.stringify(run.error));
  const events = f.pipeline.store.events(run.id);
  assert.equal(events.filter(e => e.type === 'invocation.started').length, 1);
  assert.equal(events.find(e => e.type === 'feedback.finished').data.status, 'failed');
  assert.equal(run.metrics.repairAttempts, 0);
  assert.equal(run.receipts.every(r => r.status === 'passed'), true);
  assert.equal(run.receipts.some(r => r.gateId === 'unit'), true);
});
