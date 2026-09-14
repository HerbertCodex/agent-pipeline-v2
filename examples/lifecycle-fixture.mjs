import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from './fixture.mjs';
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
export function fixtureConfig() {
    const agent = { type: 'command', command: [process.execPath, fileURLToPath(new URL('./lifecycle-worker.mjs', import.meta.url))] };
    return {
        schemaVersion: 1, executionMode: 'local-trusted', environment: { id: 'offline-lifecycle-fixture' }, agent, roles: { product: agent, qa: agent },
        gates: [{ id: 'syntax', command: [process.execPath, '--check', 'src/math.mjs'] }, { id: 'unit', command: [process.execPath, '--test', 'test/math.test.mjs'] },
            { id: 'diff-check', command: ['git', 'diff', '--check', '{{baseSha}}', '{{candidateSha}}'], mandatory: true }], concurrency: 3, maxRunMs: 30000, maxRepairAttempts: 0,
        workflow: { qaLanes: ['standard', 'high'], maxQaRepairs: 1, maxActiveMs: 120000 }
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
    const config = fixtureConfig();
    writeFileSync(join(root, 'agent.json'), JSON.stringify(config.agent, null, 2));
    writeFileSync(join(root, 'config.json'), JSON.stringify(config, null, 2));
    return { repo, state: join(root, 'state'), config };
}
