import type { RepositoryIntelligence } from './repository.js';
/** Select relevant declarations for a fresh task; report omissions and preserve repository access for exploration. */
export declare function focusedIntelligence(source: RepositoryIntelligence, paths?: readonly string[]): RepositoryIntelligence;
