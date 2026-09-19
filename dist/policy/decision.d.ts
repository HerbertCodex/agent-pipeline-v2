/** Clock-free audit identity. Inputs must contain policy data, never credentials or raw provider output. */
export declare function decisionRecord<I, O>(kind: string, inputs: I, result: O, reasons: string[]): {
    policyVersion: string;
    kind: string;
    inputs: I;
    inputHash: string;
    result: O;
    reasons: string[];
    decisionHash: string;
};
