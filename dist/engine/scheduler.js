import { invariant } from '../domain/errors.js';
import { validateDag } from '../policy/policy.js';
export const success = (r) => r.status === 'passed' || r.status === 'cached';
/** Ready queue with dependencies, named resources and shared-workspace read/write exclusion.
 * Only explicitly read-only gates overlap; a writer excludes readers too. An error never
 * leaves sibling processes running: all active promises are drained before throw. */
export async function schedule(gates, options) {
    validateDag(gates);
    invariant(Number.isInteger(options.concurrency) && options.concurrency > 0, 'DAG', 'Invalid concurrency');
    const controller = new AbortController();
    const signal = AbortSignal.any([options.signal, controller.signal]);
    const pending = new Map(gates.map(g => [g.id, g]));
    const running = new Map();
    const held = new Set();
    let writer = false;
    const done = new Map();
    let fatal;
    try {
        while (pending.size || running.size) {
            for (const [id, gate] of pending) {
                const failedDependency = gate.dependsOn.some(d => done.has(d) && !success(done.get(d)));
                if (signal.aborted || failedDependency) {
                    done.set(id, options.blocked(gate, signal.aborted ? 'Execution cancelled' : 'Dependency failed'));
                    pending.delete(id);
                    continue;
                }
                if (running.size >= options.concurrency || writer || (!gate.readOnly && running.size > 0) || !gate.dependsOn.every(d => done.has(d)) || gate.resources.some(r => held.has(r)))
                    continue;
                pending.delete(id);
                gate.resources.forEach(r => held.add(r));
                if (!gate.readOnly)
                    writer = true;
                const promise = Promise.resolve().then(() => options.execute(gate, signal)).then(receipt => {
                    done.set(id, receipt);
                    if (!success(receipt) && options.failFast)
                        controller.abort();
                }).catch((error) => { fatal ??= error; controller.abort(); }).finally(() => {
                    running.delete(id);
                    gate.resources.forEach(r => held.delete(r));
                    if (!gate.readOnly)
                        writer = false;
                });
                running.set(id, promise);
            }
            if (running.size)
                await Promise.race(running.values());
            else if (pending.size)
                throw new Error('Scheduler cannot make progress');
        }
    }
    catch (error) {
        controller.abort();
        await Promise.allSettled([...running.values()]);
        throw error;
    }
    if (fatal)
        throw fatal;
    return gates.map(g => done.get(g.id));
}
//# sourceMappingURL=scheduler.js.map