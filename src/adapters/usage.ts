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
}
/** A provider sentence is shown to the operator: keep it short and on one line, never a whole transcript. */
const PROVIDER_MESSAGE_CHARS = 300;

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
  // `is_error` with `subtype: success` happens: the session ended on a plan or quota limit, and the only
  // readable explanation is the provider's own sentence in `result`.
  const failed = r['is_error'] === true;
  const stopReason = subtype === 'error_max_turns' ? 'provider-turn-limit'
    : subtype && /budget/.test(subtype) ? 'provider-budget-limit'
      : denials ? 'permission-denied'
        : subtype && subtype !== 'success' ? subtype
          : failed ? 'provider-stopped' : null;
  const said = typeof r['result'] === 'string' ? r['result'].replace(/\s+/g, ' ').trim() : '';
  return { stopReason, providerMessage: said && (failed || stopReason) ? said.slice(0, PROVIDER_MESSAGE_CHARS) : null,
    costUsd: number(r['total_cost_usd']), turns: number(r['num_turns']), durationMs: number(r['duration_ms']) };
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
        : usage.stopReason === 'provider-stopped' ? 'the provider ended the session'
          : usage.stopReason ? `the provider ended with ${usage.stopReason}` : '';
  // The provider's own sentence first: a plan or quota limit is neither a configuration nor a pipeline defect,
  // and the operator can only act on it if they read it.
  const said = usage.providerMessage ? `the provider said: "${usage.providerMessage}"` : '';
  const spent = [usage.turns === null ? '' : `${usage.turns} turns`, usage.costUsd === null ? '' : `${usage.costUsd.toFixed(2)} USD declared by the provider`].filter(Boolean).join(', ');
  return [reason, said, spent && `spent: ${spent}`].filter(Boolean).join('; ');
}
