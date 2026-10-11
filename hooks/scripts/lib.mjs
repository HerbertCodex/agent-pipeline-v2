// Shared helpers for the APV plugin hooks. Node built-ins only: hooks run
// before any dependency install and must never fail because of a package.
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
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
 * 'settings', 'profile' or null for a path, the one function both guards use: its canonical form (canonicalPath), the
 * file a symbolic link leads to (the path itself, or its folder when the file does not exist yet), and a hard link to one
 * of the files the session loads (`where.places`, knownEnvironmentFiles: same device and inode).
 */
export function environmentFile(path, where = {}) {
  const p = canonicalPath(path, where);
  const byName = environmentFileByName(p);
  if (byName) return byName;
  try {
    const st = lstatSync(p);
    if (st.isFile() && st.nlink > 1) {
      for (const place of where.places ?? []) {
        try { const o = statSync(place.path); if (o.dev === st.dev && o.ino === st.ino) return place.kind; } catch { /* absent */ }
      }
    }
  } catch { /* not there */ }
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
/**
 * Names refused in the env block of the settings: the variables of the tool, those that run code, and those the hooks or
 * git read to decide (PATH, HOME, the folders of Claude Code and of the project, git's own, the configuration folder, zsh's).
 * A list of refusals, not of permissions: Claude Code documents many variables of its own, and the operator his.
 */
const SETTINGS_ENV_REFUSED = /^(?:APV_\w*|GIT_\w*|LD_\w*|DYLD_\w*|NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|ZDOTDIR|PATH|HOME|XDG_CONFIG_HOME|CLAUDE_PROJECT_DIR|CLAUDE_PLUGIN_ROOT|CLAUDE_CONFIG_DIR)$/i;

/**
 * Settings read as Claude Code may read them: JSON, or JSON with comments and trailing commas (JSONC); null when neither.
 */
export function parseSettings(text) {
  const raw = String(text ?? '');
  try { return JSON.parse(raw); } catch { /* JSONC? */ }
  let out = '';
  for (let k = 0; k < raw.length; k += 1) {
    const c = raw[k];
    if (c === '"') {
      let e = k + 1;
      while (e < raw.length && raw[e] !== '"') e += raw[e] === '\\' ? 2 : 1;
      out += raw.slice(k, e + 1); k = e; continue;
    }
    if (c === '/' && raw[k + 1] === '/') { while (k < raw.length && raw[k] !== '\n') k += 1; out += '\n'; continue; }
    if (c === '/' && raw[k + 1] === '*') { const end = raw.indexOf('*/', k + 2); if (end < 0) return null; k = end + 1; continue; }
    out += c;
  }
  try { return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')); } catch { return null; }
}

/** What settings hold that the guards refuse, one entry per key with its value: `env.<NAME>`, `disableAllHooks`, `enabledPlugins.<apv>`. */
function refusedSettings(value) {
  const out = [];
  if (!value || typeof value !== 'object') return out;
  const env = value.env;
  if (env && typeof env === 'object') {
    for (const [key, v] of Object.entries(env)) if (SETTINGS_ENV_REFUSED.test(key) || namesApvVariable(key) || CODE_VARIABLE_NAME.test(key)) out.push([`env.${key}`, v]);
  }
  if (value.disableAllHooks !== undefined && value.disableAllHooks !== false) out.push(['disableAllHooks', value.disableAllHooks]);
  const plugins = value.enabledPlugins;
  if (plugins && typeof plugins === 'object') for (const [key, v] of Object.entries(plugins)) if (/^apv(?:@|$)/i.test(key) && v !== true) out.push([`enabledPlugins.${key}`, v]);
  return out;
}

/** Whether a text names a variable that makes a program run other code, even rebuilt. */
export function namesCodeVariable(text) {
  return CODE_VARIABLES.test(compact(text));
}

/**
 * What settings of Claude Code hold that a guard watches, one entry per value (refusedSettings). A text that is neither
 * JSON nor JSONC (Claude Code would not read it), by the names it holds.
 */
export function settingsGuarded(text) {
  const out = new Set();
  const value = parseSettings(text);
  if (value === null) {
    const words = compact(text).match(/APV_\w*|GIT_\w*|NODE_OPTIONS|NODE_PATH|LD_\w*|DYLD_\w*|BASH_ENV|disableAllHooks|enabledPlugins|"(?:PATH|ENV|HOME|ZDOTDIR|XDG_CONFIG_HOME|CLAUDE_\w+)"/gi) ?? [];
    for (const w of words) out.add(`texte:${w.toUpperCase()}`);
    return out;
  }
  for (const [key, v] of refusedSettings(value)) out.add(`${key}=${JSON.stringify(v)}`);
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
  return /disableAllHooks|enabledPlugins|"?\b(?:PATH|ENV|HOME|ZDOTDIR|XDG_CONFIG_HOME|CLAUDE_\w+|GIT_\w+)\b"?\s*:/i.test(flatten(decodeEscapes(command)));
}

/** The profiles of the shells the session may load at its start, under the home of the account. */
const LOADED_PROFILES = ['.bashrc', '.profile', '.bash_profile', '.bash_login', '.bash_aliases', '.zshrc', '.zshenv', '.zprofile'];
/** Settings Claude Code manages for the whole machine. */
const MANAGED_SETTINGS = ['/etc/claude-code/managed-settings.json', '/Library/Application Support/ClaudeCode/managed-settings.json'];

/**
 * The files that set the environment of the session at its start: the settings of the account, of each project folder
 * (the folder of the session and its parents, the project folder Claude Code gives), the managed settings, the profiles.
 */
export function knownEnvironmentFiles({ home, projectDirs = [] }) {
  const settings = [...MANAGED_SETTINGS];
  const dirs = new Set();
  for (const start of [home, ...projectDirs]) {
    if (typeof start !== 'string' || !start) continue;
    for (let dir = posix.normalize(start.replace(/\\/g, '/')); ; dir = posix.dirname(dir)) {
      dirs.add(dir);
      if (dir === '/' || dir === '.' || posix.dirname(dir) === dir) break;
    }
  }
  for (const dir of dirs) settings.push(posix.join(dir, '.claude', 'settings.json'), posix.join(dir, '.claude', 'settings.local.json'));
  return [...new Set(settings)].map(path => ({ path, kind: 'settings' }))
    .concat(home ? LOADED_PROFILES.map(name => ({ path: posix.join(home, name), kind: 'profile' })) : []);
}

/** The folders of the project of a hook call: its working folder, and the project folder Claude Code gives. */
export function projectDirsOf(input, env = process.env) {
  return [typeof input?.cwd === 'string' ? input.cwd : null, typeof env.CLAUDE_PROJECT_DIR === 'string' ? env.CLAUDE_PROJECT_DIR : null, process.cwd()].filter(Boolean);
}

/** The names a profile sets that the guards refuse: an APV variable or a variable that runs code (comments skipped). */
function refusedInProfile(text) {
  const out = [];
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    for (const name of namesSet(flatten(line))) if (/^APV_/i.test(name) || CODE_VARIABLE_NAME.test(name)) out.push(name);
  }
  return out;
}

/**
 * What the files the session loads hold that the guards refuse, read from the files themselves whatever wrote them (a
 * cd, a computed path, a hard link, an interpreter): one line « <file> : <key> » per finding, empty when none. Settings
 * that are neither JSON nor JSONC are refused as unreadable. Nothing is repaired: the operator removes the line himself.
 */
export function environmentIntegrity({ home, projectDirs = [] }) {
  const problems = [];
  for (const { path, kind } of knownEnvironmentFiles({ home, projectDirs })) {
    let text;
    try { text = readFileSync(path, 'utf8'); } catch { continue; }
    if (kind === 'settings') {
      const value = parseSettings(text);
      if (value === null) { problems.push(`${path} : réglages illisibles (ni JSON ni JSONC)`); continue; }
      for (const [key] of refusedSettings(value)) problems.push(`${path} : ${key}`);
    } else {
      for (const name of refusedInProfile(text)) problems.push(`${path} : ${name}`);
    }
  }
  return [...new Set(problems)];
}

/** The refusal of a tool call while the files the session loads hold what the guards refuse. */
export function integrityReason(problems) {
  return `APV : outil refusé. Les fichiers que la session charge au lancement contiennent ce que les garde-fous interdisent : ${problems.slice(0, 10).join(' ; ')}${problems.length > 10 ? ' ; ...' : ''}. `
    + "Ces valeurs lèveraient ou contourneraient un garde-fou (fusion, déploiement, crochets) sans commande. L'opérateur retire lui-même ces lignes, dans son terminal, "
    + 'puis relance la session si une variable a déjà été chargée ; rien n\'est réparé automatiquement. Docs : docs/REGLES.md, « Ancrage ».';
}
