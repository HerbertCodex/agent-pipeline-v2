import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { errorMessage } from '../domain/errors.js';
import { environment, expandCommand, runProcess } from '../execution/process.js';
import type { LotGit } from '../stack/batch.js';
import type { OrderStep, VerifiedOrder } from './order.js';

/**
 * The verification command of the project (`rules.operatorOrders.verify.publication`), run by APV from a clean copy of
 * the trusted base of the run (`source`: the target as it was before any merge on this order, never a commit a pull
 * request wrote): a detached worktree of it, prepared by `batch.setup` of that same base when it declares one, then the
 * command with `{{trusted}}` (that base: where the project reads its keys), `{{base}}` (the commit the step merges on,
 * an argument only), `{{head}}` and `{{step}}` replaced, the verified
 * order as JSON on its input. Nothing of the head is executed by APV: the command reads
 * it through Git. Exit 0: the content is the one the order signed; any other exit refuses, with the code the command
 * wrote (`{ "ok": false, "code": "content" }` on its last line) when it is a short word. On success, its last line may
 * say what it regenerated and the shape it checked (`{ "ok": true, "regenerated": [{ "path", "blob" }], "shape":
 * "literal" }`, docs/PREUVE-REDUITE.md 5.3): read for the reduced lane only, never required otherwise.
 */

export interface VerifyCommand {
  command: readonly string[]; timeoutMs: number;
  /** `batch.setup` of the base, with its time limit; absent: nothing is prepared. */
  setup?: { command: readonly string[]; timeoutMs: number } | undefined;
  /** Variables given to the setup and the command: `environment.passEnv` of the base, and HOME. */
  passEnv: readonly string[];
}
export interface VerifyInput { repo: string; git: LotGit; source: string; base: string; head: string; step: OrderStep; order: VerifiedOrder; settings: VerifyCommand; env: NodeJS.ProcessEnv; signal?: AbortSignal }
/** A file the command regenerated, with the id of the blob it produced. */
export interface RegeneratedFile { path: string; blob: string }
/**
 * `projectCode`: the code the command of the project gave (`content`, `files`...), null when it gave none or did not run.
 * `regenerated` and `shape`: what a succeeding command said on its last line (null when it said nothing readable).
 */
export type VerifyResult = { ok: true; regenerated?: RegeneratedFile[] | null; shape?: string | null } | { ok: false; projectCode: string | null; detail: string };

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

const BLOB = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/** Entries of `regenerated` read at most: beyond, the list is not read. */
const MAX_REGENERATED = 200;

/**
 * What a succeeding command said on its last JSON line (E2 and M4 of the review): the files it regenerated with their
 * blob, and the shape it checked. A list with one unreadable entry (path outside the repository, blob that is not an
 * object id), more than 200 entries, or a line that does not say `ok: true`, is no list.
 */
export function successReport(stdout: string): { regenerated: RegeneratedFile[] | null; shape: string | null } {
  const last = stdout.trim().split('\n').pop() ?? '';
  let value: Record<string, unknown> | null = null;
  try { const parsed: unknown = JSON.parse(last); value = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null; } catch { value = null; }
  if (!value || value['ok'] !== true) return { regenerated: null, shape: null };
  const shape = typeof value['shape'] === 'string' && CODE.test(value['shape']) ? value['shape'] : null;
  const list = value['regenerated'];
  const path = (p: unknown): p is string => typeof p === 'string' && p.length > 0 && p.length <= 500 && !p.startsWith('/') && !p.split('/').some(x => x === '..' || x === '.' || x === '');
  const entry = (e: unknown): RegeneratedFile | null => {
    const r = e !== null && typeof e === 'object' && !Array.isArray(e) ? e as Record<string, unknown> : null;
    return r && path(r['path']) && typeof r['blob'] === 'string' && BLOB.test(r['blob']) ? { path: r['path'], blob: r['blob'] } : null;
  };
  if (!Array.isArray(list) || list.length > MAX_REGENERATED) return { regenerated: null, shape };
  const read = list.map(entry);
  return { regenerated: read.every((e): e is RegeneratedFile => e !== null) ? read : null, shape };
}

export async function runVerifyCommand(input: VerifyInput): Promise<VerifyResult> {
  const folder = mkdtempSync(join(tmpdir(), 'apv-ordre-'));
  const copy = join(folder, 'base');
  const env = environment([...input.settings.passEnv, 'HOME'], input.env);
  try {
    const added = await input.git.run(input.repo, ['worktree', 'add', '--detach', '--quiet', copy, input.source]);
    if (!added.ok) return { ok: false, projectCode: null, detail: `copie propre de la base impossible : ${tail(added.stderr)}` };
    if (input.settings.setup) {
      const prepared = await runProcess({ command: input.settings.setup.command, cwd: copy, env, timeoutMs: input.settings.setup.timeoutMs, maxOutputBytes: 256 * 1024,
        ...(input.signal ? { signal: input.signal } : {}) });
      if (prepared.status !== 'passed') return { ok: false, projectCode: null, detail: `préparation batch.setup en échec (${prepared.status}) : ${tail(`${prepared.stdout}\n${prepared.stderr}`)}` };
    }
    const command = expandCommand(input.settings.command, { trusted: input.source, base: input.base, head: input.head, step: input.step });
    const order = { ok: true, order: input.order.order.payload, payload: input.order.payload, signature: input.order.signature, digest: input.order.digest };
    const result = await runProcess({ command, cwd: copy, env, timeoutMs: input.settings.timeoutMs, input: `${JSON.stringify(order)}\n`, maxOutputBytes: 256 * 1024,
      ...(input.signal ? { signal: input.signal } : {}) });
    if (result.status === 'passed') return { ok: true, ...successReport(result.stdout) };
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
