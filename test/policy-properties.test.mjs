import test from 'node:test';
import fc from 'fast-check';
import { classify, matches, planGates, requiredApprovals } from '../dist/policy/policy.js';
import { stricter } from '../dist/lifecycle/contracts.js';
import { lanes, validateConfig } from '../dist/domain/contracts.js';
import { hash } from '../dist/domain/hash.js';
import { failureFingerprint } from '../dist/engine/diagnostic.js';

/**
 * The rules that decide how much proof a change owes are pure functions. Stating them as properties
 * checks the whole input space rather than the handful of cases anyone thinks to write down, and it
 * costs nothing: no workspace, no agent, thousands of cases per second.
 */

const at = lane => lanes.indexOf(lane);
const agent = { type: 'command', command: [process.execPath, '-e', 'process.exit(0)'] };
const config = validateConfig({
    schemaVersion: 1, executionMode: 'local-trusted', environment: { id: 'offline-properties' }, agent,
    gates: [
        { id: 'diff-check', command: ['git', 'diff', '--check'], mandatory: true },
        { id: 'unit', command: ['npm', 'test'], covers: ['unit'], lanes: ['fast', 'standard', 'high'] },
        { id: 'typecheck', command: ['npm', 'run', 'check'], lanes: ['standard', 'high'], dependsOn: ['unit'] },
        { id: 'browser', command: ['npm', 'run', 'e2e'], covers: ['browser'], lanes: ['high'], dependsOn: ['typecheck'] },
    ],
});

/** Repository-shaped paths, some of them in the sensitive set the policy raises the lane for. */
const segment = fc.stringMatching(/^[a-z][a-z0-9-]{0,7}$/);
const filePath = fc.array(segment, { minLength: 1, maxLength: 3 })
    .chain(dirs => fc.constantFrom('ts', 'svelte', 'md', 'sql', 'json').map(ext => `${dirs.join('/')}/file.${ext}`));
const changeSet = fc.record({
    files: fc.uniqueArray(filePath, { minLength: 1, maxLength: 6 }),
    lines: fc.integer({ min: 1, max: 4000 }),
    binary: fc.boolean(),
});

test('adding a file to a change never lowers the assurance it owes', () => {
    fc.assert(fc.property(changeSet, filePath, fc.constantFrom(...lanes), (changes, extra, minimum) => {
        const before = classify(changes, config, minimum);
        const after = classify({ ...changes, files: [...new Set([...changes.files, extra])], lines: changes.lines + 1 }, config, minimum);
        return at(after.lane) >= at(before.lane);
    }));
});

test('the requested minimum is never undercut, and a binary change is always high', () => {
    fc.assert(fc.property(changeSet, fc.constantFrom(...lanes), (changes, minimum) => {
        const decision = classify(changes, config, minimum);
        return at(decision.lane) >= at(minimum) && (!changes.binary || decision.lane === 'high');
    }));
});

test('the high plan contains every other plan, and every plan is closed under dependsOn', () => {
    fc.assert(fc.property(changeSet, fc.constantFrom(...lanes), (changes, lane) => {
        const plan = planGates(config, changes, lane);
        const ids = new Set(plan.map(g => g.id));
        const high = new Set(planGates(config, changes, 'high').map(g => g.id));
        const mandatory = config.gates.filter(g => g.mandatory).map(g => g.id);
        return [...ids].every(id => high.has(id))
            && mandatory.every(id => ids.has(id))
            && plan.every(g => g.dependsOn.every(dep => ids.has(dep)));
    }));
});

test('a directory pattern never matches outside its directory', () => {
    fc.assert(fc.property(segment, segment, fc.array(segment, { minLength: 1, maxLength: 3 }), (owned, other, rest) => {
        fc.pre(owned !== other);
        return matches(`${owned}/${rest.join('/')}`, `${owned}/**`) && !matches(`${other}/${rest.join('/')}`, `${owned}/**`);
    }));
});

test('a single star stays inside one path segment', () => {
    fc.assert(fc.property(segment, segment, fc.array(segment, { minLength: 1, maxLength: 3 }), (owned, leaf, deeper) => {
        // `dir/*` covers the files of a directory, never its subtrees: the difference between
        // "this directory" and "everything under it" is what keeps an allowed scope bounded.
        return matches(`${owned}/${leaf}`, `${owned}/*`) && !matches(`${owned}/${deeper.join('/')}/${leaf}`, `${owned}/*`);
    }));
});

test('stricter is commutative, idempotent and never returns less than any argument', () => {
    fc.assert(fc.property(fc.constantFrom(...lanes), fc.constantFrom(...lanes), (a, b) =>
        stricter(a, b) === stricter(b, a) && stricter(a, a) === a && at(stricter(a, b)) >= Math.max(at(a), at(b))));
});

test('a higher lane never requires fewer approvals', () => {
    fc.assert(fc.property(fc.constantFrom('solo', 'team', 'regulated'), mode =>
        lanes.every((lane, i) => i === 0 || requiredApprovals(lane, mode) >= requiredApprovals(lanes[i - 1], mode))));
});

test('identity ignores key order and notices an added field', () => {
    const scalar = fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null));
    fc.assert(fc.property(fc.dictionary(fc.string({ minLength: 1 }), scalar, { maxKeys: 6 }), fc.string({ minLength: 1 }), scalar, (object, key, value) => {
        const shuffled = Object.fromEntries(Object.entries(object).reverse());
        if (hash(object) !== hash(shuffled)) return false;
        // A field the contract gained since a hash was stored changes that hash: comparing stored
        // shapes across versions compares defaults, not meaning. This is what broke publication in #49.
        fc.pre(!Object.hasOwn(object, key));
        return hash({ ...object, [key]: value }) !== hash(object);
    }));
});

test('a failure keeps its identity across durations, timestamps, pids and commit hashes', () => {
    const volatile = fc.tuple(fc.integer({ min: 0, max: 99999 }), fc.integer({ min: 0, max: 99999 }));
    fc.assert(fc.property(fc.stringMatching(/^[A-Za-z ]{5,40}$/), volatile, (reason, [a, b]) => {
        const text = n => `${reason} after ${n} ms (pid ${n}) at 2026-09-19T11:0${n % 10}:00Z`;
        return failureFingerprint(text(a)) === failureFingerprint(text(b));
    }));
});

test('two different failures keep different identities', () => {
    fc.assert(fc.property(fc.stringMatching(/^[A-Za-z ]{5,40}$/), fc.stringMatching(/^[A-Za-z ]{5,40}$/), (one, other) => {
        fc.pre(one.trim() !== other.trim() && !/\b[0-9a-f]{7,40}\b/.test(one + other));
        return failureFingerprint(`${one} after 12 ms`) !== failureFingerprint(`${other} after 12 ms`);
    }));
});
