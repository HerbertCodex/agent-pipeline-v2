import { hash } from '../domain/hash.js';

/** Clock-free audit identity. Inputs must contain policy data, never credentials or raw provider output. */
export function decisionRecord<I, O>(kind: string, inputs: I, result: O, reasons: string[]) {
  const policyVersion = 'execution-policy-1';
  return { policyVersion, kind, inputs, inputHash: hash(inputs), result, reasons,
    decisionHash: hash({ policyVersion, kind, inputs, result, reasons }) };
}
