/** Phase durations are observations, not additive CPU times or latency promises. */
export function phaseTimings(docEvents, runs, now) {
    const phases = { product: 0, architecture: 0, design: 0, preparation: 0, implementer: 0, validation: 0, qa: 0 };
    const rolePhase = (role) => role.includes('architecture') ? 'architecture' : role.includes('design') ? 'design' : role === 'qa' ? 'qa' : 'product';
    let preflightMs = 0;
    const active = [];
    const scan = (events, runId) => {
        const finished = new Set(events.filter(e => e.type === 'invocation.finished').map(e => e.data.invocationId));
        let probe = 0;
        for (const event of events) {
            const data = event.data;
            if (event.type === 'invocation.finished' && data.role === 'model-check')
                probe += data.durationMs ?? 0;
            if (event.type === 'invocation.started' && !finished.has(data.invocationId))
                active.push({ role: data.role ?? 'unknown', elapsedMs: Math.max(0, now - event.at), runId });
        }
        preflightMs += probe;
        return probe;
    };
    scan(docEvents, null);
    // New phase events include repairs and cleanup, including failures. Historical calls remain visible.
    const hasPhases = docEvents.some(e => e.type === 'role.phase_finished');
    let phaseBoundary = -Infinity;
    if (hasPhases)
        phaseBoundary = Math.min(...docEvents.filter(e => e.type === 'role.phase_finished').map(e => Number(e.data.startedAt ?? e.at)));
    for (const event of docEvents) {
        const data = event.data;
        if (event.type === 'role.phase_finished')
            phases[rolePhase(data.mode ?? data.role ?? '')] += Math.max(0, (data.durationMs ?? 0) - (data.preflightMs ?? 0));
        else if (event.at < phaseBoundary && event.type === 'invocation.finished' && data.role !== 'model-check')
            phases[rolePhase(data.role ?? '')] += data.durationMs ?? 0;
        else if (!hasPhases && event.type === 'invocation.finished' && data.role !== 'model-check')
            phases[rolePhase(data.role ?? '')] += data.durationMs ?? 0;
    }
    const seen = new Set();
    for (const { run, events } of runs) {
        if (seen.has(run.id))
            continue;
        seen.add(run.id);
        const probes = scan(events, run.id);
        phases.preparation += run.metrics.preparationMs;
        phases.implementer += Math.max(0, run.metrics.agentMs - probes);
        phases.validation += run.metrics.validationMs;
    }
    return { phases: Object.entries(phases).map(([phase, durationMs]) => ({ phase, durationMs: Math.round(durationMs) })),
        preflightMs: Math.round(preflightMs), active, historicalPartial: docEvents.some(e => e.type === 'invocation.finished' && e.data.role !== 'model-check' && (!hasPhases || e.at < phaseBoundary)),
        note: 'Completed phase wall times include repairs. Historical roles may contain process time only. Active invocation elapsed time is separate and does not prove progress or a live process.' };
}
//# sourceMappingURL=timings.js.map