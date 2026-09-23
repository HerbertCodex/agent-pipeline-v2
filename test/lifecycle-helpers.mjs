import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { assessSecurity } from '../dist/security/owasp.js';
import { git } from './helpers.mjs';
export { git };
export function demoSpec(questions = false) {
    return {
        title: 'Multiplication et documentation', problem: 'Le module arithmétique ne fournit pas de multiplication documentée et testée.',
        scope: ['Ajouter multiply(a,b) et ses tests positifs et négatifs.', 'Documenter son usage.'], outOfScope: ['Aucune dépendance supplémentaire ni déploiement.'],
        acceptance: [{ id: 'AC-MATH', description: 'multiply renvoie le produit pour des arguments positifs et négatifs, avec des tests dédiés.', verification: 'Tests de multiply(2,3) et multiply(-2,3).' },
            { id: 'AC-DOC', description: 'La documentation contient un exemple de multiplication.', verification: 'Inspecter docs/math.md.' }],
        decisions: questions ? [] : [{ question: 'Gestion des nombres négatifs ?', answer: 'Les nombres négatifs sont inclus.' }],
        decisionCoverage: [],
        questions: questions ? [{ id: 'Q-NEG', question: 'Faut-il prendre en charge et tester les nombres négatifs ?' }] : [],
        tasks: [{ id: 'MATH', title: 'Ajouter la multiplication', description: 'Implémenter multiply et écrire ses tests.', acceptanceIds: ['AC-MATH'], allowedPaths: ['src/math.mjs', 'test/math.test.mjs'], dependsOn: [], minimumLane: 'standard' },
            { id: 'DOC', title: 'Documenter la multiplication', description: 'Documenter multiply avec un exemple.', acceptanceIds: ['AC-DOC'], allowedPaths: ['docs/math.md'], dependsOn: ['MATH'], minimumLane: 'fast' }], minimumLane: 'standard'
    };
}
/** Gates of the arithmetic fixture, in the V2 configuration format (read as is by V3). */
export function fixtureConfig() {
    return {
        schemaVersion: 1, executionMode: 'local-trusted', environment: { id: 'offline-lifecycle-fixture' },
        agent: { type: 'command', command: [process.execPath, '-e', 'process.exit(0)'] },
        gates: [{ id: 'syntax', command: [process.execPath, '--check', 'src/math.mjs'] }, { id: 'unit', command: [process.execPath, '--test', 'test/math.test.mjs'] },
            { id: 'diff-check', command: ['git', 'diff', '--check', '{{baseSha}}', '{{candidateSha}}'], mandatory: true }], concurrency: 3,
    };
}
export function makeLifecycleFixture(root) {
    const repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    const files = { '.gitignore': 'node_modules/\ndist/\n', 'AGENTS.md': '# Existing operator instructions\nDo not erase this text.\n',
        'README.md': '# Lifecycle fixture\n', 'docs/math.md': '# Math\n\nAddition only.\n', 'src/math.mjs': 'export const add = (a, b) => a + b;\n',
        'test/math.test.mjs': "import {test} from 'node:test';import assert from 'node:assert/strict';import {add} from '../src/math.mjs';test('addition',()=>assert.equal(add(2,3),5));\n",
        'package.json': JSON.stringify({ name: 'apv2-lifecycle-fixture', version: '1.0.0', private: true, type: 'module', scripts: { test: 'node --test test/math.test.mjs' } }, null, 2) + '\n',
        'package-lock.json': JSON.stringify({ name: 'apv2-lifecycle-fixture', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'apv2-lifecycle-fixture', version: '1.0.0' } } }, null, 2) + '\n' };
    for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(repo, path)), { recursive: true });
        writeFileSync(join(repo, path), text, { flag: 'wx' });
    }
    git(repo, 'init', '-q');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'Green baseline before feature work');
    return { repo, config: fixtureConfig() };
}

/** Arithmetic fixture repository, removed after the test. */
export function fixture(t) { const root = mkdtempSync(join(tmpdir(), 'apv3-life-test-')); t.after(() => rmSync(root, { recursive: true, force: true })); return { ...makeLifecycleFixture(root), root }; }
export function oneTask() { const spec = demoSpec(); spec.scope = [spec.scope[0]]; spec.acceptance = [spec.acceptance[0]]; spec.tasks = [spec.tasks[0]]; return spec; }
/** Fills a fixture spec with the security plan the controller routes for a request, when it routes any. */
export function withSecurity(spec, request, projectType = 'unknown') {
  const ctx = assessSecurity({ text: request, projectType, files: [] });
  if (!ctx.topics.length) return spec;
  if (!spec.acceptance.some(x => x.id === 'AC-SEC')) spec.acceptance.push({ id: 'AC-SEC', description: 'The security-sensitive behavior preserves the routed trust-boundary requirements.', verification: 'Inspect implementation and observed negative security tests.' });
  if (!spec.tasks[0].acceptanceIds.includes('AC-SEC')) spec.tasks[0].acceptanceIds.push('AC-SEC');
  spec.minimumLane = ctx.minimumLane;
  spec.security = { profile: { ...ctx.profile }, owaspTopics: ctx.topics.map(t => t.id),
    threatModel: { required: ctx.requiresThreatModel, summary: ctx.requiresThreatModel ? 'Fixture threat model for the routed security surface.' : '', assets: ctx.requiresThreatModel ? ['protected application state'] : [], trustBoundaries: ctx.requiresThreatModel ? ['untrusted client -> application'] : [], threats: ctx.requiresThreatModel ? [{ id: 'TM-FIXTURE', category: 'spoofing', description: 'An untrusted actor attempts to cross the protected boundary.', mitigations: ['Enforce the approved authentication/authorization and validation requirements.'], acceptanceIds: ['AC-SEC'] }] : [], assumptions: [] },
    requirements: [{ id: 'SEC-FIXTURE', title: 'Apply controller-routed security requirements', owaspTopics: ctx.topics.map(t => t.id), acceptanceIds: ['AC-SEC'], verification: 'Inspect code and runner evidence for the routed topics.', negativeTests: ctx.negativeTestsRequired ? ['Reject invalid or unauthorized input without changing protected state.'] : [] }],
    assumptions: [], deferred: [] };
  return spec;
}
