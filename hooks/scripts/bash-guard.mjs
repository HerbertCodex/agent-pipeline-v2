#!/usr/bin/env node
// PreToolUse guard for the Bash tool (APV3 spec, sections 11 and 18.2).
// Blocks force-pushes, merges outside apv stack merge (gh pr merge and gh api …/merge always; apv stack merge without its
// explicit authorisation, or inside a subagent) and production deploys without their explicit authorisation, commands that write to GitHub while hiding their output (incident 30),
// and the harness mistakes of section 18.2 (harness-guard.mjs): kills that may reach the session, installs
// through a symlinked node_modules, docker or supabase commands on a declared test stack without its lock.
// This is a guard rail against mistakes, not a security boundary: a determined command can
// always be written in a shape this parser does not recognise.
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMAIN_REVIEWERS, agentName, flatten, isMainModule, namesAnchor, readHookInput } from './lib.mjs';
import { EMPTY_CONTEXT, HARNESS_REASONS, commandWords, hookContext, installProblem, killProblem, lockWrapper, mergeHeld, remoteWriteProblem, stackProblem } from './harness-guard.mjs';

export { HARNESS_REASONS };

const OPERATORS = ['&&', '||', ';;', '$(', ';', '|', '&', '(', ')', '`', '\n'];

/** Parses a heredoc operator at `i` (pointing at `<<`); returns its delimiter and the index after it. */
function readHeredoc(s, i) {
  let j = i + 2;
  const stripTabs = s[j] === '-';
  if (stripTabs) j += 1;
  while (s[j] === ' ' || s[j] === '\t') j += 1;
  const match = /^(['"]?)([^\s'";&|<>()]+)\1/.exec(s.slice(j));
  if (!match) return { heredoc: null, next: j };
  return { heredoc: { delimiter: match[2], stripTabs }, next: j + match[0].length };
}

/** Skips the heredoc bodies that start at `i` (just after a newline); returns the index after them. */
function skipHeredocBodies(s, i, pending) {
  while (pending.length && i < s.length) {
    const end = s.indexOf('\n', i);
    const line = s.slice(i, end === -1 ? s.length : end);
    i = end === -1 ? s.length : end + 1;
    const { delimiter, stripTabs } = pending[0];
    if ((stripTabs ? line.replace(/^\t+/, '') : line) === delimiter) pending.shift();
  }
  return i;
}

/**
 * Returns the index just after the `)` closing a command substitution whose content starts at `i`.
 * Used for substitutions inside double quotes, such as a pull request body written with
 * `--body "$(cat <<'EOF' ... EOF)"`: their text is data for this guard, not a command to inspect.
 */
function skipSubstitution(s, i) {
  let depth = 1;
  const pending = [];
  while (i < s.length) {
    const c = s[i];
    if (c === '\n' && pending.length) { i = skipHeredocBodies(s, i + 1, pending); continue; }
    if (c === '\\') { i += 2; continue; }
    if (c === "'") { const end = s.indexOf("'", i + 1); i = end === -1 ? s.length : end + 1; continue; }
    if (c === '"') {
      i += 1;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\') i += 2;
        else if (s.startsWith('$(', i)) i = skipSubstitution(s, i + 2);
        else i += 1;
      }
      i += 1;
      continue;
    }
    if (s.startsWith('<<', i) && !s.startsWith('<<<', i)) {
      const { heredoc, next } = readHeredoc(s, i);
      if (heredoc) pending.push(heredoc);
      i = next;
      continue;
    }
    if (s.startsWith('$(', i)) { depth += 1; i += 2; continue; }
    if (c === '(') depth += 1;
    if (c === ')') { depth -= 1; if (depth === 0) return i + 1; }
    i += 1;
  }
  return s.length;
}

/**
 * Splits a shell command into simple commands (arrays of words) with quotes removed, and
 * returns a "shadow" copy where quoted text and heredoc bodies are blanked out, so that
 * redirections can be searched without matching text inside strings.
 */
export function tokenize(command) {
  const segments = [];
  let words = [];
  let word = '';
  let inWord = false;
  let shadow = '';
  const pending = [];
  /** Index of the simple command each heredoc feeds (its body is that command's standard input). */
  const heredocOwners = [];
  const flushWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const flushSegment = () => {
    flushWord();
    if (words.length) segments.push(words);
    words = [];
  };
  const blank = (from, to) => { shadow += command.slice(from, to).replace(/[^\n]/g, ' '); };
  let i = 0;
  while (i < command.length) {
    const c = command[i];
    if (c === '\n' && pending.length) {
      // Heredoc bodies are data, not commands.
      flushSegment();
      const next = skipHeredocBodies(command, i + 1, pending);
      shadow += '\n';
      blank(i + 1, next);
      i = next;
      continue;
    }
    if (c === '\\' && i + 1 < command.length) {
      word += command[i + 1];
      inWord = true;
      blank(i, i + 2);
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      const stop = end === -1 ? command.length : end;
      word += command.slice(i + 1, stop);
      inWord = true;
      blank(i, stop + 1);
      i = stop + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < command.length && command[j] !== '"') {
        if (command[j] === '\\' && j + 1 < command.length && '"\\$`'.includes(command[j + 1])) {
          word += command[j + 1];
          j += 2;
        } else if (command.startsWith('$(', j)) {
          const next = skipSubstitution(command, j + 2);
          word += command.slice(j, next);
          j = next;
        } else {
          word += command[j];
          j += 1;
        }
      }
      inWord = true;
      blank(i, Math.min(j + 1, command.length));
      i = j + 1;
      continue;
    }
    if (c === '#' && !inWord) {
      const end = command.indexOf('\n', i);
      const stop = end === -1 ? command.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (command.startsWith('<<', i) && !command.startsWith('<<<', i)) {
      flushWord();
      const { heredoc, next } = readHeredoc(command, i);
      if (heredoc) { pending.push(heredoc); heredocOwners.push(segments.length); }
      shadow += command.slice(i, next);
      i = next;
      continue;
    }
    const operator = OPERATORS.find(op => command.startsWith(op, i));
    if (operator) {
      flushSegment();
      shadow += operator;
      i += operator.length;
      continue;
    }
    if (c === ' ' || c === '\t') {
      flushWord();
      shadow += c;
      i += 1;
      continue;
    }
    word += c;
    inWord = true;
    shadow += c;
    i += 1;
  }
  flushSegment();
  return { segments, shadow, heredocOwners };
}

/**
 * Commands whose standard input is data, never run: a heredoc they read is text (a PR body, a commit message, a file
 * written by cat or tee). Any other command reading a heredoc (sh, bash, node, python, patch, psql...) may run it.
 */
const DATA_SINKS = new Set(['cat', 'tee', 'gh', 'git', 'wc', 'head', 'tail', 'sort', 'uniq', 'grep', 'rg', 'jq', 'column', 'fmt', 'fold', 'less', 'more', 'echo', 'printf']);
/** Options whose value is a message, never a path: `git commit -m`, `gh pr create --body`. */
const MESSAGE_OPTIONS = { git: ['-m', '--message'], gh: ['--body', '-b', '--title', '-t', '--notes'] };

/** The command substitutions inside a word (`$(…)` and backquotes): commands the shell runs, even inside a message. */
export function substitutions(word) {
  const out = [];
  for (let i = 0; i < word.length; i += 1) {
    if (word.startsWith('$(', i)) { const end = skipSubstitution(word, i + 2); out.push(word.slice(i + 2, Math.max(i + 2, end - 1))); i = end - 1; continue; }
    if (word[i] === '`') { const end = word.indexOf('`', i + 1); out.push(word.slice(i + 1, end === -1 ? word.length : end)); i = end === -1 ? word.length : end; }
  }
  return out;
}

/**
 * Whether a command names a store of the anchor or its key in what it runs or touches: its words, its redirections,
 * the substitutions it runs, the heredocs a command runs. Text that is only data is left out: the value of a message
 * option (`git commit -m "…apv/reviews…"`, `gh pr create --body "$(cat <<'EOF' … EOF)"`, whose substitutions are read
 * as commands) and the body of a heredoc read by a data command (`cat <<EOF`). Any doubt reads the whole command.
 */
export function anchorInCommand(command, depth = 0) {
  if (typeof command !== 'string' || !namesAnchor(command)) return false;
  if (depth > MAX_NESTING) return true;
  const { segments, heredocOwners } = tokenize(command);
  const lead = words => basename(commandWords(words)?.words[0] ?? words[0] ?? '');
  if (heredocOwners.some(i => !DATA_SINKS.has(lead(segments[i] ?? [])))) return true;
  const kept = [];
  for (const words of segments) {
    const options = MESSAGE_OPTIONS[lead(words)] ?? [];
    for (let k = 0; k < words.length; k += 1) {
      const word = words[k];
      const attached = options.map(o => o.startsWith('--') ? `${o}=` : o).find(o => word.startsWith(o) && word.length > o.length && (o.endsWith('=') || o.length === 2));
      const value = k > 0 && options.includes(words[k - 1]) ? word : attached ? word.slice(attached.length) : null;
      if (value === null) { kept.push(word); continue; }
      if (attached) kept.push(attached);
      for (const sub of substitutions(value)) if (anchorInCommand(sub, depth + 1)) return true;
    }
  }
  return namesAnchor(kept.join(' '));
}

const isAssignment = word => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
const commandIndex = (words, name) => words.findIndex(w => basename(w) === name);
const positional = args => args.filter(a => !a.startsWith('-'));

/** True when the words of one simple command form a force-push. */
export function isForcePush(words) {
  const at = commandIndex(words, 'git');
  if (at === -1) return false;
  let i = at + 1;
  const withValue = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);
  while (i < words.length && words[i].startsWith('-')) i += withValue.has(words[i]) ? 2 : 1;
  if (words[i] !== 'push') return false;
  return words.slice(i + 1).some(arg =>
    arg === '--force' || arg === '--force-if-includes' || arg.startsWith('--force-with-lease') ||
    /^-[A-Za-z]*f[A-Za-z]*$/.test(arg) || (arg.startsWith('+') && arg.length > 1));
}

const GIT_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);

/**
 * The branch a `git push` writes to the default branch, or null: a refspec whose destination is the default branch
 * (`main`, `HEAD:main`, `+x:refs/heads/main`), `--all` or `--mirror`, or no refspec (or `HEAD`) from the default branch.
 * Changes reach the default branch through a PR merged by `apv stack merge`, never by a push.
 */
export function pushToDefault(words, defaults = ['main', 'master'], current = null) {
  const at = commandIndex(words, 'git');
  if (at === -1) return null;
  let i = at + 1;
  while (i < words.length && words[i].startsWith('-')) i += GIT_WITH_VALUE.has(words[i]) ? 2 : 1;
  if (words[i] !== 'push') return null;
  const args = words.slice(i + 1);
  if (args.some(a => a === '--all' || a === '--mirror' || a === '--branches')) return defaults[0] ?? 'main';
  // Options followed by a separate value. `--signed`, `--force-with-lease` and `--recurse-submodules` take theirs only
  // after `=`: alone, the next word is the remote (`git push --signed origin main`).
  const valued = new Set(['--repo', '--receive-pack', '--exec', '-o', '--push-option']);
  const plain = [];
  for (let k = 0; k < args.length; k += 1) {
    if (args[k].startsWith('-')) { if (valued.has(args[k]) && !args[k].includes('=')) k += 1; continue; }
    plain.push(args[k]);
  }
  const specs = plain.slice(1);
  const name = ref => ref.replace(/^\+/, '').replace(/^refs\/heads\//, '');
  if (!specs.length) return current && defaults.includes(current) ? current : null;
  for (const spec of specs) {
    const [src, dst] = spec.includes(':') ? spec.split(':') : [spec, spec];
    const target = name(dst === '' ? src : dst) === 'HEAD' ? current : name(dst === '' ? src : dst);
    if (target && defaults.includes(target)) return target;
  }
  return null;
}

/** The root of this plugin, as launched and with its links resolved: its files run only through apv and the hooks. */
const PLUGIN_ROOTS = (() => {
  const raw = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
  let real = raw; try { real = realpathSync(raw); } catch { /* as launched */ }
  return [...new Set([raw, real])];
})();
const INTERPRETERS = new Set(['node', 'nodejs', 'python', 'python3', 'deno', 'bun', 'tsx', 'ts-node', 'perl', 'ruby', 'php']);
/** Places that are the plugin wherever it is installed: never run or imported by a script. */
const PLUGIN_PLACES = /CLAUDE_PLUGIN_ROOT|\.claude\/+plugins|hooks\/+scripts\//;
/** Modules of the tool that sign or read what is signed, by their path in a build of the plugin. */
const TOOL_MODULE_PATHS = /(?:[\w.~$@{}-]*\/+)*dist\/+(?:rules|stack|review|gates|lifecycle|commands)\/[\w./-]*/g;

/**
 * Whether `dir` (or one of its parents) is a build of this plugin: a checkout or an install holding both `dist/cli.js`
 * and `hooks/scripts/bash-guard.mjs`. A project's own `dist/commands/` is not the plugin.
 */
export function insidePluginBuild(dir) {
  let current = dir;
  for (let k = 0; k < 40 && current; k += 1) {
    if (PLUGIN_ROOTS.includes(current) || (existsSync(resolve(current, 'dist', 'cli.js')) && existsSync(resolve(current, 'hooks', 'scripts', 'bash-guard.mjs')))) return true;
    const up = dirname(current);
    if (up === current) break;
    current = up;
  }
  return false;
}

/**
 * Whether the text of a command names a module of the tool (`dist/rules/…`, `dist/commands/…`) that resolves, from `cwd`,
 * inside a build of the plugin; a path the guard cannot resolve (a variable, `~`, a file that is not there) counts as the plugin's.
 */
export function namesToolModule(flat, cwd) {
  for (const m of flat.matchAll(TOOL_MODULE_PATHS)) {
    const path = m[0];
    if (/[$~{}]/.test(path)) return true;
    const full = isAbsolute(path) ? path : resolve(cwd ?? process.cwd(), path);
    // A module that is not there cannot be told apart: counted as the plugin's (an installed copy elsewhere).
    if (!existsSync(full) || insidePluginBuild(dirname(full))) return true;
  }
  return false;
}

/**
 * Why a command reaches the plugin's own code or the key other than through apv and the hooks, or null: an interpreter
 * that names the plugin or its modules (a script that imports dist/rules/*.js signs without the key), a file of the plugin
 * run other than dist/cli.js or bin/apv, the home folder searched, copied or globbed, a path decoded from base64 and used,
 * the variables of the tool.
 */
export function pluginCodeProblem(words, flat, cwd = null) {
  const cw = commandWords(words);
  const w = cw ? cw.words : words;
  const tool = basename(w[0] ?? '');
  if (INTERPRETERS.has(tool)) {
    const script = w.slice(1).find(a => !a.startsWith('-'));
    const runsApv = script && (/(^|\/)dist\/cli\.js$/.test(script) || /(^|\/)bin\/apv$/.test(script));
    if (!runsApv && (PLUGIN_PLACES.test(flat) || PLUGIN_ROOTS.some(r => flat.includes(r)) || namesToolModule(flat, cwd))) return REASONS.pluginCode;
  }
  return null;
}

const HOME_ROOT = /^(?:~\/?|\$HOME\/?|\$\{HOME\}\/?|\/home\/[^/\s]+\/?|\/root\/?|\/Users\/[^/\s]+\/?)$/;
/** Commands that walk or copy a whole folder: handed the home folder itself, they would reach the key. */
const WALKERS = new Set(['find', 'tar', 'cp', 'rsync', 'zip', 'scp', 'du', 'grep', 'rg', 'ag']);
const KEY_FOLDER = '.apv-ancrage';
/** A glob over hidden entries that could match the key folder (`.a*`, `.apv*`, `.*`), never `.config` or `.cache/x`. */
const matchesKeyFolder = (prefix, wildcard) => wildcard !== undefined && KEY_FOLDER.startsWith(prefix);
const HOME_HIDDEN_GLOB = /(?:~|\$\{?HOME\}?|\/home\/[^/\s]+|\/root|\/Users\/[^/\s]+)\/(\.[^/\s'"*?[]*)([*?[])/g;
const RELATIVE_HIDDEN_GLOB = /(?:^|[\s'"=(])(\.[^/\s'"*?[]*)([*?[])/g;
const CD_HOME = /(?:^|[;&|(]\s*)cd(?:\s+(?:~\/?|\$HOME\/?|\$\{HOME\}\/?|\/home\/[^/\s]+\/?|\/root\/?))?\s*(?:$|[;&|)])/;

/**
 * Whether a command reaches the key folder by the home folder: handed whole to a walker (find ~, tar $HOME), a glob of
 * hidden entries of the home that could match `.apv-ancrage`, or the same glob relative after a `cd` to the home.
 */
export function homeFolderProblem(words, flat) {
  const cw = commandWords(words);
  const w = cw ? cw.words : words;
  const tool = basename(w[0] ?? '');
  for (const m of flat.matchAll(HOME_HIDDEN_GLOB)) if (matchesKeyFolder(m[1], m[2])) return REASONS.homeFolder;
  if (CD_HOME.test(flat)) for (const m of flat.matchAll(RELATIVE_HIDDEN_GLOB)) if (matchesKeyFolder(m[1], m[2])) return REASONS.homeFolder;
  if (WALKERS.has(tool) && w.slice(1).some(a => HOME_ROOT.test(a))) return REASONS.homeFolder;
  return null;
}

/**
 * Whether one command starts a Claude Code session: a command named claude or claude-code, a binary under
 * .local/share/claude/versions/, @anthropic-ai/claude-code, or a variable in command position on a line that prints
 * (`$c -p ...`, `-p` among its own words). `claude --version` and `claude -p /usage` (the quota reading, without a model) stay allowed.
 */
export function nestedClaude(cwords, flat) {
  const first = cwords[0] ?? '';
  const allowed = (cwords.length === 2 && ['--version', '-v'].includes(cwords[1])) || (cwords.length === 3 && cwords[1] === '-p' && cwords[2] === '/usage');
  if (['claude', 'claude-code'].includes(basename(first)) || /\.local\/+share\/+claude\/+versions\//.test(first)) return !allowed;
  if (cwords.some(a => /@anthropic-ai\/+claude-code/.test(a))) return true;
  // A variable in command position that prints: `-p` among the words of that same command, never elsewhere in the line.
  if (/^\$\{?\w+\}?$/.test(first) && cwords.slice(1).some(a => a === '-p' || a === '--print' || /^-[a-zA-Z]*p$/.test(a) && !a.startsWith('--'))) return true;
  return false;
}

/** A merge of a pull request through any client (gh api graphql, curl, a script): the API names it. */
const MERGE_API = /mergePullRequest|enablePullRequestAutoMerge|pulls\/+[^\s/'"]+\/+merge\b/i;

const PR_WRITES = new Set(['create', 'edit', 'merge', 'ready', 'close', 'reopen', 'comment', 'review']);
const API_WRITE_FLAGS = new Set(['-f', '-F', '--field', '--raw-field', '--input']);

/** Classifies a gh call: null when it only reads, otherwise { merge: boolean }. */
export function githubWrite(words) {
  const at = commandIndex(words, 'gh');
  if (at === -1) return null;
  const args = words.slice(at + 1);
  const [group, sub] = positional(args.filter((a, k) => !['-R', '--repo'].includes(args[k - 1])));
  if (group === 'pr' && PR_WRITES.has(sub)) return { merge: sub === 'merge' };
  if (group === 'api') {
    if (args.some(a => /(^|\/)pulls\/[^/\s]+\/merge\b/.test(a))) return { merge: true };
    const method = args.find((a, k) => (args[k - 1] === '-X' || args[k - 1] === '--method'))
      ?? args.find(a => a.startsWith('--method='))?.slice('--method='.length)
      ?? args.find(a => /^-X[A-Za-z]+$/.test(a))?.slice(2);
    if ((method && method.toUpperCase() !== 'GET') || args.some(a => API_WRITE_FLAGS.has(a))) return { merge: false };
  }
  return null;
}

/**
 * True when the words of one simple command run `apv stack merge` (or `apv stack batch --merge`): the `apv` binary (also through npx), or
 * the bundled tool `node …/dist/cli.js`. Options may sit between `stack` and `merge`; the command merges
 * pull requests on GitHub, so it needs the same explicit authorisation as `gh pr merge`.
 */
const LAUNCHERS = new Set(['node', 'npx', 'bunx', 'npm', 'pnpm', 'yarn']);
/**
 * Commands that only print, search or name their arguments, never run them: an `apv` among their words is text
 * (`echo apv stack merge`, `grep -rn "apv stack merge" docs`). Any other command that carries `apv` in its words is
 * taken as running it, whatever prefix sits in front (timeout, nice, command, env -i, watch, unbuffer...).
 */
const TEXT_COMMANDS = new Set(['echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'man', 'which', 'type', 'whereis', 'cat', 'less',
  'more', 'head', 'tail', 'wc', 'sed', 'awk', 'git', 'gh', 'ls', 'test', '[', 'true', ':']);

/**
 * The `apv` call of the words of one simple command: its arguments and the assignments set for it, or null. Prefixes
 * that run the rest of their arguments are passed by `commandWords` (assignments, sudo, env -i, nohup, timeout, nice,
 * command, exec, xargs...); `apv` then runs as the binary, or after a launcher (`npx apv`, `node …/dist/cli.js`).
 * A prefix it does not know (`watch`, `unbuffer`, `script -c`...) still counts: `apv` anywhere in the words of a
 * command that is not a text command (`TEXT_COMMANDS`) is taken as run, so a guard never lets a wrapper hide it.
 */
/** Commands of the tool (src/commands/index.ts): what follows `apv` behind an unknown prefix. */
const APV_COMMANDS = new Set(['init', 'onboard', 'spec', 'run', 'stack', 'rules', 'audit', 'ledger', 'scope', 'gates', 'lock', 'wait', 'procs', 'stacks',
  'review', 'dast', 'db', 'design', 'structure', 'reuse', 'map', 'quota', 'preview', 'web', 'status', 'help']);

export function apvCall(words) {
  const cw = commandWords(words);
  if (!cw) return null;
  const w = cw.words;
  const lead = basename(w[0]);
  if (lead === 'apv') return { args: w.slice(1), assignments: cw.assignments };
  if (TEXT_COMMANDS.has(lead)) return null;
  for (let k = 1; k < w.length; k += 1) {
    const name = basename(w[k]);
    if (name !== 'apv' && name !== 'cli.js') continue;
    // After a launcher (npx apv, node …/dist/cli.js): the tool, as always.
    if (LAUNCHERS.has(lead) || w.slice(1, k).some(x => LAUNCHERS.has(basename(x)))) return { args: w.slice(k + 1), assignments: cw.assignments };
    // Behind a prefix this guard does not know: the tool when a command of the tool follows (never `cp apv /x`).
    if (name === 'apv' && APV_COMMANDS.has(positional(w.slice(k + 1))[0] ?? '')) return { args: w.slice(k + 1), assignments: cw.assignments };
  }
  return null;
}

export function isStackMerge(words) {
  const call = apvCall(words);
  if (!call) return false;
  const [command, ...rest] = positional(call.args);
  // `apv stack batch <pr...> --merge` merges too (docs/APV3-SPEC.md, section 18.5).
  return command === 'stack' && (rest.includes('merge') || (rest[0] === 'batch' && call.args.includes('--merge')));
}

/**
 * The arguments of an `apv` call in the words of one simple command (the binary, `npx apv`, or `node …/dist/cli.js`,
 * behind any prefix: see `apvCall`), or null when the command does not run the tool.
 */
export function apvArguments(words) {
  return apvCall(words)?.args ?? null;
}

/** The value of `--name <v>` or `--name=<v>` in `args`, or undefined. */
function optionValue(args, name) {
  const at = args.indexOf(name);
  if (at !== -1) return args[at + 1];
  return args.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1);
}

/**
 * Why `apv review record` is refused here, or null: only the reviewer agent of the domain records its review
 * (`apv:qa-securite` for securite, `apv:qa-fidelite` for fidelite...), under its own name. Never the main session
 * (the lead), never the implementer or the integrator: a review recorded by who wrote the code proves nothing.
 */
export function reviewRecordProblem(words, agentType) {
  const args = apvArguments(words);
  if (!args) return null;
  const [command, sub] = positional(args);
  // `record` among the words, wherever the options put it (`apv review --domain securite record`).
  if (command !== 'review' || (sub !== 'record' && !args.includes('record'))) return null;
  const domain = optionValue(args, '--domain');
  const role = DOMAIN_REVIEWERS[domain];
  if (!role) return null; // the tool refuses an unknown domain itself
  const agent = agentName(agentType);
  if (!agentType) return REASONS.reviewByLead(domain, role);
  if (agent !== role) return REASONS.reviewByOther(domain, role, agent);
  if (agentName(optionValue(args, '--reviewer')) !== agent) return REASONS.reviewByOther(domain, role, `${agent} sous un autre nom (--reviewer ${optionValue(args, '--reviewer') ?? 'absent'})`);
  return null;
}

/** The `apv review record` call of a command, its words and its domain, or null (the seal hook reads it after the run). */
export function reviewRecordCall(command) {
  if (typeof command !== 'string') return null;
  for (const words of tokenize(command).segments) {
    const args = apvArguments(words);
    if (!args) continue;
    const [name, sub] = positional(args);
    if (name === 'review' && (sub === 'record' || args.includes('record'))) return { words, domain: optionValue(args, '--domain') ?? null, reviewer: optionValue(args, '--reviewer') ?? null };
  }
  return null;
}

/** True when the words of one simple command deploy to production with the Vercel CLI. */
export function isProductionDeploy(words) {
  const at = commandIndex(words, 'vercel');
  if (at === -1) return false;
  const args = words.slice(at + 1);
  const [sub] = positional(args);
  if (sub === 'promote' || sub === 'rollback') return true;
  return args.some((a, k) => a === '--prod' || a === '--production' || a === '--target=production' ||
    (a === '--target' && args[k + 1] === 'production'));
}

/**
 * An explicit authorisation: set in the hook environment, or as an assignment set for the command itself (before it,
 * or after a prefix such as `env` or `timeout`, as `commandWords` reads them).
 */
function authorised(words, variable, env) {
  if (env[variable] === '1') return true;
  const assignments = apvCall(words)?.assignments ?? commandWords(words)?.assignments ?? [];
  return assignments.includes(`${variable}=1`);
}

const HIDDEN_OUTPUT = /(?:&>>?|>&|\d*>>?)\s*\/dev\/null\b|\btee\s+(?:-a\s+)?\/dev\/null\b/;

export const REASONS = {
  forcePush: 'APV : force-push interdit (git push --force, -f, --force-with-lease ou refspec +). ' +
    "Un commit déjà poussé ne se réécrit jamais : empile un commit correctif par-dessus. " +
    "Réécrire l'historique distant est une décision de l'opérateur, qu'il exécute lui-même.",
  // Same text as MERGE_REFUSED of the tool (src/stack/github.ts), which refuses `apv stack merge` without it; a test keeps both equal.
  merge: "APV : fusion de PR bloquée hors de la commande dédiée. Une fusion se fait seulement sur ordre explicite " +
    "de l'opérateur, par /apv:stack (outil : APV_ALLOW_MERGE=1 apv stack merge <pr...>), qui re-cible, vérifie la base de chaque PR " +
    "juste avant de fusionner et s'arrête à la première anomalie. APV_ALLOW_MERGE=1 se pose devant cette seule commande.",
  deploy: "APV : déploiement en production bloqué hors de la commande dédiée. Il se fait seulement sur ordre " +
    "explicite de l'opérateur, par la commande de déploiement du projet (qui pose APV_ALLOW_DEPLOY=1). " +
    'Un aperçu (preview) reste autorisé.',
  anchorStore: 'APV : commande refusée, elle nomme un magasin que seul l\'outil écrit (apv/operator : les mots tapés par l\'opérateur ; ' +
    'apv/reviews : les relectures enregistrées). Ces traces ancrent les validations et les relectures ; un agent ne les lit ni ne les écrit ' +
    'directement. Lire : apv review show --commit <sha>, apv rules check --commit <sha>. Écrire : apv review record, par l\'agent relecteur du domaine.',
  reviewByLead: (domain, role) => `APV : apv review record ${domain} refusé dans la session principale. Une relecture s'enregistre par l'agent ` +
    `relecteur du domaine (apv:${role}), lancé sur une copie détachée au commit relu, jamais par le chef de projet ni par qui a écrit le code.`,
  reviewByOther: (domain, role, agent) => `APV : apv review record ${domain} refusé pour ${agent || 'cet agent'}. Seul l'agent apv:${role} ` +
    `enregistre la relecture ${domain}, sous son nom (--reviewer apv:${role}) : l'implementer et l'intégrateur ne relisent pas leur propre travail.`,
  rawMerge: 'APV : fusion directe par gh refusée. Seul apv stack merge fusionne (APV_ALLOW_MERGE=1 apv stack merge <pr...>) : il vérifie juste ' +
    'avant chaque fusion les règles du chef de projet (preuve complète au commit, aucun test instable, relectures, captures, contrôles de base, ' +
    'maquettes ; docs/REGLES.md du plugin). Sans l\'outil, l\'opérateur fusionne lui-même sur GitHub.',
  pushToDefault: branch => `APV : poussée directe vers ${branch} refusée. La branche par défaut ne change que par une PR fusionnée par apv stack merge, ` +
    'après les règles du chef de projet ; pousse ta branche de travail et ouvre une PR.',
  computedApv: 'APV : commande apv dont la commande ou la sous-commande est calculée (variable, substitution, eval) refusée : écris-la en clair, ' +
    'les garde-fous doivent pouvoir la lire.',
  commonDir: 'APV : git rev-parse --git-common-dir seulement seul, en lecture ; le répertoire commun porte les magasins de l\'outil (reçus, relectures, journal de l\'opérateur).',
  pluginCode: 'APV : commande refusée, elle exécute ou importe le code du plugin hors de la commande apv (un script qui charge dist/rules, dist/stack... ' +
    'signerait à la place des crochets). Lance l\'outil par apv (ou node <plugin>/dist/cli.js).',
  homeFolder: 'APV : commande refusée, elle parcourt ou copie le dossier personnel entier, ou vise par un motif ses dossiers cachés, où se trouve la clé d\'ancrage du plugin (~/.apv-ancrage). ' +
    'Nomme le dossier précis dont tu as besoin.',
  encodedPath: 'APV : chemin décodé (base64) puis utilisé dans la même commande : refusé, les garde-fous doivent pouvoir lire ce que la commande touche.',
  toolVariable: 'APV : les variables internes de l\'outil (APV_ENTRY, APV_ANCHOR_KEY_FILE) ne se posent pas à la main.',
  nestedClaude: 'APV : lancer claude depuis une session gérée par APV est refusé (sauf claude --version et claude -p /usage) : une session imbriquée échappe aux garde-fous des sous-agents ' +
    '(fusion, relecture). Les agents se lancent par l\'outil Agent du chef de projet.',
  mergeBySubagent: 'APV : fusion refusée dans un sous-agent. Seul le chef de projet (session principale) fusionne, par apv stack merge, ' +
    'qui vérifie les règles avant chaque fusion.',
  hiddenOutput: 'APV : commande qui écrit sur GitHub avec une sortie masquée (redirection vers /dev/null). ' +
    'Incident 30 : un `gh pr edit --base` a échoué sans message et les PR ont été fusionnées dans la mauvaise base. ' +
    'Relance sans masquer la sortie, lis-la, puis vérifie le résultat (par exemple gh pr view <n> --json baseRefName).',
};

const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'mksh', 'ash']);
/** Depth of the `sh -c` scripts examined as commands. */
const MAX_NESTING = 3;

/**
 * The script a simple command runs through a shell (`sh -c`, `bash -lc`, `flock <file> -c`), or null. The script is
 * then examined as a command, with the locks its wrapper took.
 */
export function nestedScript(words) {
  const cw = commandWords(words);
  if (!cw) return null;
  const w = cw.words;
  const tool = basename(w[0]);
  if (SHELLS.has(tool)) {
    const at = w.findIndex((x, k) => k > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(x));
    return at !== -1 && w[at + 1] !== undefined ? w[at + 1] : null;
  }
  if (tool === 'flock') {
    const at = w.findIndex((x, k) => k > 0 && (x === '-c' || x === '--command'));
    return at !== -1 && w[at + 1] !== undefined ? w[at + 1] : null;
  }
  return null;
}

/**
 * Pure decision for one Bash command: { decision: 'allow' } or { decision: 'deny', reason }. `context` gives what
 * the harness rules read around the command (docs/APV3-SPEC.md, section 18.2): the session's ancestors, the working
 * directory, the declared test stacks and the locks already held; the default knows nothing, so those rules only
 * apply to what the command itself says.
 */
export function evaluateCommand(command, env = {}, context = EMPTY_CONTEXT) {
  return evaluate(command, env, context, 0, { files: [], resources: [], stacks: [] });
}

function evaluate(command, env, context, depth, inherited) {
  if (typeof command !== 'string' || command.trim() === '') return { decision: 'allow' };
  if (anchorInCommand(command)) return { decision: 'deny', reason: REASONS.anchorStore };
  const flat = flatten(command);
  if (MERGE_API.test(flat)) return { decision: 'deny', reason: context.agentId ? REASONS.mergeBySubagent : REASONS.rawMerge };
  if (/--git-common-dir/.test(flat) && !/^\s*git\s+rev-parse(\s+--path-format=(absolute|relative))?\s+--git-common-dir\s*$/.test(flat)) return { decision: 'deny', reason: REASONS.commonDir };
  if (/(^|[\s;&|(])eval\b/.test(flat) && /\bapv\b|cli\.js/.test(flat)) return { decision: 'deny', reason: REASONS.computedApv };
  if (/\bAPV_ENTRY\b|\bAPV_ANCHOR_KEY_FILE\b/.test(flat)) return { decision: 'deny', reason: REASONS.toolVariable };
  if (/\brm\b[^;&|]*(?:\.git\/+apv\b|\/apv\/?(?:\s|$))/.test(flat)) return { decision: 'deny', reason: REASONS.anchorStore };
  if (/\bbase64\b[^|;&]*(?:\s-d\b|\s-D\b|--decode)/.test(flat) && /[|`]|\$\(/.test(flat)) return { decision: 'deny', reason: REASONS.encodedPath };
  const { segments, shadow } = tokenize(command);
  let writesGithub = false;
  const kill = killProblem(segments, context.ancestors);
  if (kill) return { decision: 'deny', reason: kill };
  const install = installProblem(segments, context.cwd, context.home);
  if (install) return { decision: 'deny', reason: install };
  // The declared stacks are read (git, config) only for a command that may reach one.
  const stacks = /\b(docker|podman|supabase)\b/.test(command) ? context.stacks() : [];
  for (const words of segments) {
    // A write to a remote database (production): refused whatever the locks, no variable lifts it.
    const remote = remoteWriteProblem(words) ?? remoteWriteProblem(lockWrapper(words, stacks, context.cwd).words);
    if (remote) return { decision: 'deny', reason: remote };
    const wrapped = lockWrapper(words, stacks, context.cwd);
    const held = mergeHeld(inherited, wrapped.held);
    const stack = stacks.length ? stackProblem(wrapped.words, held, context, context.cwd) : null;
    if (stack) return { decision: 'deny', reason: stack };
    const script = depth < MAX_NESTING ? nestedScript(wrapped.words) ?? nestedScript(words) : null;
    if (script !== null) {
      const nested = evaluate(script, env, context, depth + 1, held);
      if (nested.decision === 'deny') return nested;
    }
    if (isForcePush(words)) return { decision: 'deny', reason: REASONS.forcePush };
    const code = pluginCodeProblem(words, flat, context.cwd ?? null) ?? homeFolderProblem(words, flat);
    if (code) return { decision: 'deny', reason: code };
    const cwords = commandWords(words)?.words ?? words;
    if (nestedClaude(cwords, flat)) return { decision: 'deny', reason: REASONS.nestedClaude };
    const pushed = pushToDefault(words, (context.defaultBranches ?? (() => ['main', 'master']))(), (context.currentBranch ?? (() => null))());
    if (pushed) return { decision: 'deny', reason: REASONS.pushToDefault(pushed) };
    const apvArgs = apvArguments(words);
    if (apvArgs && positional(apvArgs).slice(0, 2).some(w => /[$`]/.test(w))) return { decision: 'deny', reason: REASONS.computedApv };
    const review = reviewRecordProblem(words, context.agentType ?? null);
    if (review) return { decision: 'deny', reason: review };
    const raw = githubWrite(words);
    const write = raw ?? (isStackMerge(words) ? { merge: true } : null);
    if (write) {
      writesGithub = true;
      if (write.merge && context.agentId) return { decision: 'deny', reason: REASONS.mergeBySubagent };
      // A merge through gh skips the rules the tool checks before any merge: only apv stack merge merges.
      if (raw?.merge) return { decision: 'deny', reason: REASONS.rawMerge };
      if (write.merge && !authorised(words, 'APV_ALLOW_MERGE', env)) return { decision: 'deny', reason: REASONS.merge };
    }
    if (isProductionDeploy(words) && !authorised(words, 'APV_ALLOW_DEPLOY', env)) {
      return { decision: 'deny', reason: REASONS.deploy };
    }
  }
  if (writesGithub && HIDDEN_OUTPUT.test(shadow)) return { decision: 'deny', reason: REASONS.hiddenOutput };
  return { decision: 'allow' };
}

async function main() {
  const input = await readHookInput();
  if (!input || input.tool_name !== 'Bash') return 0;
  const result = evaluateCommand(input.tool_input?.command, process.env, hookContext(input, process.env));
  if (result.decision === 'allow') return 0;
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: result.reason,
    },
  })}\n`);
  process.stderr.write(`${result.reason}\n`);
  // Exit 2 blocks even if the JSON above were rejected by a future schema.
  return 2;
}

if (isMainModule(import.meta.url)) {
  main().then(code => { process.exitCode = code; }, error => {
    process.stderr.write(`APV bash-guard : ${error?.message ?? error}\n`);
    process.exitCode = 0;
  });
}
