export declare function canonical(value: unknown): string;
export declare function hash(value: unknown): string;
export declare function hashFile(path: string): Promise<string>;
/** Hash raw bytes, distinct from the canonical-JSON identity helper. */
export declare function sha256(value: string | Uint8Array): string;
