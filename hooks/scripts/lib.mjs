// Shared helpers for the APV plugin hooks. Node built-ins only: hooks run
// before any dependency install and must never fail because of a package.
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Reads the whole hook payload from stdin; resolves to null when it is not a JSON object. */
export async function readHookInput(stream = process.stdin) {
  let raw = '';
  stream.setEncoding('utf8');
  for await (const chunk of stream) raw += chunk;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Returns the project's `.apv` directory, or null when the project does not use APV.
 * The project root comes from CLAUDE_PROJECT_DIR (set by Claude Code for hooks), then the
 * payload's cwd. No parent directory is searched: a hook must never write outside the project.
 */
export function findApvDir(input, env = process.env) {
  const candidates = [env.CLAUDE_PROJECT_DIR, input?.cwd].filter(v => typeof v === 'string' && v.length > 0);
  for (const root of candidates) {
    const dir = join(root, '.apv');
    try {
      if (existsSync(dir) && statSync(dir).isDirectory()) return dir;
    } catch {
      // Unreadable candidate: try the next one.
    }
  }
  return null;
}

// Same patterns as cleanLine of the tool (src/run/summary.ts): the hooks must run without the compiled dist.
// Escape sequences (CSI, OSC, then any other two-character escape) are removed whole.
const ANSI = /\u001b\[[0-?]*[ -\/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-_]?/g;
// Control (C0, DEL, C1), format (bidirectional overrides, zero width, BOM) and line or paragraph separators.
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * Text read on disk or received as one journal or context line: escape sequences removed, control and
 * format characters replaced by spaces, whitespace collapsed, at most `max` characters (code points).
 */
export function oneLine(value, max = 200) {
  const text = String(value ?? '').replace(ANSI, ' ').replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}

/**
 * Machine files of `.apv/` that are never versioned. Same list and same rule as
 * `ensureApvGitignore` of the tool (src/config/apv-files.ts); a test keeps them equal.
 */
export const APV_IGNORED = ['state/*.log', 'state/task.json', 'state/preview.json', 'receipts/'];
const IGNORE_HEADER = '# Généré par apv : fichiers machine de .apv/, jamais versionnés. Vous pouvez ajouter vos lignes.';

/** Creates `<apvDir>/.gitignore`, or appends the lines it lacks; keeps the project's own lines. */
export function ensureApvGitignore(apvDir) {
  const file = join(apvDir, '.gitignore');
  const current = existsSync(file) ? readFileSync(file, 'utf8') : null;
  const present = new Set((current ?? '').split(/\r?\n/).map(l => l.trim()));
  const missing = APV_IGNORED.filter(line => !present.has(line));
  if (current !== null && !missing.length) return false;
  mkdirSync(apvDir, { recursive: true });
  if (current === null) writeFileSync(file, `${IGNORE_HEADER}\n${missing.join('\n')}\n`);
  else writeFileSync(file, `${current}${current.endsWith('\n') || current === '' ? '' : '\n'}${missing.join('\n')}\n`);
  return true;
}

/**
 * True when the module at `moduleUrl` is the script Node was asked to run. Both sides are compared with
 * their symlinks resolved: Node resolves the main module's path, argv[1] keeps the path as launched, so a
 * plugin reached through a symlink (macOS /var, a linked plugin folder) would otherwise run no hook at all,
 * silently, including the Bash guard.
 */
export function isMainModule(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try { return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argv1); }
  catch { return false; }
}

/**
 * Stores of the Git common directory that only the tool writes (docs/REGLES.md, « Ancrage »): the operator journal
 * (`apv/operator/`, written by the UserPromptSubmit hook) and the review records (`apv/reviews/`, written by
 * `apv review record`). A command or a write that names them is refused by the guards.
 */
export const ANCHOR_STORES = /\bapv[\\/]+(?:operator|reviews|merges)(?:[\\/]|\b)/;

/**
 * The same stores, and the anchor key, looked for in a text flattened by `flatten` (quotes, backslashes and quote
 * concatenations removed), so that `.git/ap""v/...` or `join('ap'+'v', ...)` are recognised: file names, key, commit folders.
 * The journal file name, generic (`messages.jsonl`), counts only next to `operator` (`cd operator && cat messages.jsonl`).
 */
export const ANCHOR_FRAGMENTS = [/\boperator\b[\s\S]{0,200}messages\.jsonl|messages\.jsonl[\s\S]{0,200}\boperator\b/i, /anchor\.key/i, /\.apv-ancrage\b/i, /\bcle-ancrage\b/i, /cle\.empreinte/i, /\bapv\W{1,4}(?:operator|reviews|merges)\b/i, /operator\/+(?:messages|refused)/i,
  /reviews\/+[0-9a-f]{12,}/i, /merges\/+[0-9a-f]{12,}/i];

/** A command or a path as a guard reads it: quote concatenations ('ap'+'v', "ap" "v"), quotes and backslashes removed. */
export function flatten(text) {
  return String(text ?? '').replace(/(['"`])\s*\+?\s*\1/g, '').replace(/['"`\\]/g, '');
}

/** True when a text names a store of the anchor or the anchor key, even cut in pieces. */
export const namesAnchor = text => ANCHOR_STORES.test(String(text ?? '')) || ANCHOR_FRAGMENTS.some(re => re.test(flatten(text)));

/** The reviewer agent of each review domain (same table as DOMAIN_REVIEWERS of src/rules/reviews.ts; a test keeps them equal). */
export const DOMAIN_REVIEWERS = { securite: 'qa-securite', fidelite: 'qa-fidelite', donnees: 'architecte-donnees', rgpd: 'dpo' };

/** `apv:qa-securite` and `qa-securite` name the same agent. */
export const agentName = value => String(value ?? '').trim().replace(/^apv:/, '');

/**
 * Files that set the environment of the session and of every hook at its next start: the settings of Claude Code (their
 * `env` block, the hooks and plugins they switch off) and the profiles of the shells. What is written there reaches the
 * hooks without a command (an authorisation such as APV_ALLOW_MERGE, code loaded by NODE_OPTIONS...): the guards refuse
 * it (docs/REGLES.md, « Ancrage »).
 */
const SHELL_PROFILES = new Set(['.bashrc', '.bash_profile', '.bash_login', '.bash_aliases', '.profile', '.zshrc', '.zshenv', '.zprofile',
  '.zlogin', '.kshrc', '.mkshrc', '.cshrc', '.tcshrc', '.login', '.envrc', '.pam_environment']);

/**
 * A path as the system reaches it: backslashes read as separators, `~` as the home, a relative path from `cwd`, then
 * `.`, `..` and repeated separators collapsed (`.claude/./settings.json`, `.claude//x/../settings.json`).
 */
export function canonicalPath(path, { cwd = null, home = null } = {}) {
  let p = String(path ?? '').replace(/\\/g, '/');
  if (home && (p === '~' || p.startsWith('~/'))) p = `${home}${p.slice(1)}`;
  if (!p.startsWith('/') && cwd) p = `${cwd}/${p}`;
  return posix.normalize(p);
}

/** 'settings', 'profile' or null for a canonical path, by its name alone, case ignored (case-insensitive file systems). */
function environmentFileByName(path) {
  const p = path.toLowerCase();
  const base = p.split('/').pop() ?? '';
  if (/(?:^|\/)\.claude\/settings(?:\.local)?\.json$/.test(p) || base === 'settings.local.json' || base === 'managed-settings.json') return 'settings';
  if (SHELL_PROFILES.has(base) || p === '/etc/environment' || /(?:^|\/)(?:\.bashrc\.d|\.zshrc\.d|profile\.d|environment\.d)\/[^/]+$/.test(p)
    || /(?:^|\/)fish\/(?:config\.fish|conf\.d\/[^/]+)$/.test(p)) return 'profile';
  return null;
}

/**
 * 'settings', 'profile' or null for a path, the one function both guards use: its canonical form (canonicalPath), then
 * the file a symbolic link leads to (the path itself, or its folder when the file does not exist yet).
 */
export function environmentFile(path, where = {}) {
  const p = canonicalPath(path, where);
  const byName = environmentFileByName(p);
  if (byName) return byName;
  try { return environmentFileByName(realpathSync(p).replace(/\\/g, '/')); } catch { /* not there: its folder */ }
  try { return environmentFileByName(posix.join(realpathSync(posix.dirname(p)).replace(/\\/g, '/'), posix.basename(p))); } catch { return null; }
}

/** The same files named in a text, read flattened and collapsed (`.ba""shrc`, `.claude/./settings.json`), case ignored. */
const ENVIRONMENT_FILE_IN_TEXT = new RegExp('(?:^|[^\\w.-])(?:' + [...SHELL_PROFILES].map(n => n.replace(/\./g, '\\.')).join('|') +
  '|settings\\.local\\.json|managed-settings\\.json|config\\.fish)(?![\\w.-])|\\.claude/settings[\\w.-]*\\.json|/etc/environment\\b|(?:\\.bashrc\\.d|\\.zshrc\\.d|profile\\.d|environment\\.d|fish/conf\\.d)/', 'i');

function collapsePaths(text) {
  let t = String(text).replace(/\/{2,}/g, '/');
  for (let before = ''; before !== t;) { before = t; t = t.replace(/\/\.(?=\/)/g, '').replace(/[^/\s]+\/\.\.\//g, ''); }
  return t;
}

/**
 * The kinds of environment files a command names: in its text (flattened, collapsed), and each word that looks like a
 * path judged by environmentFile from where the command runs (a link to a profile, a relative path).
 */
export function environmentFilesIn(command, where = {}) {
  const kinds = new Set();
  const flat = flatten(command);
  const collapsed = collapsePaths(flat);
  for (const m of collapsed.matchAll(new RegExp(ENVIRONMENT_FILE_IN_TEXT.source, 'gi'))) kinds.add(/settings|\.json/i.test(m[0]) ? 'settings' : 'profile');
  for (const word of flat.split(/[\s;&|()<>=,`]+/)) {
    if (!word || !/[/~.]/.test(word)) continue;
    const kind = environmentFile(word, where);
    if (kind) kinds.add(kind);
  }
  return kinds;
}

/** Escapes a shell or a JSON file turns into characters (`\x41`, `\101`, `A`), decoded. */
export function decodeEscapes(text) {
  return String(text ?? '').replace(/\\x([0-9a-fA-F]{1,2})|\\u([0-9a-fA-F]{4})|\\U([0-9a-fA-F]{8})|\\0?([0-7]{1,3})/g, (m, x, u, U, o) => {
    try { return String.fromCodePoint(x ? parseInt(x, 16) : u ? parseInt(u, 16) : U ? parseInt(U, 16) : parseInt(o, 8)); } catch { return m; }
  });
}

/** A text with escapes decoded, quotes and backslashes removed, then the formats of printf (`%s`) and every blank. */
const compact = text => flatten(decodeEscapes(text)).replace(/%[-#0 +]*\d*(?:\.\d+)?[a-zA-Z]/g, '').replace(/\s+/g, '');

/**
 * Whether a text names an APV variable, even rebuilt: pieces put side by side (`'AP' 'V_X'`, `AP""V_X`, `A P V_X`) meet
 * again once compacted.
 */
export function namesApvVariable(text) {
  return /APV_/i.test(compact(text));
}

/**
 * Variables that make a program run other code (Node, the dynamic linker, a non-interactive shell): long names, found
 * even rebuilt. ENV and PATH, short, count by their exact name only.
 */
const CODE_VARIABLES = /NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT|BASH_ENV|DYLD_[A-Z_]+/i;
const CODE_VARIABLE_NAME = /^(?:NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT|BASH_ENV|DYLD_[A-Z_]+|ENV)$/i;

/** Whether a text names a variable that makes a program run other code, even rebuilt. */
export function namesCodeVariable(text) {
  return CODE_VARIABLES.test(compact(text));
}

/**
 * What settings of Claude Code hold that a guard watches, one entry per value: an APV variable, a variable that runs
 * code or PATH in `env`; `disableAllHooks` set; the plugin apv not enabled in `enabledPlugins`. A text that is not JSON
 * (Claude Code would not read it), by the names it holds.
 */
export function settingsGuarded(text) {
  const out = new Set();
  let value;
  try { value = JSON.parse(String(text ?? '')); } catch {
    const words = compact(text).match(/APV_\w*|NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT|BASH_ENV|DYLD_\w*|disableAllHooks|enabledPlugins|"(?:PATH|ENV)"/gi) ?? [];
    for (const w of words) out.add(`texte:${w.toUpperCase()}`);
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  const env = value.env;
  if (env && typeof env === 'object') {
    for (const [key, v] of Object.entries(env)) {
      if (namesApvVariable(key) || CODE_VARIABLE_NAME.test(key) || /^PATH$/i.test(key)) out.add(`env:${key}=${JSON.stringify(v)}`);
    }
  }
  if (value.disableAllHooks !== undefined && value.disableAllHooks !== false) out.add(`disableAllHooks=${JSON.stringify(value.disableAllHooks)}`);
  const plugins = value.enabledPlugins;
  if (plugins && typeof plugins === 'object') {
    for (const [key, v] of Object.entries(plugins)) if (/^apv(?:@|$)/i.test(key) && v !== true) out.add(`enabledPlugins:${key}=${JSON.stringify(v)}`);
  }
  return out;
}

/** Whether settings once written hold a watched value (settingsGuarded) the settings before did not: an ordinary change passes. */
export function settingsAddGuarded(after, before = '') {
  const had = settingsGuarded(before);
  return [...settingsGuarded(after)].some(entry => !had.has(entry));
}

/** The names a line of shell sets: `NAME=`, `export NAME=`, `setenv NAME`, `set -gx NAME` (fish). */
function namesSet(line) {
  const names = [...line.matchAll(/(?:^|[\s;&|(])([A-Za-z_]\w*)\+?=/g)].map(m => m[1]);
  for (const m of line.matchAll(/(?:^|[\s;&|(])(?:setenv|set\s+-\w*[xgU]\w*)\s+([A-Za-z_]\w*)/g)) names.push(m[1]);
  return names;
}

/**
 * Whether text added to a shell profile sets, or may set, what the guards watch: an APV variable or a variable that runs
 * code (the name literal or rebuilt, or ENV by its exact name), a variable under a computed name (`export "${x}V_X"`,
 * `printf -v`, `declare -n`, ANSI-C quoting `$'…'`), or a text the shell runs without showing it (`eval`, `source`, `.`).
 * PATH is left to the profiles (`export PATH=$PATH:~/bin`), refused only in the settings.
 */
export function profileMaySetGuarded(text) {
  if (namesApvVariable(text) || namesCodeVariable(text)) return true;
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (/(?:^|[;&|(]\s*)(?:eval|source|\.)\s/.test(line)) return true;
    if (/\$'/.test(line) || /\bprintf\s+-v\b|\bdeclare\s+-\w*n|\btypeset\s+-\w*n/.test(line)) return true;
    if (namesSet(flatten(line)).some(n => CODE_VARIABLE_NAME.test(n))) return true;
    // A name set by export, declare, setenv, set -x (fish)... that holds an expansion, a quote or a backslash.
    const setter = /(?:^|[;&|(]\s*)(?:export|declare|typeset|local|readonly|setenv|set\s+-\w*[xgU]\w*|env)\s+((?:-\w+\s+)*)([^\s=]+)/.exec(line);
    if (setter && /[$`\\'"{}]/.test(setter[2])) return true;
  }
  return false;
}

/** Whether a command's text sets a variable that runs code by its exact name (`ENV=`), or names one even rebuilt. */
export function commandSetsCodeVariable(command) {
  return namesCodeVariable(command) || flatten(command).split('\n').some(line => namesSet(line).some(n => CODE_VARIABLE_NAME.test(n)));
}

/** Whether a command's text puts in settings what they must not hold: env, a switched-off hook or plugin, PATH or ENV. */
export function commandTouchesGuardedSettings(command) {
  return /disableAllHooks|enabledPlugins|"?\b(?:PATH|ENV)\b"?\s*:/i.test(flatten(decodeEscapes(command)));
}
