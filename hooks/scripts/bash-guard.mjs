#!/usr/bin/env node
// PreToolUse guard for the Bash tool (APV3 spec, sections 11 and 18.2).
// Blocks force-pushes, merges outside apv stack merge (gh pr merge and gh api …/merge always; apv stack merge without its
// explicit authorisation, or inside a subagent) and production deploys without their explicit authorisation, commands that write to GitHub while hiding their output (incident 30),
// and the harness mistakes of section 18.2 (harness-guard.mjs): kills that may reach the session, installs
// through a symlinked node_modules, docker or supabase commands on a declared test stack without its lock.
// This is a guard rail against mistakes, not a security boundary: a determined command can
// always be written in a shape this parser does not recognise.
import { existsSync, realpathSync, statSync } from 'node:fs';
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
  const feed = (owner, text) => { (scripts[owner] ??= []).push(text); };
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
  return { segments, shadow, heredocOwners, scripts };
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

/** Commands that delete, move, empty or copy away what they are given: handed a store, they reach it. */
const STORE_WRITERS = new Set(['rm', 'unlink', 'rmdir', 'shred', 'truncate', 'mv', 'cp', 'rsync', 'tar', 'zip', 'ln', 'chmod', 'chown', 'chgrp', 'install', 'setfacl', 'chattr',
  'tee', 'trash', 'trash-put', 'rmtrash', 'gio', 'sponge', 'gzip', 'gunzip', 'bzip2', 'xz', 'zstd']);
/** Options that name the file a command writes (`sort -o f`, `curl -o f`, `curl -so f`, `wget -qO f`, `dd of=f`), by command. */
const OUTPUT_OPTIONS = { sort: ['-o', '--output'], curl: ['-o', '--output'], wget: ['-O', '--output-document'], dd: ['of'] };
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
const inlineScript = (tool, args) => AWKS.has(tool) || (INTERPRETERS.has(tool) && args.some(a => /^-[a-zA-Z]*[ceEpr][a-zA-Z]*$/.test(a) || /^--(?:eval|print|exec)(?:=|$)/.test(a) || a === 'eval' || a === '-'));
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
  const dirs = [cwd];
  // Variables the line sets to a piece of a store path (`d=.git/ap`, `d=.gi`): a computed path that uses one of them
  // by name may be the store. `.github`, `.gitignore` are no piece.
  const pieceNames = lineWords.map(w => /^([A-Za-z_]\w*)=(.*)$/.exec(w)).filter(m => m && m[2] && storePiece(m[2])).map(m => m[1]);
  // A computed path read after a cd into a Git directory (`cd .git && rm -rf "$x"`) may be the store too.
  const inGitDir = () => dirs.some(d => d && /(?:^|\/)[^/]*\.git(?:\/|$)/.test(d));
  const computedStore = arg => /[$`]/.test(arg) && (/\/apv\/?$/.test(arg) || /\.git?(?![A-Za-z])|(?:^|\/)apv?(?:\/|$)/.test(arg.replace(/\$\{?\w+\}?/g, '')) ||
    pieceNames.some(n => new RegExp(`\\$\\{?${n}\\b`).test(arg)) || inGitDir());
  // A variable set to a path in a store (`GIT_TRACE=.git/apv/receipts/x git status`): written by the command.
  for (const w of lineWords) { const m = /^[A-Za-z_]\w*=(.+)$/.exec(w); if (m && (mayBeStore(at(m[1], dir)) || mayBeStore(m[1]))) return REASONS.anchorStore; }
  for (const [index, words] of segments.entries()) {
    const moved = cdTarget(words, dir, home);
    if (moved !== undefined) { if (moved !== null) { dir = moved; dirs.push(moved); } continue; }
    let cw = commandWords(words)?.words ?? words;
    // busybox rm, toybox mv: the applet is the command.
    if (['busybox', 'toybox'].includes(basename(cw[0] ?? '')) && cw.length > 1) cw = cw.slice(1);
    const tool = basename(cw[0] ?? '');
    const args = cw.slice(1).filter(a => !a.startsWith('-'));
    // A glob that may reach into a store, whatever reads it.
    for (const arg of args) if (GLOB.test(arg) && mayBeStore(dirname(at(arg, dir)))) return REASONS.anchorStore;
    // The file a command writes by an option (`sort -o`, `curl -o`, `wget -O`, `dd of=`).
    for (const path of outputsOf(tool, cw.slice(1))) if (mayBeStore(at(path, dir)) || mayBeStore(path) || computedStore(path)) return REASONS.anchorStore;
    // A script given on the command line that names the store folder (`python3 -c "shutil.rmtree('.git/apv')"`, awk);
    // a script file only read (`python3 tools/inspect.py .git/apv/receipts`) is not refused here.
    if (inlineScript(tool, cw.slice(1)) && /\.git\W{1,4}apv\b/.test(flatten([...cw, ...(scripts[index] ?? [])].join(' ')))) return REASONS.anchorStore;
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
    if (!STORE_WRITERS.has(tool) && !inPlace) continue;
    for (const arg of fedByLine ? [...args, ...lineWords] : args) {
      // A computed path that ends in apv, holds a piece of a store path, or uses a variable the line set to one
      // (`$d/apv`, `d=.git/ap; rm -rf ${d}v`, `d=.gi; e=ap; rm -rf ${d}t/${e}v`): it may be the store.
      if (computedStore(arg)) return REASONS.anchorStore;
      if (mayBeStore(at(arg, dir)) || mayBeStore(arg)) return REASONS.anchorStore;
    }
    // An unquoted substitution followed by `/apv` is split from its command by the tokenizer: read in the line.
    for (const m of String(command).matchAll(/[)`]\/+([^\s/;&|'"<>()]+)/g)) if (globMayMatch(m[1], 'apv')) return REASONS.anchorStore;
  }
  // A redirection into a store empties or replaces what is there, whatever the command (`: > …`, `exec 3> …`, `1<> …`,
  // `>& f`). The operator is read in the shadow of the line (quoted text blanked, same positions), so `grep -c '>' f` is
  // no redirection; its target is read in the line, quotes and backslashes removed (`.git/"apv"`, `a\pv`).
  if (shadow) {
    for (const m of shadow.matchAll(/(?<![<>=&-])(?:\d+|&)?(?:<>|>{1,2}[|&]?)/g)) {
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
export function pushToDefault(words, defaults = ['main', 'master'], ...branch) {
  // No default value for the branch: `undefined` (a folder the guard cannot follow) is not `null` (no branch checked out).
  const current = branch.length ? branch[0] : null;
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
  // The branch of a folder the guard cannot follow (`undefined`): the push may go to the default branch.
  const head = current === undefined ? defaults[0] ?? 'main' : current;
  if (!specs.length) return head && defaults.includes(head) ? head : null;
  for (const spec of specs) {
    const [src, dst] = spec.includes(':') ? spec.split(':') : [spec, spec];
    const target = name(dst === '' ? src : dst) === 'HEAD' ? head : name(dst === '' ? src : dst);
    if (target && defaults.includes(target)) return target;
    // A refspec pattern (`refs/heads/*:refs/heads/*`, `m*`) that may name the default branch.
    if (target && GLOB.test(target)) { const hit = defaults.find(d => globMayMatch(target, d)); if (hit) return hit; }
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
    if (['export', 'declare', 'typeset', 'readonly', 'local', 'set', 'unset'].includes(lead) && words.some(w => lineVariable(w.split('=')[0]))) return stop();
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
      if (sub === 'push') {
        if (args.some(a => a === '--repo' || a.startsWith('--repo=') || a === '--receive-pack' || a.startsWith('--exec'))) return stop();
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
    const next = resolve(where ?? '/', value);
    // `git -C <folder that is not there>` fails before pushing: nothing to judge there; keep the folder as it is.
    where = next;
  }
  return where;
}

/** Whether a path is a folder that exists. */
const isDirectory = path => { try { return statSync(path).isDirectory(); } catch { return false; } };

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
  toolVariable: 'APV : les variables internes de l\'outil (APV_ENTRY, APV_ANCHOR_KEY_FILE) ne se posent pas à la main.',
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
  if (SHELLS.has(tool)) {
    const at = w.findIndex((x, k) => k > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(x));
    return at !== -1 && w[at + 1] !== undefined ? w[at + 1] : null;
  }
  if (tool === 'flock') {
    const at = w.findIndex((x, k) => k > 0 && (x === '-c' || x === '--command'));
    return at !== -1 && w[at + 1] !== undefined ? w[at + 1] : null;
  }
  if (tool === 'eval') return w.slice(1).join(' ') || null;
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

function evaluate(command, env, context, depth, inherited, activeAbove = false) {
  if (typeof command !== 'string' || command.trim() === '') return { decision: 'allow' };
  if (anchorInCommand(command)) return { decision: 'deny', reason: REASONS.anchorStore };
  const flat = flatten(command);
  const mergeApi = mergeApiInCommand(command);
  const { segments, shadow, scripts } = tokenize(command);
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
  if (/\bAPV_ENTRY\b|\bAPV_ANCHOR_KEY_FILE\b/.test(flat)) return { decision: 'deny', reason: REASONS.toolVariable };
  if (decodedAndUsed(command) || decodedAndUsed(flat)) return { decision: 'deny', reason: REASONS.encodedPath };
  const store = storeProblem(segments, context.cwd ?? null, context.home ?? null, command, shadow, scripts);
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
  let dir = context.cwd ?? null; let dirKnown = true;
  for (const [index, words] of segments.entries()) {
    // A cd to a folder that is not there fails and leaves the shell where it was (`cd nope || git push`, `cd /x; git push`):
    // only a folder that exists is followed. `builtin cd`, a substitution as its target (cut out by the tokenizer, read as a
    // bare cd) or a relative target with CDPATH set: unknown.
    const cdWords = basename(words[0] ?? '') === 'builtin' ? words.slice(1) : words;
    const moved = cdTarget(cdWords, dir, context.home ?? null);
    if (moved !== undefined) {
      const arg = cdWords.slice(1).find(a => !a.startsWith('-'));
      const viaCdpath = arg !== undefined && !/^(?:\/|~|\.\.?(?:\/|$))/.test(arg) && (env.CDPATH || words.some(w => w.startsWith('CDPATH=')) || /\bCDPATH=/.test(command));
      if (moved === null || viaCdpath || (arg === undefined && /(?:^|[\s;&|(])(?:builtin\s+)?(?:cd|pushd)\s+[$`]/.test(command))) dirKnown = false;
      else if (isDirectory(moved)) dir = moved;
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
    for (const script of depth < MAX_NESTING ? [...(own !== null ? [own] : []), ...fed] : []) {
      const nested = evaluate(script, env, context, depth + 1, held, active);
      if (nested.decision === 'deny') return nested;
    }
    if (isForcePush(words)) return { decision: 'deny', reason: REASONS.forcePush };
    const code = pluginCodeProblem(words, flat, context.cwd ?? null) ?? homeFolderProblem(words, flat, active);
    if (code) return { decision: 'deny', reason: code };
    const cwords = commandWords(words)?.words ?? words;
    if (active && nestedClaude(cwords, flat)) return { decision: 'deny', reason: REASONS.nestedClaude };
    let pushed = null;
    if (active) {
      const where = gitDirectory(cwords, dir, words, env);
      const known = dirKnown && where !== undefined;
      const moved = known && where !== (context.cwd ?? null);
      const current = !known ? undefined : (context.currentBranch ?? (() => null))(...(moved ? [where] : []));
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
