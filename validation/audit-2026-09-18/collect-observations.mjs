// Read-only extraction of compact operational metadata; no provider or controller is started.
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';

const [database, repository, output] = process.argv.slice(2);
if (!database || !repository || !output) throw new Error('Usage: node collect-observations.mjs DATABASE REPOSITORY OUTPUT');
const db = new DatabaseSync(database, { readOnly: true });
const specs = [];
try {
  for (const row of db.prepare("SELECT id,data FROM documents WHERE kind='spec'").all()) {
    const r = JSON.parse(row.data);
    if (r.repo !== repository) continue;
    const events = db.prepare('SELECT at,type,data FROM document_events WHERE doc_id=? ORDER BY seq').all(row.id)
      .map(e => ({ ...e, data: JSON.parse(e.data) }));
    const runs = r.attempts.map(a => db.prepare('SELECT data FROM runs WHERE id=?').get(a.runId))
      .filter(Boolean).map(row => JSON.parse(row.data));
    const roles = events.filter(e => e.type === 'role.finished');
    specs.push({
      id: row.id, title: r.content?.title ?? null, status: r.status, revision: r.revision,
      taskCount: r.content?.tasks.length ?? 0, criterionCount: r.content?.acceptance.length ?? 0,
      specBytes: r.content ? Buffer.byteLength(JSON.stringify(r.content)) : null,
      configured: { provider: r.config.agent.type, model: r.config.agent.model,
        turnLimit: r.config.agent.maxTurns, costLimitUsd: r.config.agent.maxBudgetUsd,
        agentTimeoutMs: r.config.agent.timeoutMs, runTimeoutMs: r.config.maxRunMs },
      activeMs: r.activeMs,
      productCompletedMs: roles.filter(e => e.data.role === 'product')
        .reduce((s, e) => s + (e.data.timingsMs?.total ?? e.data.durationMs), 0),
      knownImplementationCostUsd: runs.reduce((s, x) => s + (x.metrics.costUsd ?? 0), 0),
      unknownImplementationCostTaskIds: runs.filter(x => x.metrics.costUsd === undefined).map(x => x.task.id),
      knownRoleCostUsd: roles.reduce((s, e) => s + (e.data.usage?.costUsd ?? 0), 0),
      implementationAgentMs: runs.reduce((s, x) => s + x.metrics.agentMs, 0),
      implementationValidationMs: runs.reduce((s, x) => s + x.metrics.validationMs, 0),
      implementationPreparationMs: runs.reduce((s, x) => s + x.metrics.preparationMs, 0),
      events: events.filter(e => ['role.finished', 'role.output_repair', 'product.failed'].includes(e.type)).map(e => {
        const d = e.data;
        const message = d.error?.message ?? d.message;
        let envelope;
        const offset = message?.indexOf('\n\n{') ?? -1;
        if (offset >= 0) { try { envelope = JSON.parse(message.slice(offset + 2)); } catch { /* Historical excerpts may be truncated. */ } }
        return {
          at: new Date(e.at).toISOString(), type: e.type, role: d.role ?? null, mode: d.mode ?? null,
          durationMs: d.durationMs ?? null, attempts: d.attempts ?? null,
          usage: d.usage ?? null, timingsMs: d.timingsMs ?? null,
          error: message ? message.split('\n')[0].slice(0, 500) : null,
          providerDeclaredModels: envelope?.modelUsage ? Object.keys(envelope.modelUsage) : null,
          failedCostUsd: envelope?.total_cost_usd ?? null,
          failedUsage: envelope?.usage ? {
            inputTokens: envelope.usage.input_tokens, outputTokens: envelope.usage.output_tokens,
            cacheReadInputTokens: envelope.usage.cache_read_input_tokens,
            cacheCreationInputTokens: envelope.usage.cache_creation_input_tokens,
            thinkingTokens: envelope.usage.output_tokens_details?.thinking_tokens,
          } : null,
        };
      }),
    });
  }
} finally { db.close(); }
const report = {
  capturedAt: new Date().toISOString(),
  source: 'Read-only queries against the local SQLite store; no model invoked.',
  limitations: [
    'Historical rows span framework revisions; missing cost means unknown, not zero.',
    'Recorded metrics are not a controlled benchmark or a provider invoice.',
    'Only compact metadata exported; prompts, full responses and application source excluded.',
    'The live store can evolve during extraction; this is not an atomic database backup.',
  ],
  specs,
};
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output, specCount: specs.length, capturedAt: report.capturedAt }));
