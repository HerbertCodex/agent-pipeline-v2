import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** A gate read from a project file, proposed with `mandatory: false` until the operator reviews it. */
export interface DetectedGate {
  id: string;
  command: string[];
  source: string;
  note: string;
}

/** Gate ids proposed for a project without V2, each with the script or target names that stand for it. */
const KINDS: { id: string; scripts: string[]; targets: string[] }[] = [
  { id: 'check', scripts: ['check', 'typecheck', 'type-check'], targets: ['check', 'typecheck'] },
  { id: 'lint', scripts: ['lint'], targets: ['lint'] },
  { id: 'test', scripts: ['test'], targets: ['test'] },
  { id: 'build', scripts: ['build'], targets: ['build'] },
  { id: 'e2e', scripts: ['e2e', 'test:e2e'], targets: ['e2e', 'test-e2e'] },
];

const NOTE = 'détecté, pas encore obligatoire (mandatory: false) : relire la commande, puis compléter covers, resources et passEnv';

const readText = (path: string): string | null => {
  try { return existsSync(path) && statSync(path).isFile() ? readFileSync(path, 'utf8') : null; }
  catch { return null; }
};

function packageManager(repo: string, pkg: Record<string, unknown>): string {
  const declared = typeof pkg['packageManager'] === 'string' ? /^(npm|pnpm|yarn|bun)@/.exec(pkg['packageManager'])?.[1] : undefined;
  if (declared) return declared;
  if (existsSync(join(repo, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(repo, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(repo, 'bun.lock')) || existsSync(join(repo, 'bun.lockb'))) return 'bun';
  return 'npm';
}

function packageScripts(repo: string): { manager: string; scripts: Record<string, string> } | null {
  const text = readText(join(repo, 'package.json'));
  if (text === null) return null;
  let pkg: unknown;
  try { pkg = JSON.parse(text) as unknown; } catch { return null; }
  if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) return null;
  const raw = (pkg as Record<string, unknown>)['scripts'];
  const scripts: Record<string, string> = {};
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [name, value] of Object.entries(raw)) if (typeof value === 'string') scripts[name] = value;
  }
  return { manager: packageManager(repo, pkg as Record<string, unknown>), scripts };
}

function makeTargets(repo: string): { file: string; targets: Set<string> } | null {
  for (const file of ['GNUmakefile', 'makefile', 'Makefile']) {
    const text = readText(join(repo, file));
    if (text === null) continue;
    // Rule lines `name:` (not variable assignments `name := value`).
    const targets = new Set([...text.matchAll(/^([A-Za-z0-9_.-]+)\s*:(?!=)/gm)].map(m => m[1]!));
    return { file, targets };
  }
  return null;
}

/** Python tools configured in `pyproject.toml`, run through the project's environment manager when it has a lock file. */
function pyprojectGates(repo: string): DetectedGate[] {
  const text = readText(join(repo, 'pyproject.toml'));
  if (text === null) return [];
  const runner = existsSync(join(repo, 'uv.lock')) ? ['uv', 'run'] : existsSync(join(repo, 'poetry.lock')) ? ['poetry', 'run'] : [];
  const tools: { id: string; section: RegExp; label: string; command: string[] }[] = [
    { id: 'check', section: /^\[tool\.mypy\]/m, label: '[tool.mypy]', command: ['mypy', '.'] },
    { id: 'lint', section: /^\[tool\.ruff(\.[a-z-]+)?\]/m, label: '[tool.ruff]', command: ['ruff', 'check', '.'] },
    { id: 'test', section: /^\[tool\.pytest(\.ini_options)?\]/m, label: '[tool.pytest]', command: ['python', '-m', 'pytest'] },
  ];
  return tools.filter(t => t.section.test(text)).map(t => ({
    id: t.id, command: [...runner, ...t.command], source: `pyproject.toml, section ${t.label}`,
    note: `${NOTE} ; commande déduite de la configuration de l'outil`,
  }));
}

/**
 * Gates a project already declares through its own files: package.json scripts, Makefile targets, tools
 * configured in pyproject.toml. Only commands the project has; nothing is invented. First source wins per id.
 */
export function detectGates(repo: string): DetectedGate[] {
  const out: DetectedGate[] = [];
  const add = (gate: DetectedGate): void => { if (!out.some(g => g.id === gate.id)) out.push(gate); };
  const pkg = packageScripts(repo);
  const make = makeTargets(repo);
  for (const kind of KINDS) {
    const script = pkg && kind.scripts.find(s => pkg.scripts[s] !== undefined);
    if (pkg && script) {
      add({ id: kind.id, command: [pkg.manager, 'run', script], source: `package.json, script « ${script} » (${pkg.scripts[script]})`, note: NOTE });
      continue;
    }
    const target = make && kind.targets.find(t => make.targets.has(t));
    if (make && target) add({ id: kind.id, command: ['make', target], source: `${make.file}, cible « ${target} »`, note: NOTE });
  }
  for (const gate of pyprojectGates(repo)) add(gate);
  return KINDS.map(k => out.find(g => g.id === k.id)).filter((g): g is DetectedGate => g !== undefined);
}

/**
 * Hints of an existing preview (package.json scripts and files of `scripts/` named preview or aperçu). They are
 * shown, never turned into a `preview` section: its build, migrations and seed are the operator's to describe.
 */
export function previewHints(repo: string): string[] {
  const pattern = /preview|apercu|aperçu/i;
  const hints: string[] = [];
  const pkg = packageScripts(repo);
  if (pkg) for (const [name, command] of Object.entries(pkg.scripts)) if (pattern.test(name)) hints.push(`package.json, script « ${name} » (${command})`);
  const scripts = join(repo, 'scripts');
  try {
    if (existsSync(scripts) && statSync(scripts).isDirectory()) {
      for (const name of readdirSync(scripts).sort()) if (pattern.test(name)) hints.push(`scripts/${name}`);
    }
  } catch { /* unreadable folder: no hint */ }
  return hints;
}
