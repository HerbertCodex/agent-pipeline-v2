export interface RepositorySymbol {
    name: string;
    kind: 'function' | 'class' | 'interface' | 'type' | 'const' | 'method';
    path: string;
    line: number;
    excerpt: string;
    score: number;
}
export interface RepositoryIntelligence {
    sha: string;
    fileCount: number;
    manifests: string[];
    architectureFiles: string[];
    securityFiles: string[];
    relevantFiles: string[];
    reuseCandidates: RepositorySymbol[];
    note: string;
}
/** Bounded, deterministic repository awareness keyed to an immutable Git SHA.
 * It is lexical rather than semantic: it surfaces reuse candidates; it does not claim equivalence. */
export declare function inspectRepository(repo: string, sha: string, query: string, signal?: AbortSignal): Promise<RepositoryIntelligence>;
