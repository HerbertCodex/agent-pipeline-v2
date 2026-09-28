import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { s, type Infer } from '../domain/schema.js';

/**
 * Test stacks of the project (docs/APV3-SPEC.md, section 18.1): a test database or browser stack shared by the
 * copies of the repository, with its lock (kernel `flock` file or `apv lock` lease), what selects it (variables, env
 * file), its Docker project, its ports and how to stop and restart it. Read by the Bash hook (a docker or supabase
 * command on a stack needs its lock), `apv stacks` (idle stop, restart) and `apv gates run --stacks` (a suite spread
 * over several stacks).
 */
export const STACK_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const argv = s.array(s.string(1, 16000), 1, 200);
/** Default idle delay of `apv stacks idle-stop`: 30 minutes. */
export const DEFAULT_IDLE_AFTER_MS = 1_800_000;
/** Longest run of a `stop` or `start` command of a stack: 10 minutes. */
export const DEFAULT_STACK_COMMAND_TIMEOUT_MS = 600_000;
export const stackSchema = s.object({
  id: s.string(1, 80, STACK_ID),
  /** Kernel lock file of the stack: absolute, or relative to the Git common directory (like `lock.file` of a check). */
  lockFile: s.optional(s.string(1, 4000)),
  /** Lease of `apv lock` that guards the stack. */
  resource: s.optional(s.string(1, 80, STACK_ID)),
  /** Project command that takes the lock of the stack itself, then runs the rest of its arguments. */
  lockCommand: s.optional(s.array(s.string(1, 4000), 1, 50)),
  /** Docker project of the containers: `<prefix>_<dockerProject>`, label value `<dockerProject>`. */
  dockerProject: s.optional(s.string(1, 200, /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)),
  /** Variables that select the stack (a check spread on it receives them). */
  env: s.optional(s.record(/^[A-Za-z_][A-Za-z0-9_]*$/, s.string(0, 4000), 100)),
  /** File of `KEY=value` lines that selects the stack: absolute, or relative to the Git common directory. */
  envFile: s.optional(s.string(1, 4000)),
  ports: s.optional(s.array(s.number(1, 65535), 1, 100)),
  /** Commands (no shell, run from the root of the repository) that stop and restart the stack. */
  stop: s.optional(argv),
  start: s.optional(argv),
  idleAfterMs: s.optional(s.number(60_000, 604_800_000)),
  commandTimeoutMs: s.default(s.number(1000, 3_600_000), DEFAULT_STACK_COMMAND_TIMEOUT_MS),
  description: s.optional(s.string(1, 500)),
});
export type StackConfig = Infer<typeof stackSchema>;
export const stacksSchema = s.array(stackSchema, 0, 10);

/** Every problem of the declared stacks: duplicate ids, lock files or resources, a stack without a lock, duplicate ports. */
export function stackIssues(stacks: readonly StackConfig[]): string[] {
  const out: string[] = [];
  const dup = (values: (string | undefined)[], what: string): void => {
    const seen = new Set<string>();
    for (const v of values) { if (v === undefined) continue; if (seen.has(v)) out.push(`stacks: duplicate ${what} ${v}`); seen.add(v); }
  };
  dup(stacks.map(x => x.id), 'id');
  dup(stacks.map(x => x.lockFile), 'lockFile');
  dup(stacks.map(x => x.resource), 'resource');
  dup(stacks.map(x => x.dockerProject), 'dockerProject');
  for (const x of stacks) {
    if (!x.lockFile && !x.resource) out.push(`stacks.${x.id}: declare its lock, lockFile (flock) or resource (apv lock)`);
    if (x.ports && new Set(x.ports).size !== x.ports.length) out.push(`stacks.${x.id}.ports: duplicate port`);
  }
  return out;
}

/** A path of a stack: absolute as is, else relative to the Git common directory `common`. */
export const stackPath = (common: string, path: string): string => isAbsolute(path) ? path : resolve(common, path);

/**
 * Variables of an env file (`KEY=value` lines, `export ` and quotes accepted, comments and blank lines skipped), as a
 * shell `set -a; . <file>` would set them for simple values. No expansion: a value is taken as written.
 */
export function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) value = value.slice(1, -1);
    out[m[1]!] = value;
  }
  return out;
}
