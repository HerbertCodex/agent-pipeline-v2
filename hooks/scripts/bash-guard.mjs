#!/usr/bin/env node
// PreToolUse guard for the Bash tool (APV3 spec, sections 11 and 18.2).
// Blocks force-pushes, merges outside apv stack merge (gh pr merge and gh api …/merge always; apv stack merge without its
// explicit authorisation, or inside a subagent) and production deploys without their explicit authorisation, commands that write to GitHub while hiding their output (incident 30),
// and the harness mistakes of section 18.2 (harness-guard.mjs): kills that may reach the session, installs
// through a symlinked node_modules, docker or supabase commands on a declared test stack without its lock.
// This is a guard rail against mistakes, not a security boundary: a determined command can
// always be written in a shape this parser does not recognise.
import { spawnSync } from 'node:child_process';
import { accessSync, constants as fsConstants, existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMAIN_REVIEWERS, agentName, flatten, isMainModule, namesAnchor, readHookInput } from './lib.mjs';
import { EMPTY_CONTEXT, HARNESS_REASONS, cdTarget, commandWords, hookContext, installProblem, killProblem, lockWrapper, mergeHeld, remoteWriteProblem, stackProblem } from './harness-guard.mjs';

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
    // A here-string (`<<<`) is one operator: its last two characters never open a heredoc.
    if (s.startsWith('<<<', i)) { i += 3; continue; }
    if (s.startsWith('<<', i)) {
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
 * A `$` or a backquote the shell takes literally (between apostrophes, or escaped) becomes a private character in the
 * words, so that no rule reads a substitution or a variable there (`git commit -m 'cite `git push`'`, `echo '$(x)'`).
 */
const literal = text => text.replace(/\$/g, '').replace(/`/g, '');

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
  /** The texts fed to each simple command on its standard input (heredoc bodies, here-strings), by index: a shell runs them. */
  const scripts = {};
  /** The operator right after each simple command, by index (`&&`, `;`, `|`…); none when a heredoc body or the end follows. */
  const after = {};
  const feed =(owner, text) => { (scripts[owner] ??= []).push(text); };
  let pendingOwners = [];
  let hereString = false;
  const flushWord = () => {
    if (inWord) {
      words.push(word);
      if (hereString) { feed(segments.length, word); hereString = false; }
    }
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
      for (const owner of pendingOwners) feed(owner, command.slice(i + 1, next));
      pendingOwners = [];
      shadow += '\n';
      blank(i + 1, next);
      i = next;
      continue;
    }
    if (c === '\\' && i + 1 < command.length) {
      word += literal(command[i + 1]);
      inWord = true;
      blank(i, i + 2);
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      const stop = end === -1 ? command.length : end;
      word += literal(command.slice(i + 1, stop));
      inWord = true;
      blank(i, stop + 1);
      i = stop + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < command.length && command[j] !== '"') {
        if (command[j] === '\\' && j + 1 < command.length && '"\\$`'.includes(command[j + 1])) {
          word += literal(command[j + 1]);
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
    // A here-string (`<<<`) is one operator, its word the standard input of the command: never a heredoc delimiter.
    if (command.startsWith('<<<', i)) {
      flushWord();
      hereString = true;
      shadow += '<<<';
      i += 3;
      continue;
    }
    if (command.startsWith('<<', i)) {
      flushWord();
      const { heredoc, next } = readHeredoc(command, i);
      if (heredoc) { pending.push(heredoc); heredocOwners.push(segments.length); pendingOwners.push(segments.length); }
      shadow += command.slice(i, next);
      i = next;
      continue;
    }
    const operator = OPERATORS.find(op => command.startsWith(op, i));
    if (operator) {
      const before = segments.length;
      flushSegment();
      if (segments.length > before) after[segments.length - 1] = operator;
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
  return { segments, shadow, heredocOwners, scripts, after };
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
export function anchorInCommand(command) {
  if (typeof command !== 'string' || !namesAnchor(command)) return false;
  return namesAnchor(executedText(command));
}

const leadOf = words => basename(commandWords(words)?.words[0] ?? words[0] ?? '');

/**
 * The text of a command that runs or names what it touches: its words, minus the values of message options (whose
 * substitutions are read as commands, recursively), and minus the words of the simple commands `skip` says are only
 * text (`skip(words, segments)`; their substitutions still read as commands). The body of a heredoc is data when a data command reads it; read by anything else (sh, node, patch...), or
 * when `rawBodies` says so, the whole command is returned. Beyond the nesting depth, the whole command too.
 */
export function executedText(command, { skip = () => false, rawBodies = () => false } = {}, depth = 0) {
  if (typeof command !== 'string') return '';
  if (depth > MAX_NESTING) return command;
  const { segments, heredocOwners } = tokenize(command);
  if (heredocOwners.length && (heredocOwners.some(i => !DATA_SINKS.has(leadOf(segments[i] ?? []))) || rawBodies(segments))) return command;
  const kept = [];
  for (const words of segments) {
    // A command that is only text still runs the substitutions of its words (`grep "$(gh api …)" f`): read as commands.
    if (skip(words, segments)) {
      for (const word of words) for (const sub of substitutions(word)) kept.push(executedText(sub, { skip, rawBodies }, depth + 1));
      continue;
    }
    const options = MESSAGE_OPTIONS[leadOf(words)] ?? [];
    for (let k = 0; k < words.length; k += 1) {
      const word = words[k];
      const attached = options.map(o => o.startsWith('--') ? `${o}=` : o).find(o => word.startsWith(o) && word.length > o.length && (o.endsWith('=') || o.length === 2));
      const value = k > 0 && options.includes(words[k - 1]) ? word : attached ? word.slice(attached.length) : null;
      if (value === null) { kept.push(word); continue; }
      if (attached) kept.push(attached);
      for (const sub of substitutions(value)) kept.push(executedText(sub, { skip, rawBodies }, depth + 1));
    }
  }
  return kept.join(' ');
}

/**
 * Pure readers: they search or count text and never run it (no `e` command of sed, no `system()` of awk, no alias of
 * git, no `!` of less). A merge named in their arguments is never run by them, unless their output goes on to run.
 */
const PURE_READERS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'wc', 'head', 'tail', 'echo', 'printf', 'cat']);
/**
 * Subcommands of git that only read history or files. A configured alias never shadows them (git ignores it); `-c`,
 * `--config-env` and `--exec-path` can still make git run a command (a pager, an external diff), and `git grep -O` opens
 * a program of its choosing: not pure readers then.
 */
const GIT_READERS = new Set(['log', 'show', 'diff', 'grep', 'blame', 'shortlog', 'status', 'ls-files']);
const pureGit = cw => {
  let k = 1;
  while (k < cw.length && cw[k].startsWith('-')) {
    if (/^(?:-c|--config-env|--exec-path)(?:=|$)/.test(cw[k]) || /^-c./.test(cw[k])) return false;
    k += GIT_WITH_VALUE.has(cw[k]) ? 2 : 1;
  }
  if (!GIT_READERS.has(cw[k] ?? '')) return false;
  return !(cw[k] === 'grep' && cw.slice(k + 1).some(a => /^(?:-O|--open-files-in-pager)/.test(a)));
};
/**
 * Commands that run the text they read (a shell, an interpreter, `sed e`, `awk system()`, `su`) or turn it into
 * arguments of a command (`xargs`, `parallel`): what feeds them is a command, never only text.
 */
const EXECUTORS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'mksh', 'ash', 'fish', 'csh', 'tcsh', 'busybox', 'toybox', 'xargs', 'parallel', 'eval', 'source', '.',
  'node', 'nodejs', 'python', 'python2', 'python3', 'perl', 'ruby', 'php', 'deno', 'bun', 'tsx', 'ts-node', 'lua', 'tclsh', 'osascript', 'pwsh', 'awk', 'gawk', 'mawk', 'nawk',
  'sed', 'gsed', 'vim', 'vi', 'ex', 'ed', 'expect', 'su']);
/** Whether a simple command runs what it reads: its command is an executor, or it runs under `xargs` or `parallel`. */
const executes = words => {
  const lead = commandWords(words)?.words ?? [];
  const front = words.slice(0, Math.max(1, words.length - lead.length + 1)).map(w => basename(w));
  return EXECUTORS.has(basename(lead[0] ?? '')) || front.some(w => w === 'xargs' || w === 'parallel');
};
/**
 * A pure reader whose text runs nowhere: no command of the line runs what it reads, none sends its standard input or a
 * file to an API (`printf 'mutation…' > q && gh api graphql -F query=@q`).
 */
const onlyReads = (words, segments) => {
  const cw = commandWords(words)?.words ?? words;
  const tool = basename(cw[0] ?? '');
  if (tool === 'git' ? !pureGit(cw) : !PURE_READERS.has(tool)) return false;
  // rg runs a preprocessor of its own choosing (`--pre`): not a pure reader then.
  if (tool === 'rg' && cw.some(a => a === '--pre' || a.startsWith('--pre='))) return false;
  return !segments.some(s => executes(s) || SENDS_STDIN(s) || SENDS_FILE(s));
};

/**
 * The options of a `gh api` call that decide whether it writes: every method it names (`-X`, `--method`, `-XPUT`,
 * grouped short options such as `-iX PUT`), whether it sends fields (`-f`, `-F`, `--field`, `--raw-field`) and its
 * `--input`. gh applies the last method: two methods are read as a write, whatever the first says.
 */
function ghApiOptions(args) {
  const methods = []; let fields = false; let input = null;
  for (let k = 0; k < args.length; k += 1) {
    const a = args[k];
    const long = /^--(method|field|raw-field|input)(?:=(.*))?$/.exec(a);
    if (long) {
      const value = long[2] !== undefined ? long[2] : args[(k += 1)] ?? '';
      if (long[1] === 'method') methods.push(value);
      else if (long[1] === 'input') input = value;
      else fields = true;
      continue;
    }
    if (!/^-[A-Za-z]/.test(a)) continue;
    // Short options, alone or grouped: the first that takes a value takes the rest of the word, or the next word.
    for (let c = 1; c < a.length; c += 1) {
      if (!'XFfHpqt'.includes(a[c])) continue;
      const value = c + 1 < a.length ? a.slice(c + 1).replace(/^=/, '') : args[(k += 1)] ?? '';
      if (a[c] === 'X') methods.push(value);
      if (a[c] === 'F' || a[c] === 'f') fields = true;
      break;
    }
  }
  const writes = methods.length > 1 || methods.some(m => m.toUpperCase() !== 'GET') || fields || input !== null;
  return { methods, fields, input, writes };
}
/** A `gh api` call that only reads (one GET at most, no field, no input): `gh api repos/o/r/pulls/5/merge` asks whether it is merged. */
function readOnlyGhApi(words) {
  const cw = commandWords(words)?.words ?? words;
  if (basename(cw[0] ?? '') !== 'gh' || cw[1] !== 'api') return false;
  return !ghApiOptions(cw.slice(2)).writes;
}
/** A word that names the standard input as a file: `-`, `/dev/stdin`, `/dev/fd/0`, `/proc/self/fd/0`. */
const STDIN = /^(?:-|\/dev\/stdin|\/dev\/fd\/0|\/proc\/self\/fd\/0)$/;
/**
 * A command that sends its standard input to an API: `gh api --input -`, a field read from it (`-F query=@-`,
 * `--field k=@/dev/stdin`), `curl -d @-`, `curl -T -`, `wget --post-file=-`, or httpie and xh (which read it by
 * themselves): what feeds it is not only text.
 */
const SENDS_STDIN = words => {
  const cw = commandWords(words)?.words ?? words;
  const tool = basename(cw[0] ?? '');
  const at = word => word.startsWith('@') && STDIN.test(word.slice(1));
  if (tool === 'gh') {
    const { input } = ghApiOptions(cw.slice(1));
    return (input !== null && STDIN.test(input)) || cw.some(a => /=@(?:-|\/dev\/stdin|\/dev\/fd\/0|\/proc\/self\/fd\/0)$/.test(a));
  }
  if (tool === 'http' || tool === 'https' || tool === 'xh' || tool === 'xhs') return true;
  if (tool === 'curl' || tool === 'wget') {
    return cw.some((a, k) => at(a) || /[=@](?:-|\/dev\/stdin|\/dev\/fd\/0|\/proc\/self\/fd\/0)$/.test(a) ||
      ((a === '-T' || a === '--upload-file' || a === '--post-file' || a === '--body-file') && STDIN.test(cw[k + 1] ?? '')) || /^-T(?:-|\/dev\/stdin)$/.test(a));
  }
  return false;
};
/**
 * A command that sends a file to an API: `gh api --input f`, a field read from a file (`-F query=@q.graphql`), `curl -d
 * @f`, `curl -T f`, `wget --post-file=f`. Written by the same line, that file is a command: nothing of the line is only text.
 */
const SENDS_FILE = words => {
  const cw = commandWords(words)?.words ?? words;
  const tool = basename(cw[0] ?? '');
  if (tool === 'gh') return cw[1] === 'api' && (ghApiOptions(cw.slice(2)).input !== null || cw.some(a => /^[^=@\s]+=@./.test(a)));
  if (tool === 'curl' || tool === 'wget') {
    return cw.some((a, k) => /^@./.test(a) || /^--[\w-]+=@./.test(a) || /^--(?:post|body)-file=./.test(a) || /^-T./.test(a) ||
      (['-T', '--upload-file', '--post-file', '--body-file'].includes(a) && cw[k + 1] !== undefined));
  }
  return false;
};

/**
 * Whether a command merges a pull request through the API (mergePullRequest, enablePullRequestAutoMerge, a write to
 * …/pulls/<n>/merge) by any client: read in what the command runs, never in what a pure reader only searches (`grep -rn
 * mergePullRequest src`, when nothing of the line runs its output), never in a read-only `gh api` call. A command that
 * feeds an API from its standard input is read whole.
 */
export function mergeApiInCommand(command) {
  const flat = flatten(command);
  if (!MERGE_API.test(flat)) return false;
  const { segments } = tokenize(command);
  if (segments.some(SENDS_STDIN)) return true;
  const text = executedText(command, {
    skip: (words, segs) => onlyReads(words, segs) || readOnlyGhApi(words),
    rawBodies: segs => segs.some(w => !DATA_SINKS.has(leadOf(w)) || (leadOf(w) === 'gh' && (commandWords(w)?.words ?? w)[1] === 'api')),
  });
  return MERGE_API.test(flatten(text));
}

/** The parts of a glob (`*`, `?`, `[…]`, literal characters), each a test of one character except `*`. */
function globTokens(glob) {
  const out = [];
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') { out.push({ star: true }); continue; }
    if (c === '?') { out.push({ test: () => true }); continue; }
    const end = c === '[' ? glob.indexOf(']', i + 2) : -1;
    if (end === -1) { out.push({ test: x => x === c }); continue; }
    let body = glob.slice(i + 1, end);
    const negated = /^[!^]/.test(body);
    if (negated) body = body.slice(1);
    let re = /^.$/;
    try { re = new RegExp(`^[${negated ? '^' : ''}${body.replace(/\\/g, '\\\\')}]$`); } catch { /* any character */ }
    out.push({ test: x => re.test(x) });
    i = end;
  }
  return out;
}

/** Whether a glob may match `name` (`full`), or some name that ends with `name` (`*.git` and `.gi?` may end with `.git`). */
export function globMayMatch(glob, name, full = true) {
  const tokens = globTokens(glob).reverse();
  const target = [...name].reverse();
  const memo = new Map();
  const go = (a, b) => {
    const key = `${a}:${b}`;
    if (memo.has(key)) return memo.get(key);
    let r;
    if (b === target.length) r = !full || tokens.slice(a).every(t => t.star);
    else if (a === tokens.length) r = false;
    else if (tokens[a].star) r = !full || go(a + 1, b) || go(a, b + 1);
    else r = tokens[a].test(target[b]) && go(a + 1, b + 1);
    memo.set(key, r);
    return r;
  };
  return go(0, 0);
}

const GLOB = /[*?[]/;
/** Whether a path, literal or a glob, may be the store folder of a Git directory (`.git/apv`, `x.git/apv`, `.gi?/a*`) or lie in it. */
export function mayBeStore(path) {
  const parts = String(path).split('/').filter(Boolean);
  for (let k = 0; k + 1 < parts.length; k += 1) {
    const gitDir = GLOB.test(parts[k]) ? globMayMatch(parts[k], '.git', false) : parts[k].endsWith('.git');
    if (gitDir && (GLOB.test(parts[k + 1]) ? globMayMatch(parts[k + 1], 'apv') : parts[k + 1] === 'apv')) return true;
  }
  return false;
}

/**
 * Whether a glob in a store may reach a store of the anchor (operator, reviews, merges): the folder after `apv` is one of
 * them, a glob that may match one, or the glob itself. `.git/apv/receipts/*.json` cannot.
 */
export function mayReachAnchor(path) {
  const parts = String(path).split('/').filter(Boolean);
  for (let k = 0; k + 1 < parts.length; k += 1) {
    const gitDir = GLOB.test(parts[k]) ? globMayMatch(parts[k], '.git', false) : parts[k].endsWith('.git');
    if (!gitDir || !(GLOB.test(parts[k + 1]) ? globMayMatch(parts[k + 1], 'apv') : parts[k + 1] === 'apv')) continue;
    // A glob segment that may be `..` (`.?`, `..*`; sh and bash before 5.2 match it) climbs back to the anchor. Only a
    // segment that starts with a dot (or a bracket) may: `*` never matches a name that starts with one.
    if (parts.slice(k + 2).some(p => GLOB.test(p) && /^[.[]/.test(p) && globMayMatch(p, '..'))) return true;
    const next = parts[k + 2];
    if (next === undefined || ['operator', 'reviews', 'merges'].some(n => (GLOB.test(next) ? globMayMatch(next, n) : next === n))) return true;
  }
  return false;
}

/** Commands that only read what a glob names: they may glob a store outside the anchor (the receipts of the checks). */
/**
 * Not `rg` (`--pre` runs a program on each file) nor `tree` (`-o` writes a file); no pager either (`less` and `more` run
 * LESSOPEN or an editor, `bat` its pager and preprocessors): `cat` reads the same.
 */
const GLOB_READERS = new Set(['cat', 'head', 'tail', 'ls', 'jq', 'wc', 'grep', 'egrep', 'fgrep', 'diff', 'cmp', 'stat', 'file',
  'sha256sum', 'sha1sum', 'md5sum', 'du', 'zcat']);
/** Commands that only read or print what they are given: the only ones that may be handed a path in a store. */
/** Not `rg`, whose options may come from a file a variable names (RIPGREP_CONFIG_PATH): handed a store, it is refused. */
const READS_ONLY = new Set([...GLOB_READERS, 'tree', 'echo', 'printf', 'test', '[', 'realpath', 'readlink', 'basename', 'dirname', 'apv',
  // dd writes only by `of=`, read by OUTPUT_OPTIONS.
  'dd']);
/** Options of grep and rg followed by a separate value, which is neither the pattern nor a path searched. */
const GREP_VALUED = new Set(['-m', '-A', '-B', '-C', '-d', '-D', '--max-count', '--after-context', '--before-context', '--context', '--directories', '--devices',
  '--include', '--exclude', '--exclude-dir', '--label', '--binary-files']);
const RG_VALUED = new Set(['-t', '-T', '-g', '-m', '-A', '-B', '-C', '-M', '-j', '-E', '--type', '--type-not', '--glob', '--iglob', '--max-count', '--after-context',
  '--before-context', '--context', '--max-columns', '--threads', '--encoding', '--type-add', '--max-depth', '--max-filesize', '--sort', '--sortr', '--color', '--colors']);
/** Commands that delete, move, empty or copy away what they are given: handed a store, they reach it. */
const STORE_WRITERS = new Set(['rm', 'unlink', 'rmdir', 'shred', 'truncate', 'mv', 'cp', 'rsync', 'tar', 'zip', 'ln', 'chmod', 'chown', 'chgrp', 'install', 'setfacl', 'chattr',
  'tee', 'trash', 'trash-put', 'rmtrash', 'gio', 'sponge', 'gzip', 'gunzip', 'bzip2', 'xz', 'zstd']);
/** Options that name the file a command writes (`sort -o f`, `curl -o f`, `curl -so f`, `wget -qO f`, `dd of=f`), by command. */
const OUTPUT_OPTIONS = { sort: ['-o', '--output'], curl: ['-o', '--output'], wget: ['-O', '--output-document'], dd: ['of'], tree: ['-o'] };
/** Options with which ripgrep runs a program of its own choosing (on each file searched, or to name the host). */
const RG_RUNS = /^--(?:pre|pre-glob|hostname-bin)(?:=|$)/;
const outputsOf = (tool, args) => {
  const names = OUTPUT_OPTIONS[tool] ?? [];
  const out = [];
  args.forEach((a, k) => {
    for (const n of names) {
      if (a === n) out.push(args[k + 1] ?? '');
      else if (a.startsWith(`${n}=`)) out.push(a.slice(n.length + 1));
      else if (/^-[A-Za-z]$/.test(n)) {
        // A short option, alone or last of a group (`-so`, `-qO`), its value attached or in the next word.
        const m = new RegExp(`^-[A-Za-z]*${n[1]}(.*)$`).exec(a);
        if (m && !a.startsWith('--')) out.push(m[1] || (args[k + 1] ?? ''));
      }
    }
  });
  return out.filter(Boolean);
};
/**
 * Interpreters given a script on their command line (`python3 -c`, `-Ic`, `-Sc`, `node -e`, `-pe`, `--eval=`, `perl -we`,
 * `ruby -e`, `php -r`) or on their standard input (`python3 - <<EOF`), and awk.
 */
const AWKS = new Set(['awk', 'gawk', 'mawk', 'nawk']);
/** By interpreter: the letters that give a script on the command line, and the options whose value follows them. */
const SCRIPT_OPTIONS = {
  python: { script: 'c', valued: 'WXQm' }, node: { script: 'ep', valued: 'r' }, perl: { script: 'eE', valued: 'MImxdlC0' },
  ruby: { script: 'e', valued: 'rIECFKTx' }, php: { script: 'r', valued: 'dcfz' }, other: { script: 'e', valued: '' },
};
const scriptOptions = tool => SCRIPT_OPTIONS[/^python/.test(tool) ? 'python' : /^node/.test(tool) ? 'node' : ['perl', 'ruby', 'php'].includes(tool) ? tool : 'other'];
/**
 * The parts of an interpreter's command line: the script texts it is given (`-c`, `-e`, `-pe`, `--eval=`, attached or in
 * the next word; the program of awk), and its operands (the files or values the script works on). A group of short
 * options gives a script only when its last letter is the script letter and no letter before it takes a value
 * (`-rfileutils`, `-Werror`, `-Mstrict` give none); a word that starts with `-` is never a script.
 */
function interpreterParts(tool, args) {
  const scripts = []; const operands = [];
  const awk = AWKS.has(tool);
  const { script, valued } = awk ? { script: '', valued: 'vFfi' } : scriptOptions(tool);
  let program = null;
  for (let k = 0; k < args.length; k += 1) {
    const a = args[k];
    if (a === '--') { operands.push(...args.slice(k + 1)); break; }
    const long = /^--(?:eval|print|exec)(?:=(.*))?$/.exec(a);
    if (long) { const v = long[1] ?? args[(k += 1)]; if (v !== undefined) scripts.push(v); continue; }
    if (a === 'eval' && !scripts.length && !operands.length) { scripts.push(...args.slice(k + 1)); break; }
    const group = /^-([A-Za-z0-9]+)$/.exec(a);
    if (group && !a.startsWith('--')) {
      const letters = group[1];
      const at = [...letters].findIndex(l => valued.includes(l) || script.includes(l));
      if (at === -1) continue;
      const rest = letters.slice(at + 1);
      if (script.includes(letters[at])) {
        // The script letter: its value is the rest of the group, unless the rest is only more option letters (`-pe`),
        // else the next word (never an option).
        const flags = /^[a-zA-Z]+$/.test(rest) && [...rest].every(l => script.includes(l) || !valued.includes(l));
        const v = rest && !flags ? rest : (args[k + 1] !== undefined && !args[k + 1].startsWith('-') ? args[(k += 1)] : undefined);
        if (v !== undefined) scripts.push(v);
      } else {
        // A valued option, its value attached or the next word (`-v x=1`, `-F ,`, `-r lib`). For awk, a value of `-v`
        // is code too (`awk -v p=.git/apv 'BEGIN{system(…)}'`), and `-i inplace` writes its operands.
        const value = rest || args[(k += 1)];
        if (awk && letters[at] === 'v' && value !== undefined) scripts.push(value);
        if (awk && letters[at] === 'i' && value === 'inplace') scripts.push('inplace >');
      }
      if (awk && letters[at] === 'f') program = '';
      continue;
    }
    // A script attached to its option (`python3 -c"…"`, `node -e'…'`): what follows the letter.
    if (/^-[A-Za-z]/.test(a) && !a.startsWith('--') && script.includes(a[1])) { scripts.push(a.slice(2)); continue; }
    if (a.startsWith('-')) continue;
    if (awk && program === null) { program = a; scripts.push(a); continue; }
    operands.push(a);
  }
  return { scripts, operands };
}
const inlineScript = (tool, args) => (AWKS.has(tool) || INTERPRETERS.has(tool)) && interpreterParts(tool, args).scripts.length > 0;
const inlineTexts = (tool, args) => interpreterParts(tool, args).scripts;
/** A value of a variable set by the line that may be a piece of a store path (`d=.git/ap`, `d=.gi`, `e=ap`); never `git` or `it`. */
const storePiece = value => {
  const v = value.replace(/\/$/, '');
  return /\.git(?![A-Za-z])|(?:^|\/)apv(?:\/|$)/.test(v) || (v.length >= 2 && !['git', 'it'].includes(v) && '.git/apv'.includes(v));
};

/**
 * Why a command reaches the stores of the tool, or null (docs/PLUGIN.md, « toujours refusés : magasins, suppression
 * comprise »). A delete, move, copy or truncation (`rm`, `busybox rm`, `mv`, `find … -delete`, `xargs rm` fed by the line)
 * of a path that may be a store folder or lie in it: `.git/apv`, `repo.git/apv/...`, a glob that may match one (`.gi?/apv`,
 * `.git/a*`), read from the directory each literal `cd` of the line leads to (`cd .git && rm -rf ./apv`), or a computed path
 * that ends in `apv` (`$dir/apv`, `$(git rev-parse --git-common-dir)/apv`). For any command, a glob that may reach into a
 * store (`cat .git/apv/rev*\/*`). A folder of the project named `apv` (`build/apv`) is not a store.
 */
export function storeProblem(segments, cwd = null, home = null, command = '', shadow = null, scripts = {}) {
  let dir = cwd;
  const at = (arg, base) => (isAbsolute(arg) || !base ? arg : resolve(base, arg));
  const lineWords = segments.flat();
  // The folders the line works in: the working directory, then each literal cd target (`reached`). A Git directory among
  // them (`.git`, or a bare `x.git`, the working directory included when it is one) makes a computed path suspect; a
  // worktree inside a bare repository (`proj.git/feat`) is not one.
  const dirs = [cwd];
  const reached = cwd && /(?:^|\/)[^/]*\.git$/.test(cwd) ? [cwd] : [];
  let cdComputed = false;
  // The assignments of the line: the leading words of a simple command or of its wrappers (`d=.gi; …`, `GIT_TRACE=f git
  // status`, `env GIT_TRACE=f …`), and the words of export, declare, typeset, readonly, local; never an operand that only
  // looks like one (`dd if=…`, `echo key=…`).
  const EXPORTERS = new Set(['export', 'declare', 'typeset', 'readonly', 'local']);
  const assignmentsOf = words => {
    if (EXPORTERS.has(basename(words[0] ?? ''))) return words.slice(1).filter(isAssignment);
    const out = []; for (const w of words) { if (!isAssignment(w)) break; out.push(w); }
    return [...out, ...(commandWords(words)?.assignments ?? []).filter(w => !out.includes(w))];
  };
  const assignments = segments.flatMap(words => assignmentsOf(words).map(w => ({ words, w })));
  // A variable set alone (`x=…;`) reaches the commands of the line when it is exported (`export x`, `set -a`) or is one
  // of git's own (`GIT_TRACE=…; git status`).
  const exported = name => /^GIT_/.test(name) || /(?:^|[\s;&|(])set\s+(?:-[A-Za-z]*a|-o\s+allexport)/.test(String(command)) ||
    segments.some(s => EXPORTERS.has(basename(s[0] ?? '')) && s.slice(1).includes(name));
  // Variables the line sets to a piece of a store path (`d=.git/ap`, `d=.gi`), or to a value built on such a variable
  // (`e=${d}t`): a computed path that uses one of them by name may be the store. `.github`, `.gitignore` are no piece.
  const pieceNames = [];
  for (let changed = true; changed;) {
    changed = false;
    for (const { w } of assignments) {
      const [, n, v] = /^([A-Za-z_]\w*)=(.*)$/.exec(w);
      if (pieceNames.includes(n) || !v) continue;
      if (storePiece(v) || pieceNames.some(p => new RegExp(`\\$\\{?${p}\\b`).test(v))) { pieceNames.push(n); changed = true; }
    }
  }
  // A computed path read after a cd into a Git directory (`cd .git && rm -rf "$x"`, `cd .. ` into `proj.git`) may be the store too.
  const inGitDir = () => reached.some(d => /(?:^|\/)[^/]*\.git$/.test(d) || /(?:^|\/)\.git\//.test(d));
  const computedStore = arg => /[$`]/.test(arg) && (/\/apv\/?$/.test(arg) || /\.git?(?![A-Za-z])|(?:^|\/)apv?(?:\/|$)/.test(arg.replace(/\$\{?\w+\}?/g, '')) ||
    pieceNames.some(n => new RegExp(`\\$\\{?${n}\\b`).test(arg)) || inGitDir());
  // A variable set to a path in a store (`GIT_TRACE=.git/apv/receipts/x git status`, `export GIT_TRACE=…; git status`):
  // written by a command of the line. Set alone and kept local (`f=.git/apv/x; jq . "$f"`), it only names a path.
  for (const { words, w } of assignments) {
    const name = w.slice(0, w.indexOf('='));
    const alone = !EXPORTERS.has(basename(words[0] ?? '')) && assignmentsOf(words).length === words.length;
    if (alone && !exported(name)) continue;
    const value = w.slice(w.indexOf('=') + 1);
    if (mayBeStore(at(value, dir)) || mayBeStore(value) || computedStore(value)) return REASONS.anchorStore;
  }
  // What an interpreter reads on its standard input: its own heredoc or here-string, or the line piped into it.
  const pipedInto = tool => new RegExp(`\\|\\s*(?:\\S*/)?${tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(String(shadow ?? command));
  const fed = Object.values(scripts).flat().join('\n');
  // Whether a command of the line may write what a glob names: a writer, an editor, an in-place edit, a loop, `set --`,
  // xargs, or find that deletes or runs.
  const EDITING = new Set(['for', 'set', 'ed', 'ex', 'vi', 'vim', 'nvim', 'nano', 'emacs', 'xargs', 'parallel']);
  const lineWrites = segments.some(s => {
    const c = commandWords(s)?.words ?? s;
    const t = basename(c[0] ?? '');
    if (STORE_WRITERS.has(t) || EDITING.has(t)) return true;
    if (t === 'find') return c.some(a => a === '-delete' || a.startsWith('-exec') || a.startsWith('-ok'));
    if (['sed', 'gsed', 'perl', 'ruby'].includes(t)) return c.some(a => /^-[A-Za-z]*i/.test(a));
    if (AWKS.has(t)) return c.some(a => a === 'inplace' || /^--include=inplace$/.test(a)) || interpreterParts(t, c.slice(1)).scripts.some(x => />|system/.test(x));
    return false;
  });
  for (const [index, words] of segments.entries()) {
    const moved = cdTarget(words, dir, home);
    if (moved !== undefined) {
      // A relative cd may lead elsewhere through CDPATH: the folder is unknown when CDPATH is in the environment, when the
      // line names it in any way (read with quotes removed: `printf -v CDPATH`, `export CDPAT''H=`, `declare -n c=CDPATH`),
      // builds a name starting with CD (`export CD$x=`), or runs a text it does not show (`eval`, `source`, `.`).
      const cdArg = words.slice(1).find(a => !a.startsWith('-'));
      const lineSetsCdpath = /CDPATH|\bCD\w*\$/.test(flatten(String(command)))
        || segments.some(w => ['eval', 'source', '.'].includes(basename((commandWords(w)?.words ?? w)[0] ?? '')));
      const viaCdpath = cdArg !== undefined && !/^(?:\/|~|\.\.?(?:\/|$))/.test(cdArg) && (process.env.CDPATH || lineSetsCdpath);
      if (moved !== null && !viaCdpath) { dir = moved; dirs.push(moved); reached.push(moved); } else cdComputed = true;
      continue;
    }
    let cw = commandWords(words)?.words ?? words;
    // busybox rm, toybox mv: the applet is the command.
    if (['busybox', 'toybox'].includes(basename(cw[0] ?? '')) && cw.length > 1) cw = cw.slice(1);
    const tool = basename(cw[0] ?? '');
    const args = cw.slice(1).filter(a => !a.startsWith('-'));
    // A glob that may reach into a store, whatever reads it.
    // A glob that may reach into a store: refused, except for one reading command alone on its line, without redirection,
    // that cannot reach a store of the anchor (`cat .git/apv/receipts/*.json`). Paths are normalized first (`..`, `.`).
    // A command is known by its name only as the command of the system: written without a folder (or from /bin,
    // /usr/bin), on a line that changes neither the commands names lead to (PATH set, `hash`, `enable`) nor that name
    // (a function or an alias of it).
    const toolName = tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const flatLine = flatten(String(command));
    const systemTool = (!/\//.test(cw[0] ?? '') || /^\/(?:usr\/)?bin\/[^/]+$/.test(cw[0] ?? ''))
      // PATH set as an assignment: before the command of a segment, or a segment of assignments only (`echo PATH=x` is text).
      && !segments.some(w => { const c = commandWords(w)?.words ?? []; return w.slice(0, w.length - c.length).some(a => a.startsWith('PATH=')); })
      && !segments.some(w => {
        // `hash`, `enable`, a sourced or evaluated text, or a builtin that sets PATH by name (`printf -v PATH`, `read PATH`).
        const c = commandWords(w)?.words ?? w; const n = basename(c[0] ?? '');
        return ['hash', 'enable', 'source', '.', 'eval'].includes(n)
          || (['printf', 'read', 'mapfile', 'readarray', 'declare', 'typeset', 'export', 'local', 'readonly'].includes(n)
            && c.slice(1).some(a => /(?:^|^-[A-Za-z]*v|=)PATH(?:=|$)/.test(a)));
      })
      && !new RegExp(`(?:^|[\\s;&|(])(?:function\\s+${toolName}\\b|${toolName}\\s*\\(\\s*\\))|\\balias\\s+${toolName}=`).test(flatLine);
    const alone = segments.length === 1 && !/[<>]/.test(String(shadow ?? ''));
    const reader = GLOB_READERS.has(tool) && systemTool && alone && !lineWrites;
    for (const arg of args) {
      const path = resolve(dir ?? '/', at(arg, dir));
      if (GLOB.test(arg) && (mayBeStore(dirname(path)) || mayBeStore(dirname(at(arg, dir)))) && (!reader || mayReachAnchor(path))) return REASONS.anchorStore;
      // A path that climbs (`..`) into a store of the anchor names it once normalized.
      if (/(?:^|\/)\.\.(?:\/|$)/.test(arg) && /\.git\/apv\/(?:operator|reviews|merges)(?:\/|$)/.test(path)) return REASONS.anchorStore;
    }
    // ripgrep that runs a program on what it searches (`rg --pre rm '' .git/apv`): that program may write anywhere it
    // walks, the stores included, without naming them. Never needed to read the receipts: refused.
    if (tool === 'rg' && cw.slice(1).some(a => RG_RUNS.test(a))) return REASONS.anchorStore;
    // The file a command writes by an option (`sort -o`, `curl -o`, `wget -O`, `dd of=`, `tree -o`).
    for (const path of outputsOf(tool, cw.slice(1))) if (mayBeStore(at(path, dir)) || mayBeStore(path) || computedStore(path)) return REASONS.anchorStore;
    // An interpreter given a script on its command line, whatever its options (`perl -MFile::Path -le`, `ruby -x -e`,
    // `awk -- '…'`): refused when anything of its command line names the store folder or an operand may lie in it. Only a
    // script file it runs (`python3 tools/inspect.py .git/apv/receipts`) is not judged here.
    if (INTERPRETERS.has(tool) || AWKS.has(tool)) {
      const { scripts: texts, operands } = interpreterParts(tool, cw.slice(1));
      const inline = AWKS.has(tool) || texts.length > 0 || cw.slice(1).some(a => /^-[a-zA-Z0-9]*[ceEpr]/.test(a) || /^--(?:eval|print|exec)/.test(a));
      if (inline && /\.git\W{1,4}apv\b/.test(flatten([...cw.slice(1), ...(scripts[index] ?? [])].join(' ')))) return REASONS.anchorStore;
      if (inline && cw.slice(1).some(o => !o.startsWith('-') && (mayBeStore(at(o, dir)) || mayBeStore(o) || computedStore(o)))) return REASONS.anchorStore;
      // Without a script file, it runs what it reads on its standard input: its own heredoc or here-string, or a pipe.
      const stdinScript = !texts.length && (cw.slice(1).includes('-') || !operands.length);
      const input = [...(scripts[index] ?? []), ...(pipedInto(tool) ? [fed] : [])].join('\n');
      if (stdinScript && /\.git\W{1,4}apv\b/.test(flatten(input))) return REASONS.anchorStore;
    }
    const fedByLine = words.slice(0, words.length - cw.length).some(w => ['xargs', 'parallel'].includes(basename(w))) || tool === 'xargs';
    const inPlace = ['sed', 'gsed', 'perl'].includes(tool) && cw.some(a => /^-[A-Za-z]*i/.test(a) || a.startsWith('--in-place'));
    if (tool === 'find') {
      const acts = cw.some((a, k) => a === '-delete' || (['-exec', '-execdir', '-ok', '-okdir'].includes(a) && (STORE_WRITERS.has(basename(cw[k + 1] ?? '')) || EXECUTORS.has(basename(cw[k + 1] ?? '')))));
      if (!acts) continue;
      const starts = cw.slice(1, Math.max(1, cw.findIndex((a, k) => k > 0 && a.startsWith('-'))));
      const names = cw.filter((a, k) => ['-name', '-iname', '-path', '-ipath', '-wholename', '-regex', '-iregex'].includes(cw[k - 1] ?? ''));
      if (starts.some(s => mayBeStore(at(s, dir)) || mayBeStore(`${at(s, dir)}/apv`)) || names.some(n => globMayMatch(n.split('/').pop() ?? n, 'apv') || /apv/.test(n))) return REASONS.anchorStore;
      continue;
    }
    // Any command handed a store is taken for a writer, except the ones known to only read: a program unknown to the
    // guard may write its operands (`python3 -m json.tool forged.json .git/apv/receipts/r.json`, `deno run x.ts …`).
    // A bare assignment (`f=.git/apv/receipts/r.json`) runs nothing.
    if (!cw.length || /^[A-Za-z_]\w*=/.test(cw[0])) continue;
    const writer = STORE_WRITERS.has(tool) || inPlace;
    // ripgrep reads its options from the file RIPGREP_CONFIG_PATH names (`--pre=rm` written there earlier): set on the
    // line or in the environment, rg may run any program on what it walks.
    // Set, not cited: an assignment, `export`/`declare`/`read`… of it, or `printf -v` (`echo RIPGREP_CONFIG_PATH` is text).
    // Read with quotes and backslashes removed (`export RIPGREP_CONF''IG_PATH=…`).
    const text = flatten(String(command));
    const rgConfig = /\bRIPGREP_CONFIG_PATH=/.test(text) || /\b(?:export|declare|typeset|readonly|local|read)\b[^;&|\n]*\bRIPGREP_CONFIG_PATH\b/.test(text) ||
      /\bprintf\s+-v\s*RIPGREP_CONFIG_PATH\b/.test(text) || Boolean(process.env.RIPGREP_CONFIG_PATH);
    if (tool === 'rg' && rgConfig) return REASONS.anchorStore;
    // A recursive read handed the Git directory or the store folder walks into the stores of the anchor
    // (`grep -r . .git/apv`, `rg '' .git`, `diff -r .git/apv x`, `zcat -rf .git/apv`) without naming them. The pattern
    // searched, the first operand of grep or rg when no `-e` or `-f` gives it, is no path (`grep -rn ".git" src`).
    const opts = cw.slice(1);
    const greps = ['grep', 'egrep', 'fgrep'].includes(tool);
    const recursive = tool === 'rg'
      || (greps && opts.some((a, k) => /^-[a-zA-Z]*[rR]/.test(a) || /^--(?:recursive|dereference-recursive|directories=recurse)$/.test(a) || /^-[a-zA-Z]*drecurse$/.test(a)
        || ((a === '--directories' || /^-[a-zA-Z]*d$/.test(a)) && opts[k + 1] === 'recurse')))
      || (['diff', 'zcat', 'gzip', 'gunzip'].includes(tool) && opts.some(a => /^-[a-zA-Z]*r/.test(a) || a === '--recursive'));
    const patternGiven = opts.some(a => /^-[a-zA-Z]*[ef]/.test(a) || /^--(?:regexp|file)(?:=|$)/.test(a));
    // The operands of grep or rg, the values of their options that take a separate one skipped (`rg -t js x .git`).
    const valued = greps ? GREP_VALUED : tool === 'rg' ? RG_VALUED : null;
    const operands = valued ? opts.filter((a, k) => !a.startsWith('-') && !valued.has(opts[k - 1] ?? '')) : args;
    const named = valued && !patternGiven ? operands.slice(1) : operands;
    // Without a path, grep -r and rg search the folder they run in.
    const searched = named.length ? named : [dir ?? '.'];
    // rg, no longer a reader, run from inside a store without a path, reaches what it walks there.
    if (tool === 'rg' && !named.length && dir && mayBeStore(dir)) return REASONS.anchorStore;
    // After a cd the guard cannot follow, the folder is unknown: a recursive search without a path, or with a relative
    // one, may walk the stores.
    if (recursive && cdComputed && (!named.length || named.some(a => !isAbsolute(a)))) return REASONS.anchorStore;
    if (recursive && searched.some(a => { const p = resolve(dir ?? '/', at(a, dir)); return mayReachAnchor(join(p, 'apv', 'operator')) || mayReachAnchor(join(p, 'operator')); })) return REASONS.anchorStore;
    if (!writer && READS_ONLY.has(tool) && systemTool) continue;
    // What another program reads on its standard input (`python3 x.py - < .git/apv/receipts/r.json`, `<f`) is not
    // handed to it. A `<` the shell does not read as a redirection (escaped or quoted: blank in the shadow) is a word: as
    // soon as the words of the line hold more `<` than the shadow holds plain input redirections (a heredoc `<<`, a
    // here-string `<<<`, `<&` and `<>` are not counted), none of them is exempted.
    const realLt = (String(shadow ?? '').match(/(?<!<)<(?![<&>])/g) ?? []).length;
    const wordLt = segments.flat().filter(w => /^\d*</.test(w)).reduce((n, w) => n + (w.match(/</g) ?? []).length, 0);
    const redirects = realLt > 0 && wordLt <= realLt;
    const plainArgs = writer ? args : cw.slice(1).filter((a, k, all) => !a.startsWith('-') && !(redirects && (/^\d*</.test(a) || /^\d*<$/.test(all[k - 1] ?? ''))));
    // A value given with its option (`--out=<path>`, `-C<path>`) is a path the program receives, like an operand.
    const optionValues = cw.slice(1).flatMap(a => {
      const m = /^--[\w-]+=(.+)$/.exec(a) ?? (a.startsWith('--') ? null : /^-[A-Za-z](.+)$/.exec(a));
      return m ? [m[1]] : [];
    });
    const handed = [...plainArgs, ...optionValues];
    for (const arg of fedByLine ? [...handed, ...lineWords] : handed) {
      // A computed path that ends in apv, holds a piece of a store path, or uses a variable the line set to one
      // (`$d/apv`, `d=.git/ap; rm -rf ${d}v`, `d=.gi; e=ap; rm -rf ${d}t/${e}v`): it may be the store.
      if (computedStore(arg)) return REASONS.anchorStore;
      if (mayBeStore(at(arg, dir)) || mayBeStore(arg)) return REASONS.anchorStore;
      // After a cd the guard cannot follow (`G=.git; cd "$G"`), a relative path that may name the store is one.
      if (cdComputed && !isAbsolute(arg) && globMayMatch(arg.replace(/^\.\//, '').split('/')[0], 'apv')) return REASONS.anchorStore;
      // When that cd may lead into the store folder itself (the line names `.git`, `apv` or CDPATH, or CDPATH is in the
      // environment), any relative path may be a store (`cd apv && rm -rf operator`).
      if (cdComputed && !isAbsolute(arg) && (/\.git|\bapv\b|CDPATH/.test(flatten(String(command))) || process.env.CDPATH)) return REASONS.anchorStore;
    }
    // An unquoted substitution followed by `/apv` is split from its command by the tokenizer: read in the line.
    for (const m of String(command).matchAll(/[)`]\/+([^\s/;&|'"<>()]+)/g)) if (globMayMatch(m[1], 'apv')) return REASONS.anchorStore;
    // A Git directory followed by a substitution (`rm -rf .git/$(echo apv)`): the rest of the path is computed.
    if (/\.git\/+(?:\$\(|`)/.test(String(command))) return REASONS.anchorStore;
  }
  // A redirection into a store empties or replaces what is there, whatever the command (`: > …`, `exec 3> …`, `1<> …`,
  // `>& f`). The operator is read in the shadow of the line (quoted text blanked, same positions), so `grep -c '>' f` is
  // no redirection; its target is read in the line, quotes and backslashes removed (`.git/"apv"`, `a\pv`).
  if (shadow) {
    for (const m of shadow.matchAll(/(?<![<>&])(?:\d+|&)?(?:<>|>{1,2}[|&]?)/g)) {
      const rest = String(command).slice(m.index + m[0].length).trimStart();
      const raw = /^(?:"[^"]*"|'[^']*'|\\.|[^\s;&|<>()"'\\])+/.exec(rest)?.[0];
      const target = raw === undefined ? null : flatten(raw);
      if (!target || /^(?:\d+|-)$/.test(target)) continue;
      if (dirs.some(d => mayBeStore(at(target, d))) || mayBeStore(target) || computedStore(target)) return REASONS.anchorStore;
    }
  }
  return null;
}

/** Why an `rm` (or another writer of `STORE_WRITERS`) of these words reaches the stores of the tool, or null. */
export function removesStore(words, cwd = null) {
  return storeProblem([words], cwd);
}

/**
 * A base64 decode: `base64` or `basenc` with `-d`, `-D`, `--decode` or a group of short options that holds one (`-di`),
 * or `openssl base64|enc … -d`.
 */
const DECODE = String.raw`(?:\b(?:base64|basenc)\b[^)\x60;&|\n]*?(?:\s-[A-Za-z]*[dD][A-Za-z]*\b|\s--decode\b)|\bopenssl\s+(?:base64|enc)\b[^)\x60;&|\n]*?\s-d\b)`;
/** The last command of a pipe that only reads data, its output to the screen (no pipe, no redirection after it): `jq .`, `sha256sum`. */
const DATA_READER = /^\s*(?:jq|sha\d*sum|md5sum|b2sum|cksum|wc|xxd|od|hexdump|file|cmp)\b[^|<>]*$/;

/**
 * Whether a command decodes base64 and may use the result (docs/REGLES.md): the guards could no longer read what it
 * touches. Refused: a decode inside a substitution (`$(…)`, backquotes, `<(…)`, `>(…)`), a decode followed by a pipe
 * (whatever reads it: a shell, `tee` then a shell, `xargs`...) other than one last reader of data (`| jq .`, `| sha256sum`),
 * and a decode written to a file that the same command names again (`base64 -d x > p; sh p`). A decode into a file
 * nothing reads again (`base64 -d x > f.bin`) is data.
 */
export function decodedAndUsed(command) {
  if (typeof command !== 'string') return false;
  if (new RegExp(String.raw`[$<>]\([^)]*${DECODE}`).test(command) || new RegExp(String.raw`\x60[^\x60]*${DECODE}`).test(command)) return true;
  const piped = new RegExp(String.raw`${DECODE}[^;&|\n]*\|(?!\|)([^;&\n]*)`, 'g');
  for (const m of command.matchAll(piped)) if (!DATA_READER.test(m[1])) return true;
  const written = new RegExp(String.raw`${DECODE}[^;&|\n]*?(?:>>?|\s-o)\s*([^\s;&|<>()]+)`, 'g');
  for (const m of command.matchAll(written)) {
    const file = m[1].replace(/^['"]|['"]$/g, '');
    const rest = command.slice(m.index + m[0].length);
    const name = basename(file);
    if (rest.includes(file) || (name && new RegExp(String.raw`(?:^|[\s/'"=<>])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[\s;&|)'"])`).test(rest))) return true;
  }
  return false;
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
  if (words[i] !== 'push' && words[i] !== 'send-pack') return false;
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
export function pushToDefault(words, defaults = ['main', 'master'], ...branch) {
  // No default value for the branch: `undefined` (a folder the guard cannot follow) is not `null` (no branch checked out).
  const current = branch.length ? branch[0] : null;
  const at = commandIndex(words, 'git');
  if (at === -1) return null;
  let i = at + 1;
  while (i < words.length && words[i].startsWith('-')) i += GIT_WITH_VALUE.has(words[i]) ? 2 : 1;
  // `git send-pack <remote> <refs>` pushes as `git push` does; without refs, it updates the branches both sides have.
  const sendPack = words[i] === 'send-pack';
  if (words[i] !== 'push' && !sendPack) return null;
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
  // `@` alone is HEAD for git.
  const name = ref => { const n = ref.replace(/^\+/, '').replace(/^refs\/heads\//, ''); return n === '@' ? 'HEAD' : n; };
  // The branch of a folder the guard cannot follow (`undefined`): the push may go to the default branch.
  const head = current === undefined ? defaults[0] ?? 'main' : current;
  if (!specs.length && sendPack) return defaults[0] ?? 'main';
  if (!specs.length) return head && defaults.includes(head) ? head : null;
  for (const spec of specs) {
    // `:` alone pushes every branch that has a namesake on the remote, the default one included.
    if (spec.replace(/^\+/, '') === ':') return defaults[0] ?? 'main';
    const [src, dst] = spec.includes(':') ? spec.split(':') : [spec, spec];
    const raw = (dst === '' ? src : dst).replace(/^\+/, '');
    const target = name(raw) === 'HEAD' ? head : name(raw);
    if (target && defaults.includes(target)) return target;
    // A destination git completes or a pattern (`heads/main`, `refs/*:refs/*`, `r*:r*`, `m*`) that may name the default
    // branch, compared with its short and full names.
    const names = d => [d, `heads/${d}`, `refs/heads/${d}`];
    const hit = defaults.find(d => names(d).includes(raw) || (GLOB.test(raw) && names(d).some(n => globMayMatch(raw, n))));
    if (hit) return hit;
  }
  return null;
}

/** Variables that move Git or gh to another repository, or `cd` to another folder: in the line or in the environment. */
const SCOPE_VARIABLE = /^(?:GIT_(?!(?:TERMINAL_PROMPT|PAGER|EDITOR|SEQUENCE_EDITOR|AUTHOR_(?:NAME|EMAIL|DATE)|COMMITTER_(?:NAME|EMAIL|DATE)|TRACE\w*|MERGE_AUTOEDIT|ASKPASS|OPTIONAL_LOCKS|FLUSH)$)\w+|GH_(?:REPO|HOST|CONFIG_DIR)|CDPATH)$/;
/** Global options of git that change nothing of where it acts. Any other (`-C`, `-c`, `--git-dir`, `--work-tree`...) does. */
const GIT_NEUTRAL = new Set(['--no-pager', '-p', '--paginate', '-P', '--no-replace-objects', '--literal-pathspecs', '--no-optional-locks', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs']);
/** Commands that run a text of their own (shells, eval, source, xargs...): their commands are not read from here. */
const OPAQUE = new Set([...['sh', 'bash', 'dash', 'zsh', 'ksh', 'mksh', 'ash', 'fish', 'csh', 'tcsh'], 'eval', 'source', '.', 'xargs', 'parallel', 'busybox', 'toybox', 'su',
  'script', 'watch', 'unbuffer', 'ssh', 'alias', 'unalias', 'function', 'popd', 'builtin', 'enable', 'hash']);

/**
 * Whether a command keeps to the repository of its working directory in a shape this guard reads whole (docs/PLUGIN.md,
 * « Portée des crochets »), and what it reaches there: `{ plain, dirs, remotes, slugs }`. The guards are relaxed outside
 * a project of the tool only for a plain command; anything this guard cannot read to the end makes it not plain, so the
 * tool stays active: a substitution, a variable, a heredoc or here-string, `<(…)`; a shell, eval, source, xargs or an
 * unknown wrapper in front of git or gh; `env -C`, `sudo -D` and other options of a wrapper; GIT_*, GH_REPO or CDPATH set
 * in the line or in the environment; a `cd` or `pushd` that is not literal; any global option of git that is not neutral
 * (`-C`, `-C<p>`, `-c`, `--git-dir`...); a push to an address or a path, or with `--repo`; `git config` or `git remote`
 * changing a remote; gh with `-R`, `--repo`, `--hostname` or an address; a GraphQL call. `dirs` are the literal `cd`
 * targets, `remotes` the remote names reached (`*`: whichever gh or a push without remote picks), `slugs` the
 * `owner/repo` of an API call.
 */
export function commandScope(command, segments, cwd = null, home = null, env = {}) {
  const scope = { plain: true, dirs: [], remotes: [], slugs: [] };
  const stop = () => { scope.plain = false; return scope; };
  if (typeof command !== 'string' || /[$`]|<<|<\(|>\(/.test(command)) return stop();
  if (Object.keys(env).some(k => SCOPE_VARIABLE.test(k) && env[k])) return stop();
  let dir = cwd;
  // In the line, HOME and XDG_CONFIG_HOME also count: they choose the configuration git reads (`pushInsteadOf`...).
  const lineVariable = name => SCOPE_VARIABLE.test(name) || name === 'HOME' || name === 'XDG_CONFIG_HOME';
  for (const words of segments) {
    if (words.some(w => lineVariable(w.split('=')[0]) && w.includes('='))) return stop();
    const lead = basename(words[0] ?? '');
    if (['cd', 'pushd'].includes(lead)) {
      const target = cdTarget(words, dir, home);
      const arg = words.slice(1).find(a => !a.startsWith('-'));
      // A relative cd may follow CDPATH: only `./`, `../` or an absolute path, read without it.
      if (!target || (arg !== undefined && !/^(?:\/|~|\.\.?(?:\/|$))/.test(arg) && env.CDPATH)) return stop();
      scope.dirs.push(target);
      dir = target;
      continue;
    }
    if (['export', 'declare', 'typeset', 'readonly', 'local', 'set', 'unset', 'read', 'printf', 'mapfile', 'readarray', 'getopts'].includes(lead) && words.some(w => lineVariable(w.split('=')[0]))) return stop();
    const cw = commandWords(words);
    if (!cw) continue;
    const prefix = words.slice(0, words.length - cw.words.length);
    // xargs or parallel run what they read; options of env, sudo, doas may move or rewrite the command (-C, -D, -S, -i...).
    if (prefix.some(w => ['xargs', 'parallel'].includes(basename(w)) || /^-(?:-chdir|-split-string|-login|-shell|-user|[A-Za-z]*[CDSisu])/.test(w))) return stop();
    const w = cw.words;
    const tool = basename(w[0] ?? '');
    if (OPAQUE.has(tool)) return stop();
    if (tool !== 'git' && tool !== 'gh' && w.slice(1).some(x => ['git', 'gh'].includes(basename(x)))) return stop();
    if (tool === 'git') {
      let k = 1;
      for (; k < w.length && w[k].startsWith('-'); k += 1) if (!GIT_NEUTRAL.has(w[k])) return stop();
      const sub = w[k];
      const args = w.slice(k + 1);
      if (sub === 'config' || (sub === 'remote' && args.some(a => ['add', 'set-url', 'rename', 'set-branches'].includes(a)))) return stop();
      // send-pack names its remote as an address or a path, with its own program: never a plain push.
      if (sub === 'send-pack') return stop();
      if (sub === 'push') {
        if (args.some(a => a === '--repo' || a.startsWith('--repo=') || a.startsWith('--receive-pack') || a.startsWith('--exec'))) return stop();
        const valued = new Set(['-o', '--push-option']);
        let remote;
        for (let j = 0; remote === undefined && j < args.length; j += 1) {
          if (args[j].startsWith('-')) { if (valued.has(args[j])) j += 1; continue; }
          remote = args[j];
        }
        if (remote === undefined) scope.remotes.push('*');
        else if (/[/:~]|^\./.test(remote)) return stop();
        else scope.remotes.push(remote);
      }
    }
    if (tool === 'gh') {
      const args = w.slice(1);
      if (args.some(a => /^(?:-R|--repo|--hostname)(?:=|$)|^-R./.test(a) || /^https?:\/\/|github\.com/i.test(a))) return stop();
      if (args[0] === 'api') {
        if (args.includes('graphql')) return stop();
        for (const a of args) { const m = /^\/?repos\/([^/\s]+)\/([^/\s?]+)/.exec(a); if (m) scope.slugs.push(`${m[1]}/${m[2]}`.toLowerCase()); }
      } else scope.remotes.push('*');
    }
    if (['curl', 'wget', 'http', 'https', 'xh', 'xhs'].includes(tool)) {
      if (w.some(a => /graphql/i.test(a))) return stop();
      for (const a of w) { const m = /\/repos\/([^/\s]+)\/([^/\s?]+)/.exec(a); if (m) scope.slugs.push(`${m[1]}/${m[2]}`.toLowerCase()); }
    }
  }
  return scope;
}

/**
 * The folder a git command acts in: `dir`, or its literal `-C` (resolved from `dir`); undefined when computed or unknown.
 * Any other command: `dir`.
 */
export function gitDirectory(cwords, dir, words = cwords, env = {}) {
  if (basename(cwords[0] ?? '') !== 'git') return dir;
  // Where git acts is moved by GIT_DIR or GIT_WORK_TREE, by `env -C` or `sudo -D` in front of it: unknown.
  const prefix = words.slice(0, words.length - cwords.length);
  if (env.GIT_DIR || env.GIT_WORK_TREE || prefix.some(w => /^(?:GIT_DIR|GIT_WORK_TREE)=/.test(w) || /^-(?:-chdir|[A-Za-z]*[CD])/.test(w))) return undefined;
  let where = dir;
  for (let k = 1; k < cwords.length && cwords[k].startsWith('-'); k += 1) {
    if (/^--(?:git-dir|work-tree)(?:=|$)/.test(cwords[k])) return undefined;
    const option = /^-C(.*)$/.exec(cwords[k]);
    if (!option) { if (GIT_WITH_VALUE.has(cwords[k])) k += 1; continue; }
    const value = option[1] || cwords[(k += 1)];
    if (value === undefined || /[$`~]/.test(value) || (where === null && !isAbsolute(value))) return undefined;
    // `git -C <folder that is not there>` fails before pushing: judged on that folder, whose branch reads as none.
    where = resolve(where ?? '/', value);
  }
  return where;
}

/**
 * How a git command changes the branch checked out: null (it does not), `{ created }` (`checkout -b x`, `switch -c x`),
 * or `{ unknown: true }` (any other switch, a checkout of a branch, `symbolic-ref HEAD …`). The global options of git
 * (`-C .`, `-c a=b`) are skipped before the subcommand. `git checkout -- f`, `git checkout <commit> <paths>` (two
 * operands or more: files taken from a commit), and a checkout of one path that exists in the folder and names no branch,
 * tag or remote branch (`git checkout package-lock.json`, never `git checkout main` beside a folder `main`), change no
 * branch.
 */
export function branchChange(cwords, dir = null) {
  if (basename(cwords[0] ?? '') !== 'git') return null;
  let k = 1;
  while (k < cwords.length && cwords[k].startsWith('-')) k += GIT_WITH_VALUE.has(cwords[k]) ? 2 : 1;
  const sub = cwords[k];
  const rest = cwords.slice(k + 1);
  if (sub === 'symbolic-ref') return rest.filter(a => !a.startsWith('-')).length > 1 ? { unknown: true } : null;
  if (sub !== 'switch' && sub !== 'checkout') return null;
  const create = rest.findIndex(a => ['-b', '-B', '-c', '-C', '--create', '--force-create', '--orphan'].includes(a));
  if (create !== -1) return rest[create + 1] && !/[$`]/.test(rest[create + 1]) ? { created: rest[create + 1] } : { unknown: true };
  if (sub === 'checkout' && rest.includes('--')) return null;
  const operands = rest.filter(a => !a.startsWith('-'));
  if (sub !== 'checkout' || operands.some(p => /[$`]/.test(p))) return { unknown: true };
  if (operands.length >= 2) return null;
  if (dir && operands.length === 1 && existsSync(resolve(dir, operands[0])) && !namesRef(dir, operands[0])) return null;
  return { unknown: true };
}

/** Whether `name` is a revision git would check out in `dir` (branch, tag, commit) or a remote branch it would follow. */
function namesRef(dir, name) {
  const run = args => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 });
  const rev = run(['rev-parse', '--verify', '--quiet', '--end-of-options', `${name}^{commit}`]);
  if (rev.status === 0 || rev.error) return true;
  const remote = run(['for-each-ref', '--count=1', '--format=%(refname)', `refs/remotes/*/${name}`]);
  return remote.status !== 0 || Boolean(remote.stdout.trim());
}

/** Whether a path is a folder that exists. */
const isDirectory = path => { try { return statSync(path).isDirectory(); } catch { return false; } };
/** Whether a cd to this path succeeds: a folder that exists and can be entered (x permission). */
const enterable = path => { try { accessSync(path, fsConstants.X_OK); return isDirectory(path); } catch { return false; } };

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
export function homeFolderProblem(words, flat, active = true) {
  const cw = commandWords(words);
  const w = cw ? cw.words : words;
  const tool = basename(w[0] ?? '');
  // Outside a project of the tool, a command that only sizes the home folder (du) never reads the key: allowed there.
  if (!active && tool === 'du') return null;
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
    // GET …/pulls/<n>/merge only asks whether the PR is merged; PUT (or fields, which make gh send a POST) merges.
    // Two methods (`-X GET -X PUT`) count as a write: gh applies the last one.
    const { writes } = ghApiOptions(args);
    if (writes && args.some(a => /(^|\/)pulls\/[^/\s]+\/merge\b/.test(a))) return { merge: true };
    if (writes) return { merge: false };
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
const APV_COMMANDS = new Set(['init', 'onboard', 'spec', 'run', 'stack', 'rules', 'audit', 'metrics', 'ledger', 'scope', 'gates', 'lock', 'wait', 'procs', 'stacks',
  'review', 'dast', 'db', 'design', 'structure', 'reuse', 'tests', 'map', 'quota', 'preview', 'web', 'status', 'help']);

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
    if (name === 'review' && (sub === 'record' || args.includes('record'))) return { words, domain: optionValue(args, '--domain') ?? null, reviewer: optionValue(args, '--reviewer') ?? null, commit: optionValue(args, '--commit') ?? null };
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
  scopeNote: "Ce dépôt n'est pas un projet APV, mais l'outil reste actif pour cette commande (docs/PLUGIN.md, « Portée des crochets ») : " +
    "sa forme n'est pas lue en entier (substitution, variable, shell, cd ailleurs, option de git ou de gh...), ou un dépôt distant qu'elle atteint " +
    "n'est pas vérifié (jamais récupéré : git fetch ; adresse de poussée différente). Écris-la simplement, récupère le dépôt distant, ou fais-la hors de Claude.",
  mergeOutside: "APV : fusion de PR bloquée sans autorisation explicite. Hors d'un projet sous APV, une fusion se fait seulement sur ordre " +
    "de l'opérateur, avec APV_ALLOW_MERGE=1 devant la seule commande (APV_ALLOW_MERGE=1 gh pr merge <pr>) ; dans un projet sous APV, " +
    'par apv stack merge.',
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
  toolVariable: 'APV : les variables internes de l\'outil (APV_ENTRY, APV_ANCHOR_KEY_FILE, APV_ATTESTATION_LOOPBACK) ne se posent pas à la main.',
  nestedClaude: 'APV : lancer claude depuis une session gérée par APV est refusé (sauf claude --version et claude -p /usage) : une session imbriquée échappe aux garde-fous des sous-agents ' +
    '(fusion, relecture). Les agents se lancent par l\'outil Agent du chef de projet. Une commande `claude plugin …` (installation, mise à jour) se tape dans un terminal, hors de Claude Code.',
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
  // The script is run by its shell: what was literal here (between apostrophes) is shell text there again.
  const script = text => (text === undefined ? null : text.replace(//g, '$').replace(//g, '`'));
  if (SHELLS.has(tool)) {
    const at = w.findIndex((x, k) => k > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(x));
    return at !== -1 ? script(w[at + 1]) : null;
  }
  if (tool === 'flock') {
    const at = w.findIndex((x, k) => k > 0 && (x === '-c' || x === '--command'));
    return at !== -1 ? script(w[at + 1]) : null;
  }
  if (tool === 'eval') return script(w.slice(1).join(' ')) || null;
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

function evaluate(command, env, context, depth, inherited, activeAbove = false, start = null) {
  if (typeof command !== 'string' || command.trim() === '') return { decision: 'allow' };
  if (anchorInCommand(command)) return { decision: 'deny', reason: REASONS.anchorStore };
  const flat = flatten(command);
  const mergeApi = mergeApiInCommand(command);
  const { segments, shadow, scripts, after } = tokenize(command);
  // Where the tool is active (docs/PLUGIN.md, « Portée des crochets »), every rule; elsewhere, the rules that protect the
  // key and the stores of every project, and the ones that held before the rules. Relaxed only for a plain command
  // (commandScope) whose repository, folders and remotes are known to be outside the tool (context.apvProject); a merge
  // through the API that names no repository cannot be placed. A script run by a command of an active line stays active.
  const scope = commandScope(command, segments, context.cwd ?? null, context.home ?? null, env);
  if (mergeApi && !scope.slugs.length) scope.plain = false;
  const active = activeAbove || !context.apvProject || !scope.plain || context.apvProject(scope) !== false;
  // A refusal in a repository outside the tool says why the tool stays active there (docs/PLUGIN.md, « Portée »).
  const explain = reason => (context.apvProject && context.apvProject({ plain: true, dirs: [], remotes: [], slugs: [] }) === false ? `${reason} ${REASONS.scopeNote}` : reason);
  if (mergeApi) {
    if (context.agentId) return { decision: 'deny', reason: REASONS.mergeBySubagent };
    if (active) return { decision: 'deny', reason: explain(REASONS.rawMerge) };
    // The authorisation is set for the command that merges (or in the environment), never elsewhere in the line.
    const merging = segments.filter(w => MERGE_API.test(flatten(w.join(' '))));
    if (env.APV_ALLOW_MERGE !== '1' && !merging.some(w => authorised(w, 'APV_ALLOW_MERGE', env))) return { decision: 'deny', reason: REASONS.mergeOutside };
  }
  if (active && /--git-common-dir/.test(flat) && !/^\s*git\s+rev-parse(\s+--path-format=(absolute|relative))?\s+--git-common-dir\s*$/.test(flat)) return { decision: 'deny', reason: REASONS.commonDir };
  if (active && /(^|[\s;&|(])eval\b/.test(flat) && /\bapv\b|cli\.js/.test(flat)) return { decision: 'deny', reason: REASONS.computedApv };
  if (/\bAPV_ENTRY\b|\bAPV_ANCHOR_KEY_FILE\b|\bAPV_ATTESTATION_LOOPBACK\b/.test(flat)) return { decision: 'deny', reason: REASONS.toolVariable };
  if (decodedAndUsed(command) || decodedAndUsed(flat)) return { decision: 'deny', reason: REASONS.encodedPath };
  // A script or substitution run by a command of the line is judged in the folder where that command runs.
  const store = storeProblem(segments, start && start.known ? start.dir : context.cwd ?? null, context.home ?? null, command, shadow, scripts);
  if (store) return { decision: 'deny', reason: store };
  let writesGithub = false;
  const kill = killProblem(segments, context.ancestors);
  if (kill) return { decision: 'deny', reason: kill };
  const install = installProblem(segments, context.cwd, context.home);
  if (install) return { decision: 'deny', reason: install };
  // The declared stacks are read (git, config) only for a command that may reach one.
  const stacks = /\b(docker|podman|supabase)\b/.test(command) ? context.stacks() : [];
  // The folder each simple command runs in (literal cd, git -C): its branch decides where a push without refspec goes.
  // A cd the guard cannot follow leaves it unknown (undefined): such a push counts as one to the default branch.
  // A script or a substitution run by a command of the line starts where that command runs (`start` from the line above).
  let dir = start ? start.dir : context.cwd ?? null; let dirKnown = start ? start.known : true; let branchSet = start ? start.branch : null;
  // A branch the line created holds only along the chain of `&&` that follows its creation.
  let created = false;
  for (const [index, words] of segments.entries()) {
    if (created && index > 0 && after[index - 1] !== '&&') { created = false; branchSet = null; dirKnown = false; }
    // Only a cd to a folder that exists and can be entered is followed. One that fails leaves the shell where it was
    // (`cd nope || git push`, `cd /root; git push`), and one to a folder the line itself creates (`git clone u x && cd x &&
    // git push`) cannot be read now: both make the folder unknown, as do `builtin cd` to such a folder, a substitution
    // anywhere in the words of the cd (cut out by the tokenizer: `cd -P $(…)`), and a relative target with CDPATH set.
    const cdWords = basename(words[0] ?? '') === 'builtin' ? words.slice(1) : words;
    const moved = cdTarget(cdWords, dir, context.home ?? null);
    if (moved !== undefined) {
      const arg = cdWords.slice(1).find(a => !a.startsWith('-'));
      // CDPATH named in any way on the line, a name built from CD, or a text run unseen: as in the store guard.
      const lineSetsCdpath = /CDPATH|\bCD\w*\$/.test(flatten(String(command)))
        || segments.some(w => ['eval', 'source', '.'].includes(basename((commandWords(w)?.words ?? w)[0] ?? '')));
      const viaCdpath = arg !== undefined && !/^(?:\/|~|\.\.?(?:\/|$))/.test(arg) && (env.CDPATH || lineSetsCdpath);
      const computed = arg === undefined && /(?:^|[\s;&|(])(?:builtin\s+)?(?:cd|pushd)(?:\s+-\S*)*\s+[$`]/.test(command);
      if (moved === null || viaCdpath || computed || !enterable(moved)) dirKnown = false;
      else { dir = moved; branchSet = null; }
    }
    // A write to a remote database (production): refused whatever the locks, no variable lifts it.
    const remote = remoteWriteProblem(words) ?? remoteWriteProblem(lockWrapper(words, stacks, context.cwd).words);
    if (remote) return { decision: 'deny', reason: remote };
    const wrapped = lockWrapper(words, stacks, context.cwd);
    const held = mergeHeld(inherited, wrapped.held);
    const stack = stacks.length ? stackProblem(wrapped.words, held, context, context.cwd) : null;
    if (stack) return { decision: 'deny', reason: stack };
    // The scripts a command runs: `sh -c`, `flock -c`, `eval`, a heredoc or a here-string read by a shell or by eval.
    const lead = basename((commandWords(wrapped.words)?.words ?? wrapped.words)[0] ?? '');
    const fed = SHELLS.has(lead) || ['eval', 'source', '.'].includes(lead) ? (scripts[index] ?? []) : [];
    const own = depth < MAX_NESTING ? nestedScript(wrapped.words) ?? nestedScript(words) : null;
    const inner = depth < MAX_NESTING ? [...(own !== null ? [own] : []), ...fed, ...words.flatMap(w => substitutions(w))] : [];
    for (const script of inner) {
      const nested = evaluate(script, env, context, depth + 1, held, active, { dir, known: dirKnown, branch: branchSet });
      if (nested.decision === 'deny') return nested;
    }
    // A branch changed by a command of such a script (`bash -c 'git switch main' && git push`): unknown for what follows.
    // Read in its commands, never in the text it carries (a commit message that cites `git checkout`).
    if (inner.some(s => tokenize(s).segments.some(w => branchChange(commandWords(w)?.words ?? w) !== null))) { dirKnown = false; branchSet = null; }
    if (isForcePush(words)) return { decision: 'deny', reason: REASONS.forcePush };
    const code = pluginCodeProblem(words, flat, context.cwd ?? null) ?? homeFolderProblem(words, flat, active);
    if (code) return { decision: 'deny', reason: code };
    const cwords = commandWords(words)?.words ?? words;
    if (active && nestedClaude(cwords, flat)) return { decision: 'deny', reason: REASONS.nestedClaude };
    let pushed = null;
    // A branch changed by a command of the line, for the commands after it: the new branch it names (`checkout -b x`,
    // `switch -c x`); unknown for any other switch, checkout of a branch or symbolic-ref (`git switch main && git push`).
    // `git checkout -- <file>` changes no branch.
    const change = branchChange(cwords, dir);
    if (change !== null) {
      // The new branch is believed only when the next command runs after its success (`&&`): after `;` or `||`, a
      // creation that failed (the branch exists) leaves the shell on the branch it was on. The operator is the one that
      // follows this very command, read by the tokenizer (`git checkout -b x main && …`, never an `x &&` further on).
      const followedByAnd = after[index] === '&&';
      // Made in this folder only: where git acts, as gitDirectory reads it (its global options, and what stands in front
      // of it or in the environment), must be the folder of the line.
      const sub = cwords.findIndex((w, k) => k > 0 && (w === 'checkout' || w === 'switch'));
      const here = dirKnown && gitDirectory(cwords, dir, words, env) === dir
        && !cwords.slice(1, sub === -1 ? undefined : sub).some(w => /^(?:-C|--git-dir|--work-tree)/.test(w));
      if (change.created && followedByAnd && here) { branchSet = change.created; created = true; }
      else if (change.created || change.unknown) { dirKnown = false; branchSet = null; created = false; }
    }
    if (active) {
      const where = gitDirectory(cwords, dir, words, env);
      const known = dirKnown && where !== undefined;
      const moved = known && where !== (context.cwd ?? null);
      const current = !known ? undefined : (branchSet && where === dir ? branchSet : (context.currentBranch ?? (() => null))(...(moved ? [where] : [])));
      pushed = pushToDefault(words, (context.defaultBranches ?? (() => ['main', 'master']))(...(moved ? [where] : [])), current);
    }
    if (pushed) return { decision: 'deny', reason: explain(REASONS.pushToDefault(pushed)) };
    const apvArgs = apvArguments(words);
    if (apvArgs && positional(apvArgs).slice(0, 2).some(w => /[$`]/.test(w))) return { decision: 'deny', reason: REASONS.computedApv };
    const review = reviewRecordProblem(words, context.agentType ?? null);
    if (review) return { decision: 'deny', reason: review };
    const raw = githubWrite(words);
    const write = raw ?? (isStackMerge(words) ? { merge: true } : null);
    if (write) {
      writesGithub = true;
      if (write.merge && context.agentId) return { decision: 'deny', reason: REASONS.mergeBySubagent };
      // A merge through gh skips the rules the tool checks before any merge: only apv stack merge merges (where the tool
      // is active; elsewhere, gh pr merge needs APV_ALLOW_MERGE=1, as before the rules).
      if (raw?.merge && active) return { decision: 'deny', reason: explain(REASONS.rawMerge) };
      if (write.merge && !authorised(words, 'APV_ALLOW_MERGE', env)) return { decision: 'deny', reason: raw?.merge && !active ? REASONS.mergeOutside : REASONS.merge };
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
