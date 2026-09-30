import type { ApvConfig } from '../config/load.js';
import type { RequiredGate } from './config.js';

/**
 * The check of the tree structure, added by `apv init` and `apv onboard` to a web project (task stage: it also runs in the
 * full suite). By default every finding is a warning: the check fails only on what the project raised to `error`.
 */
export const STRUCTURE_GATE = { id: 'structure', command: ['apv', 'structure', 'check'], covers: ['architecture'], stage: 'task', readOnly: true, mandatory: true } as const;

/**
 * Checks every web project must declare, mandatory, before a merge (rule `controles`): the reuse of the shared components,
 * the code map and the tree structure. A check is recognised by the start of its command (`apv reuse check ...`), wrapped
 * or not (`node .../cli.js reuse check`, `npx apv ...`), whatever its id. A new capability of the tool (the architecture
 * map, for instance) is added here, and a project adds its own through `rules.requiredGates`.
 */
export const REQUIRED_WEB_GATES: readonly RequiredGate[] = [
  { id: 'reuse', command: ['apv', 'reuse', 'check'], source: 'apv' },
  { id: 'code-map', command: ['apv', 'map', '--check'], source: 'apv' },
  { id: 'structure', command: ['apv', 'structure', 'check'], source: 'apv' },
];

const LAUNCHERS = new Set(['node', 'npx', 'bunx', 'pnpm', 'yarn', 'exec', 'dlx']);
const isTool = (w: string): boolean => w === 'apv' || /(?:^|\/)dist\/cli\.js$/.test(w) || /(?:^|\/)bin\/apv$/.test(w);

/**
 * The words of a command after its launcher: `node <plugin>/dist/cli.js reuse check` and `npx apv reuse check` read as
 * `apv reuse check`. Only launchers (and their options) may come before the tool: `echo apv reuse check` is not the tool.
 */
function normalized(command: readonly string[]): string[] {
  const words = [...command];
  const cli = words.findIndex(isTool);
  if (cli < 0 || !words.slice(0, cli).every(w => LAUNCHERS.has(w.slice(w.lastIndexOf('/') + 1)) || w.startsWith('-'))) return words;
  return ['apv', ...words.slice(cli + 1)];
}

/** Whether `command` runs `required` (its words, in order, at the start of the command once the launcher is read). */
export function runsCommand(command: readonly string[], required: readonly string[]): boolean {
  const words = normalized(command);
  if (required[0] === 'apv') return words[0] === 'apv' && required.every((w, i) => words[i] === w);
  // A project command: its words anywhere, in order and contiguous (`npm run check:a11y`, wrapped in `apv lock run`).
  for (let i = 0; i + required.length <= words.length; i += 1) if (required.every((w, k) => words[i + k] === w)) return true;
  return false;
}

export interface MissingGate { id: string; command: string[]; problem: 'absent' | 'optional' }

/** The required checks the configuration lacks, or declares without `mandatory`. */
export function missingRequiredGates(config: ApvConfig, required: readonly RequiredGate[]): MissingGate[] {
  const out: MissingGate[] = [];
  for (const r of required) {
    const found = config.gates.filter(g => runsCommand(g.command, r.command));
    if (!found.length) out.push({ id: r.id, command: [...r.command], problem: 'absent' });
    else if (!found.some(g => g.mandatory)) out.push({ id: r.id, command: [...r.command], problem: 'optional' });
  }
  return out;
}
