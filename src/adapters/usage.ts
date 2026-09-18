import { parseJson } from '../domain/schema.js';
import type { Config } from '../domain/contracts.js';

/**
 * What one agent invocation spent and why it ended, as the provider reports it. These are declared values,
 * not measurements by this controller: a cost here is what the provider says it charged, never an invoice.
 */
export interface AttemptUsage {
  stopReason: string | null;
  /** What the provider itself said about the stop, when it says anything: quota, plan limit, API error. */
  providerMessage: string | null;
  costUsd: number | null;
  turns: number | null;
  durationMs: number | null;
  models?: string[];
  tokens?: { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null };
}
/** A provider sentence is shown to the operator: keep it short and on one line, never a whole transcript. */
const PROVIDER_MESSAGE_CHARS = 300;

const number = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);

/** Claude Code reports its own limits in the result envelope; a stop reason is named rather than buried. */
function claudeUsage(text: string): AttemptUsage | null {
  let envelope: unknown;
  try { envelope = parseJson(text.slice(text.indexOf('{'))); } catch { return null; }
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) return null;
  const r = envelope as Record<string, unknown>;
  if (r['type'] !== 'result') return null;
  const subtype = typeof r['subtype'] === 'string' ? r['subtype'] : null;
  const denials = Array.isArray(r['permission_denials']) ? r['permission_denials'].length : 0;
  // `is_error` with `subtype: success` happens: the session ended on a plan or quota limit, and the only
  // readable explanation is the provider's own sentence in `result`.
  const failed = r['is_error'] === true;
  const stopReason = subtype === 'error_max_turns' ? 'provider-turn-limit'
    : subtype && /budget/.test(subtype) ? 'provider-budget-limit'
      : denials ? 'permission-denied'
        : subtype && subtype !== 'success' ? subtype
          : failed ? 'provider-stopped' : null;
  const said = typeof r['result'] === 'string' ? r['result'].replace(/\s+/g, ' ').trim() : '';
  const usage = r['usage'] as Record<string, unknown> | undefined;
  return { stopReason, providerMessage: said && (failed || stopReason) ? said.slice(0, PROVIDER_MESSAGE_CHARS) : null,
    costUsd: number(r['total_cost_usd']), turns: number(r['num_turns']), durationMs: number(r['duration_ms']),
    ...(r['modelUsage'] && typeof r['modelUsage'] === 'object' ? { models: Object.keys(r['modelUsage']) } : {}),
    ...(usage ? { tokens: { input: number(usage['input_tokens']), output: number(usage['output_tokens']), cacheRead: number(usage['cache_read_input_tokens']), cacheWrite: number(usage['cache_creation_input_tokens']) } } : {}) };
}

/**
 * Usage of the last invocation, when the configured provider reports it. A provider that reports nothing
 * yields null: the controller never invents a cost, a turn count or a reason.
 */
export function providerUsage(type: Config['agent']['type'], stdout: string): AttemptUsage | null {
  if (!stdout.trim()) return null;
  if (type === 'claude') return claudeUsage(stdout);
  if (type === 'codex') {
    const totals = { input: 0, output: 0, cacheRead: 0 }; let turns = 0;
    for (const line of stdout.split('\n')) {
      try {
        const event = JSON.parse(line);
        if (event.type !== 'turn.completed' || !event.usage) continue;
        totals.input += number(event.usage.input_tokens) ?? 0;
        totals.output += number(event.usage.output_tokens) ?? 0;
        totals.cacheRead += number(event.usage.cached_input_tokens) ?? 0; turns++;
      } catch { /* A truncated or non-JSON diagnostic is not usage. */ }
    }
    if (turns) return { costUsd: null, stopReason: null, providerMessage: null, durationMs: null, turns, tokens: { ...totals, cacheWrite: null } };
  }
  return null;
}

/** One line an operator can act on: what stopped the agent and what it had spent when it stopped. */
export function usageSentence(usage: AttemptUsage | null): string {
  if (!usage) return '';
  const reason = usage.stopReason === 'provider-turn-limit' ? 'the provider stopped it at its turn limit (agent.maxTurns)'
    : usage.stopReason === 'provider-budget-limit' ? 'the provider stopped it at its cost ceiling (agent.maxBudgetUsd)'
      : usage.stopReason === 'permission-denied' ? 'the provider denied a permission'
        : usage.stopReason === 'provider-stopped' ? 'the provider ended the session'
          : usage.stopReason ? `the provider ended with ${usage.stopReason}` : '';
  // The provider's own sentence first: a plan or quota limit is neither a configuration nor a pipeline defect,
  // and the operator can only act on it if they read it.
  const said = usage.providerMessage ? `the provider said: "${usage.providerMessage}"` : '';
  const spent = [usage.turns === null ? '' : `${usage.turns} turns`, usage.costUsd === null ? '' : `${usage.costUsd.toFixed(2)} USD declared by the provider`].filter(Boolean).join(', ');
  return [reason, said, spent && `spent: ${spent}`].filter(Boolean).join('; ');
}
