/** Identifies the QA implementation actually loaded from this installation, independently of cwd. */
export declare function qaRuntime(): {
    version: string;
    installation: string;
    qaEngineHash: string;
    qaSchemaHash: string;
    qaInstructionsHash: string;
};
