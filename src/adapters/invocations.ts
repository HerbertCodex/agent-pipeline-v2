import { decisionRecord } from '../policy/decision.js';
import { hash } from '../domain/hash.js';
import { applyModelOverrides } from './routing.js';
import { executionAgent, specCostCeiling } from './billing.js';
import { randomUUID } from 'node:crypto';
import type { AgentConfig, ProcessResult } from '../domain/contracts.js';
import { invariant } from '../domain/errors.js';
import type { Store } from '../persistence/store.js';
import type { SpecRecord } from '../lifecycle/contracts.js';
import { providerUsage, type AttemptUsage } from './usage.js';

export interface InvocationOwner { kind: 'run' | 'document'; id: string }
export interface CostSummary { knownUsd: number; unknownInvocations: number; pendingInvocations: number }
interface Event { type: string; data: unknown }

/** Accounting is independent of output acceptance. An unfinished call remains visible after a crash. */
export function invocationTotals(events: Event[], budgetOnly = false): CostSummary {
  const subscriptions = new Set(events.flatMap(e => {
    const d = e.data as { invocationId?: string; usageMode?: string };
    return d.invocationId && d.usageMode === 'subscription' ? [d.invocationId] : [];
  }));
  const started = new Set<string>();
  const finished = new Set<string>();
  let knownUsd = 0; let unknownInvocations = 0;
  for (const event of events) {
    const d = event.data as { invocationId?: string; usage?: AttemptUsage | null };
    if (budgetOnly && d.invocationId && subscriptions.has(d.invocationId)) continue;
    if (event.type === 'invocation.started' && d.invocationId) started.add(d.invocationId);
    if (event.type !== 'invocation.finished' || !d.invocationId || finished.has(d.invocationId)) continue;
    finished.add(d.invocationId);
    if (d.usage?.costUsd === null || d.usage?.costUsd === undefined) unknownInvocations++;
    else knownUsd += d.usage.costUsd;
  }
  return { knownUsd, unknownInvocations, pendingInvocations: [...started].filter(id => !finished.has(id)).length };
}

/** Legacy metrics are included only before the first journal entry, to avoid counting an invocation twice. */
export function specCosts(store: Store, record: SpecRecord, documentId: string, budgetOnly = false): CostSummary {
  const events = store.documentEvents(documentId, ['invocation.started', 'invocation.finished', 'role.finished', 'role.output_repair', 'product.failed']);
  const total = invocationTotals(events, budgetOnly);
  const first = events.find(e => e.type === 'invocation.started')?.seq ?? Infinity;
  for (const e of events.filter(e => e.seq < first && e.type === 'role.finished')) {
    const d = e.data as { usage?: AttemptUsage };
    if (d.usage?.costUsd != null) total.knownUsd += d.usage.costUsd;
    else total.unknownInvocations++;
  }
  total.unknownInvocations += events.filter(e => e.seq < first && ['role.output_repair', 'product.failed'].includes(e.type)).length;
  for (const id of new Set([...record.attempts.map(a => a.runId), ...record.validationRunIds])) {
    const run = store.get(id); const runEvents = store.events(id, ['invocation.started', 'invocation.finished', 'agent.usage']);
    const part = invocationTotals(runEvents, budgetOnly);
    total.knownUsd += part.knownUsd;
    total.unknownInvocations += part.unknownInvocations;
    total.pendingInvocations += part.pendingInvocations;
    const boundary = runEvents.find(e => e.type === 'invocation.started')?.seq ?? Infinity;
    const legacy = runEvents.filter(e => e.seq < boundary && e.type === 'agent.usage');
    if (legacy.length) for (const e of legacy) {
      const usage = e.data as unknown as AttemptUsage;
      if (usage.costUsd != null) total.knownUsd += usage.costUsd; else total.unknownInvocations++;
    }
    else if (boundary === Infinity && run.metrics.agentMs > 0) {
      if (run.metrics.costUsd !== undefined) total.knownUsd += run.metrics.costUsd; else total.unknownInvocations++;
    }
  }
  return total;
}

/** Metered/legacy calls share the remaining declared budget; included subscription calls bypass USD ceilings. */
export function budgetedAgent(store: Store, documentId: string | undefined, agent: AgentConfig, acceptCost = false, role: 'product' | 'design' | 'implementer' | 'qa' = 'implementer'): AgentConfig {
  if (!documentId) return executionAgent(agent);
  const document = store.document<SpecRecord>(documentId, 'spec');
  if (document.kind !== 'spec') return executionAgent(agent);
  agent = executionAgent(applyModelOverrides(agent, document.data.config, role, document.data.operational));
  if (acceptCost || agent.usageMode === 'subscription') return agent;
  const ceiling = specCostCeiling(document.data);
  if (ceiling === null || ceiling === undefined) return agent;
  const costs = specCosts(store, document.data, documentId, true);
  const remaining = ceiling - costs.knownUsd;
  invariant(remaining >= 0.01, 'COST_BUDGET', `Spec declared spending ${costs.knownUsd.toFixed(2)} USD reached its ${ceiling.toFixed(2)} USD ceiling; ${costs.unknownInvocations} calls have unknown cost. Authorize an operational budget amendment before continuing.`);
  return agent.type === 'claude' ? { ...agent, maxBudgetUsd: Math.min(agent.maxBudgetUsd ?? remaining, Math.floor(remaining * 100) / 100) } : agent;
}

export function remainingSpecMs(store: Store, documentId?: string): number {
  if (!documentId) return Infinity;
  const r = store.document<SpecRecord>(documentId, 'spec').data;
  return (r.operational?.maxActiveMs ?? r.config.workflow.maxActiveMs) - r.activeMs - (r.planningMs ?? 0)
    - (r.sessionStartedAt ? Math.max(0, Date.now() - r.sessionStartedAt) : 0);
}

export function startInvocation(store: Store, owner: InvocationOwner, agent: AgentConfig, role: string, input: string) {
  if (owner.kind === 'run') {
    const events = store.events(owner.id, ['invocation.started', 'agent.usage']); const run = store.get(owner.id);
    if (!events.some(e => ['invocation.started', 'agent.usage'].includes(e.type)) && run.metrics.agentMs > 0)
      store.event(owner.id, 'agent.usage', { costUsd: run.metrics.costUsd ?? null, legacyBaseline: true });
  }
  const invocationId = randomUUID();
  const emit = (type: string, data: Record<string, unknown>): void => {
    if (owner.kind === 'run') store.event(owner.id, type, data); else store.documentEvent(owner.id, type, data);
  };
  const decision = decisionRecord('invocation', { role, provider: agent.type, model: agent.model || null, effort: agent.effort,
    usageMode: agent.usageMode ?? 'legacy', inputHash: hash(input), timeoutMs: agent.timeoutMs, maxBudgetUsd: agent.maxBudgetUsd },
    { action: 'invoke', monetaryCeiling: agent.usageMode === 'subscription' ? null : agent.maxBudgetUsd },
    [agent.usageMode === 'subscription' ? 'included-subscription-no-usd-ceiling' : 'configured-monetary-policy', agent.model ? 'explicit-model' : 'legacy-provider-default']);
  emit('invocation.started', { decision, invocationId, role, provider: agent.type, requestedModel: agent.model || null, requestedEffort: agent.effort ?? 'default',
    usageMode: agent.usageMode ?? 'legacy', inputBytes: Buffer.byteLength(input), timeoutMs: agent.timeoutMs, maxBudgetUsd: agent.maxBudgetUsd });
  return {
    finish(result: ProcessResult): AttemptUsage | null {
      const usage = providerUsage(agent.type, result.stdout);
      emit('invocation.finished', { invocationId, role, provider: agent.type, requestedModel: agent.model || null, requestedEffort: agent.effort ?? 'default',
        usageMode: agent.usageMode ?? 'legacy', status: result.status, durationMs: result.durationMs, usage, costStatus: usage?.costUsd == null ? 'unknown' : 'known',
        stdoutHash: result.stdoutHash, stderrHash: result.stderrHash, truncated: result.truncated });
      return usage;
    },
  };
}
