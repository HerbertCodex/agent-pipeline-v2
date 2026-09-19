import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { fixture, approved, oneTask, demoSpec, git } from './lifecycle-helpers.mjs';
import { Store } from '../dist/persistence/store.js';
import { agentSchema } from '../dist/domain/contracts.js';
import { specHash } from '../dist/lifecycle/contracts.js';
const noQa = { workflow: { qaLanes: [], maxQaRepairs: 0, maxActiveMs: 60000 } };
test('lifecycle store rejects optimistic write conflicts', t => { const f = fixture(t); const d = f.life.store.createDocument('test', { value: 1 }); const stale = f.life.store.document(d.id, 'test'); d.data.value = 2; f.life.store.saveDocument(d, 'updated'); stale.data.value = 3; assert.throws(() => f.life.store.saveDocument(stale, 'stale'), /Stale/); });
test('lifecycle lease cannot be stolen while controller is alive', t => { const f = fixture(t); const d = f.life.store.createDocument('test', {}); const token = f.life.store.acquireDocument(d.id); assert.throws(() => f.life.store.acquireDocument(d.id), /locked/); assert.throws(() => f.life.store.recoverDocument(d.id, true), /alive/); f.life.store.releaseDocument(d.id, token); });
test('document payload corruption is detected before use', t => { const f = fixture(t); const d = f.life.store.createDocument('test', { value: 1 }); const db = new DatabaseSync(join(f.state, 'control.sqlite')); db.prepare('UPDATE documents SET data=? WHERE id=?').run('{"value":2}', d.id); db.close(); assert.throws(() => f.life.store.document(d.id, 'test'), /digest/); });
test('schema migration accepts v1 store and retains run data', async (t) => { const f = fixture(t); const run = await f.life.pipeline.create({ repo: f.repo, task: { id: 'LEGACY', title: 'Legacy task', description: 'A legacy task', acceptance: ['Existing behavior'], allowedPaths: ['src/**'] }, config: f.config }); f.life.close(); const db = new DatabaseSync(join(f.state, 'control.sqlite')); db.exec('DROP TABLE document_children;DROP TABLE document_leases;DROP TABLE document_events;DROP TABLE documents;PRAGMA user_version=1;'); db.close(); const store = new Store(f.state); t.after(() => store.close()); assert.equal(store.get(run.id).id, run.id); assert.equal(store.documents('spec').length, 0); const check = new DatabaseSync(join(f.state, 'control.sqlite')); assert.equal(check.prepare('PRAGMA user_version').get().user_version, 2); check.close(); });
test('future database version is rejected', t => { const f = fixture(t); f.life.close(); const db = new DatabaseSync(join(f.state, 'control.sqlite')); db.exec('PRAGMA user_version=3'); db.close(); assert.throws(() => new Store(f.state), /Unsupported database version/); });
test('Product cannot modify its workspace and still return a valid spec', async (t) => {
    const f = fixture(t);
    const command = [process.execPath, '--input-type=module', '-e', `import {writeFileSync,readFileSync} from 'node:fs';readFileSync(0,'utf8');writeFileSync('README.md','unauthorized edit');console.log(${JSON.stringify(JSON.stringify(demoSpec()))});`];
    const cfg = { ...f.config, roles: { product: { type: 'command', command }, qa: f.config.agent } };
    await assert.rejects(f.life.draft({ repo: f.repo, config: cfg, request: 'Prepare bounded arithmetic work.' }), /uncommitted/);
    assert.equal(git(f.repo, 'status', '--porcelain'), '');
    assert.notEqual(readFileSync(join(f.repo, 'README.md'), 'utf8'), 'unauthorized edit');
});
test('Codex Product transport requests read-only and parses schema-bound final file', async (t) => {
    const f = fixture(t);
    const stub = join(f.root, 'fake-codex');
    const spec = JSON.stringify(demoSpec());
    writeFileSync(stub, `#!${process.execPath}\nconst fs=require('fs');const a=process.argv.slice(2);fs.readFileSync(0,'utf8');if(a[a.indexOf('--sandbox')+1]!=='read-only')process.exit(7);const s=JSON.parse(fs.readFileSync(a[a.indexOf('--output-schema')+1]));if(s.required.length!==Object.keys(s.properties).length)process.exit(8);fs.writeFileSync(a[a.indexOf('--output-last-message')+1],${JSON.stringify(spec)});console.log('provider progress, not a JSON response');\n`, { mode: 0o700 });
    const cfg = { ...f.config, roles: { product: agentSchema.parse({ type: 'codex', command: [stub] }), qa: f.config.agent } };
    const d = await f.life.draft({ repo: f.repo, config: cfg, request: 'Prepare bounded arithmetic work.' });
    assert.equal(d.data.content.title, demoSpec().title);
});
test('actual workflow SIGKILL requires explicit recovery and candidate adoption', async (t) => {
    const f = fixture(t, noQa);
    const script = `import {readFileSync,writeFileSync} from 'node:fs';readFileSync(0,'utf8');writeFileSync('src/math.mjs','export const add=(a,b)=>a+b;\\nexport const multiply=(a,b)=>a*b;\\n');setInterval(()=>{},1000);`;
    f.config.agent = { type: 'command', command: [process.execPath, '--input-type=module', '-e', script], timeoutMs: 20000 };
    const d = await approved(f, oneTask());
    const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
    const child = spawn(process.execPath, [cli, 'spec', 'run', d.id, '--state-dir', f.state, '--quiet'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let logs = '';
    child.stderr.on('data', b => logs += b);
    child.stdout.resume();
    const exited = new Promise(resolve => child.once('exit', resolve));
    let active;
    let pids = [];
    try {
        for (let i = 0; i < 200; i++) {
            const current = f.life.get(d.id);
            if (current.data.activeRunId) {
                active = f.life.pipeline.store.get(current.data.activeRunId);
                pids = f.life.pipeline.store.activeProcesses(active.id).filter(p => p.alive).map(p => p.pid);
                if (active.state === 'implementing' && pids.length && readFileSync(join(active.workspace, 'src/math.mjs'), 'utf8').includes('multiply'))
                    break;
            }
            await wait(25);
        }
        assert.ok(active?.state === 'implementing' && pids.length, logs);
        child.kill('SIGKILL');
        await exited;
        await assert.rejects(f.life.run(d.id), /locked/);
        for (const pid of pids) {
            try {
                process.kill(-pid, 'SIGKILL');
            }
            catch { }
        }
        for (let i = 0; i < 100 && f.life.pipeline.store.activeProcesses(active.id).some(p => p.alive); i++)
            await wait(20);
        f.life.recover(d.id, true);
        let result = await f.life.run(d.id);
        assert.equal(result.data.error.code, 'UNKNOWN_AGENT_OUTCOME');
        result = await f.life.run(d.id, { acceptCurrent: true });
        assert.equal(result.data.status, 'awaiting_review', JSON.stringify(result.data.error));
    }
    finally {
        try {
            child.kill('SIGKILL');
        }
        catch { }
        for (const pid of pids) {
            try {
                process.kill(-pid, 'SIGKILL');
            }
            catch { }
        }
    }
});

test('a spec still runs after its own candidate was merged and the branch moved on', async t => {
  const f = fixture(t);
  f.config.workflow.qaLanes = [];
  f.config.workflow.reviewMode = 'solo';
  let d = await approved(f, oneTask());
  d = await f.life.run(d.id);
  assert.equal(d.data.status, 'awaiting_review');
  const candidate = d.data.currentSha;

  // What merging this spec's own pull request does: the branch advances past the base, and past the
  // candidate. Nothing about the spec is stale — the base moved because of its own work.
  git(f.repo, 'merge', '--no-ff', '-q', '-m', 'Merge the reviewed candidate', candidate);
  const head = git(f.repo, 'rev-parse', 'HEAD').trim();
  assert.notEqual(head, d.data.baseSha);
  assert.notEqual(head, candidate);

  d = await f.life.verify(d.id);
  assert.equal(d.data.error, null, JSON.stringify(d.data.error));
  assert.equal(git(f.repo, 'rev-parse', 'HEAD').trim(), head, 'the operator checkout is left alone');
  d = await f.life.review(d.id, candidate, 'Reviewer Test', 'Reviewed the candidate this branch already contains.');
  assert.equal(d.data.status, 'ready');
});

test('a spec that produced nothing yet still refuses a moved base', async t => {
  const f = fixture(t);
  f.config.workflow.qaLanes = [];
  const d = await approved(f, oneTask());
  writeFileSync(join(f.repo, 'UNRELATED.md'), '# Someone else\u2019s pull request\n');
  git(f.repo, 'add', 'UNRELATED.md');
  git(f.repo, 'commit', '-qm', 'Merge an unrelated pull request');
  await assert.rejects(() => f.life.run(d.id), /HEAD/);
});

test('a spec refuses to run when its base commit is gone or the repository is dirty', async t => {
  const f = fixture(t);
  const d = await approved(f, oneTask());
  writeFileSync(join(f.repo, 'UNCOMMITTED.md'), '# Work in flight\n');
  await assert.rejects(() => f.life.run(d.id), e => e.code === 'DIRTY');
  rmSync(join(f.repo, 'UNCOMMITTED.md'));
  const broken = f.life.get(d.id);
  broken.data.baseSha = 'f'.repeat(40);
  broken.data.contentHash = specHash(broken.data);
  f.life.store.saveDocument(broken, 'test.base_missing');
  await assert.rejects(() => f.life.run(d.id));
});

test('a revalidation that failed can be run again once its cause is fixed', async t => {
  const f = fixture(t);
  f.config.workflow = { ...f.config.workflow, qaLanes: [], reviewMode: 'solo' };
  const broken = join(f.root, 'environment-broken');
  // A check that only fails while something outside the candidate is wrong: a missing tool, a service
  // that is down, a flaky suite. The candidate never changes; only the world around it does.
  f.config.gates = [...f.config.gates, { id: 'environment', command: [process.execPath, '-e',
    `process.exit(require('node:fs').existsSync(${JSON.stringify(broken)}) ? 1 : 0)`] }];
  let d = await approved(f, oneTask());
  d = await f.life.run(d.id);
  assert.equal(d.data.status, 'awaiting_review');

  writeFileSync(broken, '');
  d = await f.life.verify(d.id);
  assert.equal(d.data.status, 'blocked');
  assert.equal(d.data.error.code, 'GATES_FAILED');

  // Refusing here left the spec with no way back to a complete validation: its only fault was one
  // check that failed on a candidate nobody had touched.
  rmSync(broken);
  d = await f.life.run(d.id);
  assert.equal(d.data.error, null, JSON.stringify(d.data.error));
  assert.equal(f.life.pipeline.store.get(d.data.finalRunId).state, 'awaiting_review');
  d = await f.life.review(d.id, d.data.currentSha, 'Reviewer Test', 'Reviewed the candidate once its environment was fixed.');
  assert.equal(d.data.status, 'ready');
});
