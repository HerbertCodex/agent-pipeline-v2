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

test('Product cannot drop controller-routed OWASP topics or required threat modeling', () => {
  const ctx = assessSecurity({ text:'Add email/password login and protected admin access.', projectType:'fullstack', files:[] });
  const incomplete = demoSpec();
  assert.throws(() => validateSpec(incomplete, false, {schemaVersion:1,decisions:[]}, undefined, ctx), /Security topic|security plan|SPEC_SECURITY/i);
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
