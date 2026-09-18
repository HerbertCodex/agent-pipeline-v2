import type { FeedbackConnection } from '../execution/feedback.js';
import type { AgentConfig } from '../domain/contracts.js';
import type { JsonSchema } from '../domain/schema.js';
/** Native Claude Code protocol. Tool allowlisting is NOT an OS sandbox.
 * No shell, network tools or subagents. Optional check-only MCP is supplied by the controller.
 */
export declare function claudeCommand(agent: AgentConfig, schema: JsonSchema, readOnly: boolean, feedback?: FeedbackConnection): string[];
/** Never fall back to prose in `result`: structured output and success are both required. */
export declare function claudeOutput(text: string): unknown;
