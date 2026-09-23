#!/usr/bin/env node
// SessionStart hook: gives the lead a short resume context when the project uses APV
// (APV3 spec, section 11). Read-only, bounded output, silent when there is no `.apv/`.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findApvDir, oneLine, readHookInput } from './lib.mjs';

const MAX_CONTEXT = 4000;
const MAX_NOTES_LINES = 40;
const MAX_STATE_FILES = 10;

function readText(path) {
  try {
    return existsSync(path) && statSync(path).isFile() ? readFileSync(path, 'utf8') : null;
  } catch {
    return null;
  }
}

/** Last non-empty line of a text file, or null. */
export function lastLine(path) {
  const text = readText(path);
  if (!text) return null;
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
  return lines.length ? lines[lines.length - 1] : null;
}

/**
 * One readable line for the last quota reading. `apv quota` writes one JSON object per line
 * (`at`, `session`, `week`, `percent`, `level`); a line in another format is shown as it is.
 */
export function describeQuota(line) {
  let value;
  try { value = JSON.parse(line); } catch { return oneLine(line, 300); }
  if (!value || typeof value !== 'object' || typeof value.at !== 'string') return oneLine(line, 300);
  const window = (w, label) => {
    if (!w || typeof w.percent !== 'number') return `${label} non lue`;
    return `${label} ${w.percent} %${typeof w.resets === 'string' && w.resets ? ` (remise à zéro ${oneLine(w.resets, 60)})` : ''}`;
  };
  return oneLine(`${value.at} : ${window(value.session, 'session')}, ${window(value.week, 'semaine')}, niveau ${value.level ?? '?'}`, 300);
}

/** Most recently modified entries of `.apv/state`, newest first. */
function stateEntries(stateDir) {
  try {
    return readdirSync(stateDir, { withFileTypes: true })
      .filter(e => !e.name.startsWith('.'))
      .map(e => {
        const full = join(stateDir, e.name);
        return { name: e.isDirectory() ? `${e.name}/` : e.name, mtime: statSync(full).mtime };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, MAX_STATE_FILES);
  } catch {
    return [];
  }
}

/** Builds the resume context for a project `.apv` directory. */
export function buildResumeContext(apvDir) {
  const stateDir = join(apvDir, 'state');
  const lines = [`[APV] Projet sous Agent Pipeline V3 (${apvDir}).`];
  const notes = readText(join(stateDir, 'resume.md'));
  if (notes) {
    const kept = notes.split(/\r?\n/).slice(0, MAX_NOTES_LINES);
    lines.push('Notes de reprise (.apv/state/resume.md) :', ...kept);
    if (notes.split(/\r?\n/).length > MAX_NOTES_LINES) lines.push('(suite dans .apv/state/resume.md)');
  } else {
    lines.push('Aucune note de reprise (.apv/state/resume.md absent).');
  }
  const entries = stateEntries(stateDir);
  if (entries.length) {
    lines.push('Fichiers d\'état récents (.apv/state) : ' +
      entries.map(e => `${e.name} (${e.mtime.toISOString()})`).join(', '));
  }
  const quota = lastLine(join(stateDir, 'quota.log'));
  lines.push(quota ? `Dernier relevé de quota (.apv/state/quota.log) : ${describeQuota(quota)}` : 'Aucun relevé de quota : lancer /apv:quota avant toute vague.');
  const journal = lastLine(join(stateDir, 'journal.log'));
  if (journal) lines.push(`Dernière fin de tour : ${oneLine(journal, 300)}`);
  lines.push('Pour reprendre après une coupure : /apv:resume. Pour l\'état complet : /apv:status.');
  const text = lines.join('\n');
  return text.length > MAX_CONTEXT ? `${text.slice(0, MAX_CONTEXT - 1)}…` : text;
}

async function main() {
  const input = await readHookInput();
  const apvDir = findApvDir(input);
  if (!apvDir) return 0;
  process.stdout.write(`${JSON.stringify({
    systemMessage: 'APV : contexte de reprise chargé depuis .apv/state.',
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: buildResumeContext(apvDir) },
  })}\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(code => { process.exitCode = code; }, error => {
    process.stderr.write(`APV session-start : ${error?.message ?? error}\n`);
    process.exitCode = 0;
  });
}
