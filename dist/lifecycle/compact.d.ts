import { type Config } from '../domain/contracts.js';
import { type Spec } from './contracts.js';
/** Explicit compact input is already a scoped task. No paid Product or Design round is needed.
 * Normal spec validation, decision coverage, approval, risk escalation and gates still apply.
 */
export declare function compactProposal(input: unknown, request: string, config: Config): Spec;
