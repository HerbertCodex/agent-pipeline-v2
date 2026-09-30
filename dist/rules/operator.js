import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { maskSecrets } from '../knowledge/code-map.js';
/**
 * The operator journal: what the operator typed himself in the session, kept by the UserPromptSubmit hook of the plugin
 * (hooks/scripts/operator-journal.mjs) in the Git common directory, outside every worktree and never versioned
 * (docs/REGLES.md, « Ancrage »). Each line is signed (HMAC-SHA256) with the anchor key, kept outside the repository in the
 * user's configuration folder (`~/.config/apv/anchor.key`, 0600): an unsigned or altered line is ignored. Only what a
 * rule needs is kept: the hash of each sentence (to recognise a quoted validation), a few words of the sentences that
 * validate, and the waiver lines, secrets masked; lines older than `rules.journalDays` (90 by default) are purged.
 * Limit: the key is on the same machine, under the same account; an agent that reads it (a guard refuses the usual forms,
 * not all) could sign. The tool compares texts: it never decides that words mean a validation.
 */
export const OPERATOR_JOURNAL = ['apv', 'operator', 'messages.jsonl'];
/** Written by the hook when it refuses a prompt (source absent or not the operator's): its date and reason, never the text. */
export const OPERATOR_REFUSED = ['apv', 'operator', 'refused.json'];
/** Days a line of the journal is kept by default (`rules.journalDays`). */
export const DEFAULT_JOURNAL_DAYS = 90;
let keyFileOverride = null;
/** In-process tests only: the anchor key file. No option nor variable of the tool changes it. */
export function setAnchorKeyFile(file) { keyFileOverride = file; }
/**
 * The anchor key file: `<home of the account>/.config/apv/anchor.key`. The home comes from the account database
 * (`os.userInfo()`), never from `HOME` or `XDG_CONFIG_HOME`, which a command can set for itself.
 */
export function anchorKeyFile() {
    return keyFileOverride ?? join(userInfo().homedir, '.config', 'apv', 'anchor.key');
}
export function readAnchorKey(file = anchorKeyFile()) {
    try {
        const text = readFileSync(file, 'utf8').trim();
        return /^[0-9a-f]{64}$/.test(text) ? Buffer.from(text, 'hex') : null;
    }
    catch {
        return null;
    }
}
/** The key, created (32 random bytes, file 0600 in a folder 0700) when absent. Only the hooks create it. */
export function ensureAnchorKey(file = anchorKeyFile()) {
    const existing = readAnchorKey(file);
    if (existing)
        return existing;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const key = randomBytes(32);
    try {
        writeFileSync(file, `${key.toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
    }
    catch {
        const again = readAnchorKey(file);
        if (again)
            return again;
        throw new Error(`clé d'ancrage illisible : ${file}`);
    }
    chmodSync(file, 0o600);
    return key;
}
export function sign(key, kind, payload) {
    return createHmac('sha256', key).update(`${kind}\n${payload}`).digest('hex');
}
export function signatureValid(key, kind, payload, signature) {
    if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/.test(signature))
        return false;
    return timingSafeEqual(Buffer.from(sign(key, kind, payload), 'hex'), Buffer.from(signature, 'hex'));
}
/** Text compared without its typography: spaces collapsed, apostrophes and quotes unified, case ignored. */
export function comparable(text) {
    return text.normalize('NFC').replace(/[‘’ʼ]/g, '\'').replace(/[“”«»]/g, '"').replace(/[\s  ]+/g, ' ').trim().toLowerCase();
}
const EDGE = /^[\s.!?…,;:"'()-]+|[\s.!?…,;:"'()-]+$/g;
/** The sentences of a text (split on line breaks and on . ! ? followed by a space), each made comparable, empty ones dropped. */
export function sentences(text) {
    return text.split(/\n+|(?<=[.!?…])\s+/).map(s => comparable(s).replace(EDGE, '')).filter(s => s.length > 0);
}
const digest = (text) => createHash('sha256').update(text).digest('hex');
/** Shortest quote that can anchor a validation: « ok » or « oui » alone never does. */
export const MIN_QUOTE = 12;
/** Words that make a sentence a validation, whose first words are kept for the reader. */
const VALIDATES = /valid|approuv|accord|d[ée]rogation|go pour|on part/i;
/** Shortest prefix of the commit a waiver must name. */
export const WAIVER_SHA = 12;
/** Shortest reason after the commit, in characters. */
export const MIN_WAIVER_REASON = 10;
const WAIVER_LINE = new RegExp(`d[ée]rogation\\s+[a-z]+\\s+(?:pour\\s+)?[0-9a-f]{${WAIVER_SHA},64}`, 'i');
/** The signed entry of a message the operator typed; null when it has no sentence. */
export function journalEntry(text, meta, key) {
    const list = sentences(text);
    if (!list.length)
        return null;
    const preview = text.split(/\n+|(?<=[.!?…])\s+/).filter(s => VALIDATES.test(s) && !WAIVER_LINE.test(s)).map(s => maskSecrets(s.trim().split(/\s+/).slice(0, 8).join(' '))).slice(0, 10);
    // The rule and the commit are kept as typed (a full commit id looks like a secret to the mask), the reason masked.
    const waivers = text.split('\n').filter(l => WAIVER_LINE.test(l)).map(l => {
        const line = l.trim();
        const head = WAIVER_LINE.exec(line);
        return `${line.slice(0, head.index + head[0].length)}${maskSecrets(line.slice(head.index + head[0].length))}`.slice(0, 500);
    }).slice(0, 20);
    const body = { v: 2, at: meta.at, session: meta.session.slice(0, 100), sentences: [...new Set(list.map(digest))].slice(0, 200), preview, waivers };
    return { ...body, sig: sign(key, 'operator', JSON.stringify(body)) };
}
export function operatorJournalPath(common) { return join(common, ...OPERATOR_JOURNAL); }
function verified(line, key) {
    if (!key)
        return null;
    try {
        const value = JSON.parse(line);
        if (value['v'] !== 2 || typeof value['at'] !== 'string' || !Array.isArray(value['sentences']) || !Array.isArray(value['waivers']) || !Array.isArray(value['preview']))
            return null;
        const { sig, ...body } = value;
        return signatureValid(key, 'operator', JSON.stringify(body), sig) ? value : null;
    }
    catch {
        return null;
    }
}
/** Appends an entry, then drops the lines older than `keepDays` (and unreadable ones). */
export function appendJournal(common, entry, keepDays = DEFAULT_JOURNAL_DAYS, now = new Date()) {
    const file = operatorJournalPath(common);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const limit = now.getTime() - keepDays * 86_400_000;
    let kept = [];
    try {
        kept = readFileSync(file, 'utf8').split('\n').filter(l => {
            if (!l.trim())
                return false;
            try {
                return Date.parse(JSON.parse(l).at) >= limit;
            }
            catch {
                return false;
            }
        });
    }
    catch {
        kept = [];
    }
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${[...kept, JSON.stringify(entry)].join('\n')}\n`, { mode: 0o600 });
    renameSync(tmp, file);
}
/** The signed messages of the journal, oldest first; unsigned, altered or unreadable lines are ignored. */
export function readOperatorMessages(common, key = readAnchorKey()) {
    let raw;
    try {
        raw = readFileSync(operatorJournalPath(common), 'utf8');
    }
    catch {
        return [];
    }
    return raw.split('\n').filter(l => l.trim()).map(l => verified(l, key)).filter((e) => e !== null)
        .map(({ at, session, sentences: list, preview, waivers }) => ({ at, session, sentences: list, preview, waivers }));
}
export function journalState(common) {
    const file = operatorJournalPath(common);
    const key = readAnchorKey();
    let lines = [];
    try {
        lines = readFileSync(file, 'utf8').split('\n').filter(l => l.trim());
    }
    catch {
        lines = [];
    }
    const ok = lines.map(l => verified(l, key)).filter((e) => e !== null);
    let refused = null;
    try {
        const r = JSON.parse(readFileSync(join(common, ...OPERATOR_REFUSED), 'utf8'));
        if (typeof r.at === 'string' && typeof r.reason === 'string')
            refused = { at: r.at, reason: r.reason.slice(0, 300) };
    }
    catch {
        refused = null;
    }
    return { file, key: key !== null, messages: ok.length, ignored: lines.length - ok.length, last: ok.at(-1)?.at ?? null, refused };
}
/** Notes, for `apv status`, that the hook refused a prompt: date and reason, never the text. */
export function recordRefusal(common, reason, now = new Date()) {
    const file = join(common, ...OPERATOR_REFUSED);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${JSON.stringify({ at: now.toISOString(), reason: reason.slice(0, 300) })}\n`, { mode: 0o600 });
}
/**
 * The message of the operator that holds every sentence of `quote`, or null. Whole sentences only: the journal keeps
 * their hashes, never the text, so a quote cut in the middle of a sentence is not recognised.
 */
export function anchoredQuote(messages, quote) {
    const wanted = sentences(quote);
    if (!wanted.length || comparable(quote).length < MIN_QUOTE)
        return null;
    const hashes = wanted.map(digest);
    return messages.find(m => hashes.every(h => m.sentences.includes(h))) ?? null;
}
/** The sentence the operator types himself to waive `rule` for `sha` (shown in every refusal). */
export function waiverSentence(rule, sha) {
    return `dérogation ${rule} ${sha.slice(0, WAIVER_SHA)} : <ta raison>`;
}
/**
 * The waiver of `rule` for the commit `sha` the operator typed himself, or null: a line « dérogation <règle> <12 premiers
 * caractères du commit au moins> : <raison> ». Never for another commit, never « dérogation » alone, never without a reason.
 */
export function waiverFor(messages, rule, sha) {
    const pattern = new RegExp(`d[ée]rogation\\s+${rule}\\s+(?:pour\\s+)?([0-9a-f]{${WAIVER_SHA},64})\\s*[:,-]?\\s*(.*)`, 'i');
    for (const message of [...messages].reverse()) {
        for (const line of message.waivers) {
            const m = pattern.exec(line.normalize('NFC'));
            if (!m)
                continue;
            const reason = m[2].trim();
            if (sha.toLowerCase().startsWith(m[1].toLowerCase()) && reason.length >= MIN_WAIVER_REASON)
                return { message, reason };
        }
    }
    return null;
}
/** Whether the key file exists with no access for group and others. */
export function anchorKeyPrivate(file = anchorKeyFile()) {
    try {
        return existsSync(file) && (statSync(file).mode & 0o077) === 0;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=operator.js.map