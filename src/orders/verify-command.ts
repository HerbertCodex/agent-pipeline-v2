import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { errorMessage } from '../domain/errors.js';
import { environment, expandCommand, runProcess } from '../execution/process.js';
import type { LotGit } from '../stack/batch.js';
import type { OrderStep, VerifiedOrder } from './order.js';

/**
 * The verification command of the project (`rules.operatorOrders.verify.publication`), run by APV from a clean copy of
 * the base: a detached worktree of the base commit, prepared by `batch.setup` of the base when it declares one (the
 * dependencies of the base, never those of the pull request), then the command with `{{base}}`, `{{head}}` and
 * `{{step}}` replaced, the verified order as JSON on its input. Nothing of the head is executed by APV: the command reads
 * it through Git. Exit 0: the content is the one the order signed; any other exit refuses, with the code the command
 * wrote (`{ "ok": false, "code": "content" }` on its last line) when it is a short word.
 */

export interface VerifyCommand {
  command: readonly string[]; timeoutMs: number;
  /** `batch.setup` of the base, with its time limit; absent: nothing is prepared. */
  setup?: { command: readonly string[]; timeoutMs: number } | undefined;
  /** Variables given to the setup and the command: `environment.passEnv` of the base, and HOME. */
  passEnv: readonly string[];
}
export interface VerifyInput { repo: string; git: LotGit; base: string; head: string; step: OrderStep; order: VerifiedOrder; settings: VerifyCommand; env: NodeJS.ProcessEnv; signal?: AbortSignal }
/** `projectCode`: the code the command of the project gave (`content`, `files`...), null when it gave none or did not run. */
export type VerifyResult = { ok: true } | { ok: false; projectCode: string | null; detail: string };

const CODE = /^[a-z][a-z_]{0,39}$/;
const tail = (text: string): string => text.trim().split('\n').slice(-5).join(' | ').replace(/\s+/g, ' ').slice(-600);

/** The code a refusing command wrote on its last JSON line, when it is a short word. */
export function refusalCode(stdout: string): string | null {
  const last = stdout.trim().split('\n').pop() ?? '';
  try {
    const code = (JSON.parse(last) as Record<string, unknown>)?.['code'];
    return typeof code === 'string' && CODE.test(code) ? code : null;
  } catch { return null; }
}

export async function runVerifyCommand(input: VerifyInput): Promise<VerifyResult> {
  const folder = mkdtempSync(join(tmpdir(), 'apv-ordre-'));
  const copy = join(folder, 'base');
  const env = environment([...input.settings.passEnv, 'HOME'], input.env);
  try {
    const added = await input.git.run(input.repo, ['worktree', 'add', '--detach', '--quiet', copy, input.base]);
    if (!added.ok) return { ok: false, projectCode: null, detail: `copie propre de la base impossible : ${tail(added.stderr)}` };
    if (input.settings.setup) {
      const prepared = await runProcess({ command: input.settings.setup.command, cwd: copy, env, timeoutMs: input.settings.setup.timeoutMs, maxOutputBytes: 256 * 1024,
        ...(input.signal ? { signal: input.signal } : {}) });
      if (prepared.status !== 'passed') return { ok: false, projectCode: null, detail: `préparation batch.setup en échec (${prepared.status}) : ${tail(`${prepared.stdout}\n${prepared.stderr}`)}` };
    }
    const command = expandCommand(input.settings.command, { base: input.base, head: input.head, step: input.step });
    const order = { ok: true, order: input.order.order.payload, payload: input.order.payload, signature: input.order.signature, digest: input.order.digest };
    const result = await runProcess({ command, cwd: copy, env, timeoutMs: input.settings.timeoutMs, input: `${JSON.stringify(order)}\n`, maxOutputBytes: 256 * 1024,
      ...(input.signal ? { signal: input.signal } : {}) });
    if (result.status === 'passed') return { ok: true };
    const code = refusalCode(result.stdout);
    return { ok: false, projectCode: code, detail: code ? `commande du projet : ${code}` : `commande du projet en échec (${result.status}, code ${result.exitCode ?? '-'}) : ${tail(`${result.stdout}\n${result.stderr}`)}` };
  } catch (error) {
    return { ok: false, projectCode: null, detail: `commande du projet non lancée : ${errorMessage(error)}` };
  } finally {
    await input.git.run(input.repo, ['worktree', 'remove', '--force', copy]).catch(() => undefined);
    rmSync(folder, { recursive: true, force: true });
    await input.git.run(input.repo, ['worktree', 'prune']).catch(() => undefined);
  }
}
