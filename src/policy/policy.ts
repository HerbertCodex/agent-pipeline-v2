import type { ChangeSet, Config, Gate, Lane, RiskDecision, Task } from '../domain/contracts.js';
import { invariant } from '../domain/errors.js';

export function validRelativePath(path: string): boolean {
  return path.length > 0 && !path.startsWith('/') && !/^[a-zA-Z]:/.test(path) &&
    !path.includes('\\') && !/[\0\r\n]/.test(path) &&
    path.split('/').every(p => p !== '' && p !== '.' && p !== '..');
}
// Restricted portable globs: *, **, ?. Brackets and parentheses are literal path characters (dynamic
// route or group directories in several stacks); character classes are not supported. Braces and a
// leading "!" are refused so that brace expansion or negation never silently matches nothing.
export function matches(path: string, pattern: string): boolean {
  invariant(validRelativePath(pattern) && !/[{}]/.test(pattern) && !pattern.split('/').some(segment => segment.startsWith('!')), 'GLOB',
    `Unsupported glob: ${pattern}. Use only *, ** and ?; brackets and parentheses are literal characters, braces and leading ! are not supported.`);
  let regex = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '*' && pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/') { regex += '(?:.*/)?'; i++; }
      else regex += '.*';
    } else if (c === '*') regex += '[^/]*';
    else if (c === '?') regex += '[^/]';
    else regex += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${regex}$`).test(path);
}
export const sensitivePaths = [
  '.agent-pipeline/**', '.github/**', '.gitmodules', '.gitattributes', '**/AGENTS.md', '**/CLAUDE.md', '.codex/**', '.claude/**', '.agents/**', '**/SKILL.md', 'roles/**', 'skills/**',
  '**/package.json','**/package-lock.json','**/npm-shrinkwrap.json','**/pnpm-lock.yaml','**/yarn.lock',
  '**/requirements*.txt','**/pyproject.toml','**/uv.lock','**/poetry.lock',
  '**/Cargo.toml','**/Cargo.lock','**/go.mod','**/go.sum',
  '**/*.sql','**/migrations/**','**/auth/**','**/*auth*.*','**/security/**',
  '**/payment*/**','**/*permission*.*','**/*policy*.*','**/*secret*.*',
  '**/Dockerfile*','**/*.tf','**/.env*','**/pipeline*.json',
];
export function classify(changes: ChangeSet, config: Config, minimum: Lane = 'fast'): RiskDecision {
  const sensitive = changes.files.filter(f => [...sensitivePaths, ...config.risk.highPaths].some(p => matches(f, p)));
  if (minimum === 'high' || sensitive.length || changes.binary) return { lane: 'high', reasons: [
    ...(minimum === 'high' ? ['Requested minimum: high'] : []),
    ...sensitive.map(f => `Sensitive path: ${f}`), ...(changes.binary ? ['Binary change'] : []),
  ] };
  if (minimum !== 'standard' && changes.files.length > 0 && changes.files.length <= config.risk.maxFastFiles &&
      changes.lines <= config.risk.maxFastLines && changes.files.every(f => config.risk.fastPaths.some(p => matches(f, p)))) {
    return { lane: 'fast', reasons: ['All observed paths are in the approved fast set; size limits satisfied'] };
  }
  return { lane: 'standard', reasons: ['Default assurance for code, unknown impact, or size threshold'] };
}
export function assertScope(changes: ChangeSet | string[], task: Task): string[] {
  for (const p of [...task.allowedPaths, ...task.allowedNewPaths]) matches('probe', p);
  const files = Array.isArray(changes) ? changes : changes.files;
  const added = new Set(Array.isArray(changes) ? [] : changes.added);
  const autoNew: string[] = [];
  const rejected: string[] = [];
  for (const file of files) {
    if (!validRelativePath(file)) { rejected.push(file); continue; }
    if (task.allowedPaths.some(p => matches(file, p))) continue;
    const safeNew = added.has(file) && task.allowedNewPaths.some(p => matches(file, p)) &&
      !sensitivePaths.some(p => matches(file, p));
    if (safeNew) { autoNew.push(file); continue; }
    rejected.push(file);
  }
  invariant(autoNew.length <= task.maxNewFiles, 'SCOPE', `Too many automatically-created supporting files: ${autoNew.join(', ')}`);
  invariant(rejected.length === 0, 'SCOPE', `Out-of-scope files: ${rejected.join(', ')}`);
  return autoNew;
}
export function validateDag(gates: Gate[]): void {
  const byId = new Map(gates.map(g => [g.id, g]));
  invariant(byId.size === gates.length, 'DAG', 'Duplicate gate id');
  const visiting = new Set<string>(); const done = new Set<string>();
  function visit(id: string): void {
    if (done.has(id)) return;
    invariant(!visiting.has(id), 'DAG', `Dependency cycle at ${id}`);
    const gate = byId.get(id); invariant(gate, 'DAG', `Missing gate ${id}`);
    visiting.add(id); gate.dependsOn.forEach(visit); visiting.delete(id); done.add(id);
  }
  gates.forEach(g => visit(g.id));
}
export function planGates(config: Config, changes: ChangeSet, lane: Lane): Gate[] {
  validateDag(config.gates);
  const chosen = new Set(config.gates.filter(g => lane === 'high' || g.mandatory ||
    (g.lanes.includes(lane) && (g.paths.length === 0 || changes.files.some(f => g.paths.some(p => matches(f, p)))))).map(g => g.id));
  const byId = new Map(config.gates.map(g => [g.id, g]));
  function include(id: string): void { for (const dep of byId.get(id)!.dependsOn) { if (!chosen.has(dep)) { chosen.add(dep); include(dep); } } }
  [...chosen].forEach(include);
  invariant(chosen.size > 0, 'NO_GATES', `No checks configured for ${lane}; refusing empty validation`);
  return config.gates.filter(g => chosen.has(g.id));
}
export type ReviewMode = 'solo' | 'team' | 'regulated';
export function requiredApprovals(lane: Lane, mode: ReviewMode = 'team'): number {
  if (mode === 'solo') return lane === 'fast' ? 0 : 1;
  if (mode === 'regulated') return lane === 'high' ? 2 : 1;
  return lane === 'high' ? 2 : lane === 'standard' ? 1 : 0;
}
