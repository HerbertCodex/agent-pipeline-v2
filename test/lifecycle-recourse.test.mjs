import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { fixture, approved, oneTask, git, passingQa } from './lifecycle-helpers.mjs';

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
async function explore(sequence) {
    const closed = [];
    const f = fixture({ after: fn => closed.push(fn) });
    f.config.workflow = { ...f.config.workflow, reviewMode: 'solo', maxQaRepairs: 0 };
    const blocked = new Set();
    const violations = [];
    try {
        const doc = await approved(f, oneTask());
        for (const name of sequence) {
            try { await COMMANDS[name](f, doc.id); }
            catch { /* A refused command is a legitimate outcome; the state it leaves is what matters. */ }
            const current = f.life.get(doc.id);
            const code = current.data.error?.code;
            if (current.data.status !== 'blocked' || !code) continue;
            blocked.add(code);
            const next = String(f.life.summary(current).nextAction);
            if (operatorCodes.has(code) && isFallbackAdvice(next, code))
                violations.push({ sequence, command: name, code, nextAction: next });
        }
    }
    finally { for (const fn of closed) { try { fn(); } catch { /* fixture teardown */ } } }
    return { blocked, violations };
}

/** Ordered sequences that reach a named blockage every time, so coverage never depends on a draw. */
const SCENARIOS = [
    { code: 'GATES_FAILED', sequence: ['run', 'breakGate', 'run'] },
    { code: 'QA_REJECTED', sequence: ['run', 'qaChangesRequested', 'run'] },
];

test('scripted blockages are reached and name a command', { timeout: 900000 }, async () => {
    for (const { code, sequence } of SCENARIOS) {
        const seen = await explore(sequence);
        assert.ok(seen.blocked.has(code), `${sequence.join(' → ')} no longer reaches ${code} (saw ${[...seen.blocked].join(', ') || 'no blockage'})`);
        assert.deepEqual(seen.violations, [], `${code} left the operator without a command:\n${JSON.stringify(seen.violations, null, 1)}`);
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
