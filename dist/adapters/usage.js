import { parseJson } from '../domain/schema.js';
const number = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
/** Claude Code reports its own limits in the result envelope; a stop reason is named rather than buried. */
function claudeUsage(text) {
    let envelope;
    try {
        envelope = parseJson(text.slice(text.indexOf('{')));
    }
    catch {
        return null;
    }
    if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope))
        return null;
    const r = envelope;
    if (r['type'] !== 'result')
        return null;
    const subtype = typeof r['subtype'] === 'string' ? r['subtype'] : null;
    const denials = Array.isArray(r['permission_denials']) ? r['permission_denials'].length : 0;
    const stopReason = subtype === 'success' ? (denials ? 'permission-denied' : null)
        : subtype === 'error_max_turns' ? 'provider-turn-limit'
            : subtype && /budget/.test(subtype) ? 'provider-budget-limit'
                : subtype ?? 'provider-error';
    const usage = r['usage'];
    return { stopReason, costUsd: number(r['total_cost_usd']), turns: number(r['num_turns']), durationMs: number(r['duration_ms']),
        ...(r['modelUsage'] && typeof r['modelUsage'] === 'object' ? { models: Object.keys(r['modelUsage']) } : {}),
        ...(usage ? { tokens: { input: number(usage['input_tokens']), output: number(usage['output_tokens']), cacheRead: number(usage['cache_read_input_tokens']), cacheWrite: number(usage['cache_creation_input_tokens']) } } : {}) };
}
/**
 * Usage of the last invocation, when the configured provider reports it. A provider that reports nothing
 * yields null: the controller never invents a cost, a turn count or a reason.
 */
export function providerUsage(type, stdout) {
    if (!stdout.trim())
        return null;
    if (type === 'claude')
        return claudeUsage(stdout);
    if (type === 'codex') {
        const totals = { input: 0, output: 0, cacheRead: 0 };
        let turns = 0;
        for (const line of stdout.split('\n')) {
            try {
                const event = JSON.parse(line);
                if (event.type !== 'turn.completed' || !event.usage)
                    continue;
                totals.input += number(event.usage.input_tokens) ?? 0;
                totals.output += number(event.usage.output_tokens) ?? 0;
                totals.cacheRead += number(event.usage.cached_input_tokens) ?? 0;
                turns++;
            }
            catch { /* A truncated or non-JSON diagnostic is not usage. */ }
        }
        if (turns)
            return { costUsd: null, stopReason: null, durationMs: null, turns, tokens: { ...totals, cacheWrite: null } };
    }
    return null;
}
/** One line an operator can act on: what stopped the agent and what it had spent when it stopped. */
export function usageSentence(usage) {
    if (!usage)
        return '';
    const reason = usage.stopReason === 'provider-turn-limit' ? 'the provider stopped it at its turn limit (agent.maxTurns)'
        : usage.stopReason === 'provider-budget-limit' ? 'the provider stopped it at its cost ceiling (agent.maxBudgetUsd)'
            : usage.stopReason === 'permission-denied' ? 'the provider denied a permission'
                : usage.stopReason ? `the provider ended with ${usage.stopReason}` : '';
    const spent = [usage.turns === null ? '' : `${usage.turns} turns`, usage.costUsd === null ? '' : `${usage.costUsd.toFixed(2)} USD declared by the provider`].filter(Boolean).join(', ');
    return [reason, spent && `spent: ${spent}`].filter(Boolean).join('; ');
}
//# sourceMappingURL=usage.js.map