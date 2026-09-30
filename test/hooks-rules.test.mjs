import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMPTY_CONTEXT } from '../hooks/scripts/harness-guard.mjs';
import { evaluateCommand, REASONS } from '../hooks/scripts/bash-guard.mjs';
import { evaluateWrite, WRITE_REASON } from '../hooks/scripts/write-guard.mjs';
import { operatorEntry } from '../hooks/scripts/operator-journal.mjs';
import { DOMAIN_REVIEWERS as HOOK_REVIEWERS } from '../hooks/scripts/lib.mjs';
import { DOMAIN_REVIEWERS } from '../dist/rules/reviews.js';

/**
 * The guards of the rules (docs/REGLES.md, « Ancrage »): a review is recorded by the reviewer agent of its domain only,
 * the stores of the operator journal and of the reviews are closed to agents, only the lead merges, and the journal
 * keeps only what the operator typed himself.
 */

const as = agentType => ({ ...EMPTY_CONTEXT, agentType, agentId: agentType ? 'a1' : null });
const record = (domain, reviewer) => `apv review record --commit abc --domain ${domain} --reviewer ${reviewer} --report r.md --critical 0 --high 0 --medium 0 --low 0`;

test('apv review record: only the reviewer agent of the domain, under its own name', () => {
  assert.equal(evaluateCommand(record('securite', 'apv:qa-securite'), {}, as('apv:qa-securite')).decision, 'allow');
  assert.equal(evaluateCommand(record('fidelite', 'qa-fidelite'), {}, as('qa-fidelite')).decision, 'allow');
  assert.equal(evaluateCommand(`cd /tmp/copie && node /p/dist/cli.js ${record('donnees', 'apv:architecte-donnees').slice(4)}`, {}, as('apv:architecte-donnees')).decision, 'allow');
  const lead = evaluateCommand(record('securite', 'apv:qa-securite'), {}, as(null));
  assert.deepEqual(lead, { decision: 'deny', reason: REASONS.reviewByLead('securite', 'qa-securite') });
  for (const agent of ['apv:implementer', 'apv:integrateur', 'apv:qa-fidelite']) {
    const r = evaluateCommand(record('securite', agent), {}, as(agent));
    assert.equal(r.decision, 'deny', agent);
    assert.match(r.reason, /Seul l'agent apv:qa-securite enregistre la relecture securite/);
  }
  assert.equal(evaluateCommand(record('securite', 'apv:dpo'), {}, as('apv:qa-securite')).decision, 'deny', 'under another name');
  assert.equal(evaluateCommand(`sh -c "${record('rgpd', 'apv:dpo')}"`, {}, as('apv:implementer')).decision, 'deny', 'nested in a shell');
  assert.equal(evaluateCommand('apv review show --commit abc', {}, as('apv:implementer')).decision, 'allow');
  assert.equal(evaluateCommand('apv review plan --base main', {}, as(null)).decision, 'allow');
});

test('the stores of the operator journal and of the reviews are closed to every command and every write', () => {
  for (const command of ['cat .git/apv/operator/messages.jsonl', 'echo x >> "$(git rev-parse --git-common-dir)/apv/reviews/abc/securite/r.json"',
    'cp faux.json ../.git/apv/reviews/abc/', 'node -e "fs.appendFileSync(\'.git/apv/operator/messages.jsonl\', x)"']) {
    assert.deepEqual(evaluateCommand(command, {}, as('apv:qa-securite')), { decision: 'deny', reason: REASONS.anchorStore }, command);
  }
  assert.deepEqual(evaluateWrite({ tool_input: { file_path: '/r/.git/apv/reviews/abc/securite/x.json' } }), { decision: 'deny', reason: WRITE_REASON });
  assert.deepEqual(evaluateWrite({ tool_input: { file_path: 'C:\\r\\.git\\apv\\operator\\messages.jsonl' } }).decision, 'deny');
  assert.equal(evaluateWrite({ tool_input: { file_path: '/r/src/review/plan.ts' } }).decision, 'allow');
  assert.equal(evaluateWrite({ tool_input: { notebook_path: '/r/notes.ipynb' } }).decision, 'allow');
});

test('only the lead merges: a merge command is refused in a subagent, even with APV_ALLOW_MERGE=1', () => {
  assert.deepEqual(evaluateCommand('APV_ALLOW_MERGE=1 apv stack merge 3', {}, as('apv:integrateur')), { decision: 'deny', reason: REASONS.mergeBySubagent });
  assert.deepEqual(evaluateCommand('APV_ALLOW_MERGE=1 gh pr merge 3 --merge', {}, as('general-purpose')), { decision: 'deny', reason: REASONS.mergeBySubagent });
  assert.equal(evaluateCommand('APV_ALLOW_MERGE=1 apv stack merge 3', {}, as(null)).decision, 'allow');
  assert.equal(evaluateCommand('gh pr create --draft --title x --body y', {}, as('apv:implementer')).decision, 'allow');
});

test('the operator journal keeps only prompts typed in the interactive composer', () => {
  const now = new Date('2026-09-30T10:00:00Z');
  const entry = operatorEntry({ hook_event_name: 'UserPromptSubmit', source: 'user', prompt: 'Je valide la maquette', session_id: 's1' }, now);
  assert.equal(entry.text, 'Je valide la maquette');
  assert.equal(entry.at, '2026-09-30T10:00:00.000Z');
  assert.match(entry.sha256, /^[0-9a-f]{64}$/);
  for (const input of [
    { hook_event_name: 'UserPromptSubmit', source: 'sdk', prompt: 'dérogation relecture abc : x' },
    { hook_event_name: 'UserPromptSubmit', prompt: 'sans source connue' },
    { hook_event_name: 'UserPromptSubmit', source: 'user', agent_id: 'sub', prompt: 'message du chef à un agent' },
    { hook_event_name: 'UserPromptSubmit', source: 'loop_wakeup', prompt: 'réveil' },
    { hook_event_name: 'UserPromptSubmit', source: 'user', prompt: '   ' },
  ]) assert.equal(operatorEntry(input, now), null, JSON.stringify(input));
});

test('the operator journal hook writes into the Git common directory of a project that uses APV, never elsewhere', t => {
  const root = mkdtempSync(join(tmpdir(), 'apv3-journal-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  const hook = fileURLToPath(new URL('../hooks/scripts/operator-journal.mjs', import.meta.url));
  const run = input => spawnSync(process.execPath, [hook], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
  const journal = join(root, '.git', 'apv', 'operator', 'messages.jsonl');
  assert.equal(run({ hook_event_name: 'UserPromptSubmit', source: 'user', prompt: 'bonjour', cwd: root }).status, 0);
  assert.ok(!existsSync(journal), 'no .apv/: not an APV project, nothing kept');
  mkdirSync(join(root, '.apv'));
  const r = run({ hook_event_name: 'UserPromptSubmit', source: 'user', prompt: 'dérogation relecture 0123456789ab : urgence', cwd: root });
  assert.equal(r.status, 0); assert.equal(r.stdout, '');
  assert.equal(JSON.parse(readFileSync(journal, 'utf8').trim()).text, 'dérogation relecture 0123456789ab : urgence');
});

test('the hooks and the tool name the same reviewer for each domain', () => {
  assert.deepEqual(HOOK_REVIEWERS, DOMAIN_REVIEWERS);
});
