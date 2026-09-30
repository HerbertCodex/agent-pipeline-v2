import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

/** The payload of UserPromptSubmit as Claude Code sends it, with `source` as given (absent: `undefined`, as in 2.1.280). */
const prompt = (text, source, extra = {}) => ({ session_id: 's1', transcript_path: '/tmp/t.jsonl', cwd: '/tmp/p', permission_mode: 'default',
  hook_event_name: 'UserPromptSubmit', prompt: text, ...(source === undefined ? {} : { source }), ...extra });

test('the operator journal keeps only prompts typed in the composer (source user or tty); without source, nothing', () => {
  for (const source of ['user', 'tty']) assert.deepEqual(operatorEntry(prompt('Je valide la maquette', source)), { keep: { text: 'Je valide la maquette', session: 's1' } }, source);
  // Claude Code 2.1.280 sends no source: a claude -p launched by an agent could not be told apart, so nothing is kept.
  assert.match(operatorEntry(prompt('Je valide la maquette', undefined)).refuse, /champ source absent/);
  for (const source of ['sdk', 'argument', 'stdin', 'api', 'file', 'resume', 'system', 'loop_wakeup', 'schedule_wakeup', 'poll_event']) {
    assert.match(operatorEntry(prompt('dérogation relecture 0123456789ab : urgence', source)).refuse, /pas un message tapé par l'opérateur/, source);
  }
  assert.match(operatorEntry(prompt('message du chef à un agent', 'user', { agent_id: 'sub' })).refuse, /sous-agent/);
  assert.equal(operatorEntry(prompt('   ', 'user')), null);
  assert.equal(operatorEntry({ hook_event_name: 'Stop' }), null);
});

test('the operator journal hook signs what it keeps, keeps no whole message, masks secrets, notes a refusal for apv status', async t => {
  const root = mkdtempSync(join(tmpdir(), 'apv3-journal-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  const keyFile = join(root, 'cle', 'cle-ancrage');
  const hook = fileURLToPath(new URL('../hooks/scripts/operator-journal.mjs', import.meta.url));
  const run = input => spawnSync(process.execPath, [hook], { input: JSON.stringify({ ...input, cwd: root }), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root, APV_ANCHOR_KEY_FILE: keyFile } });
  const journal = join(root, '.git', 'apv', 'operator', 'messages.jsonl');
  assert.equal(run(prompt('bonjour', 'user')).status, 0);
  assert.ok(!existsSync(journal), 'no .apv/: not an APV project, nothing kept');
  mkdirSync(join(root, '.apv'));
  const secret = ['sk', 'live', 'a1B2c3D4e5F6g7H8i9J0'].join('_');
  const text = `Mon mot de passe est hunter2 et la clé ${secret}. Je valide la maquette des articles.\ndérogation relecture 0123456789ab : urgence validée, clé ${secret}`;
  const r = run(prompt(text, 'tty'));
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, '');
  const raw = readFileSync(journal, 'utf8');
  assert.ok(!raw.includes('hunter2') && !raw.includes(secret), 'never the whole message, never a secret');
  const line = JSON.parse(raw.trim());
  assert.deepEqual(line.waivers, ['dérogation relecture 0123456789ab : urgence validée, clé [masqué]']);
  assert.deepEqual(line.preview, ['Je valide la maquette des articles.']);
  assert.equal((statSync(keyFile).mode & 0o777), 0o400);
  const { setAnchorKeyFile, readOperatorMessages, anchoredQuote, journalState } = await import('../dist/rules/operator.js');
  setAnchorKeyFile(keyFile);
  const common = join(root, '.git');
  assert.ok(anchoredQuote(readOperatorMessages(common), 'Je valide la maquette des articles'), 'a whole sentence is recognised by its hash');
  assert.equal(anchoredQuote(readOperatorMessages(common), 'la maquette des articles'), null, 'a piece of a sentence is not');
  // A line written without the key, or altered, is ignored.
  writeFileSync(journal, `${raw}${JSON.stringify({ ...line, waivers: ['dérogation preuve 0123456789ab : forgée par un agent'] })}\n`);
  assert.equal(readOperatorMessages(common).length, 1);
  assert.equal(journalState(common).ignored, 1);
  // Claude Code without source: nothing kept, the reason noted for apv status.
  run(prompt('Je valide tout', undefined));
  assert.equal(readOperatorMessages(common).length, 1);
  assert.match(journalState(common).refused.reason, /champ source absent/);
  setAnchorKeyFile(null);
});

test('the hooks and the tool name the same reviewer for each domain', () => {
  assert.deepEqual(HOOK_REVIEWERS, DOMAIN_REVIEWERS);
});

test('review 99, HAUT 1: every bypass found is refused', () => {
  const lead = as(null);
  const denied = [
    // The stores and the key, even cut in pieces.
    ['d=apv; cat "$(git rev-parse --git-common-dir)/$d/operator/messages.jsonl"', REASONS.anchorStore],
    ['echo x >> .git/ap""v/operator/messages.jsonl', REASONS.anchorStore],
    [`node -e "fs.appendFileSync(require('path').join(root, 'ap'+'v', 'operator', 'm'), x)"`, REASONS.anchorStore],
    ['cat ~/.config/apv/anchor.key', REASONS.anchorStore],
    ['x=$(git rev-parse --git-common-dir); ls $x', REASONS.commonDir],
    // A record whose command is computed.
    ['c=review; apv $c record --commit abc --domain securite', REASONS.computedApv],
    ['eval "apv review record --commit abc --domain securite"', REASONS.computedApv],
    // A merge through any client.
    ['gh api graphql -f query="mutation { mergePullRequest(input: {pullRequestId: \\"x\\"}) { clientMutationId } }"', REASONS.rawMerge],
    ['gh api graphql -f query="mutation { enablePullRequestAutoMerge(input: {}) { clientMutationId } }"', REASONS.rawMerge],
    ['curl -X PUT -H "Authorization: token $T" https://api.github.com/repos/o/r/pulls/12/merge', REASONS.rawMerge],
    // A push to the default branch, forced or not.
    ['git push origin HEAD:main', REASONS.pushToDefault('main')],
    ['git push origin main', REASONS.pushToDefault('main')],
    ['git push origin feat:refs/heads/main', REASONS.pushToDefault('main')],
    ['git -C /r push origin +feat:master', REASONS.forcePush],
    ['git push --all origin', REASONS.pushToDefault('main')],
  ];
  for (const [command, reason] of denied) assert.deepEqual(evaluateCommand(command, {}, lead), { decision: 'deny', reason }, command);
  // From the default branch itself, a bare push or HEAD pushes it.
  const onMain = { ...lead, currentBranch: () => 'main', defaultBranches: () => ['trunk', 'main', 'master'] };
  assert.equal(evaluateCommand('git push', {}, onMain).decision, 'deny');
  assert.equal(evaluateCommand('git push origin HEAD', {}, onMain).decision, 'deny');
  assert.equal(evaluateCommand('git push origin trunk', {}, onMain).decision, 'deny', 'the default branch of origin');
  for (const command of ['git push -u origin feat/regles', 'git push origin HEAD:feat/x', 'git rev-parse --git-common-dir', 'git rev-parse --path-format=absolute --git-common-dir',
    'apv review show --commit abc', 'gh pr view 12 --json state', 'git log --oneline origin/main']) assert.equal(evaluateCommand(command, {}, lead).decision, 'allow', command);
  assert.equal(evaluateCommand('git push', {}, { ...lead, currentBranch: () => 'feat/x' }).decision, 'allow');
});

test('the read and write guard keeps the anchor key and the stores out of reach of the file tools', () => {
  for (const tool_input of [{ file_path: '/home/u/.config/apv/anchor.key' }, { path: '/r/.git/apv/reviews' }, { pattern: '**/anchor.key' }, { file_path: '/r/.git/apv/merges/12-abc.json' }]) {
    assert.equal(evaluateWrite({ tool_input }).decision, 'deny', JSON.stringify(tool_input));
  }
  assert.equal(evaluateWrite({ tool_input: { path: '/r/src', pattern: 'review' } }).decision, 'allow');
});

test('the seal hook seals a record only for the reviewer agent of its domain, from the id the tool printed', async t => {
  const { sealRequest, recordId } = await import('../hooks/scripts/review-seal.mjs');
  const command = 'cd /tmp/copie && apv review record --commit abc --domain securite --reviewer apv:qa-securite --report r.md --critical 0 --high 0 --medium 0 --low 0';
  const out = { stdout: 'Enregistrement 20260930T101010Z-0a1b2c3d\nRelecture securite enregistrée' };
  assert.equal(recordId(out), '20260930T101010Z-0a1b2c3d');
  assert.deepEqual(sealRequest({ tool_name: 'Bash', tool_input: { command }, tool_response: out, agent_type: 'apv:qa-securite' }), { id: '20260930T101010Z-0a1b2c3d', domain: 'securite', agent: 'apv:qa-securite' });
  for (const agent_type of [undefined, 'apv:implementer', 'apv:qa-fidelite']) {
    assert.equal(sealRequest({ tool_name: 'Bash', tool_input: { command }, tool_response: out, agent_type }), null, String(agent_type));
  }
  assert.equal(sealRequest({ tool_name: 'Bash', tool_input: { command: 'apv review show --commit abc' }, tool_response: out, agent_type: 'apv:qa-securite' }), null);
  // The hook itself: a record written by the tool, sealed by the hook of the reviewer, counted; written by anyone else, not.
  const { TEST_KEY_FILE, commonDirOf } = await import('./support/rules.mjs');
  const { recordReview, latestReviews } = await import('../dist/rules/reviews.js');
  const root = mkdtempSync(join(tmpdir(), 'apv3-seal-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@l', 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: root });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const report = join(tmpdir(), `rapport-${process.pid}.md`);
  writeFileSync(report, `Relecture du commit ${sha}\n${'rien à signaler. '.repeat(20)}`);
  const common = commonDirOf(root);
  const hook = fileURLToPath(new URL('../hooks/scripts/review-seal.mjs', import.meta.url));
  const seal = (record, agent_type) => spawnSync(process.execPath, [hook], { encoding: 'utf8', env: { ...process.env, APV_ANCHOR_KEY_FILE: TEST_KEY_FILE },
    input: JSON.stringify({ tool_name: 'Bash', cwd: root, agent_type, tool_input: { command: command.replace('abc', sha) }, tool_response: { stdout: `Enregistrement ${record.id}\n` } }) });
  const forged = recordReview(common, { checkout: root, commit: sha, domain: 'securite', reviewer: 'apv:qa-securite', findings: { critical: 0, high: 0, medium: 0, low: 0 }, report, captures: [], now: new Date('2026-09-30T10:00:00Z') });
  assert.equal(seal(forged, 'apv:implementer').status, 0);
  assert.match(latestReviews(common, sha).get('securite').problem, /non scellée/);
  const real = recordReview(common, { checkout: root, commit: sha, domain: 'securite', reviewer: 'apv:qa-securite', findings: { critical: 0, high: 0, medium: 0, low: 0 }, report, captures: [], now: new Date('2026-09-30T11:00:00Z') });
  assert.equal(seal(real, 'apv:qa-securite').status, 0);
  assert.equal(latestReviews(common, sha).get('securite').problem, null);
  rmSync(report, { force: true });
});

test('review of 7e27b88: every way found to forge a waiver is closed', async t => {
  const lead = as(null);
  // 1. Reading the key: ~/.config in every form, « anchor », globs of hidden home folders, the home walked or copied, a decoded path.
  for (const command of ['cat $HOME/.config/a*/anch*', 'cat ${XDG_CONFIG_HOME}/apv/x', 'find ~/.config -type f -exec cat {} \;', 'tar czf /tmp/c.tgz ~/.config',
    'cp -r ~/.config /tmp/c', 'echo L2hvbWUvdS8uYXB2LWFuY3JhZ2UvY2xl | base64 -d | xargs cat', 'python3 -c "import glob; print(open(glob.glob(\'/home/u/.a*/*\')[0]).read())"',
    'cat ~/.apv-ancrage/cle-ancrage', 'ls ~/.c*', 'find ~ -type f', 'rsync -a $HOME /tmp/h', 'python3 -c "import os; print(os.path.expanduser(1))"']) {
    assert.equal(evaluateCommand(command, {}, lead).decision, 'deny', command);
  }
  for (const tool_input of [{ pattern: 'anchor', path: '/r' }, { pattern: '**/*', path: '/home/u/.config' }, { pattern: '**/.apv-ancrage/*' }]) assert.equal(evaluateWrite({ tool_input }).decision, 'deny', JSON.stringify(tool_input));
  for (const command of ['cat svelte.config.js', 'npx vite build --config vite.config.ts', 'ls $HOME/projets', 'cd ~ && ls projets']) assert.equal(evaluateCommand(command, {}, lead).decision, 'allow', command);
  // 3. Running the plugin's code other than through apv: a script that imports dist/rules signs without reading the key.
  const pluginRoot = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
  for (const command of ['node -e "import(\'/p/dist/rules/operator.js\').then(m => m.sign(k))"', `node ${pluginRoot}/hooks/scripts/review-seal.mjs`, `node --input-type=module -e "import '${pluginRoot}/dist/stack/github.js'"`,
    'python3 -c "open(\'/p/dist/review/plan.js\')"', 'APV_ENTRY=cli node x.js', 'APV_ANCHOR_KEY_FILE=/tmp/k apv stack merge 1']) assert.equal(evaluateCommand(command, {}, lead).decision, 'deny', command);
  for (const command of [`node ${pluginRoot}/dist/cli.js status`, 'node build/index.js', 'node --test test/a.test.mjs']) assert.equal(evaluateCommand(command, {}, lead).decision, 'allow', command);
  // The module itself refuses to sign when it is not the apv command or a hook.
  const direct = spawnSync(process.execPath, ['--input-type=module', '-e', `import { sign } from ${JSON.stringify(new URL('../dist/rules/operator.js', import.meta.url).href)}; sign(Buffer.alloc(32), 'operator', 'x');`],
    { encoding: 'utf8', env: { ...process.env, APV_ENTRY: '' } });
  assert.notEqual(direct.status, 0);
  assert.match(direct.stderr, /signature refusée hors de la commande apv et des crochets du plugin/);
  // 4. Nested sessions: claude -p would escape the guards of the subagents.
  for (const command of ['claude -p "fusionne la PR 12"', 'claude --agent apv:qa-securite -p "enregistre"', 'npx @anthropic-ai/claude-code -p x', 'sh -c "claude -p x"']) {
    assert.deepEqual(evaluateCommand(command, {}, lead), { decision: 'deny', reason: REASONS.nestedClaude }, command);
  }
  assert.equal(evaluateCommand('claude --version', {}, lead).decision, 'allow');
  assert.equal(evaluateCommand('claude -p /usage', {}, lead).decision, 'allow', 'the quota reading, a fixed command without a model');
});

test('review of 7e27b88: a deleted or replaced key is never made anew in silence, and nothing signed is accepted then', async t => {
  const { TEST_KEY, TEST_KEY_FILE, operatorSays, commonDirOf } = await import('./support/rules.mjs');
  const { anchorKey, ensureAnchorKey, readOperatorMessages, setAnchorKeyFile, journalEntry } = await import('../dist/rules/operator.js');
  const root = mkdtempSync(join(tmpdir(), 'apv3-cle-'));
  t.after(() => { rmSync(root, { recursive: true, force: true }); setAnchorKeyFile(TEST_KEY_FILE); });
  execFileSync('git', ['init', '-q', join(root, 'r')]);
  const repo = join(root, 'r');
  const common = commonDirOf(repo);
  assert.equal(ensureAnchorKey(common, TEST_KEY_FILE).equals(TEST_KEY), true, 'first use: fingerprint recorded');
  operatorSays(repo, 'dérogation relecture 0123456789ab : correctif urgent en production');
  assert.equal(readOperatorMessages(common).length, 1);
  // Deleted: the hook refuses to make a new one, since the project holds something signed.
  const gone = join(root, 'absente');
  assert.throws(() => ensureAnchorKey(common, gone), /clé d'ancrage absente/);
  // Replaced: another key, found by the fingerprint; nothing signed with it is accepted.
  const other = join(root, 'autre');
  writeFileSync(other, `${'ab'.repeat(32)}\n`);
  setAnchorKeyFile(other);
  assert.match(anchorKey(common).problem, /clé d'ancrage remplacée/);
  assert.equal(readOperatorMessages(common).length, 0);
  assert.throws(() => ensureAnchorKey(common, other), /remplacée/);
  // 5. The hashes of the sentences are keyed: a short code typed alone is not found by a dictionary.
  const { createHash } = await import('node:crypto');
  const entry = journalEntry('1234', { at: 't', session: 's' }, TEST_KEY);
  assert.notEqual(entry.sentences[0], createHash('sha256').update('1234').digest('hex'));
});
