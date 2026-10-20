import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dispatch } from '../dist/commands/index.js';

/**
 * In-process `apv` invocation with captured output; `env` is added to the test process environment. `onStderr`, when
 * given, sees the error output gathered so far each time it grows (a test reacts to what the command announces).
 */
export async function apv(cwd, args, env = {}, { onStderr = null } = {}) {
  const out = []; const err = [];
  const io = { stdout: s => out.push(s), stderr: s => { err.push(s); onStderr?.(err.join('')); }, cwd, env: { ...process.env, ...env } };
  const code = await dispatch(args, io);
  return { code, stdout: out.join(''), stderr: err.join(''), json: () => JSON.parse(out.join('')) };
}

export function write(root, path, value) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

/** A confirmed Product decision of the operator, valid in a ledger. */
export function decision(id, extra = {}) {
  return { id, subject: `Subject ${id}`, value: 'Value', enforcement: 'product', status: 'confirmed', source: 'operator', sourceQuote: 'quote',
    rationale: 'Operator decision.', supersedes: [], clarificationQuestion: '', interpretations: [], ...extra };
}
