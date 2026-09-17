import { parseJson } from '../domain/schema.js';
import type { Config } from '../domain/contracts.js';

/**
 * What one agent invocation spent and why it ended, as the provider reports it. These are declared values,
 * not measurements by this controller: a cost here is what the provider says it charged, never an invoice.
 */
export interface AttemptUsage {
  stopReason: string | null;
  costUsd: number | null;
  turns: number | null;
  durationMs: number | null;
}

const number = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** Claude Code reports its own limits in the result envelope; a stop reason is named rather than buried. */
function claudeUsage(text: string): AttemptUsage | null {
  let envelope: unknown;
  try { envelope = parseJson(text.slice(text.indexOf('{'))); } catch { return null; }
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) return null;
  const r = envelope as Record<string, unknown>;
  if (r['type'] !== 'result') return null;
  const subtype = typeof r['subtype'] === 'string' ? r['subtype'] : null;
  const denials = Array.isArray(r['permission_denials']) ? r['permission_denials'].length : 0;
  const stopReason = subtype === 'success' ? (denials ? 'permission-denied' : null)
    : subtype === 'error_max_turns' ? 'provider-turn-limit'
      : subtype && /budget/.test(subtype) ? 'provider-budget-limit'
        : subtype ?? 'provider-error';
  return { stopReason, costUsd: number(r['total_cost_usd']), turns: number(r['num_turns']), durationMs: number(r['duration_ms']) };
}

/**
 * Usage of the last invocation, when the configured provider reports it. A provider that reports nothing
 * yields null: the controller never invents a cost, a turn count or a reason.
 */
export function providerUsage(type: Config['agent']['type'], stdout: string): AttemptUsage | null {
  if (!stdout.trim()) return null;
  return type === 'claude' ? claudeUsage(stdout) : null;
}

/** One line an operator can act on: what stopped the agent and what it had spent when it stopped. */
export function usageSentence(usage: AttemptUsage | null): string {
  if (!usage) return '';
  const reason = usage.stopReason === 'provider-turn-limit' ? 'the provider stopped it at its turn limit (agent.maxTurns)'
    : usage.stopReason === 'provider-budget-limit' ? 'the provider stopped it at its cost ceiling (agent.maxBudgetUsd)'
      : usage.stopReason === 'permission-denied' ? 'the provider denied a permission'
        : usage.stopReason ? `the provider ended with ${usage.stopReason}` : '';
  const spent = [usage.turns === null ? '' : `${usage.turns} turns`, usage.costUsd === null ? '' : `${usage.costUsd.toFixed(2)} USD declared by the provider`].filter(Boolean).join(', ');
  return [reason, spent && `spent: ${spent}`].filter(Boolean).join('; ');
}
