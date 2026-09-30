import type { MergeRule } from './config.js';
/**
 * The operator journal: what the operator typed himself in the session, kept by the UserPromptSubmit hook of the plugin
 * (hooks/scripts/operator-journal.mjs) in the Git common directory, outside every worktree and never versioned. It is
 * the trace an agent cannot write through the plugin: the hook keeps only the prompts of the interactive composer, and
 * the guards refuse the commands and the writes that name this folder. A human validation or a waiver the tool reads
 * elsewhere (the ledger, GitHub, a file) counts only when these words are there (docs/REGLES.md, « Ancrage »).
 * Limit: a guard rail, not a sandbox; a process outside Claude Code (or a command the guard does not recognise) can write
 * the file. The tool compares texts: it never decides that words mean a validation.
 */
export declare const OPERATOR_JOURNAL: readonly ["apv", "operator", "messages.jsonl"];
export interface OperatorMessage {
    at: string;
    session: string;
    text: string;
}
export declare function operatorJournalPath(common: string): string;
/** The messages of the journal, oldest first; unreadable lines are skipped, a missing journal is empty. */
export declare function readOperatorMessages(common: string): OperatorMessage[];
/** Text compared without its typography: spaces collapsed, apostrophes and quotes unified, case ignored. */
export declare function comparable(text: string): string;
/** Shortest quote that can anchor a validation: « ok » or « oui » alone never does. */
export declare const MIN_QUOTE = 12;
/** The message of the operator that contains `quote` word for word, or null. */
export declare function anchoredQuote(messages: readonly OperatorMessage[], quote: string): OperatorMessage | null;
/** Shortest prefix of the commit a waiver must name. */
export declare const WAIVER_SHA = 12;
/** Shortest reason after the commit, in characters. */
export declare const MIN_WAIVER_REASON = 10;
/** The sentence the operator types himself to waive `rule` for `sha` (shown in every refusal). */
export declare function waiverSentence(rule: MergeRule, sha: string): string;
/**
 * The waiver of `rule` for the commit `sha` the operator typed himself, or null: a message that says
 * « dérogation <règle> <12 premiers caractères du commit au moins> : <raison> ». Never a waiver for another commit,
 * never « dérogation » alone, never a waiver without its reason.
 */
export declare function waiverFor(messages: readonly OperatorMessage[], rule: MergeRule, sha: string): {
    message: OperatorMessage;
    reason: string;
} | null;
