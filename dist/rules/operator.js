import { readFileSync } from 'node:fs';
import { join } from 'node:path';
/**
 * The operator journal: what the operator typed himself in the session, kept by the UserPromptSubmit hook of the plugin
 * (hooks/scripts/operator-journal.mjs) in the Git common directory, outside every worktree and never versioned. It is
 * the trace an agent cannot write through the plugin: the hook keeps only the prompts of the interactive composer, and
 * the guards refuse the commands and the writes that name this folder. A human validation or a waiver the tool reads
 * elsewhere (the ledger, GitHub, a file) counts only when these words are there (docs/REGLES.md, « Ancrage »).
 * Limit: a guard rail, not a sandbox; a process outside Claude Code (or a command the guard does not recognise) can write
 * the file. The tool compares texts: it never decides that words mean a validation.
 */
export const OPERATOR_JOURNAL = ['apv', 'operator', 'messages.jsonl'];
export function operatorJournalPath(common) {
    return join(common, ...OPERATOR_JOURNAL);
}
/** The messages of the journal, oldest first; unreadable lines are skipped, a missing journal is empty. */
export function readOperatorMessages(common) {
    let raw;
    try {
        raw = readFileSync(operatorJournalPath(common), 'utf8');
    }
    catch {
        return [];
    }
    const out = [];
    for (const line of raw.split('\n')) {
        if (!line.trim())
            continue;
        try {
            const value = JSON.parse(line);
            if (typeof value['text'] === 'string' && typeof value['at'] === 'string')
                out.push({ at: value['at'], session: typeof value['session'] === 'string' ? value['session'] : '', text: value['text'] });
        }
        catch { /* skipped */ }
    }
    return out;
}
/** Text compared without its typography: spaces collapsed, apostrophes and quotes unified, case ignored. */
export function comparable(text) {
    return text.normalize('NFC').replace(/[‘’ʼ]/g, '\'').replace(/[“”«»]/g, '"').replace(/[\s  ]+/g, ' ').trim().toLowerCase();
}
/** Shortest quote that can anchor a validation: « ok » or « oui » alone never does. */
export const MIN_QUOTE = 12;
/** The message of the operator that contains `quote` word for word, or null. */
export function anchoredQuote(messages, quote) {
    const q = comparable(quote);
    if (q.length < MIN_QUOTE)
        return null;
    return messages.find(m => comparable(m.text).includes(q)) ?? null;
}
/** Shortest prefix of the commit a waiver must name. */
export const WAIVER_SHA = 12;
/** Shortest reason after the commit, in characters. */
export const MIN_WAIVER_REASON = 10;
/** The sentence the operator types himself to waive `rule` for `sha` (shown in every refusal). */
export function waiverSentence(rule, sha) {
    return `dérogation ${rule} ${sha.slice(0, WAIVER_SHA)} : <ta raison>`;
}
/**
 * The waiver of `rule` for the commit `sha` the operator typed himself, or null: a message that says
 * « dérogation <règle> <12 premiers caractères du commit au moins> : <raison> ». Never a waiver for another commit,
 * never « dérogation » alone, never a waiver without its reason.
 */
export function waiverFor(messages, rule, sha) {
    const pattern = new RegExp(`d[ée]rogation\\s+${rule}\\s+(?:pour\\s+)?([0-9a-f]{${WAIVER_SHA},64})\\s*[:,-]?\\s*(.*)`, 'i');
    for (const message of [...messages].reverse()) {
        for (const line of message.text.split('\n')) {
            const m = pattern.exec(line.normalize('NFC'));
            if (!m)
                continue;
            const prefix = m[1].toLowerCase();
            const reason = m[2].trim();
            if (sha.toLowerCase().startsWith(prefix) && reason.length >= MIN_WAIVER_REASON)
                return { message, reason };
        }
    }
    return null;
}
//# sourceMappingURL=operator.js.map