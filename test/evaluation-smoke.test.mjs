import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

test('evaluation dry run is side effect free and an executed fixture produces a complete report', t => {
  const root = mkdtempSync(join(tmpdir(), 'apv2-eval-smoke-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = new URL('../scripts/evaluate.mjs', import.meta.url).pathname;
  const output = join(root, 'report');
  const call = args => execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
  const dry = JSON.parse(call(['--case', 'boundary-fix', '--output', output]));
  assert.equal(dry.executed, false); assert.equal(existsSync(output), false);
  const worker = join(root, 'worker.mjs');
  writeFileSync(worker, `import {readFileSync,writeFileSync} from 'node:fs'; const req=JSON.parse(readFileSync(0,'utf8'));
if(req.role==='qa') console.log(JSON.stringify({candidateSha:req.context.candidateSha,verdict:'pass',summary:'Fixture-only inspection',criteria:req.context.spec.acceptance.map(c=>({id:c.id,status:'pass',evidence:'Fixed acceptance oracle passed.'})),findings:[],observations:[]}));
else {writeFileSync('src/range.mjs','export function clamp(value,min,max) { if(min>max) throw new RangeError(); return Math.max(min,Math.min(max,value)); }\\n');console.log(JSON.stringify({summary:'Deterministic fixture correction; no model was called.'}));}
`);
  const config = join(root, 'config.json');
  writeFileSync(config, JSON.stringify({ schemaVersion: 1, executionMode: 'local-trusted', environment: { id: 'eval-smoke' },
    agent: { type: 'command', command: [process.execPath, worker], timeoutMs: 10000 },
    gates: [{ id: 'acceptance', command: [process.execPath, '--test'], mandatory: true }],
    maxRunMs: 15000, maxRepairAttempts: 0, workflow: { maxActiveMs: 30000, maxQaRepairs: 0 } }));
  call(['--case', 'boundary-fix', '--config', config, '--planning', 'fixture', '--output', output, '--execute']);
  const report = JSON.parse(readFileSync(join(output, 'report.json'), 'utf8'));
  assert.equal(report.samples.length, 1); assert.equal(report.samples[0].success, true);
  assert.equal(report.realHumanReview, false); assert.equal(report.aggregate[0].costComplete, false);
  assert.equal(report.details[0].untouched, true);
  assert.throws(() => call(['--case', 'boundary-fix', '--config', config, '--output', output, '--execute']), /already exists/);
  // A passing fixed oracle must not hide a failing regression added by the agent.
  writeFileSync(worker, readFileSync(worker, 'utf8').replace("else {writeFileSync", "else {writeFileSync('test/regression.mjs',\"import test from 'node:test'; import assert from 'node:assert/strict'; test('regression',()=>assert.equal(1,2));\");writeFileSync"));
  const failed = join(root, 'failed-regression');
  assert.throws(() => call(['--case', 'boundary-fix', '--config', config, '--planning', 'fixture', '--output', failed, '--execute']));
  const failedReport = JSON.parse(readFileSync(join(failed, 'report.json'), 'utf8'));
  assert.equal(failedReport.samples[0].success, false);
  assert.equal(failedReport.details[0].status, 'blocked');
});
