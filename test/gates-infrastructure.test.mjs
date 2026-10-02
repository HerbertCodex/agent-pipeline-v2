import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailures, infrastructureAdvice, infrastructureCause, infrastructureText } from '../dist/gates/infrastructure.js';

/** Failures of the infrastructure told apart from failing tests (src/gates/infrastructure.ts). */

const failed = (diagnostic, status = 'failed', gateId = 'integration') => ({ gateId, status, diagnostic });

test('a variable of the environment absent: named by the output, or in the usual words of the tools', () => {
  assert.equal(infrastructureCause(failed('Error: Variable SUPABASE_TEST_URL absente'), ['SUPABASE_TEST_URL']).kind, 'environment');
  assert.match(infrastructureCause(failed('Error: Variable SUPABASE_TEST_URL absente'), ['SUPABASE_TEST_URL']).detail, /SUPABASE_TEST_URL/);
  for (const text of ['Error: Variable SUPABASE_TEST_URL absente', 'environment variable DATABASE_URL is not set', 'Missing environment variable: API_KEY',
    'Error: DATABASE_URL is not set', 'variable d\'environnement E2E_STACK manquante', 'Missing required env var `TOKEN_X`']) {
    const cause = infrastructureCause(failed(text));
    assert.equal(cause?.kind, 'environment', text);
  }
  // A missing variable never named by the output: not a cause by itself.
  assert.equal(infrastructureCause(failed('AssertionError: expected 2 to equal 3'), ['E2E_PORT']), null);
});

test('a stack or a service unreachable', () => {
  for (const text of ['connect ECONNREFUSED 127.0.0.1:55321', 'psql: error: could not connect to server: Connection refused',
    'supabase start is not running.', 'Error response from daemon: failed to set up container networking', 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock']) {
    assert.equal(infrastructureCause(failed(text))?.kind, 'unreachable', text);
  }
  assert.equal(infrastructureCause(failed('Copie de la pile 2 non préparée : batch.setup en échec', 'spawn_error'))?.kind, 'setup');
  assert.equal(infrastructureCause(failed('Executable unavailable: npx', 'spawn_error'))?.kind, 'setup');
});

test('a failing test, a passed or cancelled check: never infrastructure', () => {
  assert.equal(infrastructureCause(failed('1 failed\n  expected "Bonjour" received "Bonsoir"')), null);
  assert.equal(infrastructureCause({ gateId: 'x', status: 'passed', diagnostic: 'ECONNREFUSED' }), null);
  assert.equal(infrastructureCause({ gateId: 'x', status: 'cancelled', diagnostic: 'ECONNREFUSED' }), null);
});

test('classification of a run: all failures infrastructure or not; blocked and cancelled checks are not failures of their own', () => {
  const missing = new Map([['integration', ['SUPABASE_TEST_URL']]]);
  const all = classifyFailures([failed('Variable SUPABASE_TEST_URL absente'), { gateId: 'browser', status: 'cancelled', diagnostic: '' },
    { gateId: 'after', status: 'blocked', diagnostic: 'dependency failed' }, { gateId: 'unit', status: 'passed', diagnostic: '' }], missing);
  assert.equal(all.all, true);
  assert.deepEqual(all.causes.map(c => c.gateId), ['integration']);
  const mixed = classifyFailures([failed('Variable SUPABASE_TEST_URL absente'), failed('expected 1 received 2', 'failed', 'unit')], missing);
  assert.equal(mixed.all, false);
  assert.equal(mixed.causes.length, 1);
  assert.deepEqual(classifyFailures([{ gateId: 'unit', status: 'passed', diagnostic: '' }], new Map()), { causes: [], all: false });
  assert.match(infrastructureText(all.causes[0]), /^integration : variable d'environnement absente \(/);
  assert.match(infrastructureAdvice(all.causes, ['1', '2']), /--stacks <pile> \(déclarées : 1, 2\)/);
  assert.match(infrastructureAdvice([{ gateId: 'x', kind: 'unreachable', detail: 'ECONNREFUSED' }], []), /vérifier que le service de test répond/);
});
