// Harness guards of the Bash PreToolUse hook (APV3 spec, section 18.2): process kills that could reach the session,
// installs through a symlinked node_modules, and docker or supabase commands on a declared test stack without its lock.
// Node built-ins only, like every hook: they run before any install and never need the compiled dist.
// A guard rail against mistakes, not a security boundary: a command that computes its targets is not guessed.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export const HARNESS_REASONS = {
  killall: 'APV : killall et pkill -f sont interdits. Le motif figure aussi dans la ligne de commande du shell qui les lance ' +
    '(et souvent dans celle de la session ou de ses parents), qui est alors tué avec les cibles : le chef de projet a coupé ainsi ' +
    'sa propre session (projet pilote, 28 septembre 2026). À la place : apv procs list, puis apv procs stop --port <p> ou ' +
    '--repo <copie> (jamais la session, ses parents, les outils protégés ni le checkout principal), ou kill <pid> d\'un pid lu dans apv procs list.',
  killSession: (what) => `APV : arrêt refusé : ${what} est la session Claude Code ou l'un de ses parents (ou tout le système). ` +
    'Tuer un parent de la session la coupe, travaux en cours compris (projet pilote, 28 septembre 2026 : le parent d\'une suite ' +
    'était le binaire de l\'extension Claude Code). Pour arrêter des serveurs de test : apv procs list, puis apv procs stop --port <p> ' +
    'ou --repo <copie>, qui ne touche jamais à la session.',
  killPgrep: 'APV : kill alimenté par pgrep -f refusé : pgrep -f trouve aussi le shell qui le lance (son motif est dans sa ligne ' +
    'de commande) et peut désigner la session. À la place : apv procs list, puis apv procs stop --port <p> ou --repo <copie>, ' +
    'ou kill <pid> d\'un pid lu dans apv procs list.',
  install: (dir, target, tool) => `APV : ${tool} refusé dans ${dir} : son node_modules est un lien symbolique vers ${target}. ` +
    "L'installation viderait puis remplirait la cible, partagée avec d'autres copies (projet pilote, 27 septembre 2026 : " +
    'node_modules du dépôt principal vidé par un npm ci lancé dans un worktree). Pour installer dans cette copie : ' +
    `unlink ${join(dir, 'node_modules')} (retire le seul lien, jamais rm -r), puis ${tool} ; sinon, installer dans la copie cible elle-même.`,
  stack: (stack, what) => `APV : ${what} vise la pile de test « ${stack.id} »${stack.dockerProject ? ` (projet Docker ${stack.dockerProject})` : ''} ` +
    'sans tenir son verrou (stacks de .apv/config.json). Une commande Docker ou Supabase hors verrou peut redémarrer la pile sous une ' +
    'suite en cours (projet pilote, 27 septembre 2026). À la place : ' +
    [stack.lockFile ? `flock -w 1800 ${stack.lockFile} <commande>` : '',
      stack.resource ? `apv lock run ${stack.resource} -- <commande>` : '',
      stack.lockCommand ? `${[...Object.entries(stack.env ?? {}).map(([k, v]) => `${k}=${v}`), ...stack.lockCommand].join(' ')} <commande>` : '']
      .filter(Boolean).join(', ou ') + ' ; ou les scripts du projet qui prennent déjà ce verrou.',
};

const isAssignment = word => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
const name = word => basename(word ?? '');

/** Wrappers that run the rest of their arguments as a command, with the options that take a value. */
const WRAPPERS = {
  sudo: new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '-T']),
  doas: new Set(['-u', '-C']),
  env: new Set(['-u', '-C', '-S', '--unset', '--chdir', '--split-string']),
  nohup: new Set(), setsid: new Set(), command: new Set(), exec: new Set(['-a']), time: new Set(['-f', '-o']),
  nice: new Set(['-n', '--adjustment']), ionice: new Set(['-c', '-n', '-p']), stdbuf: new Set(['-i', '-o', '-e']),
  chrt: new Set(), taskset: new Set(), timeout: new Set(['-s', '--signal', '-k', '--kill-after']),
  xargs: new Set(['-n', '-I', '-i', '-P', '-L', '-l', '-d', '-a', '-s', '-E', '-e', '--max-args', '--replace', '--max-procs', '--delimiter', '--arg-file']),
};

/**
 * The command a simple command runs: leading assignments and wrappers (sudo, env, nohup, timeout, xargs...) skipped.
 * Returns the assignments seen before it and the remaining words (the command name first), or null when none.
 */
export function commandWords(words) {
  const assignments = [];
  let i = 0;
  for (;;) {
    while (i < words.length && isAssignment(words[i])) assignments.push(words[i++]);
    if (i >= words.length) return null;
    const wrapper = WRAPPERS[name(words[i])];
    if (!wrapper) return { assignments, words: words.slice(i) };
    const which = name(words[i]);
    i += 1;
    while (i < words.length && words[i].startsWith('-') && words[i] !== '--') i += wrapper.has(words[i]) ? 2 : 1;
    if (words[i] === '--') i += 1;
    // timeout DURATION command; taskset MASK command; chrt PRIORITY command.
    if ((which === 'timeout' || which === 'taskset' || which === 'chrt') && i < words.length) i += 1;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Process kills
// ---------------------------------------------------------------------------------------------------------------

const hasShortFlag = (arg, flag) => /^-[A-Za-z0-9]+$/.test(arg) && !/^-\d+$/.test(arg) && arg.slice(1).includes(flag);

/** Why this kill-like command may reach the session, or null. `ancestors()` lists `{ pid, pgid, comm }`. */
export function killProblem(segments, ancestors) {
  let feedsKill = false;
  let pgrepFull = false;
  let readsPpid = false;
  for (const [index, words] of segments.entries()) {
    const cw = commandWords(words);
    if (!cw) continue;
    const [cmd, ...args] = cw.words;
    const tool = name(cmd);
    if (tool === 'killall') return HARNESS_REASONS.killall;
    if (tool === 'pgrep' && args.some(a => a === '-f' || a === '--full' || hasShortFlag(a, 'f'))) pgrepFull = true;
    if (tool === 'pkill') {
      if (args.some(a => a === '-f' || a === '--full' || hasShortFlag(a, 'f'))) return HARNESS_REASONS.killall;
      const withValue = new Set(['-u', '-U', '-g', '-G', '-P', '-s', '-t', '--signal', '--parent', '--pgroup', '--session', '--terminal', '--euid', '--uid', '--group', '-F', '--pidfile']);
      let pattern = null;
      for (let k = 0; k < args.length; k++) {
        if (withValue.has(args[k])) { k += 1; continue; }
        if (args[k].startsWith('-')) continue;
        pattern = args[k]; break;
      }
      if (pattern !== null) {
        let re = null;
        try { re = new RegExp(pattern); } catch { /* not a regex pkill accepts either */ }
        const hit = re ? ancestors().find(a => a.comm && re.test(a.comm)) : null;
        if (hit) return HARNESS_REASONS.killSession(`pkill ${pattern} désigne ${hit.comm} (pid ${hit.pid})`);
      }
      feedsKill = true;
      continue;
    }
    if (tool !== 'kill') continue;
    // `kill -0 <pid>` (and -s 0, -n 0) only tests that a process exists: never a kill.
    if (args.some((a, k) => a === '-0' || ((a === '-s' || a === '-n' || a === '--signal') && args[k + 1] === '0'))) continue;
    feedsKill = true;
    // A ppid read by the kill itself: in its arguments (a quoted substitution), or by the substitution that
    // follows it (`kill $(ps -o ppid= -p $$)`, split by the tokenizer). A ppid elsewhere (`ps -o pid,ppid`) is data.
    const next = segments[index + 1] ?? [];
    if (args.some(a => /ppid/i.test(a) && a !== '$PPID') || (args.every(a => a.startsWith('-')) && next.some(w => /ppid/i.test(w)))) readsPpid = true;
    const targets = [];
    let endOfOptions = false;
    let signalSeen = false;
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      if (!endOfOptions && a === '--') { endOfOptions = true; continue; }
      if (!endOfOptions && (a === '-l' || a === '-L' || a === '--list' || a === '--table')) { targets.length = 0; break; }
      if (/^\$\{?PPID\}?$/.test(a)) return HARNESS_REASONS.killSession('$PPID (le parent du shell de l\'outil Bash)');
      if (!endOfOptions && !signalSeen && (a === '-s' || a === '-n' || a === '--signal')) { k += 1; signalSeen = true; continue; }
      // The first `-9`, `-TERM`, `-SIGKILL` is the signal; a later `-<n>` is a process group.
      if (!endOfOptions && !signalSeen && targets.length === 0 && /^-[A-Za-z0-9+]+$/.test(a)) { signalSeen = true; continue; }
      targets.push(a);
    }
    for (const t of targets) {
      if (t === '0' || t === '-1' || t === '-0' || t === '1') return HARNESS_REASONS.killSession(`kill ${t} (tout le groupe du shell, ou tous les processus)`);
      if (/^\d+$/.test(t)) {
        const hit = ancestors().find(a => a.pid === Number(t));
        if (hit) return HARNESS_REASONS.killSession(`le pid ${t} (${hit.comm || '?'})`);
      } else if (/^-\d+$/.test(t)) {
        const group = Number(t.slice(1));
        const hit = ancestors().find(a => a.pgid === group);
        if (hit) return HARNESS_REASONS.killSession(`le groupe ${group} (celui de ${hit.comm || '?'}, pid ${hit.pid})`);
      }
    }
  }
  if (feedsKill && pgrepFull) return HARNESS_REASONS.killPgrep;
  if (feedsKill && readsPpid) return HARNESS_REASONS.killSession('un ppid lu dans la même commande');
  return null;
}

/** The session and its parents: the ancestors of this hook process, read from /proc (empty elsewhere). */
export function processAncestors(root = '/proc', start = process.ppid) {
  const out = [];
  let pid = start;
  for (let i = 0; i < 200 && pid > 1; i++) {
    let stat;
    try { stat = readFileSync(join(root, String(pid), 'stat'), 'utf8'); } catch { break; }
    const comm = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'));
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    out.push({ pid, pgid: Number(fields[2]), comm });
    pid = Number(fields[1]);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Installs through a symlinked node_modules
// ---------------------------------------------------------------------------------------------------------------

const NPM_INSTALL = new Set(['ci', 'clean-install', 'ic', 'install-clean', 'isntall-clean', 'install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall',
  'add', 'update', 'up', 'upgrade', 'udpate', 'uninstall', 'unlink', 'remove', 'rm', 'r', 'un', 'dedupe', 'ddp', 'prune', 'install-test', 'it', 'install-ci-test', 'cit', 'rebuild', 'rb']);
const PNPM_INSTALL = new Set(['install', 'i', 'add', 'update', 'up', 'upgrade', 'remove', 'rm', 'uninstall', 'un', 'prune', 'dedupe', 'import', 'rebuild', 'rb', 'link', 'ln', 'unlink', 'install-test', 'it', 'fetch']);
const YARN_INSTALL = new Set(['install', 'add', 'remove', 'upgrade', 'up', 'dedupe', 'import', 'link', 'unlink', 'upgrade-interactive']);
const BUN_INSTALL = new Set(['install', 'i', 'add', 'a', 'remove', 'rm', 'update', 'link', 'unlink']);

/** The install a command runs, with the directory option it names: `{ tool, dir }`, or null. */
export function installCommand(words) {
  const cw = commandWords(words);
  if (!cw) return null;
  const [cmd, ...args] = cw.words;
  const tool = name(cmd);
  const option = (names) => {
    for (let k = 0; k < args.length; k++) {
      for (const n of names) {
        if (args[k] === n) return args[k + 1] ?? null;
        if (args[k].startsWith(`${n}=`)) return args[k].slice(n.length + 1);
      }
    }
    return null;
  };
  const withValue = new Set(['--prefix', '-C', '--dir', '--cwd', '-w', '--workspace', '--filter', '-F', '--registry', '--cache', '--userconfig', '--loglevel']);
  const positionals = [];
  for (let k = 0; k < args.length; k++) {
    if (withValue.has(args[k])) { k += 1; continue; }
    if (args[k].startsWith('-')) continue;
    positionals.push(args[k]);
  }
  const sub = positionals[0];
  if (tool === 'npm' && sub && NPM_INSTALL.has(sub)) return { tool: `npm ${sub}`, dir: option(['--prefix', '-C']) };
  if (tool === 'pnpm' && sub && PNPM_INSTALL.has(sub)) return { tool: `pnpm ${sub}`, dir: option(['-C', '--dir']) };
  if (tool === 'yarn' && (sub === undefined || YARN_INSTALL.has(sub))) return { tool: sub ? `yarn ${sub}` : 'yarn', dir: option(['--cwd']) };
  if (tool === 'bun' && sub && BUN_INSTALL.has(sub)) return { tool: `bun ${sub}`, dir: option(['--cwd']) };
  return null;
}

/** The directory a `cd` or `pushd` moves to, relative to `cwd`; null when it cannot be known without a shell. */
export function cdTarget(words, cwd, home) {
  const cw = commandWords(words);
  if (!cw || !['cd', 'pushd'].includes(name(cw.words[0]))) return undefined;
  const arg = cw.words.slice(1).find(a => !a.startsWith('-') || a === '-');
  if (arg === undefined) return home ?? null;
  if (arg === '-' || /[$`*?]/.test(arg)) return null;
  const expanded = arg === '~' ? home : arg.startsWith('~/') ? (home ? join(home, arg.slice(2)) : null) : arg;
  if (expanded === null || expanded === undefined) return null;
  if (cwd === null && !isAbsolute(expanded)) return null;
  return resolve(cwd ?? '/', expanded);
}

/**
 * The project directory an install in `dir` writes to (the nearest one with a package.json, else `dir`) when its
 * node_modules is a symbolic link: `{ dir, target }`; null otherwise.
 */
export function linkedNodeModules(dir) {
  let current = resolve(dir);
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(current, 'package.json')) || i === 0) {
      const modules = join(current, 'node_modules');
      try {
        if (lstatSync(modules).isSymbolicLink()) {
          let target;
          try { target = readlinkSync(modules); } catch { target = '?'; }
          return { dir: current, target };
        }
      } catch { /* no node_modules here */ }
      if (existsSync(join(current, 'package.json'))) return null;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

/** Why an install of this command writes through a symlinked node_modules, or null. */
export function installProblem(segments, cwd, home) {
  let dir = cwd ?? null;
  for (const words of segments) {
    const moved = cdTarget(words, dir, home);
    if (moved !== undefined) { dir = moved; continue; }
    const install = installCommand(words);
    if (!install) continue;
    const where = install.dir !== null ? (isAbsolute(install.dir) ? install.dir : dir !== null ? resolve(dir, install.dir) : null) : dir;
    if (where === null || /[$`]/.test(where)) continue;
    const linked = linkedNodeModules(where);
    if (linked) return HARNESS_REASONS.install(linked.dir, linked.target, install.tool);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Test stacks
// ---------------------------------------------------------------------------------------------------------------

const DOCKER_READ = new Set(['ps', 'logs', 'inspect', 'stats', 'top', 'port', 'images', 'version', 'info', 'events', 'diff', 'history', 'search', 'login', 'logout', 'help', '--help', '-h', '--version', '-v']);
const DOCKER_OBJECT_READ = new Set(['ls', 'list', 'ps', 'inspect', 'logs', 'top', 'port', 'stats', 'diff', 'history', 'df', 'events', 'info']);
const COMPOSE_READ = new Set(['ps', 'logs', 'config', 'ls', 'top', 'images', 'version', 'port', 'events']);
const DOCKER_GLOBAL_VALUE = new Set(['--context', '-c', '-H', '--host', '--config', '-l', '--log-level', '--tlscacert', '--tlscert', '--tlskey']);
const COMPOSE_VALUE = new Set(['-p', '--project-name', '-f', '--file', '--env-file', '--profile', '--project-directory', '--ansi', '--parallel', '--progress']);
const MASS = new Set(['stop', 'kill', 'rm', 'restart', 'pause', 'unpause', 'start', 'update', 'wait']);

/** True when `word` designates the Docker project `project` (a name `<prefix>_<project>`, the project itself, a label value). */
export function namesProject(word, project) {
  if (!project) return false;
  return word.split(/[=,:\s]/).some(part => part === project || part.endsWith(`_${project}`) || part.endsWith(`/${project}`));
}

/**
 * The stacks a docker command changes: `{ what, stacks }` where `stacks` is the list of targeted stack ids (every
 * stack when the targets cannot be read), or null when it only reads or targets no declared stack.
 */
export function dockerTargets(words, stacks) {
  const cw = commandWords(words);
  if (!cw || !['docker', 'podman'].includes(name(cw.words[0]))) return null;
  const args = cw.words.slice(1);
  let k = 0;
  while (k < args.length && args[k].startsWith('-')) k += DOCKER_GLOBAL_VALUE.has(args[k]) ? 2 : 1;
  const sub = args[k];
  if (sub === undefined || DOCKER_READ.has(sub)) return null;
  let rest = args.slice(k + 1);
  let action = sub;
  if (sub === 'compose') {
    let j = 0;
    const named = [];
    while (j < rest.length && rest[j].startsWith('-')) {
      if (COMPOSE_VALUE.has(rest[j])) { named.push(rest[j + 1] ?? ''); j += 2; } else j += 1;
    }
    action = rest[j];
    if (action === undefined || COMPOSE_READ.has(action)) return null;
    rest = [...named, ...rest.slice(j + 1)];
  } else if (['container', 'volume', 'network', 'system', 'image', 'builder', 'buildx'].includes(sub)) {
    action = rest[0];
    if (action === undefined || DOCKER_OBJECT_READ.has(action)) return null;
    rest = rest.slice(1);
  }
  const what = `docker ${sub}${sub !== action && action ? ` ${action}` : ''}`;
  const hits = stacks.filter(s => s.dockerProject && rest.some(w => namesProject(w, s.dockerProject)));
  if (hits.length) return { what, stacks: hits.map(s => s.id) };
  if (action === 'prune') return { what, stacks: stacks.filter(s => s.dockerProject).map(s => s.id) };
  const literal = rest.filter(w => !w.startsWith('-'));
  // `docker stop $(docker ps -q)`: the targets are computed, possibly every stack.
  if (MASS.has(action) && (literal.length === 0 || literal.some(w => /[$`]/.test(w)))) return { what, stacks: stacks.filter(s => s.dockerProject).map(s => s.id) };
  return null;
}

const SUPABASE_LAUNCHERS = new Set(['npx', 'bunx', 'pnpx']);
const SUPABASE_GLOBAL_VALUE = new Set(['--workdir', '--profile', '--network-id', '-o', '--output', '--dns-resolver']);

/** The local stack change a supabase command makes: `{ what, workdir, projectEnv }`, or null (read only, remote). */
export function supabaseCommand(words) {
  const cw = commandWords(words);
  if (!cw) return null;
  let rest = cw.words;
  const first = name(rest[0]);
  if (SUPABASE_LAUNCHERS.has(first) || ((first === 'pnpm' || first === 'yarn') && rest[1] === 'dlx') || (first === 'npm' && rest[1] === 'exec')) {
    let j = first === 'pnpm' || first === 'yarn' || first === 'npm' ? 2 : 1;
    while (j < rest.length && rest[j].startsWith('-') && rest[j] !== '--') j += ['-p', '--package'].includes(rest[j]) ? 2 : 1;
    if (rest[j] === '--') j += 1;
    rest = rest.slice(j);
  }
  if (!/^supabase(@[\w.^~-]+)?$/.test(name(rest[0]))) return null;
  const args = rest.slice(1);
  let workdir = null;
  const positionals = [];
  for (let k = 0; k < args.length; k++) {
    if (args[k] === '--workdir') { workdir = args[k + 1] ?? null; k += 1; continue; }
    if (args[k].startsWith('--workdir=')) { workdir = args[k].slice('--workdir='.length); continue; }
    if (SUPABASE_GLOBAL_VALUE.has(args[k])) { k += 1; continue; }
    if (args[k].startsWith('-')) continue;
    positionals.push(args[k]);
  }
  const [a, b] = positionals;
  const local = args.includes('--local') || !args.some(x => x === '--linked' || x.startsWith('--db-url') || x.startsWith('--project-ref'));
  // `db reset --linked` (or --db-url) resets a remote database, never a local stack.
  const mutating = a === 'start' || a === 'stop' || (a === 'seed' && local) ||
    (a === 'db' && (b === 'start' || (['reset', 'diff', 'push'].includes(b) && local))) ||
    (a === 'migration' && ['up', 'down'].includes(b) && local) || (a === 'test' && b === 'db');
  if (!mutating) return null;
  const projectEnv = [...cw.assignments, ...words.filter(isAssignment)].find(w => w.startsWith('SUPABASE_PROJECT_ID='))?.slice('SUPABASE_PROJECT_ID='.length) ?? null;
  return { what: `supabase ${[a, b].filter(Boolean).join(' ')}`, workdir, projectEnv };
}

/** `project_id` of `<dir>/supabase/config.toml`, looking up from `dir` (the way the CLI finds its project); null when none. */
export function supabaseProjectId(dir) {
  let current = resolve(dir);
  for (let i = 0; i < 32; i++) {
    const file = join(current, 'supabase', 'config.toml');
    if (existsSync(file)) {
      try { return /^\s*project_id\s*=\s*"([^"]+)"/m.exec(readFileSync(file, 'utf8'))?.[1] ?? null; } catch { return null; }
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

/**
 * The lock wrapper a simple command starts with, and the command it runs: `flock [options] <file> <command...>`,
 * `apv lock run <resource> [options] -- <command...>` (also `node …/cli.js lock run`), or the `lockCommand` of a
 * stack. Returns `{ held: { files, resources, stacks }, words }`: the locks taken and the remaining words.
 */
export function lockWrapper(words, stacks, cwd) {
  const held = { files: [], resources: [], stacks: [] };
  const cw = commandWords(words);
  if (!cw) return { held, words };
  const w = cw.words;
  const tool = name(w[0]);
  if (tool === 'flock') {
    const withValue = new Set(['-w', '--wait', '--timeout', '-E', '--conflict-exit-code']);
    let k = 1;
    while (k < w.length && w[k].startsWith('-')) k += withValue.has(w[k]) ? 2 : 1;
    const file = w[k];
    if (file !== undefined && !/[$`]/.test(file)) held.files.push(resolve(cwd ?? '/', file));
    return { held, words: w.slice(k + 1) };
  }
  const apvAt = w.findIndex((x, k) => (name(x) === 'apv' && k === 0) || (name(x) === 'cli.js' && k > 0));
  if (apvAt !== -1 && w[apvAt + 1] === 'lock' && w[apvAt + 2] === 'run' && w[apvAt + 3]) {
    held.resources.push(w[apvAt + 3]);
    const dash = w.indexOf('--', apvAt + 4);
    return { held, words: dash === -1 ? [] : w.slice(dash + 1) };
  }
  // The lock command of a stack takes the lock of the stack its variables select: the command it runs is examined
  // either way, and holds the lock only of the stack whose variables are set in front of it.
  let wrapped = null;
  for (const stack of stacks) {
    const prefix = stack.lockCommand;
    if (!prefix || prefix.length === 0 || w.length < prefix.length) continue;
    if (!prefix.every((p, k) => w[k] === p || (k === 0 && name(w[k]) === name(p)))) continue;
    wrapped ??= w.slice(prefix.length);
    const env = Object.entries(stack.env ?? {});
    const assigned = new Set(cw.assignments);
    if (env.length && !env.every(([key, value]) => assigned.has(`${key}=${value}`))) continue;
    held.stacks.push(stack.id);
  }
  return { held, words: wrapped ?? words };
}

/** Merges the locks taken by a wrapper into those already held. */
export function mergeHeld(a, b) {
  return { files: [...a.files, ...b.files], resources: [...a.resources, ...b.resources], stacks: [...a.stacks, ...b.stacks] };
}

const samePath = (a, b) => {
  if (a === b) return true;
  try { return realpathSync(a) === realpathSync(b); } catch { return false; }
};

/** Whether the locks held (by wrappers, by an ancestor, by `APV_LOCK_HELD`) include the lock of `stack`. */
export function holdsStack(stack, held, context) {
  if (held.stacks.includes(stack.id)) return true;
  if (stack.lockFile && (held.files.some(f => samePath(f, stack.lockFile)) || context.flockHeldByAncestor(stack.lockFile))) return true;
  if (stack.resource && (held.resources.includes(stack.resource) || context.leaseHeld().includes(stack.resource))) return true;
  return false;
}

/** Why a docker or supabase command of these words changes a declared stack without its lock, or null. */
export function stackProblem(words, held, context, cwd) {
  const stacks = context.stacks();
  if (!stacks.length) return null;
  const docker = dockerTargets(words, stacks);
  if (docker) {
    for (const id of docker.stacks) {
      const stack = stacks.find(s => s.id === id);
      if (!holdsStack(stack, held, context)) return HARNESS_REASONS.stack(stack, docker.what);
    }
    return null;
  }
  const supabase = supabaseCommand(words);
  if (!supabase) return null;
  let project = supabase.projectEnv;
  if (project === null) {
    const dir = supabase.workdir !== null ? (isAbsolute(supabase.workdir) ? supabase.workdir : cwd !== null ? resolve(cwd, supabase.workdir) : null) : cwd;
    if (dir === null || /[$`]/.test(dir)) return null;
    project = supabaseProjectId(dir);
  }
  const stack = project === null ? null : stacks.find(s => s.dockerProject === project);
  if (!stack || holdsStack(stack, held, context)) return null;
  return HARNESS_REASONS.stack(stack, supabase.what);
}

// ---------------------------------------------------------------------------------------------------------------
// Real context of the hook
// ---------------------------------------------------------------------------------------------------------------

const STACK_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const strings = (v) => Array.isArray(v) && v.length > 0 && v.every(x => typeof x === 'string' && x.length > 0) ? v : null;

/**
 * The stacks declared in `<root>/.apv/config.json`, resolved: lock files made absolute (relative to the Git common
 * directory, like `lock.file` of a check). Invalid entries are skipped: the hook never blocks on its own misreading.
 */
export function readStacks(root, commonDir) {
  let raw;
  try { raw = JSON.parse(readFileSync(join(root, '.apv', 'config.json'), 'utf8')); } catch { return []; }
  if (!raw || !Array.isArray(raw.stacks)) return [];
  const out = [];
  for (const s of raw.stacks) {
    if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !STACK_ID.test(s.id)) continue;
    const lockFile = typeof s.lockFile === 'string' && s.lockFile ? (isAbsolute(s.lockFile) ? s.lockFile : commonDir ? resolve(commonDir, s.lockFile) : null) : null;
    const resource = typeof s.resource === 'string' && s.resource ? s.resource : null;
    if (!lockFile && !resource) continue;
    const env = s.env && typeof s.env === 'object' && !Array.isArray(s.env) ? Object.fromEntries(Object.entries(s.env).filter(([, v]) => typeof v === 'string')) : {};
    out.push({ id: s.id, lockFile, resource, dockerProject: typeof s.dockerProject === 'string' && s.dockerProject ? s.dockerProject : null,
      lockCommand: strings(s.lockCommand), env });
  }
  return out;
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** True when a flock on `file` is held by one of `ancestors` (read from `/proc/locks`). */
export function flockHeldBy(file, ancestors, locksPath = '/proc/locks') {
  let locks; let inode;
  try { locks = readFileSync(locksPath, 'utf8'); inode = statSync(file).ino; } catch { return false; }
  const pids = new Set(ancestors.map(a => a.pid));
  for (const line of locks.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields[1] !== 'FLOCK' || fields[3] !== 'WRITE') continue;
    if (Number(fields[5]?.split(':')[2]) === inode && pids.has(Number(fields[4]))) return true;
  }
  return false;
}

/** The context of the real hook: lazy, each part read once and only when a rule needs it. */
export function hookContext(input, env = process.env) {
  const cwd = typeof input?.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  let ancestors = null; let stacks = null;
  const context = {
    cwd,
    home: env.HOME ?? null,
    ancestors: () => (ancestors ??= processAncestors()),
    stacks: () => {
      if (stacks) return stacks;
      const root = git(cwd, ['rev-parse', '--show-toplevel']) ?? (typeof env.CLAUDE_PROJECT_DIR === 'string' ? env.CLAUDE_PROJECT_DIR : null);
      if (!root) return (stacks = []);
      const common = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
      return (stacks = readStacks(root, common));
    },
    flockHeldByAncestor: file => flockHeldBy(file, context.ancestors()),
    leaseHeld: () => (env.APV_LOCK_HELD ?? '').split(',').map(x => x.trim()).filter(Boolean),
  };
  return context;
}

/** A context where nothing is known: no ancestors, no stacks, no directory (the pure calls of the tests). */
export const EMPTY_CONTEXT = { cwd: null, home: null, ancestors: () => [], stacks: () => [], flockHeldByAncestor: () => false, leaseHeld: () => [] };
