// Deterministic offline fixture. This is NOT an AI agent or an assessment of model quality.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { demoSpec, fixtureConfig } from './lifecycle-fixture.mjs';
const req = JSON.parse(readFileSync(0, 'utf8'));
if (req.role === 'setup') {
    console.log(JSON.stringify({ config: fixtureConfig(), questions: [], notes: ['Offline deterministic setup proposal; commands are known fixture checks.'] }));
}
else if (req.role === 'product' && req.context?.mode === 'design-proposal') {
    console.log(JSON.stringify({
        summary: 'Fixture visual proposal for the arithmetic screen.',
        rationale: 'Keep the existing documentation-first fixture visually quiet and make the primary arithmetic result easy to scan without introducing decorative dashboard chrome.',
        visualDirection: 'Editorial utility: restrained typography, strong hierarchy, generous whitespace and one clear primary action.',
        implementationBrief: 'Preserve the existing page structure, use semantic HTML, a narrow readable measure and explicit empty/error states. Do not add gradients, glass effects or generic metric-card grids.',
        css: ':root{font-family:system-ui,sans-serif;color:#171717;background:#f6f5f2}body{margin:0}main{max-width:48rem;margin:0 auto;padding:2rem}header{border-bottom:1px solid #d8d5cf;padding-bottom:1rem}section{padding:1.5rem 0}button{font:inherit;padding:.65rem 1rem;border:1px solid #171717;background:#171717;color:white}',
        screens: [{ id: 'arithmetic', title: 'Arithmetic', purpose: 'Show the main arithmetic action and its result with a calm, non-generic hierarchy.', bodyHtml: '<main><header><p>Arithmetic workspace</p><h1>Multiply with confidence</h1></header><section><p>Enter two values and review the result.</p><button type="button">Calculate</button></section></main>', states: ['default', 'empty', 'validation-error'], responsive: 'Single column from mobile through desktop; cap line length rather than introducing card columns.' }],
        decisions: [{ decision: 'Use a single editorial column instead of a dashboard card grid.', rationale: 'The fixture has one primary job and does not benefit from repeated containers.', alternatives: ['Metric cards', 'Two-column control/result panel'], tradeoffs: ['Less simultaneous information density, but clearer hierarchy.'] }],
        avoid: ['Decorative gradients', 'Glassmorphism', 'Interchangeable dashboard cards', 'Placeholder iconography'],
        references: [], questions: []
    }));
}
else if (req.role === 'product') {
    console.log(JSON.stringify(demoSpec(req.context.request.includes('DEMO_QUESTION') && !req.context.previous)));
}
else if (req.role === 'qa') {
    const tests = readFileSync('test/math.test.mjs', 'utf8');
    const doc = readFileSync('docs/math.md', 'utf8');
    const mathOK = tests.includes('negative multiplication');
    const docOK = doc.includes('multiply');
    const pass = mathOK && docOK;
    console.log(JSON.stringify({ candidateSha: req.context.candidateSha, verdict: pass ? 'pass' : 'changes_requested', summary: pass ? 'Fixture review: code, tests and documentation match the specified example.' : 'Fixture review requests the missing negative-input test.',
        criteria: req.context.spec.acceptance.map(a => ({ id: a.id, status: a.id === 'AC-MATH' ? (mathOK ? 'pass' : 'unknown') : (docOK ? 'pass' : 'fail'), evidence: a.id === 'AC-MATH' ? 'Inspected test/math.test.mjs and runner receipts.' : 'Inspected docs/math.md.' })),
        findings: pass ? [] : [{ id: 'QA-NEG', severity: 'major', path: 'test/math.test.mjs', description: 'Add a dedicated negative multiplication test.' }], observations: [], decisionChecks: [] }));
}
else if (req.protocol === 'agent-pipeline/v2') {
    if (req.task.id === 'MATH') {
        writeFileSync('src/math.mjs', 'export const add = (a, b) => a + b;\nexport const multiply = (a, b) => a * b;\n');
        writeFileSync('test/math.test.mjs', "import {test} from 'node:test';import assert from 'node:assert/strict';import {add,multiply} from '../src/math.mjs';test('addition',()=>assert.equal(add(2,3),5));test('positive multiplication',()=>assert.equal(multiply(2,3),6));\n");
    }
    else if (req.task.id === 'COMPANION') {
        writeFileSync('src/math.mjs', readFileSync('src/math.mjs', 'utf8') + 'export const double = (n) => n * 2;\n');
        writeFileSync('src/helper.mjs', 'export const clamp = (n, min, max) => Math.max(min, Math.min(max, n));\n');
    }
    else if (req.task.id === 'OUTSIDE') {
        writeFileSync('src/math.mjs', readFileSync('src/math.mjs', 'utf8') + 'export const double = (n) => n * 2;\n');
        mkdirSync('other', { recursive: true });
        writeFileSync('other/helper.mjs', 'export const outsideHelper = () => true;\n');
    }
    else if (req.task.id === 'DOC')
        writeFileSync('docs/math.md', '# Math\n\n`multiply(2, 3)` returns `6`.\n');
    else if (req.task.id === 'SPEC-INTEGRATION')
        writeFileSync('test/math.test.mjs', readFileSync('test/math.test.mjs', 'utf8') + "test('negative multiplication',()=>assert.equal(multiply(-2,3),-6));\n");
    else
        throw new Error('Unknown fixture task ' + req.task.id);
    console.log(JSON.stringify({ summary: 'Deterministic fixture edit completed for ' + req.task.id }));
}
else
    throw new Error('Unsupported fixture protocol');
