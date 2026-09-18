import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import stylelint from 'stylelint';
import config from '../examples/stylelint-bem.config.mjs';
import { fixture, git } from './lifecycle-helpers.mjs';
import { inspectProject, proposeConfiguration, doctor } from '../dist/lifecycle/onboarding.js';

test('global CSS naming accepts BEM, utilities, states and native nested selectors', async () => {
  const code = `
    .order-card, .order-card__title, .order-card--compact, .order-card__title--muted { color: red; }
    .u-hidden, .muted, .mono { display: none; }
    .order-card { &:hover { color: blue; } & > .order-card__title { color: green; } }
    [data-label=".NotAClass"]::before { content: ".not_a_selector"; }
    /* .NotASelector */
    @keyframes pulse { 0% { opacity: 0; } 100% { opacity: 1; } }
  `;
  const result = await stylelint.lint({ code, config });
  assert.equal(result.errored, false, JSON.stringify(result.results.map(r => r.warnings)));
});

test('global CSS naming rejects malformed BEM, camelCase and invalid nested class selectors', async () => {
  for (const selector of ['.orderCard', '.order_card', '.card__body__label', '.card--compact--red', '.card--compact__title', '.card___title', '.card__', '.card--']) {
    const result = await stylelint.lint({ code: `@media (width > 1px) { .card { & > ${selector} { color: red; } } }`, config });
    assert.equal(result.errored, true, selector);
    assert.ok(result.results[0].warnings.some(w => w.rule === 'selector-class-pattern'), selector);
  }
});

test('malformed CSS is a failing check, not a naming pass', async () => {
  const result = await stylelint.lint({ code: '.card { color: red;', config });
  assert.equal(result.errored, true);
});

test('onboarding discovers CSS checks, skips watch commands and does not invent BEM coverage', async t => {
  const f = fixture(t);
  const inventory = await inspectProject(f.repo);
  inventory.scripts['lint:css'] = 'stylelint "src/styles/**/*.css" --max-warnings 0';
  inventory.scripts['lint:styles'] = 'stylelint "styles/**/*.css" --watch';
  const proposal = proposeConfiguration(inventory);
  const gate = proposal.config.gates.find(g => g.id === 'lint-css');
  assert.deepEqual(gate.command, ['npm', 'run', 'lint:css']);
  assert.deepEqual(gate.lanes, ['standard', 'high']);
  assert.equal(proposal.config.gates.some(g => g.id === 'lint-styles'), false);
  delete inventory.scripts['lint:css'];
  inventory.scripts['lint:styles'] = 'stylelint "styles/**/*.css"';
  assert.deepEqual(proposeConfiguration(inventory).config.gates.find(g => g.id === 'lint-styles').command, ['npm', 'run', 'lint:styles']);
  delete inventory.scripts['lint:styles'];
  assert.equal(proposeConfiguration(inventory).config.gates.some(g => g.id === 'lint-css'), false);
});

test('discovered CSS gate blocks invalid naming and passes after the source is corrected', async t => {
  const f = fixture(t);
  const pkg = JSON.parse(readFileSync(join(f.repo, 'package.json'), 'utf8'));
  const cli = fileURLToPath(new URL('../node_modules/stylelint/bin/stylelint.mjs', import.meta.url));
  pkg.scripts['lint:css'] = `"${process.execPath}" "${cli}" "src/**/*.css" --config stylelint.config.json --max-warnings 0`;
  writeFileSync(join(f.repo, 'package.json'), JSON.stringify(pkg));
  writeFileSync(join(f.repo, 'stylelint.config.json'), JSON.stringify(config));
  writeFileSync(join(f.repo, 'src/card.css'), '.card__body__label { color: red; }\n');
  git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'CSS naming regression');
  const proposal = proposeConfiguration(await inspectProject(f.repo));
  const cssGate = proposal.config.gates.find(g => g.id === 'lint-css');
  const pipelineConfig = { ...f.config, gates: [cssGate] };
  const failed = await doctor(f.life.pipeline, f.repo, pipelineConfig, true);
  assert.equal(failed.passed, false);
  const receipt = f.life.pipeline.store.get(failed.runId).receipts.find(r => r.gateId === 'lint-css');
  assert.equal(receipt.status, 'failed');
  assert.match(receipt.diagnostic, /selector-class-pattern|block__element/);
  writeFileSync(join(f.repo, 'src/card.css'), '.card__label { color: red; }\n');
  git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'Correct element ownership naming');
  assert.equal((await doctor(f.life.pipeline, f.repo, pipelineConfig, true)).passed, true);
});
