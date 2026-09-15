import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, oneTask } from './lifecycle-helpers.mjs';

test('spec summary tolerates records created before the alpha.8 security layer', async (t) => {
  const f = fixture(t);
  const d = await f.life.draft({ repo: f.repo, config: f.config, request: 'Implement the approved arithmetic example.', proposal: oneTask() });
  const data = structuredClone(d.data);
  delete data.securityContext;
  delete data.securityContextHash;
  delete data.decisionLedger;
  delete data.content.security;
  const summary = f.life.summary({ ...d, data });
  assert.deepEqual(summary.security, { contextHash: null, minimumLane: null, requiresThreatModel: null, topics: [], requirements: [] });
  assert.equal(summary.title, d.data.content.title);
});

test('spec summary still reports the security context of current records', async (t) => {
  const f = fixture(t);
  const d = await f.life.draft({ repo: f.repo, config: f.config, request: 'Implement the approved arithmetic example.', proposal: oneTask() });
  const summary = f.life.summary(d);
  assert.equal(summary.security.minimumLane, d.data.securityContext.minimumLane);
  assert.equal(summary.security.contextHash, d.data.securityContextHash);
});
