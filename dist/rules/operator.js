import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, constants as fsConstants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { maskSecrets } from '../knowledge/code-map.js';
import { REVIEW_DOMAINS } from '../review/config.js';
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
export const OPERATOR_JOURNAL = ['apv', 'operator', 'messages.jsonl'];
/** Written by the hook when it refuses a prompt (source absent or not the operator's): its date and reason, never the text. */
export const OPERATOR_REFUSED = ['apv', 'operator', 'refused.json'];
/** Written by the seal hook, one file per review it could not seal (`<id>.json`), removed once that domain is sealed. */
export const OPERATOR_SEAL_NOTES = ['apv', 'operator', 'sceau'];
/** Days a line of the journal is kept by default (`rules.journalDays`). */
export const DEFAULT_JOURNAL_DAYS = 90;
let keyFileOverride = null;
/** In-process tests only: the anchor key file. No option nor variable of the tool changes it. */
export function setAnchorKeyFile(file) { keyFileOverride = file; }
/** Folder and file of the anchor key: a place agents have no reason to touch, whose name the guards recognise. */
export const ANCHOR_DIR = '.apv-ancrage';
export const ANCHOR_FILE = 'cle-ancrage';
/**
 * The anchor key file: `<home of the account>/.apv-ancrage/cle-ancrage` (folder 0700, file 0400). The home comes from the
 * account database (`os.userInfo()`), never from `HOME` or `XDG_CONFIG_HOME`, which a command can set for itself.
 */
export function anchorKeyFile() {
    return keyFileOverride ?? join(userInfo().homedir, ANCHOR_DIR, ANCHOR_FILE);
}
/** Largest key file and fingerprint read: a key is 65 bytes, a fingerprint about 120. */
const KEY_MAX_BYTES = 256;
const FINGERPRINT_MAX_BYTES = 4096;
/**
 * A small file of the account, as the anchor reads it: a regular file (never a symbolic link, a FIFO or a device), owned
 * by the account, of at most `max` bytes. Opened without following a link and without blocking, checked on the open
 * file (no change between the check and the reading).
 */
function readOwnFile(file, max) {
    let fd;
    try {
        fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    }
    catch (error) {
        const code = error.code ?? 'erreur';
        if (code === 'ENOENT')
            return { state: 'absent' };
        // O_NOFOLLOW on a link: ELOOP (Linux, macOS), EMLINK (FreeBSD).
        if (code === 'ELOOP' || code === 'EMLINK')
            return { state: 'refused', why: 'lien symbolique' };
        return { state: 'refused', why: `illisible (${code})` };
    }
    try {
        const st = fstatSync(fd);
        if (!st.isFile())
            return { state: 'refused', why: 'pas un fichier ordinaire' };
        const uid = process.getuid?.();
        if (uid !== undefined && st.uid !== uid)
            return { state: 'refused', why: `propriétaire ${st.uid}, pas le compte ${uid}` };
        if (st.size > max)
            return { state: 'refused', why: `trop grand (${st.size} octets)` };
        const text = readFileSync(fd, 'utf8');
        if (Buffer.byteLength(text) > max)
            return { state: 'refused', why: 'trop grand' };
        return { state: 'read', text, size: st.size, mtimeMs: st.mtimeMs };
    }
    catch (error) {
        return { state: 'refused', why: `illisible (${error.code ?? 'erreur'})` };
    }
    finally {
        closeSync(fd);
    }
}
function readKeyFile(file) {
    const read = readOwnFile(file, KEY_MAX_BYTES);
    if (read.state !== 'read')
        return read;
    const text = read.text.trim();
    return /^[0-9a-f]{64}$/.test(text) ? { state: 'key', key: Buffer.from(text, 'hex') } : { state: 'incomplete', size: read.size, mtimeMs: read.mtimeMs };
}
export function readAnchorKey(file = anchorKeyFile()) {
    const read = readKeyFile(file);
    return read.state === 'key' ? read.key : null;
}
/** Fingerprint of the key in the Git common directory of each project: a replaced key is detected, never trusted. */
export const KEY_FINGERPRINT = ['apv', 'operator', 'cle.empreinte'];
const fingerprintOf = (key) => createHash('sha256').update(Buffer.concat([Buffer.from('apv-anchor-fingerprint\n'), key])).digest('hex');
function readFingerprint(common) {
    const read = readOwnFile(join(common, ...KEY_FINGERPRINT), FINGERPRINT_MAX_BYTES);
    if (read.state === 'absent')
        return read;
    if (read.state === 'refused')
        return { state: 'unreadable', why: read.why, size: null, mtimeMs: null };
    const unreadable = { state: 'unreadable', why: 'incomplète ou abîmée', size: read.size, mtimeMs: read.mtimeMs };
    try {
        const v = JSON.parse(read.text);
        return typeof v.sha256 === 'string' && /^[0-9a-f]{64}$/.test(v.sha256) && typeof v.createdAt === 'string' ? { state: 'recorded', sha256: v.sha256, createdAt: v.createdAt } : unreadable;
    }
    catch {
        return unreadable;
    }
}
/** Whether the project already holds something signed (journal, review seals, merge traces): its key cannot be made anew. */
function signedArtifacts(common) {
    try {
        if (readFileSync(operatorJournalPath(common), 'utf8').trim())
            return true;
    }
    catch { /* none */ }
    try {
        if (readdirSync(join(common, 'apv', 'merges')).some(n => n.endsWith('.json')))
            return true;
    }
    catch { /* none */ }
    try {
        const root = join(common, 'apv', 'reviews');
        for (const commit of readdirSync(root))
            for (const domain of readdirSync(join(root, commit)))
                if (readdirSync(join(root, commit, domain)).some(n => n.endsWith('.sig')))
                    return true;
    }
    catch { /* none */ }
    return false;
}
/**
 * Whether `key` verifies at least one signed trace of the project: a line of the operator journal, a review seal, a
 * merge trace. Without a fingerprint, the only proof that a key is the one the project signed with.
 */
function signsATrace(common, key) {
    try {
        if (readFileSync(operatorJournalPath(common), 'utf8').split('\n').some(line => line.trim() && verified(line, key)))
            return true;
    }
    catch { /* none */ }
    try {
        const dir = join(common, 'apv', 'merges');
        for (const name of readdirSync(dir).filter(n => n.endsWith('.json'))) {
            try {
                const { sig, ...body } = JSON.parse(readFileSync(join(dir, name), 'utf8'));
                if (signatureValid(key, 'merge', JSON.stringify(body), sig))
                    return true;
            }
            catch { /* not this one */ }
        }
    }
    catch { /* none */ }
    try {
        const root = join(common, 'apv', 'reviews');
        for (const commit of readdirSync(root))
            for (const domain of readdirSync(join(root, commit))) {
                const dir = join(root, commit, domain);
                for (const seal of readdirSync(dir).filter(n => /^[\w-]+\.sig$/.test(n))) {
                    try {
                        const record = readFileSync(join(dir, seal.replace(/\.sig$/, '.json')));
                        if (signatureValid(key, 'review', createHash('sha256').update(record).digest('hex'), readFileSync(join(dir, seal), 'utf8').trim()))
                            return true;
                    }
                    catch { /* not this one */ }
                }
            }
    }
    catch { /* none */ }
    return false;
}
const fingerprintProblem = (common, why) => `empreinte de la clé d'ancrage illisible (${join(common, ...KEY_FINGERPRINT)} : ${why}) : l'opérateur la vérifie ; s'il est sûr de sa clé, il supprime ce fichier et l'empreinte est réenregistrée seulement si la clé vérifie une trace signée du projet ; rien de signé n'est accepté d'ici là`;
function keyProblem(file, read) {
    if (read.state === 'refused')
        return `clé d'ancrage refusée (${file} : ${read.why}) : seul un fichier ordinaire du compte est lu ; l'opérateur la restaure depuis sa sauvegarde ; rien de signé n'est accepté`;
    if (read.state === 'incomplete')
        return `clé d'ancrage illisible (${file}) : le fichier existe mais ne contient pas une clé entière (arrêt brutal pendant sa création ?) ; si le projet n'a encore rien de signé, l'opérateur supprime ce fichier et la clé est recréée, sinon il la restaure depuis sa sauvegarde ; rien de signé n'est accepté`;
    return `clé d'ancrage absente (${file}) : l'opérateur la restaure depuis sa sauvegarde ; rien de signé n'est accepté sans elle`;
}
/**
 * The key as the tool may trust it for a project: a regular file of the account, in a real folder of the account,
 * holding a whole key, the one whose fingerprint the project recorded; without a fingerprint, a project that holds
 * signed traces accepts only a key that verifies one of them. Otherwise no key and the problem: nothing signed is then
 * accepted.
 */
export function anchorKey(common, file = anchorKeyFile()) {
    const folder = keyFolderProblem(dirname(file));
    if (folder)
        return { key: null, problem: folder, createdAt: null };
    return judgeKey(common, file, readKeyFile(file), readFingerprint(common));
}
/** The judgement of `anchorKey` on a key file and a fingerprint already read. */
function judgeKey(common, file, read, fp) {
    if (fp.state === 'unreadable')
        return { key: null, problem: fingerprintProblem(common, fp.why), createdAt: null };
    const createdAt = fp.state === 'recorded' ? fp.createdAt : null;
    if (read.state !== 'key')
        return { key: null, problem: keyProblem(file, read), createdAt };
    if (fp.state === 'recorded' && fp.sha256 !== fingerprintOf(read.key))
        return { key: null, problem: `clé d'ancrage remplacée (empreinte différente de celle du projet) : l'opérateur restaure l'ancienne depuis sa sauvegarde ; rien de signé n'est accepté`, createdAt };
    if (fp.state === 'absent' && signedArtifacts(common) && !signsATrace(common, read.key)) {
        return { key: null, problem: `empreinte absente alors que le projet a des traces signées (${join(common, ...KEY_FINGERPRINT)}) et la clé n'en vérifie aucune : l'opérateur restaure la clé et l'empreinte depuis sa sauvegarde ; rien de signé n'est accepté`, createdAt: null };
    }
    return { key: read.key, problem: null, createdAt };
}
/** How long a hook waits for a key file or a fingerprint another hook is writing: 100 readings, 20 ms apart. */
const KEY_WAIT_TURNS = 100;
const KEY_WAIT_MS = 20;
const KEY_WAIT_TOTAL_MS = KEY_WAIT_TURNS * KEY_WAIT_MS;
/** Age after which a file left aside by a stopped hook is removed. */
const ASIDE_MAX_AGE_MS = 60_000;
/**
 * The key, for the hooks only. Created (32 random bytes, file 0400 in a folder 0700) only when absent and the project holds
 * nothing signed yet; never made anew in silence once something was signed (a deleted key would otherwise let anyone sign).
 * Records the fingerprint of the key in the project on first use.
 *
 * Hooks run together (four reviewers sealing at once): the key appears whole in one step (written aside, then linked under
 * its name, which fails when it exists), always before its fingerprint; a key file or a fingerprint seen incomplete is
 * waited for while it may still be written (recent, or changing), a bounded time, never taken for absent; nothing is
 * accepted by default.
 */
export function ensureAnchorKey(common, file = anchorKeyFile()) {
    checkKeyFolder(dirname(file));
    sweepAside(file);
    const found = anchorKey(common, file);
    if (found.key)
        return withFingerprint(common, found.key);
    if (readKeyFile(file).state === 'absent' && readFingerprint(common).state !== 'unreadable') {
        // What the project holds is read before the key is looked for again: a hook that creates the key links it, whole,
        // before it records the fingerprint, so a key another hook made in between is seen by this second look.
        const signed = readFingerprint(common).state !== 'absent' || signedArtifacts(common);
        if (readKeyFile(file).state === 'absent') {
            if (signed)
                throw new Error(found.problem ?? keyProblem(file, { state: 'absent' }));
            mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
            checkKeyFolder(dirname(file));
            const key = randomBytes(32);
            // Another hook may create it at the same instant: the one that links first wins, the others read its key.
            if (createExclusive(file, `${key.toString('hex')}\n`, 0o400))
                return withFingerprint(common, key);
        }
    }
    return awaitKey(common, file);
}
/**
 * The key another hook created or is writing: read until it is whole and accepted. Waited for only while the key file or
 * the fingerprint is incomplete and may still be written (younger than the wait, or changing between two readings), a
 * bounded time; anything else is refused at once with its problem.
 */
function awaitKey(common, file) {
    let last = '';
    for (let turn = 0;; turn += 1) {
        // One reading of each file per turn: the judgement and the wait see the same state.
        const key = readKeyFile(file);
        const fp = readFingerprint(common);
        const found = judgeKey(common, file, key, fp);
        if (found.key)
            return withFingerprint(common, found.key);
        const pending = key.state === 'incomplete' ? key : fp.state === 'unreadable' && fp.size !== null && fp.mtimeMs !== null ? { size: fp.size, mtimeMs: fp.mtimeMs } : null;
        const seen = pending ? `${key.state}:${pending.size}:${pending.mtimeMs}` : '';
        const writing = pending !== null && (Date.now() - pending.mtimeMs < KEY_WAIT_TOTAL_MS || (turn > 0 && seen !== last));
        last = seen;
        if (!writing || turn >= KEY_WAIT_TURNS)
            throw new Error(found.problem ?? keyProblem(file, key));
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, KEY_WAIT_MS);
    }
}
/** The key, its fingerprint recorded in the project when it has none yet. */
function withFingerprint(common, key) {
    if (readFingerprint(common).state !== 'absent')
        return key;
    const f = join(common, ...KEY_FINGERPRINT);
    mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
    sweepAside(f);
    // Recorded once: another hook recording the same key at the same instant keeps its line.
    createExclusive(f, `${JSON.stringify({ sha256: fingerprintOf(key), createdAt: new Date().toISOString() })}\n`, 0o600);
    return key;
}
/**
 * What is wrong with the folder of the key, or null: when it exists, it must be a real folder (never a link) of the
 * account. Read only: the apv side says it, the hooks refuse it (checkKeyFolder).
 */
function keyFolderProblem(dir) {
    let st;
    try {
        st = lstatSync(dir);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        return `dossier de la clé d'ancrage refusé (${dir} : illisible) ; rien de signé n'est accepté`;
    }
    if (st.isSymbolicLink() || !st.isDirectory())
        return `dossier de la clé d'ancrage refusé (${dir} : ${st.isSymbolicLink() ? 'lien symbolique' : 'pas un dossier'}) ; rien de signé n'est accepté`;
    const uid = process.getuid?.();
    if (uid !== undefined && st.uid !== uid)
        return `dossier de la clé d'ancrage refusé (${dir} : propriétaire ${st.uid}, pas le compte ${uid}) ; rien de signé n'est accepté`;
    return null;
}
/** For the hooks: the folder of the key refused as keyFolderProblem says, and closed to others (0700, tightened when it is not). */
function checkKeyFolder(dir) {
    const problem = keyFolderProblem(dir);
    if (problem)
        throw new Error(problem);
    try {
        if ((lstatSync(dir).mode & 0o077) !== 0)
            chmodSync(dir, 0o700);
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
}
/** Removes the files a stopped hook left aside next to `path` (`<name>.<pid>.<hex>.tmp`) once older than a minute. */
function sweepAside(path) {
    const dir = dirname(path);
    const prefix = `${basename(path)}.`;
    let names;
    try {
        names = readdirSync(dir);
    }
    catch {
        return;
    }
    for (const name of names) {
        if (!name.startsWith(prefix) || !/^\d+\.[0-9a-f]+\.tmp$/.test(name.slice(prefix.length)))
            continue;
        try {
            const st = lstatSync(join(dir, name));
            if (st.isFile() && Date.now() - st.mtimeMs > ASIDE_MAX_AGE_MS)
                rmSync(join(dir, name), { force: true });
        }
        catch { /* gone */ }
    }
}
/** Codes of a file system that cannot make a hard link. */
const NO_LINK = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV']);
/** Syncs a folder, so that a name just linked in it survives a crash; a system that cannot sync a folder is left as is. */
function syncFolder(dir) {
    try {
        const fd = openSync(dir, fsConstants.O_RDONLY);
        try {
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
    }
    catch { /* not supported here */ }
}
/**
 * Creates `path` with `content`, whole, only if it does not exist: written and synced aside, then linked under its name
 * (link fails when the name exists) and the folder synced, so a reader sees no file or the whole file. True when created,
 * false when it existed. On a file system without hard links, an exclusive creation (open O_EXCL), whose readers wait
 * for the content while it may still be written.
 */
function createExclusive(path, content, mode) {
    const aside = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const fd = openSync(aside, 'wx', mode);
    try {
        try {
            writeFileSync(fd, content);
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
        chmodSync(aside, mode);
    }
    catch (error) {
        rmSync(aside, { force: true });
        throw error;
    }
    try {
        linkSync(aside, path);
        syncFolder(dirname(path));
        return true;
    }
    catch (error) {
        const code = error.code ?? '';
        if (code === 'EEXIST')
            return false;
        if (!NO_LINK.has(code))
            throw error;
        try {
            writeFileSync(path, content, { mode, flag: 'wx' });
        }
        catch (e) {
            if (e.code === 'EEXIST')
                return false;
            throw e;
        }
        chmodSync(path, mode);
        syncFolder(dirname(path));
        return true;
    }
    finally {
        rmSync(aside, { force: true });
    }
}
/**
 * Signing is for the tool run as a command (`bin/apv`, `dist/cli.js`, which set APV_ENTRY) and for the hooks: a script
 * that imports the module directly cannot sign (the Bash guard also refuses such scripts). A guard rail, not a secret.
 */
const SIGNERS = new Set(['cli', 'hook']);
export function sign(key, kind, payload) {
    if (!SIGNERS.has(process.env['APV_ENTRY'] ?? ''))
        throw new Error('signature refusée hors de la commande apv et des crochets du plugin');
    return createHmac('sha256', key).update(`${kind}\n${payload}`).digest('hex');
}
export function signatureValid(key, kind, payload, signature) {
    if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/.test(signature))
        return false;
    const expected = createHmac('sha256', key).update(`${kind}\n${payload}`).digest('hex');
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
}
/** A sentence keyed with the anchor key: a short code typed alone is not found back by a dictionary. */
const keyed = (key, text) => createHmac('sha256', key).update(`sentence\n${text}`).digest('hex');
/** Text compared without its typography: spaces collapsed, apostrophes and quotes unified, case ignored. */
export function comparable(text) {
    return text.normalize('NFC').replace(/[‘’ʼ]/g, '\'').replace(/[“”«»]/g, '"').replace(/[\s  ]+/g, ' ').trim().toLowerCase();
}
const EDGE = /^[\s.!?…,;:"'()-]+|[\s.!?…,;:"'()-]+$/g;
/** The sentences of a text (split on line breaks and on . ! ? followed by a space), each made comparable, empty ones dropped. */
export function sentences(text) {
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
/**
 * A waiver line: a rule, or the rule `relecture` for one review domain (`relecture:rgpd`, issue #126), then the commit.
 * The domains are those of `apv review plan`, written out: any other word after `:` is no waiver.
 */
const WAIVER_LINE = new RegExp(`d[ée]rogation\\s+[a-z]+(?::(?:${REVIEW_DOMAINS.join('|')}))?\\s+(?:pour\\s+)?[0-9a-f]{${WAIVER_SHA},64}`, 'i');
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
    const body = { v: 2, at: meta.at, session: meta.session.slice(0, 100), sentences: [...new Set(list.map(s => keyed(key, s)))].slice(0, 200), preview, waivers };
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
export function readOperatorMessages(common, key = anchorKey(common).key) {
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
    const anchor = anchorKey(common);
    const key = anchor.key;
    let lines = [];
    try {
        lines = readFileSync(file, 'utf8').split('\n').filter(l => l.trim());
    }
    catch {
        lines = [];
    }
    const ok = lines.map(l => verified(l, key)).filter((e) => e !== null);
    const read = (note) => {
        try {
            const r = JSON.parse(readFileSync(note, 'utf8'));
            return typeof r.at === 'string' && typeof r.reason === 'string' ? { at: r.at, reason: r.reason.slice(0, 300) } : null;
        }
        catch {
            return null;
        }
    };
    // `refused.json` holds the last refused message, or a seal note of the first versions (`relecture …`).
    const single = read(join(common, ...OPERATOR_REFUSED));
    const sealed = single && /^relecture\b/.test(single.reason) ? [single] : [];
    // A note older than the journal keeps its lines is not said, even before the hook purges it on its next pass.
    const fresh = (n) => n !== null && !(Date.now() - Date.parse(n.at) > DEFAULT_JOURNAL_DAYS * 86_400_000);
    const sealRefusals = [...sealed, ...sealNotes(common).map(n => read(n.file))].filter(fresh).sort((a, b) => a.at.localeCompare(b.at));
    return { file, key: key !== null, keyProblem: anchor.problem, keyCreatedAt: anchor.createdAt, messages: ok.length, ignored: lines.length - ok.length, last: ok.at(-1)?.at ?? null,
        refused: sealed.length ? null : single, sealRefusals };
}
/** The notes of the seal hook, one file per review it could not seal (several reviewers run at once: no shared file). */
function sealNotes(common) {
    const dir = join(common, ...OPERATOR_SEAL_NOTES);
    try {
        return readdirSync(dir).filter(f => /^[\w-]+\.json$/.test(f)).map(f => ({ file: join(dir, f), id: f.slice(0, -'.json'.length) }));
    }
    catch {
        return [];
    }
}
/** Writes `content` to `file` whole or not at all (temporary file, then rename): a reader never sees half a note. */
function writeWhole(file, content) {
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
export function clearSealRefusal(common, id, domain = null, commit = null, now = new Date()) {
    forgetSealNotes(common, note => note.id === id || (domain !== null && note.domain === domain && sameCommit(note.commit, commit)), now);
    // A seal note of the versions before one file per note, kept in `refused.json` (`relecture non scellée : …`,
    // `relecture <id> non scellée : …`): no new one is written there, so the first seal lifts it.
    const file = join(common, ...OPERATOR_REFUSED);
    try {
        const r = JSON.parse(readFileSync(file, 'utf8'));
        if (typeof r.reason === 'string' && /^relecture\b/.test(r.reason))
            rmSync(file, { force: true });
    }
    catch { /* no note */ }
}
/**
 * Whether a note about `noted` (the commit the review was recorded at, as known when the note was written) is about the
 * sealed `commit`. A note that knows no commit (`--commit HEAD`, a record not found) goes with any of its domain.
 */
function sameCommit(noted, commit) {
    if (typeof noted !== 'string' || !/^[0-9a-f]{7,40}$/.test(noted))
        return true;
    return commit !== null && (commit.startsWith(noted) || noted.startsWith(commit));
}
/**
 * Removes the notes `drop` picks, and in any case those older than the journal keeps its lines (`DEFAULT_JOURNAL_DAYS`)
 * and the temporary files a stopped hook left behind: no note stays for good.
 */
function forgetSealNotes(common, drop, now) {
    const dir = join(common, ...OPERATOR_SEAL_NOTES);
    let names = [];
    try {
        names = readdirSync(dir);
    }
    catch {
        return;
    }
    for (const name of names) {
        const file = join(dir, name);
        try {
            // A temporary file younger than a minute may be a note being written by another hook.
            const age = now.getTime() - statSync(file).mtimeMs;
            if (age > DEFAULT_JOURNAL_DAYS * 86_400_000 || (name.endsWith('.tmp') && age > 60_000)) {
                rmSync(file, { force: true });
                continue;
            }
            if (!/^[\w-]+\.json$/.test(name))
                continue;
            let note = {};
            try {
                note = JSON.parse(readFileSync(file, 'utf8'));
            }
            catch { /* unreadable: by its id only */ }
            if (drop({ id: name.slice(0, -'.json'.length), domain: note.domain ?? null, commit: note.commit ?? null }))
                rmSync(file, { force: true });
        }
        catch { /* gone meanwhile */ }
    }
}
/**
 * Notes, for `apv status`, that the seal hook could not seal the review `id` of `domain` at `commit` (when known): date,
 * id, domain, commit and reason. The note replaces those of earlier reviews of the same domain and commit.
 */
export function recordSealRefusal(common, id, domain, reason, now = new Date(), commit = null) {
    if (!/^[\w-]+$/.test(id))
        return;
    const known = commit && /^[0-9a-f]{7,40}$/.test(commit) ? commit : null;
    forgetSealNotes(common, note => note.id !== id && note.domain === domain && (known === null ? typeof note.commit !== 'string' : sameCommit(note.commit, known)), now);
    writeWhole(join(common, ...OPERATOR_SEAL_NOTES, `${id}.json`), `${JSON.stringify({ at: now.toISOString(), domain, commit: known, reason: `relecture ${id} (${domain}${known ? ` ${known.slice(0, 12)}` : ''}) non scellée : ${reason}`.slice(0, 300) })}\n`);
}
/** Notes, for `apv status`, that the hook refused a prompt: date and reason, never the text. */
export function recordRefusal(common, reason, now = new Date()) {
    writeWhole(join(common, ...OPERATOR_REFUSED), `${JSON.stringify({ at: now.toISOString(), reason: reason.slice(0, 300) })}\n`);
}
/**
 * The message of the operator that holds every sentence of `quote`, or null. Whole sentences only: the journal keeps
 * their hashes, never the text, so a quote cut in the middle of a sentence is not recognised.
 */
export function anchoredQuote(messages, quote, key) {
    const wanted = sentences(quote);
    if (!key || !wanted.length || comparable(quote).length < MIN_QUOTE)
        return null;
    const hashes = wanted.map(s => keyed(key, s));
    return messages.find(m => hashes.every(h => m.sentences.includes(h))) ?? null;
}
/** The sentence the operator types himself to waive `rule` (or the review of one domain) for `sha` (shown in every refusal). */
export function waiverSentence(rule, sha) {
    return `dérogation ${rule} ${sha.slice(0, WAIVER_SHA)} : <ta raison>`;
}
/**
 * The waiver of `rule` for the commit `sha` the operator typed himself, or null: a line « dérogation <règle> <12 premiers
 * caractères du commit au moins> : <raison> ». Never for another commit, never « dérogation » alone, never without a reason.
 * `relecture:<domaine>` is the waiver of that review only: it never waives the rule `relecture` whole, nor another domain.
 */
export function waiverFor(messages, rule, sha) {
    return waiverLines(messages, rule, sha).find(w => !w.template && w.reason.length >= MIN_WAIVER_REASON) ?? null;
}
/**
 * A reason that is the template of the tool, quoted rather than written: `<ta raison>` (any `<…>`), « ta raison »,
 * « raison ». Security review of PR #128: the operator asking « l'outil m'affiche « dérogation … : <ta raison> », c'est
 * quoi ? » waived the rule.
 */
const TEMPLATE_REASON = /<[^>]*>|^\W*(?:ta |votre |une )?raison\W*$/i;
/** Whether the operator typed a waiver of `rule` for `sha` whose reason is the template of the tool: ignored, said. */
export function templateWaiver(messages, rule, sha) {
    return waiverLines(messages, rule, sha).some(w => w.template);
}
/** The waiver lines of `rule` for `sha`, newest first, with their reason and whether it is the template of the tool. */
function waiverLines(messages, rule, sha) {
    const pattern = new RegExp(`d[ée]rogation\\s+${rule}\\s+(?:pour\\s+)?([0-9a-f]{${WAIVER_SHA},64})\\s*[:,-]?\\s*(.*)`, 'i');
    const out = [];
    for (const message of [...messages].reverse()) {
        for (const line of message.waivers) {
            const m = pattern.exec(line.normalize('NFC'));
            if (!m || !sha.toLowerCase().startsWith(m[1].toLowerCase()))
                continue;
            const reason = m[2].trim();
            out.push({ message, reason, template: TEMPLATE_REASON.test(reason) });
        }
    }
    return out;
}
/** What a refusal says when the operator quoted the template of the tool instead of a reason. */
export const TEMPLATE_WAIVER_NOTE = 'Une dérogation tapée avec le gabarit de l\'outil, ignorée : raison à écrire en clair (les mots de l\'opérateur, pas « <ta raison> »).';
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