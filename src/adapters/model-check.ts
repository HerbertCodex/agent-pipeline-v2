import { mkdtempSync, readFileSync, writeFileSync, lstatSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash } from '../domain/hash.js';
import { invariant, PipelineError } from '../domain/errors.js';
import type { AgentConfig, ProcessResult } from '../domain/contracts.js';
import type { Store } from '../persistence/store.js';
import { runProcess, redact, type ProcessHooks } from '../execution/process.js';
import { executableAvailability } from './providers.js';
import { claudeCommand, claudeOutput } from './claude.js';
import { startInvocation, type InvocationOwner } from './invocations.js';
import { usageSentence } from './usage.js';

const schema = { type: 'object', properties: { ready: { type: 'boolean', enum: [true] } }, required: ['ready'], additionalProperties: false };
const prompt = 'Compatibility check only. Do not use tools or inspect files. Return exactly {"ready":true} using the required output schema.';
const cache = new WeakMap<Store, Map<string, { at: number; version: string }>>();
const TTL = 15 * 60 * 1000;

/** Diagnose provider failures, never infer retirement from a successful model's prose. */
export function assertModelResponse(agent: AgentConfig, result: ProcessResult): void {
  if (agent.type === 'command' || result.status === 'cancelled' || result.status === 'timed_out') return;
  let failed = result.status !== 'passed';
  if (agent.type === 'claude') {
    try { const r = JSON.parse(result.stdout); failed ||= r.is_error === true || (r.type === 'result' && r.subtype !== 'success'); } catch { /* normal output validation handles it */ }
  } else {
    failed ||= result.stdout.split('\n').some(line => { try { const r = JSON.parse(line); return r.type === 'error' || r.type === 'turn.failed'; } catch { return false; } });
  }
  if (!failed) return;
  const text = `${result.stderr}\n${result.stdout}`.slice(-32000);
  const identity = `${agent.type} model ${agent.model || '(provider default)'}`;
  if (/invalid.api.key|authentication.failed|not.authenticated|not.logged.in|please.log.in|unauthorized|\b401\b/i.test(text))
    throw new PipelineError('MODEL_AUTH', `${identity}: authentication failed. Check the configured CLI account; no fallback model was selected.`);
  if (/unsupported.{0,60}(effort|reasoning)|(effort|reasoning).{0,60}(not.supported|unsupported|invalid)/i.test(text))
    throw new PipelineError('MODEL_EFFORT', `${identity}: effort ${agent.effort} is not supported. Review the effort setting and rerun models check; no downgrade was applied.`);
  if (/(model|deployment).{0,100}(not.found|does.not.exist|not.available|unavailable|not.supported|unsupported|retired|deprecated|no.access|do.not.have.access)|(?:invalid|unknown|unsupported).{0,25}model/i.test(text))
    throw new PipelineError('MODEL_UNAVAILABLE', `${identity}: identifier unavailable or inaccessible to this account. Use models replace to prepare an explicit configuration migration, or amend the affected role with spec budget for retained work. No replacement was chosen automatically.`);
}

/** A real bounded native-CLI probe; only a fixed prompt is sent, never project contents.
 * Success attests this model/effort/CLI/account combination now, not future availability or quality.
 */
export async function ensureModelReady(agent: AgentConfig, options: {
  store: Store; owner: InvocationOwner; env: NodeJS.ProcessEnv; cwd?: string; signal?: AbortSignal; hooks?: ProcessHooks;
}): Promise<void> {
  if (agent.preflight !== 'probe') return;
  invariant(agent.type !== 'command' && agent.model.trim(), 'MODEL_SELECTION', 'Model preflight needs an explicit native model. Select profiles with --models FILE or set agent/roles model.');
  const emit = (type: string, data: Record<string, unknown>) => options.owner.kind === 'run'
    ? options.store.event(options.owner.id, type, data) : options.store.documentEvent(options.owner.id, type, data);
  const root = mkdtempSync(join(tmpdir(), 'apv2-model-check-'));
  const deadline = Date.now() + Math.min(60000, agent.timeoutMs);
  try {
    const executable = executableAvailability(agent, options.cwd ?? process.cwd(), options.env['PATH'] ?? '');
    invariant(executable.available && executable.path, 'MODEL_CLI', `Executable for ${agent.type} is missing; install/authenticate the CLI before running the model.`);
    const st = statSync(executable.path);
    const key = hash({ provider: agent.type, model: agent.model, effort: agent.effort, executable: executable.path,
      mtime: st.mtimeMs, size: st.size, env: options.env });
    const entries = cache.get(options.store) ?? new Map(); cache.set(options.store, entries);
    const previous = entries.get(key);
    if (previous && Date.now() - previous.at < TTL) { emit('model.preflight_reused', { provider: agent.type, model: agent.model, effort: agent.effort, checkedAt: previous.at, version: previous.version }); return; }
    const versionResult = await runProcess({ command: [executable.path, '--version'], cwd: root, env: options.env,
      timeoutMs: Math.max(1, Math.min(5000, deadline - Date.now())), ...(options.signal ? { signal: options.signal } : {}), ...options.hooks, maxOutputBytes: 4000 });
    invariant(versionResult.status === 'passed' && !versionResult.truncated, versionResult.status === 'cancelled' ? 'CANCELLED' : 'MODEL_CLI', `${agent.type}: CLI version check failed before sending project content.`);
    const version = versionResult.stdout.trim().slice(0, 200);
    const effective = { ...agent, maxTurns: Math.min(agent.maxTurns, 3), maxBudgetUsd: agent.type === 'claude' ? Math.min(agent.maxBudgetUsd ?? 0.25, 0.25) : null };
    let command: string[]; const output = join(root, 'result.json');
    if (agent.type === 'claude') {
      command = claudeCommand(effective, schema, true);
      command[0] = executable.path;
      command[command.indexOf('--tools') + 1] = '';
      command[command.indexOf('--allowedTools') + 1] = '';
    } else {
      const schemaPath = join(root, 'schema.json'); writeFileSync(schemaPath, JSON.stringify(schema), { mode: 0o600 });
      command = [executable.path, 'exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', '--cd', root,
        '--output-schema', schemaPath, '--output-last-message', output, '--model', agent.model,
        ...(agent.effort !== 'default' ? ['-c', `model_reasoning_effort="${agent.effort}"`] : []), '-'];
    }
    invariant(Date.now() < deadline, 'MODEL_CHECK', 'Model preflight deadline exhausted.');
    const invocation = startInvocation(options.store, options.owner, effective, 'model-check', prompt);
    const result = await runProcess({ command, cwd: root, env: options.env, input: prompt, timeoutMs: Math.max(1, deadline - Date.now()),
      ...(options.signal ? { signal: options.signal } : {}), ...options.hooks, maxOutputBytes: 131072 });
    const usage = invocation.finish(result);
    assertModelResponse(agent, result);
    const diagnostic = redact(usageSentence(usage) || result.stderr.slice(-600), options.env);
    invariant(result.status === 'passed' && !result.truncated && !usage?.stopReason, result.status === 'cancelled' ? 'CANCELLED' : 'MODEL_CHECK', `${agent.type} model check did not complete cleanly (${result.status}); project content was not sent.${diagnostic ? ` ${diagnostic}` : ' Inspect the invocation and check account limits or CLI compatibility.'}`);
    let value: unknown;
    if (agent.type === 'claude') value = claudeOutput(result.stdout);
    else {
      let valid = false;
      try { const stat = lstatSync(output); valid = stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4096; } catch { /* handled below */ }
      invariant(valid, 'MODEL_CHECK', 'Model probe did not produce a bounded regular JSON output file.');
      try { value = JSON.parse(readFileSync(output, 'utf8')); } catch { throw new PipelineError('MODEL_CHECK', 'Model probe returned invalid JSON.'); }
    }
    invariant(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && (value as {ready?: unknown}).ready === true,
      'MODEL_CHECK', 'Model probe failed the structured-output contract. No project content was sent.');
    entries.set(key, { at: Date.now(), version });
    emit('model.preflight_passed', { provider: agent.type, model: agent.model, effort: agent.effort, version, expiresAt: Date.now() + TTL,
      scope: 'Native CLI and structured output. Not a quality benchmark or a guarantee of future availability.' });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
