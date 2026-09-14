import type { AgentConfig } from '../domain/contracts.js';
import type { JsonSchema } from '../domain/schema.js';
import { parseJson } from '../domain/schema.js';
import { invariant } from '../domain/errors.js';
import { strictSchema } from './structured-schema.js';
/** Native Claude Code protocol. Tool allowlisting is NOT an OS sandbox.
 * Shell, network tools, subagents and MCP are intentionally absent. The trusted runner executes tests.
 */
export function claudeCommand(agent: AgentConfig, schema: JsonSchema, readOnly: boolean): string[] {
  invariant(agent.command.length <= 1, 'CONFIG', 'Claude command accepts only an executable path');
  const tools = readOnly ? 'Read,Glob,Grep' : 'Read,Glob,Grep,Edit,Write';
  return [agent.command[0] ?? 'claude', '--print', '--output-format', 'json', '--input-format', 'text',
    '--json-schema', JSON.stringify(strictSchema(schema)), '--tools', tools, '--allowedTools', tools,
    '--permission-mode', 'dontAsk', '--disallowedTools', 'Bash,Agent,Task,WebFetch,WebSearch,mcp__*',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '',
    '--settings', '{"disableAllHooks":true}', '--disable-slash-commands', '--no-session-persistence',
    '--max-turns', String(agent.maxTurns),
    ...(agent.maxBudgetUsd === null ? [] : ['--max-budget-usd', String(agent.maxBudgetUsd)]),
    ...(agent.model ? ['--model', agent.model] : [])];
}
/** Never fall back to prose in `result`: structured output and success are both required. */
export function claudeOutput(text: string): unknown {
  invariant(Buffer.byteLength(text) <= 1024 * 1024, 'CLAUDE_OUTPUT', 'Claude response exceeds limit');
  const envelope = parseJson(text);
  invariant(envelope !== null && typeof envelope === 'object' && !Array.isArray(envelope), 'CLAUDE_OUTPUT', 'Expected Claude result envelope');
  const r = envelope as Record<string, unknown>;
  invariant(r['type'] === 'result' && r['subtype'] === 'success' && r['is_error'] === false,
    'CLAUDE_OUTPUT', 'Claude did not return a successful result (budget, permissions or provider error)');
  invariant(r['permission_denials'] === undefined || (Array.isArray(r['permission_denials']) && r['permission_denials'].length === 0),
    'CLAUDE_PERMISSIONS', 'Claude reported permission denials; inspect rather than bypass');
  const output = r['structured_output'];
  invariant(output !== null && typeof output === 'object' && !Array.isArray(output), 'CLAUDE_OUTPUT', 'Missing structured_output');
  return output;
}
