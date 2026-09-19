import type { FeedbackConnection } from '../execution/feedback.js';
import type { AgentConfig } from '../domain/contracts.js';
import type { JsonSchema } from '../domain/schema.js';
import { parseJson } from '../domain/schema.js';
import { invariant } from '../domain/errors.js';
import { strictSchema } from './structured-schema.js';
/** Native Claude Code protocol. Tool allowlisting is NOT an OS sandbox.
 * No shell, network tools or subagents. Optional check-only MCP is supplied by the controller.
 */
export function claudeCommand(agent: AgentConfig, schema: JsonSchema, readOnly: boolean, feedback?: FeedbackConnection): string[] {
  invariant(agent.command.length <= 1, 'CONFIG', 'Claude command accepts only an executable path');
  invariant(!readOnly || !feedback, 'CONFIG', 'Read-only roles cannot run project checks');
  const tools = readOnly ? 'Read,Glob,Grep' : 'Read,Glob,Grep,Edit,Write';
  const allowed = tools + (feedback ? ',mcp__pipeline__run_check' : '');
  return [agent.command[0] ?? 'claude', '--print', '--output-format', 'json', '--input-format', 'text',
    '--json-schema', JSON.stringify(strictSchema(schema)), '--tools', tools, '--allowedTools', allowed,
    '--permission-mode', 'dontAsk', '--disallowedTools', `Bash,Agent,Task,WebFetch,WebSearch${feedback ? '' : ',mcp__*'}`,
    '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: feedback ? { pipeline: { type: 'http', url: feedback.url, headers: { Authorization: `Bearer ${feedback.token}` } } } : {} }), '--setting-sources', '',
    '--settings', '{"disableAllHooks":true,"disableClaudeAiConnectors":true}', '--disable-slash-commands', '--no-session-persistence',
    '--max-turns', String(agent.maxTurns),
    ...(agent.usageMode === 'subscription' || agent.maxBudgetUsd === null ? [] : ['--max-budget-usd', String(agent.maxBudgetUsd)]),
    ...(agent.model ? ['--model', agent.model] : []),
    ...(agent.effort && agent.effort !== 'default' ? ['--effort', agent.effort] : [])];
}
/** Never fall back to prose in `result`: structured output and success are both required. */
export function claudeOutput(text: string): unknown {
  invariant(Buffer.byteLength(text) <= 1024 * 1024, 'CLAUDE_OUTPUT', 'Claude response exceeds limit');
  const envelope = parseJson(text);
  invariant(envelope !== null && typeof envelope === 'object' && !Array.isArray(envelope), 'CLAUDE_OUTPUT', 'Expected Claude result envelope');
  const r = envelope as Record<string, unknown>;
  invariant(r['type'] === 'result', 'CLAUDE_OUTPUT', 'Expected Claude result envelope');
  invariant(r['subtype'] === 'success' && r['is_error'] === false,
    'CLAUDE_PROVIDER', `Claude provider stopped: ${typeof r['subtype'] === 'string' ? r['subtype'] : 'unknown result'} (inspect budget, turns or provider errors)`);
  invariant(r['permission_denials'] === undefined || (Array.isArray(r['permission_denials']) && r['permission_denials'].length === 0),
    'CLAUDE_PERMISSIONS', 'Claude reported permission denials; inspect rather than bypass');
  const output = r['structured_output'];
  invariant(output !== null && typeof output === 'object' && !Array.isArray(output), 'CLAUDE_OUTPUT', 'Missing structured_output');
  return output;
}
