import type { AgentConfig } from '../domain/contracts.js';
import type { JsonSchema } from '../domain/schema.js';
/** Native Claude Code protocol. Tool allowlisting is NOT an OS sandbox.
 * Shell, network tools, subagents and MCP are intentionally absent. The trusted runner executes tests.
 */
export declare function claudeCommand(agent: AgentConfig, schema: JsonSchema, readOnly: boolean): string[];
/** Never fall back to prose in `result`: structured output and success are both required. */
export declare function claudeOutput(text: string): unknown;
