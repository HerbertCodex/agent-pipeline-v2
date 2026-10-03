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
export declare const OPERATOR_JOURNAL: readonly ["apv", "operator", "messages.jsonl"];
/** Written by the hook when it refuses a prompt (source absent or not the operator's): its date and reason, never the text. */
export declare const OPERATOR_REFUSED: readonly ["apv", "operator", "refused.json"];
/** Written by the seal hook, one file per review it could not seal (`<id>.json`), removed once that domain is sealed. */
export declare const OPERATOR_SEAL_NOTES: readonly ["apv", "operator", "sceau"];
/** Days a line of the journal is kept by default (`rules.journalDays`). */
export declare const DEFAULT_JOURNAL_DAYS = 90;
/** In-process tests only: the anchor key file. No option nor variable of the tool changes it. */
export declare function setAnchorKeyFile(file: string | null): void;
/** Folder and file of the anchor key: a place agents have no reason to touch, whose name the guards recognise. */
export declare const ANCHOR_DIR = ".apv-ancrage";
export declare const ANCHOR_FILE = "cle-ancrage";
/**
 * The anchor key file: `<home of the account>/.apv-ancrage/cle-ancrage` (folder 0700, file 0400). The home comes from the
 * account database (`os.userInfo()`), never from `HOME` or `XDG_CONFIG_HOME`, which a command can set for itself.
 */
export declare function anchorKeyFile(): string;
export declare function readAnchorKey(file?: string): Buffer | null;
/** Fingerprint of the key in the Git common directory of each project: a replaced key is detected, never trusted. */
export declare const KEY_FINGERPRINT: readonly ["apv", "operator", "cle.empreinte"];
export interface AnchorKey {
    key: Buffer | null;
    problem: string | null;
    createdAt: string | null;
}
/**
 * The key as the tool may trust it for a project: present, and the one whose fingerprint the project recorded. A missing
 * key, or another one (deleted then made anew), gives no key and the problem: nothing signed is then accepted.
 */
export declare function anchorKey(common: string, file?: string): AnchorKey;
/**
 * The key, for the hooks only. Created (32 random bytes, file 0400 in a folder 0700) only when absent and the project holds
 * nothing signed yet; never made anew in silence once something was signed (a deleted key would otherwise let anyone sign).
 * Records the fingerprint of the key in the project on first use.
 */
export declare function ensureAnchorKey(common: string, file?: string): Buffer;
export declare function sign(key: Buffer, kind: string, payload: string): string;
export declare function signatureValid(key: Buffer, kind: string, payload: string, signature: unknown): boolean;
/** Text compared without its typography: spaces collapsed, apostrophes and quotes unified, case ignored. */
export declare function comparable(text: string): string;
/** The sentences of a text (split on line breaks and on . ! ? followed by a space), each made comparable, empty ones dropped. */
export declare function sentences(text: string): string[];
/** Shortest quote that can anchor a validation: « ok » or « oui » alone never does. */
export declare const MIN_QUOTE = 12;
/** Shortest prefix of the commit a waiver must name. */
export declare const WAIVER_SHA = 12;
/** Shortest reason after the commit, in characters. */
export declare const MIN_WAIVER_REASON = 10;
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
export declare function journalEntry(text: string, meta: {
    at: string;
    session: string;
}, key: Buffer): JournalEntry | null;
export declare function operatorJournalPath(common: string): string;
/** Appends an entry, then drops the lines older than `keepDays` (and unreadable ones). */
export declare function appendJournal(common: string, entry: JournalEntry, keepDays?: number, now?: Date): void;
/** The signed messages of the journal, oldest first; unsigned, altered or unreadable lines are ignored. */
export declare function readOperatorMessages(common: string, key?: Buffer<ArrayBufferLike> | null): OperatorMessage[];
/**
 * What `apv status` says of the journal: signed messages kept, ignored lines, last message, last refused message, and
 * every review the seal hook could not seal (oldest first).
 */
export interface JournalState {
    file: string;
    key: boolean;
    keyProblem: string | null;
    keyCreatedAt: string | null;
    messages: number;
    ignored: number;
    last: string | null;
    refused: {
        at: string;
        reason: string;
    } | null;
    sealRefusals: {
        at: string;
        reason: string;
    }[];
}
export declare function journalState(common: string): JournalState;
/**
 * Forgets the notes of the seal hook once the review `id` of `domain` at `commit` is sealed: the note about that review,
 * and those about earlier reviews of the same domain at the same commit, which this one replaces (each record gets a new
 * id, so a note kept for its own id only would stay for good; the unsealed record itself is still said by `apv review
 * show`). A note about another domain or another commit, or a refused message, stays.
 */
export declare function clearSealRefusal(common: string, id: string, domain?: string | null, commit?: string | null, now?: Date): void;
/**
 * Notes, for `apv status`, that the seal hook could not seal the review `id` of `domain` at `commit` (when known): date,
 * id, domain, commit and reason. The note replaces those of earlier reviews of the same domain and commit.
 */
export declare function recordSealRefusal(common: string, id: string, domain: string, reason: string, now?: Date, commit?: string | null): void;
/** Notes, for `apv status`, that the hook refused a prompt: date and reason, never the text. */
export declare function recordRefusal(common: string, reason: string, now?: Date): void;
/**
 * The message of the operator that holds every sentence of `quote`, or null. Whole sentences only: the journal keeps
 * their hashes, never the text, so a quote cut in the middle of a sentence is not recognised.
 */
export declare function anchoredQuote(messages: readonly OperatorMessage[], quote: string, key?: Buffer | null): OperatorMessage | null;
/** The sentence the operator types himself to waive `rule` for `sha` (shown in every refusal). */
export declare function waiverSentence(rule: MergeRule, sha: string): string;
/**
 * The waiver of `rule` for the commit `sha` the operator typed himself, or null: a line « dérogation <règle> <12 premiers
 * caractères du commit au moins> : <raison> ». Never for another commit, never « dérogation » alone, never without a reason.
 */
export declare function waiverFor(messages: readonly OperatorMessage[], rule: MergeRule, sha: string): {
    message: OperatorMessage;
    reason: string;
} | null;
/** Whether the key file exists with no access for group and others. */
export declare function anchorKeyPrivate(file?: string): boolean;
