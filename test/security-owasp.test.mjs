import test from 'node:test';
import assert from 'node:assert/strict';
import { assessSecurity, validateSpec, validateQa, readRole } from '../dist/index.js';
import { demoSpec } from '../examples/lifecycle-fixture.mjs';

function topicIds(ctx) { return new Set(ctx.topics.map(t => t.id)); }

function secureSpec(ctx) {
  const spec = demoSpec();
  spec.acceptance.push({ id:'AC-SEC', description:'Security-sensitive behavior enforces the approved trust boundaries and rejects invalid access.', verification:'Run the explicit negative security tests and inspect the implementation against the routed requirements.' });
  spec.tasks[0].acceptanceIds.push('AC-SEC');
  spec.minimumLane = ctx.minimumLane;
  spec.security = {
    profile: { ...ctx.profile },
    owaspTopics: ctx.topics.map(t => t.id),
    threatModel: {
      required: ctx.requiresThreatModel,
      summary: ctx.requiresThreatModel ? 'Model the credential and request boundary before implementation.' : '',
      assets: ctx.requiresThreatModel ? ['user account', 'session'] : [],
      trustBoundaries: ctx.requiresThreatModel ? ['untrusted client -> application'] : [],
      threats: ctx.requiresThreatModel ? [{ id:'TM-1', category:'spoofing', description:'An attacker attempts to act as another user.', mitigations:['Authenticate the user and reject invalid credentials.'], acceptanceIds:['AC-SEC'] }] : [],
      assumptions: [],
    },
    requirements: ctx.topics.length ? [{ id:'SEC-1', title:'Apply the controller-routed security controls', owaspTopics:ctx.topics.map(t=>t.id), acceptanceIds:['AC-SEC'], verification:'Inspect code and runner-observed tests for every routed topic.', negativeTests:ctx.negativeTestsRequired ? ['Reject invalid credentials or unauthorized requests without changing protected state.'] : [] }] : [],
    assumptions: [], deferred: [],
  };
  return spec;
}

test('authentication/password work routes OWASP auth topics, threat modeling and negative tests', () => {
  const ctx = assessSecurity({ text:'Build an internet-facing login with email and password, sessions and staff roles.', projectType:'fullstack', files:[] });
  const ids = topicIds(ctx);
  for (const id of ['authentication','password-storage','session-management','authorization','data-protection','logging-monitoring','threat-modeling']) assert.ok(ids.has(id), id);
  assert.equal(ctx.profile.authentication, true);
  assert.equal(ctx.requiresThreatModel, true);
  assert.equal(ctx.negativeTestsRequired, true);
  assert.equal(ctx.minimumLane, 'high');
});

test('outbound API work routes SSRF, REST and validation guidance', () => {
  const ctx = assessSecurity({ text:'Add a REST endpoint that fetches a user supplied callback URL from an external API.', projectType:'backend', files:[] });
  const ids = topicIds(ctx);
  for (const id of ['ssrf','rest-security','input-validation','threat-modeling']) assert.ok(ids.has(id), id);
  assert.equal(ctx.profile.externalRequests, true);
  assert.equal(ctx.profile.api, true);
  assert.equal(ctx.minimumLane, 'high');
});

test('AI agent and MCP work routes agent, prompt-injection, AI coding and MCP guidance', () => {
  const ctx = assessSecurity({ text:'Add an AI agent using MCP tool calling and repository context.', projectType:'backend', files:[] });
  const ids = topicIds(ctx);
  for (const id of ['ai-agent-security','llm-prompt-injection','secure-coding-with-ai','mcp-security','threat-modeling']) assert.ok(ids.has(id), id);
  assert.equal(ctx.profile.aiAgent, true);
  assert.equal(ctx.profile.mcp, true);
  assert.equal(ctx.minimumLane, 'high');
});

test('ordinary arithmetic change stays fast and does not become a supply-chain task just because a lockfile exists elsewhere', () => {
  const ctx = assessSecurity({ text:'Add a multiplication function and document it.', projectType:'library', files:['src/math.mjs','test/math.test.mjs'] });
  assert.equal(ctx.minimumLane, 'fast');
  assert.deepEqual(ctx.topics, []);
  assert.equal(ctx.profile.dependencyChange, false);
});

test('authorization-only scope does not invent login, session or database work from exclusions and paths', () => {
  const ctx = assessSecurity({ text: 'Correct the authorization guard canBorrow(user). Validate the borrower role and id. Do not implement login, a database, or a new authentication scheme. Only src/auth/borrower.mjs may change.', files: ['src/auth/borrower.mjs'] });
  assert.equal(ctx.profile.authorization, true);
  for (const key of ['authentication', 'sessionState', 'database']) assert.equal(ctx.profile[key], false, key);
  assert.equal(ctx.minimumLane, 'high'); assert.equal(ctx.requiresThreatModel, true); assert.equal(ctx.negativeTestsRequired, true);
  for (const topic of ['authorization', 'input-validation', 'logging-monitoring', 'threat-modeling']) assert.ok(topicIds(ctx).has(topic), topic);
});

test('scope exclusions preserve negative security obligations and affirmative clauses', () => {
  const excluded = assessSecurity({ text: 'Corriger les permissions. Ne pas ajouter de connexion ni de base de données. Ne pas modifier les sessions.' });
  assert.equal(excluded.profile.authentication, false); assert.equal(excluded.profile.sessionState, false);
  const obligations = assessSecurity({ text: 'Never bypass authentication. Do not leak passwords. Do not disable session validation.' });
  assert.equal(obligations.profile.authentication, true); assert.equal(obligations.profile.sessionState, true); assert.equal(obligations.profile.sensitiveData, true);
  const mixed = assessSecurity({ text: 'Do not add a database, but implement password login. Do not modify sessions and add a new login endpoint.' });
  assert.equal(mixed.profile.database, false); assert.equal(mixed.profile.authentication, true); assert.equal(mixed.profile.api, true);
});

test('actual security paths override prose exclusions while repository prose does not imply persistence', () => {
  const ctx = assessSecurity({ text: 'Do not change login or the database.', files: ['src/auth/login.ts', 'db/migrations/001.sql'] });
  assert.equal(ctx.profile.authentication, true); assert.equal(ctx.profile.database, true); assert.equal(ctx.minimumLane, 'high');
  const genericAuth = assessSecurity({ text: 'Refactor the helper.', files: ['src/auth/helper.ts'] });
  assert.equal(genericAuth.minimumLane, 'high');
  const sessions = assessSecurity({ text: 'Correct authorization only. Do not modify sessions.', files: ['src/auth/session.ts'] });
  assert.equal(sessions.profile.sessionState, true); assert.equal(sessions.minimumLane, 'high');
  const passwords = assessSecurity({ text: 'Do not modify passwords.', files: ['src/auth/password.ts'] });
  assert.ok(topicIds(passwords).has('password-storage')); assert.equal(passwords.profile.sensitiveData, true);
  assert.equal(assessSecurity({ text: 'Inspect the repository and correct arithmetic.' }).profile.database, false);
});

test('Product cannot drop controller-routed OWASP topics or required threat modeling', () => {
  const ctx = assessSecurity({ text:'Add email/password login and protected admin access.', projectType:'fullstack', files:[] });
  const incomplete = demoSpec();
  assert.throws(() => validateSpec(incomplete, false, {schemaVersion:1,decisions:[]}, undefined, ctx), error => {
    assert.equal(error.code, 'SPEC_SECURITY');
    for (const topic of ctx.topics) assert.ok(error.message.includes(topic.id), `same repair must see missing topic ${topic.id}`);
    assert.match(error.message, /security.requirements/);
    assert.match(error.message, /sessionState/);
    return true;
  });
  const spec = secureSpec(ctx);
  assert.doesNotThrow(() => validateSpec(spec, false, {schemaVersion:1,decisions:[]}, undefined, ctx));
});

test('QA cannot pass a security-sensitive spec without evidence for every security requirement', () => {
  const ctx = assessSecurity({ text:'Add email/password login and protected admin access.', projectType:'fullstack', files:[] });
  const spec = validateSpec(secureSpec(ctx), false, {schemaVersion:1,decisions:[]}, undefined, ctx);
  const sha = 'a'.repeat(40);
  const base = { candidateSha:sha, verdict:'pass', summary:'Reviewed candidate and observed test evidence.', criteria:spec.acceptance.map(c=>({id:c.id,status:'pass',evidence:'Observed matching implementation and tests.'})), findings:[], observations:[], decisionChecks:[] };
  assert.throws(() => validateQa(base, spec, sha), /security requirement|QA_SECURITY/i);
  const qa = { ...base, securityChecks:spec.security.requirements.map(r=>({requirementId:r.id,status:'pass',evidence:'Inspected implementation and observed the required negative test evidence.'})) };
  assert.equal(validateQa(qa, spec, sha).verdict, 'pass');
});

test('shipped roles treat repository and external content as untrusted prompt-injection surfaces', () => {
  for (const role of ['product','implementer','qa']) {
    const text = readRole(role).instructions.toLowerCase();
    assert.match(text, /untrusted/);
    assert.match(text, /prompt[- ]injection|embedded instructions/);
  }
});
