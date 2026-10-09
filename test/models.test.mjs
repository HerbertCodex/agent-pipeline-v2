import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';
import { apv, write } from './cli-helpers.mjs';
import { configIssues } from '../dist/config/load.js';
import { DEFAULT_MODELS, MODEL_KEYS } from '../dist/config/models.js';

test('the models section is optional: absent, the defaults of the pilot project apply', () => {
  const { config, issues } = configIssues({});
  assert.deepEqual(issues, []);
  assert.equal(config.models, undefined);
  assert.deepEqual(DEFAULT_MODELS, {
    roles: { chef: 'fable', conception: 'opus', implementer: 'sonnet', fondations: 'opus', integrateur: 'opus', relecture: 'sonnet', 'relecture-securite-regles': 'opus', recherche: 'haiku' },
    effort: 'high',
  });
});

test('a valid models section is accepted, every role of the closed list included', () => {
  const roles = ['chef', 'product', 'architecte', 'architecte-donnees', 'designer', 'critique-design', 'dpo', 'implementer', 'fondations', 'integrateur', 'qa-securite', 'qa-fidelite', 'auditeur-web', 'relecture', 'recherche'];
  for (const role of roles) assert.ok(MODEL_KEYS.includes(role), role);
  const models = { chef: 'fable', 'qa-securite': 'opus', implementer: 'haiku', effort: 'xhigh' };
  const { config, issues } = configIssues({ models });
  assert.deepEqual(issues, []);
  assert.deepEqual(config.models, models);
});

test('an unknown model, effort or key is refused with a message that names it', () => {
  for (const [models, pattern] of [
    [{ chef: 'gpt-5' }, /models\.chef: expected fable\|opus\|sonnet\|haiku/],
    [{ effort: 'max' }, /models\.effort: expected high\|xhigh/],
    // Review of PR #129, F2: the operator's rule is high at the least, never low nor medium.
    [{ effort: 'low' }, /models\.effort: expected high\|xhigh/],
    [{ effort: 'medium' }, /models\.effort: expected high\|xhigh/],
    [{ chef: 7 }, /models\.chef/],
    [{ cuisinier: 'opus' }, /unknown property cuisinier/],
  ]) {
    const { config, issues } = configIssues({ models });
    assert.equal(config, undefined, JSON.stringify(models));
    assert.match(issues.map(i => i.message).join('\n'), pattern, JSON.stringify(models));
  }
});

test('apv status says the models of each role, the defaults when the section is absent', async t => {
  const f = fixture(t);
  write(f.repo, '.apv/config.json', { gates: [] });
  const plain = await apv(f.repo, ['status']);
  assert.equal(plain.code, 0, plain.stderr);
  assert.match(plain.stdout, /^Modèles par rôle : chef fable ; conception opus ; implementer sonnet ; fondations opus ; integrateur opus ; relecture sonnet ; relecture-securite-regles opus ; recherche haiku \(effort high\) \(défauts\)$/m);
  const defaults = (await apv(f.repo, ['status', '--json'])).json().models;
  assert.deepEqual(defaults, { custom: false, roles: DEFAULT_MODELS.roles, effort: 'high' });
});

test('apv status shows the configured models: the defaults completed by what the project sets', async t => {
  const f = fixture(t);
  write(f.repo, '.apv/config.json', { models: { implementer: 'opus', 'qa-fidelite': 'haiku', effort: 'xhigh' } });
  const human = await apv(f.repo, ['status']);
  assert.match(human.stdout, /^Modèles par rôle : chef fable ; .*implementer opus ;.*qa-fidelite haiku.*\(effort xhigh\)$/m);
  assert.doesNotMatch(human.stdout, /défauts/);
  const { models } = (await apv(f.repo, ['status', '--json'])).json();
  assert.equal(models.custom, true);
  assert.equal(models.effort, 'xhigh');
  assert.equal(models.roles.implementer, 'opus');
  assert.equal(models.roles['qa-fidelite'], 'haiku');
  assert.equal(models.roles.chef, 'fable');
});

test('apv status keeps the defaults when the configuration is invalid', async t => {
  const f = fixture(t);
  write(f.repo, '.apv/config.json', { models: { chef: 'gpt-5' } });
  const r = await apv(f.repo, ['status']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Configuration : \.apv\/config\.json ; invalide/);
  assert.match(r.stdout, /Modèles par rôle : chef fable .*\(effort high\) \(défauts\)/);
});
