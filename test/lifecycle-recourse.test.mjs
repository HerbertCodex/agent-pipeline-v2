import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { fixture, approved, oneTask, demoSpec, git, passingQa } from './lifecycle-helpers.mjs';

/**
 * The error catalogue says which codes an operator can act on. This suite checks the other half:
 * that the controller actually names a command, from states a real sequence of commands reaches.
 * A static audit can prove neither that a state is reachable nor that its advice names anything.
 *
 * Coverage comes from the scripted scenarios, discovery from the random ones. Randomness alone
 * would let the suite pass on a lucky draw that never blocks, while every recourse rots.
 */
const catalogue = JSON.parse(readFileSync(fileURLToPath(new URL('../scripts/error-recovery.json', import.meta.url)), 'utf8'));
const operatorCodes = new Set(catalogue.groups.filter(g => g.operator === 'yes').flatMap(g => g.codes));

/** The advice the controller falls back to when no branch claims the code: it names no command. */
const isFallbackAdvice = (next, code) => next.startsWith(`Resolve ${code} before running again:`);

const actor = 'Reviewer Test';
const failing = { id: 'red', command: [process.execPath, '-e', 'process.exit(1)'] };
/** Fails once, then passes: the shape of a transient failure, where retrying is the real recourse. */
const flaky = marker => ({ id: 'flaky', command: [process.execPath, '-e',
    `const fs = require('node:fs'); const m = ${JSON.stringify(marker)};` +
    'if (fs.existsSync(m)) process.exit(0); fs.writeFileSync(m, ""); process.exit(1);'] });

/**
 * Operator commands, plus the perturbations a real project inflicts on a spec: a check that starts
 * failing, a review demanding a correction, an allowance that runs out, a branch that moves on.
 */
const COMMANDS = {
    run: async (f, id) => f.life.run(id),
    retry: async (f, id) => f.life.retry(id, true),
    verify: async (f, id) => f.life.verify(id),
    review: async (f, id) => f.life.review(id, f.life.get(id).data.currentSha, actor, 'Inspected the exact candidate under test.'),
    qaRepair: async (f, id) => f.life.authorizeQaRepair(id, actor, 'Inspected the evidence the review could not conclude on.'),
    deliver: async (f, id) => f.life.deliver(id, `${f.root}/delivery-${Date.now()}`),
    amendTime: async (f, id) => f.life.amendBudget(id, { maxActiveMs: 900000 }, actor, 'Raised the active-time allowance for this exploration.'),
    breakGate: async (f, id) => f.life.amendBudget(id, { gates: { add: [failing] } }, actor, 'Added a check that fails, as a regression would.'),
    breakGateOnce: async (f, id) => f.life.amendBudget(id, { gates: { add: [flaky(`${f.root}/flaky-cleared`)] } }, actor, 'Added a check that fails once, as a transient failure would.'),
    exhaustTime: async (f, id) => {
        const doc = f.life.get(id);
        doc.data.activeMs = doc.data.operational?.maxActiveMs ?? doc.data.config.workflow.maxActiveMs;
        f.life.store.saveDocument(doc, 'test.allowance_exhausted');
    },
    qaChangesRequested: async (f, id) => {
        const doc = f.life.get(id);
        await f.life.importQa(id, { ...passingQa(doc), verdict: 'changes_requested',
            summary: 'Fixture review requesting a correction.',
            findings: [{ id: 'F-FIXTURE', severity: 'major', resolution: 'required', path: 'src/math.mjs',
                description: 'Fixture finding that requires a correction before this candidate ships.' }] });
    },
    mergeBranch: async (f, id) => {
        const { currentSha, baseSha } = f.life.get(id).data;
        if (currentSha !== baseSha) git(f.repo, 'merge', '--no-ff', '-q', '-m', 'Merge the candidate', currentSha);
        else git(f.repo, 'commit', '-q', '--allow-empty', '-m', 'Merge an unrelated pull request');
    },
};
const names = Object.keys(COMMANDS);

/** Runs one sequence and reports the blocked codes it reached and the advice that named nothing. */
async function explore(sequence, recover = [], watched = null, proposal = oneTask()) {
    const closed = [];
    const f = fixture({ after: fn => closed.push(fn) });
    f.config.workflow = { ...f.config.workflow, reviewMode: 'solo', maxQaRepairs: 0 };
    const blocked = new Set();
    const violations = [];
    let adviceAtBlock = '';
    let finalError = null;
    try {
        const doc = await approved(f, proposal);
        for (const name of sequence) {
            try { await COMMANDS[name](f, doc.id); }
            catch { /* A refused command is a legitimate outcome; the state it leaves is what matters. */ }
            const current = f.life.get(doc.id);
            const code = current.data.error?.code;
            if (current.data.status !== 'blocked' || !code) continue;
            blocked.add(code);
            const next = String(f.life.summary(current).nextAction);
            if (code === watched && !adviceAtBlock) adviceAtBlock = next;
            if (operatorCodes.has(code) && isFallbackAdvice(next, code))
                violations.push({ sequence, command: name, code, nextAction: next });
        }
        for (const name of recover) {
            try { await COMMANDS[name](f, doc.id); }
            catch { /* The recourse may itself be refused; the state it leaves is what is judged. */ }
        }
        const after = f.life.get(doc.id).data;
        finalError = after.status === 'blocked' ? after.error?.code ?? null : null;
    }
    finally { for (const fn of closed) { try { fn(); } catch { /* fixture teardown */ } } }
    return { blocked, violations, adviceAtBlock, finalError };
}

/**
 * Ordered sequences that reach a named blockage every time, so coverage never depends on a draw,
 * each with the command that is supposed to get the operator out of it. `advises` is the command the
 * controller must name, `recover` is what the operator then does: naming a command that does not
 * clear the blockage is the failure mode these scenarios exist to catch.
 */
const SCENARIOS = [
    { code: 'GATES_FAILED', reach: ['run', 'breakGateOnce', 'run'], advises: /spec retry/, recover: ['retry', 'run'] },
    // The scripted reviewer only passes once both tasks of the demonstration spec are done, so this
    // scenario uses the whole spec: a repair can then actually satisfy it, which is what is measured.
    { code: 'QA_REJECTED', reach: ['run', 'qaChangesRequested', 'run'], advises: /spec qa-repair/, recover: ['qaRepair', 'run'], proposal: () => demoSpec() },
];

test('scripted blockages are reached and name a command', { timeout: 900000 }, async () => {
    for (const { code, reach, proposal } of SCENARIOS) {
        const seen = await explore(reach, [], null, proposal ? proposal() : oneTask());
        assert.ok(seen.blocked.has(code), `${reach.join(' → ')} no longer reaches ${code} (saw ${[...seen.blocked].join(', ') || 'no blockage'})`);
        assert.deepEqual(seen.violations, [], `${code} left the operator without a command:\n${JSON.stringify(seen.violations, null, 1)}`);
    }
});

test('the command a blockage advertises actually clears it', { timeout: 900000 }, async () => {
    for (const { code, reach, advises, recover, proposal } of SCENARIOS) {
        const seen = await explore(reach, recover, code, proposal ? proposal() : oneTask());
        assert.ok(seen.blocked.has(code), `${reach.join(' → ')} no longer reaches ${code}`);
        assert.match(seen.adviceAtBlock, advises, `${code} advertises a command that is not the one that recovers it`);
        assert.notEqual(seen.finalError, code, `${recover.join(' → ')} left the spec blocked on ${code}: the advertised recourse does not recover it`);
    }
});

// Sequences stay short and few: every command drives the real controller, scripted agent included.
const RUNS = Number(process.env.APV2_RECOURSE_RUNS ?? 12);

test('random command sequences never strand an operator-owned code', { timeout: 1800000 }, async () => {
    const violations = [];
    await fc.assert(
        fc.asyncProperty(fc.array(fc.constantFrom(...names), { minLength: 2, maxLength: 5 }), async sequence => {
            const seen = await explore(sequence);
            violations.push(...seen.violations);
            return seen.violations.length === 0;
        }),
        { numRuns: RUNS, endOnFailure: true },
    );
    assert.deepEqual(violations, [], `Operator-owned codes left without a command:\n${JSON.stringify(violations, null, 1)}`);
});
