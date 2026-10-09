import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { maskSecrets } from '../knowledge/code-map.js';
import type { MergeRule } from './config.js';

/**
 * The operator journal: what the operator typed himself in the session, kept by the UserPromptSubmit hook of the plugin
 * (hooks/scripts/operator-journal.mjs) in the Git common directory, outside every worktree and never versioned
 * (docs/REGLES.md, « Ancrage »). Each line is signed (HMAC-SHA256) with the anchor key, kept outside the repository
 * (`~/.apv-ancrage/cle-ancrage`, 0400): an unsigned or altered line is ignored. Only what a
 * rule needs is kept: the hash of each sentence (to recognise a quoted validation), a few words of the sentences that
 * validate, and the waiver lines, secrets masked; lines older than `rules.journalDays` (90 by default) are purged.
 * Limit: the key is on the same machine, under the same account; an agent that reads it (a guard refuses the usual forms,
 * not all) could sign. The tool compares texts: it never decides that words mean a validation.
 */
export const OPERATOR_JOURNAL = ['apv', 'operator', 'messages.jsonl'] as const;
/** Written by the hook when it refuses a prompt (source absent or not the operator's): its date and reason, never the text. */
export const OPERATOR_REFUSED = ['apv', 'operator', 'refused.json'] as const;
/** Written by the seal hook, one file per review it could not seal (`<id>.json`), removed once that domain is sealed. */
export const OPERATOR_SEAL_NOTES = ['apv', 'operator', 'sceau'] as const;
/** Days a line of the journal is kept by default (`rules.journalDays`). */
export const DEFAULT_JOURNAL_DAYS = 90;

let keyFileOverride: string | null = null;
/** In-process tests only: the anchor key file. No option nor variable of the tool changes it. */
export function setAnchorKeyFile(file: string | null): void { keyFileOverride = file; }

/** Folder and file of the anchor key: a place agents have no reason to touch, whose name the guards recognise. */
export const ANCHOR_DIR = '.apv-ancrage';
export const ANCHOR_FILE = 'cle-ancrage';

/**
 * The anchor key file: `<home of the account>/.apv-ancrage/cle-ancrage` (folder 0700, file 0400). The home comes from the
 * account database (`os.userInfo()`), never from `HOME` or `XDG_CONFIG_HOME`, which a command can set for itself.
 */
export function anchorKeyFile(): string {
  return keyFileOverride ?? join(userInfo().homedir, ANCHOR_DIR, ANCHOR_FILE);
}

export function readAnchorKey(file = anchorKeyFile()): Buffer | null {
  try {
    const text = readFileSync(file, 'utf8').trim();
    return /^[0-9a-f]{64}$/.test(text) ? Buffer.from(text, 'hex') : null;
  } catch { return null; }
}

/** Fingerprint of the key in the Git common directory of each project: a replaced key is detected, never trusted. */
export const KEY_FINGERPRINT = ['apv', 'operator', 'cle.empreinte'] as const;
const fingerprintOf = (key: Buffer): string => createHash('sha256').update(Buffer.concat([Buffer.from('apv-anchor-fingerprint\n'), key])).digest('hex');

function readFingerprint(common: string): { sha256: string; createdAt: string } | null {
  try {
    const v = JSON.parse(readFileSync(join(common, ...KEY_FINGERPRINT), 'utf8')) as { sha256?: unknown; createdAt?: unknown };
    return typeof v.sha256 === 'string' && typeof v.createdAt === 'string' ? { sha256: v.sha256, createdAt: v.createdAt } : null;
  } catch { return null; }
}

/** Whether the project already holds something signed (journal, review seals, merge traces): its key cannot be made anew. */
function signedArtifacts(common: string): boolean {
  try { if (readFileSync(operatorJournalPath(common), 'utf8').trim()) return true; } catch { /* none */ }
  try { if (readdirSync(join(common, 'apv', 'merges')).some(n => n.endsWith('.json'))) return true; } catch { /* none */ }
  try {
    const root = join(common, 'apv', 'reviews');
    for (const commit of readdirSync(root)) for (const domain of readdirSync(join(root, commit))) if (readdirSync(join(root, commit, domain)).some(n => n.endsWith('.sig'))) return true;
  } catch { /* none */ }
  return false;
}

export interface AnchorKey { key: Buffer | null; problem: string | null; createdAt: string | null }

/**
 * The key as the tool may trust it for a project: present, and the one whose fingerprint the project recorded. A missing
 * key, or another one (deleted then made anew), gives no key and the problem: nothing signed is then accepted.
 */
export function anchorKey(common: string, file = anchorKeyFile()): AnchorKey {
  const key = readAnchorKey(file);
  const fp = readFingerprint(common);
  if (!key) return { key: null, problem: `clé d'ancrage absente (${file}) : l'opérateur la restaure depuis sa sauvegarde ; rien de signé n'est accepté sans elle`, createdAt: fp?.createdAt ?? null };
  if (fp && fp.sha256 !== fingerprintOf(key)) return { key: null, problem: `clé d'ancrage remplacée (empreinte différente de celle du projet) : l'opérateur restaure l'ancienne depuis sa sauvegarde ; rien de signé n'est accepté`, createdAt: fp.createdAt };
  return { key, problem: null, createdAt: fp?.createdAt ?? null };
}

/**
 * The key, for the hooks only. Created (32 random bytes, file 0400 in a folder 0700) only when absent and the project holds
 * nothing signed yet; never made anew in silence once something was signed (a deleted key would otherwise let anyone sign).
 * Records the fingerprint of the key in the project on first use.
 */
export function ensureAnchorKey(common: string, file = anchorKeyFile()): Buffer {
  const found = anchorKey(common, file);
  if (found.key) {
    if (!readFingerprint(common)) writeFingerprint(common, found.key, new Date().toISOString());
    return found.key;
  }
  if (readAnchorKey(file)) {
    // Written by another hook since the first reading (four reviewers sealing together): read again.
    const again = anchorKey(common, file);
    if (again.key) {
      if (!readFingerprint(common)) writeFingerprint(common, again.key, new Date().toISOString());
      return again.key;
    }
    throw new Error(again.problem ?? 'clé d\'ancrage inutilisable');
  }
  if (readFingerprint(common) || signedArtifacts(common)) throw new Error(found.problem ?? 'clé d\'ancrage inutilisable');
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const key = randomBytes(32);
  try { writeFileSync(file, `${key.toString('hex')}\n`, { mode: 0o400, flag: 'wx' }); }
  catch (error) {
    // Another hook created it at the same instant (four reviewers sealing together): use that key, once it is written.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const other = anchorKey(common, file);
      if (other.key) {
        if (!readFingerprint(common)) writeFingerprint(common, other.key, new Date().toISOString());
        return other.key;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    throw error;
  }
  chmodSync(file, 0o400);
  writeFingerprint(common, key, new Date().toISOString());
  return key;
}

function writeFingerprint(common: string, key: Buffer, createdAt: string): void {
  const f = join(common, ...KEY_FINGERPRINT);
  mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
  writeFileSync(f, `${JSON.stringify({ sha256: fingerprintOf(key), createdAt })}\n`, { mode: 0o600 });
}

/**
 * Signing is for the tool run as a command (`bin/apv`, `dist/cli.js`, which set APV_ENTRY) and for the hooks: a script
 * that imports the module directly cannot sign (the Bash guard also refuses such scripts). A guard rail, not a secret.
 */
const SIGNERS = new Set(['cli', 'hook', 'test']);
export function sign(key: Buffer, kind: string, payload: string): string {
  if (!SIGNERS.has(process.env['APV_ENTRY'] ?? '')) throw new Error('signature refusée hors de la commande apv et des crochets du plugin');
  return createHmac('sha256', key).update(`${kind}\n${payload}`).digest('hex');
}

export function signatureValid(key: Buffer, kind: string, payload: string, signature: unknown): boolean {
  if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/.test(signature)) return false;
  const expected = createHmac('sha256', key).update(`${kind}\n${payload}`).digest('hex');
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
}

/** A sentence keyed with the anchor key: a short code typed alone is not found back by a dictionary. */
const keyed = (key: Buffer, text: string): string => createHmac('sha256', key).update(`sentence\n${text}`).digest('hex');

/** Text compared without its typography: spaces collapsed, apostrophes and quotes unified, case ignored. */
export function comparable(text: string): string {
  return text.normalize('NFC').replace(/[‘’ʼ]/g, '\'').replace(/[“”«»]/g, '"').replace(/[\s  ]+/g, ' ').trim().toLowerCase();
}

const EDGE = /^[\s.!?…,;:"'()-]+|[\s.!?…,;:"'()-]+$/g;
/** The sentences of a text (split on line breaks and on . ! ? followed by a space), each made comparable, empty ones dropped. */
export function sentences(text: string): string[] {
  return text.split(/\n+|(?<=[.!?…])\s+/).map(s => comparable(s).replace(EDGE, '')).filter(s => s.length > 0);
}

/** Shortest quote that can anchor a validation: « ok » or « oui » alone never does. */
export const MIN_QUOTE = 12;
/** Words that make a sentence a validation, whose first words are kept for the reader. */
export const VALIDATES = /valid|approuv|accord|d[ée]rogation|go pour|on part/i;
/** Shortest prefix of the commit a waiver must name. */
export const WAIVER_SHA = 12;
/** Shortest reason after the commit, in characters. */
export const MIN_WAIVER_REASON = 10;
const WAIVER_LINE = new RegExp(`d[ée]rogation\\s+[a-z]+\\s+(?:pour\\s+)?[0-9a-f]{${WAIVER_SHA},64}`, 'i');

/** One line of the journal: hashes, a few words, waiver lines; never the whole message. */
export interface JournalEntry {
  v: 2;
  at: string;
  session: string;
  /** HMAC (anchor key) of each comparable sentence of the message. */
  sentences: string[];
  /** The first words of the sentences that validate or waive, secrets masked. */
  preview: string[];
  /** Lines « dérogation <règle> <commit> : <raison> », secrets masked. */
  waivers: string[];
  sig: string;
}
export type OperatorMessage = Omit<JournalEntry, 'sig' | 'v'>;

/** The signed entry of a message the operator typed; null when it has no sentence. */
export function journalEntry(text: string, meta: { at: string; session: string }, key: Buffer): JournalEntry | null {
  const list = sentences(text);
  if (!list.length) return null;
  const preview = text.split(/\n+|(?<=[.!?…])\s+/).filter(s => VALIDATES.test(s) && !WAIVER_LINE.test(s)).map(s => maskSecrets(s.trim().split(/\s+/).slice(0, 8).join(' '))).slice(0, 10);
  // The rule and the commit are kept as typed (a full commit id looks like a secret to the mask), the reason masked.
  const waivers = text.split('\n').filter(l => WAIVER_LINE.test(l)).map(l => {
    const line = l.trim();
    const head = WAIVER_LINE.exec(line)!;
    return `${line.slice(0, head.index + head[0].length)}${maskSecrets(line.slice(head.index + head[0].length))}`.slice(0, 500);
  }).slice(0, 20);
  const body = { v: 2 as const, at: meta.at, session: meta.session.slice(0, 100), sentences: [...new Set(list.map(s => keyed(key, s)))].slice(0, 200), preview, waivers };
  return { ...body, sig: sign(key, 'operator', JSON.stringify(body)) };
}

export function operatorJournalPath(common: string): string { return join(common, ...OPERATOR_JOURNAL); }

function verified(line: string, key: Buffer | null): JournalEntry | null {
  if (!key) return null;
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (value['v'] !== 2 || typeof value['at'] !== 'string' || !Array.isArray(value['sentences']) || !Array.isArray(value['waivers']) || !Array.isArray(value['preview'])) return null;
    const { sig, ...body } = value;
    return signatureValid(key, 'operator', JSON.stringify(body), sig) ? value as unknown as JournalEntry : null;
  } catch { return null; }
}

/** Appends an entry, then drops the lines older than `keepDays` (and unreadable ones). */
export function appendJournal(common: string, entry: JournalEntry, keepDays = DEFAULT_JOURNAL_DAYS, now = new Date()): void {
  const file = operatorJournalPath(common);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const limit = now.getTime() - keepDays * 86_400_000;
  let kept: string[] = [];
  try {
    kept = readFileSync(file, 'utf8').split('\n').filter(l => {
      if (!l.trim()) return false;
      try { return Date.parse((JSON.parse(l) as { at: string }).at) >= limit; } catch { return false; }
    });
  } catch { kept = []; }
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${[...kept, JSON.stringify(entry)].join('\n')}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** The signed messages of the journal, oldest first; unsigned, altered or unreadable lines are ignored. */
export function readOperatorMessages(common: string, key = anchorKey(common).key): OperatorMessage[] {
  let raw: string;
  try { raw = readFileSync(operatorJournalPath(common), 'utf8'); } catch { return []; }
  return raw.split('\n').filter(l => l.trim()).map(l => verified(l, key)).filter((e): e is JournalEntry => e !== null)
    .map(({ at, session, sentences: list, preview, waivers }) => ({ at, session, sentences: list, preview, waivers }));
}

/**
 * What `apv status` says of the journal: signed messages kept, ignored lines, last message, last refused message, and
 * every review the seal hook could not seal (oldest first).
 */
export interface JournalState { file: string; key: boolean; keyProblem: string | null; keyCreatedAt: string | null; messages: number; ignored: number; last: string | null; refused: { at: string; reason: string } | null; sealRefusals: { at: string; reason: string }[] }
export function journalState(common: string): JournalState {
  const file = operatorJournalPath(common);
  const anchor = anchorKey(common);
  const key = anchor.key;
  let lines: string[] = [];
  try { lines = readFileSync(file, 'utf8').split('\n').filter(l => l.trim()); } catch { lines = []; }
  const ok = lines.map(l => verified(l, key)).filter((e): e is JournalEntry => e !== null);
  const read = (note: string): { at: string; reason: string } | null => {
    try {
      const r = JSON.parse(readFileSync(note, 'utf8')) as { at?: unknown; reason?: unknown };
      return typeof r.at === 'string' && typeof r.reason === 'string' ? { at: r.at, reason: r.reason.slice(0, 300) } : null;
    } catch { return null; }
  };
  // `refused.json` holds the last refused message, or a seal note of the first versions (`relecture …`).
  const single = read(join(common, ...OPERATOR_REFUSED));
  const sealed = single && /^relecture\b/.test(single.reason) ? [single] : [];
  // A note older than the journal keeps its lines is not said, even before the hook purges it on its next pass.
  const fresh = (n: { at: string } | null): n is { at: string; reason: string } => n !== null && !(Date.now() - Date.parse(n.at) > DEFAULT_JOURNAL_DAYS * 86_400_000);
  const sealRefusals = [...sealed, ...sealNotes(common).map(n => read(n.file))].filter(fresh).sort((a, b) => a.at.localeCompare(b.at));
  return { file, key: key !== null, keyProblem: anchor.problem, keyCreatedAt: anchor.createdAt, messages: ok.length, ignored: lines.length - ok.length, last: ok.at(-1)?.at ?? null,
    refused: sealed.length ? null : single, sealRefusals };
}

/** The notes of the seal hook, one file per review it could not seal (several reviewers run at once: no shared file). */
function sealNotes(common: string): { file: string; id: string }[] {
  const dir = join(common, ...OPERATOR_SEAL_NOTES);
  try { return readdirSync(dir).filter(f => /^[\w-]+\.json$/.test(f)).map(f => ({ file: join(dir, f), id: f.slice(0, -'.json'.length) })); } catch { return []; }
}

/** Writes `content` to `file` whole or not at all (temporary file, then rename): a reader never sees half a note. */
function writeWhole(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, file);
}

/**
 * Forgets the notes of the seal hook once the review `id` of `domain` at `commit` is sealed: the note about that review,
 * and those about earlier reviews of the same domain at the same commit, which this one replaces (each record gets a new
 * id, so a note kept for its own id only would stay for good; the unsealed record itself is still said by `apv review
 * show`). A note about another domain or another commit, or a refused message, stays.
 */
export function clearSealRefusal(common: string, id: string, domain: string | null = null, commit: string | null = null, now = new Date()): void {
  forgetSealNotes(common, note => note.id === id || (domain !== null && note.domain === domain && sameCommit(note.commit, commit)), now);
  // A seal note of the versions before one file per note, kept in `refused.json` (`relecture non scellée : …`,
  // `relecture <id> non scellée : …`): no new one is written there, so the first seal lifts it.
  const file = join(common, ...OPERATOR_REFUSED);
  try {
    const r = JSON.parse(readFileSync(file, 'utf8')) as { reason?: unknown };
    if (typeof r.reason === 'string' && /^relecture\b/.test(r.reason)) rmSync(file, { force: true });
  } catch { /* no note */ }
}

/**
 * Whether a note about `noted` (the commit the review was recorded at, as known when the note was written) is about the
 * sealed `commit`. A note that knows no commit (`--commit HEAD`, a record not found) goes with any of its domain.
 */
function sameCommit(noted: unknown, commit: string | null): boolean {
  if (typeof noted !== 'string' || !/^[0-9a-f]{7,40}$/.test(noted)) return true;
  return commit !== null && (commit.startsWith(noted) || noted.startsWith(commit));
}

/**
 * Removes the notes `drop` picks, and in any case those older than the journal keeps its lines (`DEFAULT_JOURNAL_DAYS`)
 * and the temporary files a stopped hook left behind: no note stays for good.
 */
function forgetSealNotes(common: string, drop: (note: { id: string; domain: unknown; commit: unknown }) => boolean, now: Date): void {
  const dir = join(common, ...OPERATOR_SEAL_NOTES);
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    const file = join(dir, name);
    try {
      // A temporary file younger than a minute may be a note being written by another hook.
      const age = now.getTime() - statSync(file).mtimeMs;
      if (age > DEFAULT_JOURNAL_DAYS * 86_400_000 || (name.endsWith('.tmp') && age > 60_000)) { rmSync(file, { force: true }); continue; }
      if (!/^[\w-]+\.json$/.test(name)) continue;
      let note: { domain?: unknown; commit?: unknown } = {};
      try { note = JSON.parse(readFileSync(file, 'utf8')) as typeof note; } catch { /* unreadable: by its id only */ }
      if (drop({ id: name.slice(0, -'.json'.length), domain: note.domain ?? null, commit: note.commit ?? null })) rmSync(file, { force: true });
    } catch { /* gone meanwhile */ }
  }
}

/**
 * Notes, for `apv status`, that the seal hook could not seal the review `id` of `domain` at `commit` (when known): date,
 * id, domain, commit and reason. The note replaces those of earlier reviews of the same domain and commit.
 */
export function recordSealRefusal(common: string, id: string, domain: string, reason: string, now = new Date(), commit: string | null = null): void {
  if (!/^[\w-]+$/.test(id)) return;
  const known = commit && /^[0-9a-f]{7,40}$/.test(commit) ? commit : null;
  forgetSealNotes(common, note => note.id !== id && note.domain === domain && (known === null ? typeof note.commit !== 'string' : sameCommit(note.commit, known)), now);
  writeWhole(join(common, ...OPERATOR_SEAL_NOTES, `${id}.json`), `${JSON.stringify({ at: now.toISOString(), domain, commit: known, reason: `relecture ${id} (${domain}${known ? ` ${known.slice(0, 12)}` : ''}) non scellée : ${reason}`.slice(0, 300) })}\n`);
}

/** Notes, for `apv status`, that the hook refused a prompt: date and reason, never the text. */
export function recordRefusal(common: string, reason: string, now = new Date()): void {
  writeWhole(join(common, ...OPERATOR_REFUSED), `${JSON.stringify({ at: now.toISOString(), reason: reason.slice(0, 300) })}\n`);
}

/**
 * The message of the operator that holds every sentence of `quote`, or null. Whole sentences only: the journal keeps
 * their hashes, never the text, so a quote cut in the middle of a sentence is not recognised.
 */
export function anchoredQuote(messages: readonly OperatorMessage[], quote: string, key: Buffer | null = readAnchorKey()): OperatorMessage | null {
  const wanted = sentences(quote);
  if (!key || !wanted.length || comparable(quote).length < MIN_QUOTE) return null;
  const hashes = wanted.map(s => keyed(key, s));
  return messages.find(m => hashes.every(h => m.sentences.includes(h))) ?? null;
}

/** The sentence the operator types himself to waive `rule` for `sha` (shown in every refusal). */
export function waiverSentence(rule: MergeRule, sha: string): string {
  return `dérogation ${rule} ${sha.slice(0, WAIVER_SHA)} : <ta raison>`;
}

/**
 * The waiver of `rule` for the commit `sha` the operator typed himself, or null: a line « dérogation <règle> <12 premiers
 * caractères du commit au moins> : <raison> ». Never for another commit, never « dérogation » alone, never without a reason.
 */
export function waiverFor(messages: readonly OperatorMessage[], rule: MergeRule, sha: string): { message: OperatorMessage; reason: string } | null {
  const pattern = new RegExp(`d[ée]rogation\\s+${rule}\\s+(?:pour\\s+)?([0-9a-f]{${WAIVER_SHA},64})\\s*[:,-]?\\s*(.*)`, 'i');
  for (const message of [...messages].reverse()) {
    for (const line of message.waivers) {
      const m = pattern.exec(line.normalize('NFC'));
      if (!m) continue;
      const reason = m[2]!.trim();
      if (sha.toLowerCase().startsWith(m[1]!.toLowerCase()) && reason.length >= MIN_WAIVER_REASON) return { message, reason };
    }
  }
  return null;
}

/** Whether the key file exists with no access for group and others. */
export function anchorKeyPrivate(file = anchorKeyFile()): boolean {
  try { return existsSync(file) && (statSync(file).mode & 0o077) === 0; } catch { return false; }
}
