// The dashboard can approve on the operator's behalf, so its access and action guards are tested as such:
// one-time token, session cookie, Host check, same-origin CSRF, exact hash, and sandboxed mockups.
import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { fixture, git } from './lifecycle-helpers.mjs';
import { startUi } from '../dist/ui/server.js';

function call(ui, path, { method = 'GET', headers = {}, body, raw } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: ui.port, path, method, headers: { host: `127.0.0.1:${ui.port}`, ...headers } }, (res) => {
      if (raw) { resolve(res); return; }
      let data = ''; res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data, json: () => JSON.parse(data) }));
    });
    req.on('error', reject);
    if (body !== undefined) req.end(JSON.stringify(body)); else req.end();
  });
}

async function open(t) {
  const f = fixture(t);
  git(f.repo, 'config', 'user.name', 'Dashboard Operator');
  const ui = await startUi({ stateDir: f.state, port: 0, pollMs: 50 });
  t.after(() => ui.close());
  const entry = await call(ui, `/?token=${ui.accessToken}`);
  assert.equal(entry.status, 303);
  const cookie = String(entry.headers['set-cookie']).split(';')[0];
  assert.match(String(entry.headers['set-cookie']), /HttpOnly; SameSite=Strict/);
  const session = (await call(ui, '/api/session', { headers: { cookie } })).json();
  const post = (path, body, headers = {}) => call(ui, path, { method: 'POST', body,
    headers: { cookie, origin: `http://127.0.0.1:${ui.port}`, 'content-type': 'application/json', 'x-apv2-csrf': session.csrf, ...headers } });
  return { f, ui, cookie, csrf: session.csrf, get: (path) => call(ui, path, { headers: { cookie } }), post };
}

test('the dashboard requires the one-time token, its cookie and the expected Host', async (t) => {
  const { ui, cookie, get } = await open(t);
  assert.equal((await call(ui, '/')).status, 401, 'no session, no page');
  assert.equal((await call(ui, '/?token=' + 'a'.repeat(64))).status, 401, 'a wrong token is refused');
  assert.equal((await call(ui, '/api/specs', { headers: { cookie: 'apv2_session=forged' } })).status, 401);
  assert.equal((await call(ui, '/api/specs', { headers: { cookie, host: 'evil.example:80' } })).status, 421, 'DNS rebinding is refused');
  const page = await get('/');
  assert.equal(page.status, 200);
  assert.match(page.text, /Agent Pipeline/);
  assert.match(String(page.headers['content-security-policy']), /script-src 'self'/);
  assert.match(String(page.headers['content-security-policy']), /frame-ancestors 'none'/);
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.equal((await get('/app.js')).status, 200);
  assert.equal(ui.url.startsWith('http://127.0.0.1:'), true);
});

test('specs, their detail and their events are readable', async (t) => {
  const { f, get } = await open(t);
  const d = await f.life.draft({ repo: f.repo, config: f.config, request: 'Implement the approved arithmetic example.' });
  const list = (await get('/api/specs')).json();
  assert.equal(list[0].id, d.id);
  assert.equal(list[0].repo, f.repo);
  const detail = (await get(`/api/specs/${d.id}`)).json();
  assert.equal(detail.summary.hash, d.data.contentHash);
  assert.equal(detail.content.title, d.data.content.title);
  assert.ok((await get(`/api/specs/${d.id}/events`)).json().some(e => e.type === 'product.proposed'));
  assert.equal((await get('/api/specs/unknown-id')).status, 404);
  assert.ok(Array.isArray((await get('/api/maintenance')).json().garbage));
});

test('an action needs the CSRF token, the same origin, the exact hash and a note', async (t) => {
  const { f, post } = await open(t);
  const d = await f.life.draft({ repo: f.repo, config: f.config, request: 'Implement the approved arithmetic example.' });
  const body = { hash: d.data.contentHash, note: 'Relu dans le tableau de bord.' };
  assert.equal((await post(`/api/specs/${d.id}/approve`, body, { 'x-apv2-csrf': 'forged' })).status, 403, 'CSRF token required');
  assert.equal((await post(`/api/specs/${d.id}/approve`, body, { origin: 'http://evil.example' })).status, 403, 'foreign origin refused');
  assert.equal((await post(`/api/specs/${d.id}/approve`, body, { origin: '' })).status, 403, 'missing origin refused');
  assert.equal((await post(`/api/specs/${d.id}/approve`, { ...body, note: 'court' })).status, 400, 'a note is required');
  assert.equal((await post(`/api/specs/${d.id}/approve`, { ...body, hash: 'f'.repeat(64) })).status, 422, 'only the exact hash approves');
  const ok = await post(`/api/specs/${d.id}/approve`, body);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json().status, 'approved');
  const approval = f.life.get(d.id).data.approval;
  assert.equal(approval.reviewer, 'Dashboard Operator', 'the reviewer is the repository git identity');
  assert.match(approval.note, /^\[tableau de bord\] /, 'the approval says where it came from');
});

test('a long operation runs as a separate CLI process that the dashboard follows', async (t) => {
  const { f, get, post } = await open(t);
  let d = await f.life.draft({ repo: f.repo, config: f.config, request: 'Implement the approved arithmetic example.' });
  d = await f.life.approveSpec(d.id, d.data.contentHash, 'Test Owner', 'Fixture approval after inspecting scope and criteria.');
  const started = await post(`/api/specs/${d.id}/run`, {});
  assert.equal(started.status, 202, started.text);
  assert.equal((await post(`/api/specs/${d.id}/run`, {})).status, 409, 'one operation at a time per spec');
  let job;
  for (let i = 0; i < 600; i++) {
    job = (await get('/api/jobs')).json().find(j => j.id === started.json().id);
    if (job.state !== 'running') break;
    await new Promise(r => setTimeout(r, 200));
  }
  assert.equal(job.state, 'succeeded', job.tail);
  assert.equal((await get(`/api/specs/${d.id}`)).json().summary.status, 'awaiting_review');
});

test('a spec is busy while any controller holds it, not only jobs started by this dashboard', async (t) => {
  const { f, get } = await open(t);
  const d = await f.life.draft({ repo: f.repo, config: f.config, request: 'Implement the approved arithmetic example.' });
  assert.equal((await get(`/api/specs/${d.id}`)).json().busy, false);
  const token = f.life.store.acquireDocument(d.id);
  assert.equal((await get(`/api/specs/${d.id}`)).json().busy, true, 'a terminal run holds the lease with a live pid');
  assert.equal((await get('/api/specs')).json().find(s => s.id === d.id).busy, true);
  f.life.store.releaseDocument(d.id, token);
  assert.equal((await get(`/api/specs/${d.id}`)).json().busy, false);
});

test('the live stream pushes new lifecycle events', async (t) => {
  const { f, ui, cookie } = await open(t);
  const res = await call(ui, '/api/stream', { headers: { cookie }, raw: true });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /text\/event-stream/);
  let received = '';
  const seen = new Promise((resolve) => { res.setEncoding('utf8'); res.on('data', chunk => { received += chunk; if (received.includes('product.proposed')) resolve(); }); });
  await f.life.draft({ repo: f.repo, config: f.config, request: 'Implement the approved arithmetic example.' });
  await Promise.race([seen, new Promise((_, reject) => setTimeout(() => reject(new Error('no event received')), 10000))]);
  res.destroy();
  assert.match(received, /event: events/);
});

test('only this spec\'s mockups are served, sandboxed', async (t) => {
  const { f, get } = await open(t);
  const s = (await import('./lifecycle-helpers.mjs')).oneTask();
  s.experience = { uiImpact: 'major', surfaces: ['Arithmetic dashboard'], rationale: 'The task changes the primary user-facing screen.' };
  const request = 'Create a distinctive arithmetic dashboard.';
  const d = await f.life.draft({ repo: f.repo, config: { ...f.config, skills: { enabled: ['ui-design'], projectType: 'frontend', maxContextBytes: 16000 } }, request,
    proposal: (await import('./lifecycle-helpers.mjs')).withSecurity(s, request, 'frontend') });
  const file = d.data.design.screenPaths[0].split('/').pop();
  assert.ok(existsSync(d.data.design.screenPaths[0]));
  const preview = await get(`/api/specs/${d.id}/design/${file}`);
  assert.equal(preview.status, 200);
  assert.equal(preview.text, readFileSync(d.data.design.screenPaths[0], 'utf8'));
  assert.match(String(preview.headers['content-security-policy']), /^sandbox;/);
  assert.equal((await get(`/api/specs/${d.id}/design/..%2F..%2Fcontrol.sqlite`)).status, 404, 'no path is built from the request');
  assert.equal((await get(`/api/specs/${d.id}/design/INDEX.md`)).status, 404, 'only screen files');
});
