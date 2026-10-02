import type { GhRunner } from '../stack/github.js';
import { type MergeAudit } from './merges.js';
import { type JournalState } from './operator.js';
import { type Protection } from './protection.js';
/** What `apv status` says of the anchors: the operator journal, the branch protection, the merge audit. */
export interface AnchorStatus {
    journal: JournalState;
    protection: Protection;
    audit: MergeAudit | null;
}
export declare function anchorStatus(repo: string, gh: GhRunner): Promise<AnchorStatus | null>;
/** The journal in one or two lines: messages kept, or why none (Claude Code without the source field, no key). */
export declare function journalLines(j: JournalState): string[];
export declare function anchorLines(a: AnchorStatus): string[];
