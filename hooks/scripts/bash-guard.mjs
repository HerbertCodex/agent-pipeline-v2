#!/usr/bin/env node
// PreToolUse guard for the Bash tool (APV3 spec, section 11).
// Blocks force-pushes, merges (gh pr merge, gh api …/merge, apv stack merge) and production deploys
// without their explicit authorisation, and
// commands that write to GitHub while hiding their output (incident 30).
// This is a guard rail against mistakes, not a security boundary: a determined command can
// always be written in a shape this parser does not recognise.
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readHookInput } from './lib.mjs';

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
      if (heredoc) pending.push(heredoc);
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
  return { segments, shadow };
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
 * True when the words of one simple command run `apv stack merge`: the `apv` binary (also through npx), or
 * the bundled tool `node …/dist/cli.js`. Options may sit between `stack` and `merge`; the command merges
 * pull requests on GitHub, so it needs the same explicit authorisation as `gh pr merge`.
 */
const LAUNCHERS = new Set(['node', 'npx', 'bunx', 'npm', 'pnpm', 'yarn']);
export function isStackMerge(words) {
  const start = words.findIndex(w => !isAssignment(w) && w !== 'env');
  if (start === -1) return false;
  const lead = basename(words[start]);
  return words.some((word, k) => {
    const name = basename(word);
    if (name !== 'apv' && name !== 'cli.js') return false;
    if (!(k === start && name === 'apv') && !(k > start && LAUNCHERS.has(lead))) return false;
    const [command, ...rest] = positional(words.slice(k + 1));
    return command === 'stack' && rest.includes('merge');
  });
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

/** An explicit authorisation: set in the hook environment, or as an assignment prefixing the command. */
function authorised(words, variable, env) {
  if (env[variable] === '1') return true;
  const at = words.findIndex(w => !isAssignment(w) && w !== 'env');
  const prefix = at === -1 ? words : words.slice(0, at);
  return prefix.includes(`${variable}=1`);
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
  hiddenOutput: 'APV : commande qui écrit sur GitHub avec une sortie masquée (redirection vers /dev/null). ' +
    'Incident 30 : un `gh pr edit --base` a échoué sans message et les PR ont été fusionnées dans la mauvaise base. ' +
    'Relance sans masquer la sortie, lis-la, puis vérifie le résultat (par exemple gh pr view <n> --json baseRefName).',
};

/** Pure decision for one Bash command: { decision: 'allow' } or { decision: 'deny', reason }. */
export function evaluateCommand(command, env = {}) {
  if (typeof command !== 'string' || command.trim() === '') return { decision: 'allow' };
  const { segments, shadow } = tokenize(command);
  let writesGithub = false;
  for (const words of segments) {
    if (isForcePush(words)) return { decision: 'deny', reason: REASONS.forcePush };
    const write = githubWrite(words) ?? (isStackMerge(words) ? { merge: true } : null);
    if (write) {
      writesGithub = true;
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
  const result = evaluateCommand(input.tool_input?.command, process.env);
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(code => { process.exitCode = code; }, error => {
    process.stderr.write(`APV bash-guard : ${error?.message ?? error}\n`);
    process.exitCode = 0;
  });
}
