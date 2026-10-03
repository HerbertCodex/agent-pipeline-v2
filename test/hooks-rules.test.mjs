import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMPTY_CONTEXT } from '../hooks/scripts/harness-guard.mjs';
import { evaluateCommand, REASONS } from '../hooks/scripts/bash-guard.mjs';
import { evaluateWrite, WRITE_REASON } from '../hooks/scripts/write-guard.mjs';
import { isClaudeProcess, operatorEntry, sessionOrigin } from '../hooks/scripts/operator-journal.mjs';
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

test('the operator journal keeps only prompts typed in the composer (source user or tty); without source, the processes decide', () => {
  for (const source of ['user', 'tty']) assert.deepEqual(operatorEntry(prompt('Je valide la maquette', source)), { keep: { text: 'Je valide la maquette', session: 's1' } }, source);
  // Claude Code 2.1.280 sends no source: kept only when the processes above the hook show the operator's own session.
  assert.match(operatorEntry(prompt('Je valide la maquette', undefined)).refuse, /champ source absent et origine de la session non lue/);
  assert.deepEqual(operatorEntry(prompt('Je valide la maquette', undefined), { interactive: true, reason: 'x' }), { keep: { text: 'Je valide la maquette', session: 's1' } });
  assert.match(operatorEntry(prompt('Je valide la maquette', undefined), { interactive: false, reason: 'session Claude Code non interactive (-p, --print)' }).refuse, /non interactive/);
  // A source given always decides, whatever the processes say.
  assert.match(operatorEntry(prompt('Je valide', 'sdk'), { interactive: true, reason: 'x' }).refuse, /pas un message tapé/);
  assert.match(operatorEntry(prompt('Je valide', undefined, { agent_id: 'sub' }), { interactive: true, reason: 'x' }).refuse, /sous-agent/);
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
  // Claude Code without source, the hook run outside any Claude Code session (by this test): nothing kept, the reason noted.
  const outside = spawnSync(process.execPath, [hook], { input: JSON.stringify({ ...prompt('Je valide tout', undefined), cwd: root }), encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, APV_ANCHOR_KEY_FILE: keyFile } });
  assert.equal(outside.status, 0);
  if (!sessionOrigin().interactive) {
    assert.equal(readOperatorMessages(common).length, 1);
    assert.match(journalState(common).refused.reason, /champ source absent et /);
  }
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
  assert.deepEqual(sealRequest({ tool_name: 'Bash', tool_input: { command }, tool_response: out, agent_type: 'apv:qa-securite' }), { id: '20260930T101010Z-0a1b2c3d', domain: 'securite', agent: 'apv:qa-securite', commit: 'abc' });
  for (const agent_type of [undefined, 'apv:implementer', 'apv:qa-fidelite']) {
    assert.equal(sealRequest({ tool_name: 'Bash', tool_input: { command }, tool_response: out, agent_type }), null, String(agent_type));
  }
  assert.equal(sealRequest({ tool_name: 'Bash', tool_input: { command: 'apv review show --commit abc' }, tool_response: out, agent_type: 'apv:qa-securite' }), null);
  // The commit of a record comes from its folder, whatever `--commit` said (review of ffcdb9e).
  const { recordCommit } = await import('../hooks/scripts/review-seal.mjs');
  const store = mkdtempSync(join(tmpdir(), 'apv3-rc-'));
  t.after(() => rmSync(store, { recursive: true, force: true }));
  mkdirSync(join(store, 'apv', 'reviews', 'c'.repeat(40), 'securite'), { recursive: true });
  writeFileSync(join(store, 'apv', 'reviews', 'c'.repeat(40), 'securite', '20260930T101010Z-0a1b2c3d.json'), '{}');
  assert.equal(recordCommit(store, '20260930T101010Z-0a1b2c3d', 'securite'), 'c'.repeat(40));
  assert.equal(recordCommit(store, '20260930T101010Z-0a1b2c3d', 'rgpd'), null);
  assert.equal(recordCommit(store, '../x', 'securite'), null);
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
  // 1. Reading the key: its exact names, the home walked whole, hidden globs that could match its folder, a decoded path.
  for (const command of ['cat ~/.apv-ancrage/cle-ancrage', 'cat ~/.apv-ancrage/*', 'echo L2hvbWUvdS8uYXB2LWFuY3JhZ2UvY2xl | base64 -d | xargs cat',
    'python3 -c "import glob; print(open(glob.glob(\'/home/u/.a*/*\')[0]).read())"', 'ls ~/.a*', 'find ~ -type f', 'rsync -a $HOME /tmp/h', 'tar czf /tmp/h.tgz ~']) {
    assert.equal(evaluateCommand(command, {}, lead).decision, 'deny', command);
  }
  for (const tool_input of [{ pattern: '**/.apv-ancrage/*' }, { file_path: '/home/u/.apv-ancrage/cle-ancrage' }]) assert.equal(evaluateWrite({ tool_input }).decision, 'deny', JSON.stringify(tool_input));
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

test('review of 55ba279: no false blocking; the key is named exactly, ~/.config and the home directory stay reachable', () => {
  const lead = as(null);
  for (const command of ['cat src/lib/anchored-popover.svelte.ts', 'grep -rn "anchor-name" src', 'git commit -m "docs: ancrage des validations humaines"', 'cat ~/.config/gh/hosts.yml',
    'ls ~/.config', 'ls $HOME/.config/gh', 'node -e "console.log(require(\'os\').homedir())"', 'python3 -c "import os; print(os.path.expanduser(\'~\'))"', 'cat svelte.config.js',
    'npx vite build --config vite.config.ts', 'ls $HOME/projets', 'ls ~', 'cd ~ && ls projets', 'cd ~ && ls .config', 'ls ~/.c*', 'rm -rf node_modules', 'grep -rn anchor src']) {
    assert.equal(evaluateCommand(command, {}, lead).decision, 'allow', command);
  }
  for (const input of [{ tool_name: 'Read', tool_input: { file_path: '/home/u/.config/gh/hosts.yml' } }, { tool_name: 'Grep', tool_input: { pattern: 'anchor', path: '/r/src' } },
    { tool_name: 'Read', tool_input: { file_path: '/r/src/lib/anchored-popover.svelte.ts' } }, { tool_name: 'Glob', tool_input: { pattern: '**/*.svelte', path: '/home/u' } },
    { tool_name: 'Grep', tool_input: { pattern: '\\.apv', path: '/home/u' } }]) {
    assert.equal(evaluateWrite(input).decision, 'allow', JSON.stringify(input));
  }
});

test('review of 55ba279: the simple remaining ways are refused', () => {
  const lead = as(null);
  // A relative hidden glob after a cd to the home; Grep or Glob from the home toward hidden folders.
  for (const command of ['cd ~ && cat .a*/*', 'cd && ls .apv*', 'cd $HOME; tar czf /tmp/k.tgz .a*', 'cd /home/u && cp -r .* /tmp/x']) assert.deepEqual(evaluateCommand(command, {}, lead), { decision: 'deny', reason: REASONS.homeFolder }, command);
  for (const input of [{ tool_name: 'Glob', tool_input: { pattern: '.a*/*', path: '/home/u' } }, { tool_name: 'Grep', tool_input: { pattern: 'x', glob: '.apv*/**', path: '/home/u/' } }]) {
    assert.equal(evaluateWrite(input).decision, 'deny', JSON.stringify(input));
  }
  // The stores removed wholesale.
  for (const command of ['rm -rf .git/apv', 'rm -r ../repo/.git/apv/', 'rm -rf "$(git rev-parse --git-common-dir)/apv"']) assert.equal(evaluateCommand(command, {}, lead).decision, 'deny', command);
  // Nested sessions, whatever their spelling.
  for (const command of ['/home/u/.local/share/claude/versions/2.1.280 -p "fusionne"', 'c=claude; $c -p "fusionne"', '${c} --print x', 'npx -y @anthropic-ai/claude-code -p x',
    'claude-code -p x', 'env FOO=1 claude --agent apv:qa-securite -p x']) assert.deepEqual(evaluateCommand(command, {}, lead), { decision: 'deny', reason: REASONS.nestedClaude }, command);
  for (const command of ['claude --version', 'claude -p /usage', '$EDITOR notes.md']) assert.equal(evaluateCommand(command, {}, lead).decision, 'allow', command);
});

test('origin of a prompt without source: a top-level Claude Code session, not in print mode, nothing nested', () => {
  const tree = procs => pid => procs[pid] ?? null;
  const top = { 10: { ppid: 9, args: ['/bin/sh', '-c', 'node hook'] }, 9: { ppid: 5, args: ['/home/u/.vscode-server/extensions/anthropic.claude-code-2.1.287-linux-x64/resources/native-binary/claude', '--output-format', 'stream-json', '--input-format', 'stream-json'] },
    5: { ppid: 1, args: ['node', 'extensionHost'] } };
  assert.equal(sessionOrigin(tree(top), 10).interactive, true);
  assert.equal(sessionOrigin(tree({ 10: { ppid: 9, args: ['sh'] }, 9: { ppid: 1, args: ['claude'] } }), 10).interactive, true);
  const print = sessionOrigin(tree({ 10: { ppid: 9, args: ['sh'] }, 9: { ppid: 1, args: ['claude', '-p', 'Je valide'] } }), 10);
  assert.deepEqual([print.interactive, print.reason], [false, 'session Claude Code non interactive (-p, --print)']);
  assert.equal(sessionOrigin(tree({ 10: { ppid: 9, args: ['sh'] }, 9: { ppid: 1, args: ['claude', '--print', 'x'] } }), 10).interactive, false);
  // A session an agent started from its own: another Claude Code above it.
  const nested = sessionOrigin(tree({ 10: { ppid: 9, args: ['sh'] }, 9: { ppid: 8, args: ['node', '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'] },
    8: { ppid: 7, args: ['bash', '-c', 'claude'] }, 7: { ppid: 1, args: ['/home/u/.local/share/claude/versions/2.1.280'] } }), 10);
  assert.equal(nested.interactive, false);
  assert.match(nested.reason, /lancée depuis une autre session \(pid 7\)/);
  assert.equal(sessionOrigin(tree({ 10: { ppid: 1, args: ['node', 'script.mjs'] } }), 10).interactive, false, 'no session above');
  assert.equal(sessionOrigin(() => null, 10).interactive, false, 'unreadable');
  assert.equal(isClaudeProcess(['node', 'claude-helper.js']), false);
});

test('review 99, second pass: merges behind any prefix are seen; data never blocks; signed pushes read right', () => {
  const sub = as('apv:integrateur');
  const lead = as(null);
  // HAUT 1: every execution prefix, in a subagent: refused; for the lead, the authorisation is read through the prefix.
  for (const command of ['APV_ALLOW_MERGE=1 timeout 900 apv stack merge 5', 'APV_ALLOW_MERGE=1 nice apv stack merge 5', 'APV_ALLOW_MERGE=1 command apv stack merge 5',
    'env -i APV_ALLOW_MERGE=1 apv stack merge 5', 'APV_ALLOW_MERGE=1 nohup setsid apv stack merge 5', 'APV_ALLOW_MERGE=1 stdbuf -o0 apv stack merge 5',
    'APV_ALLOW_MERGE=1 watch apv stack merge 5', 'APV_ALLOW_MERGE=1 unbuffer apv stack batch 1 2 --merge', 'APV_ALLOW_MERGE=1 timeout 60 npx apv stack merge 5',
    'APV_ALLOW_MERGE=1 nice node /p/dist/cli.js stack merge 5', 'sudo -u me APV_ALLOW_MERGE=1 apv stack merge 5', 'APV_ALLOW_MERGE=1 xargs apv stack merge < prs']) {
    assert.deepEqual(evaluateCommand(command, {}, sub), { decision: 'deny', reason: REASONS.mergeBySubagent }, command);
  }
  for (const command of ['nice apv stack merge 5', 'timeout 900 apv stack merge 5', 'env -i apv stack merge 5', 'watch apv stack merge 5']) {
    assert.deepEqual(evaluateCommand(command, {}, lead), { decision: 'deny', reason: REASONS.merge }, `${command} without APV_ALLOW_MERGE=1`);
  }
  for (const command of ['APV_ALLOW_MERGE=1 timeout 900 apv stack merge 5', 'env -i APV_ALLOW_MERGE=1 apv stack merge 5', 'timeout 900 env APV_ALLOW_MERGE=1 apv stack merge 5']) {
    assert.equal(evaluateCommand(command, {}, lead).decision, 'allow', command);
  }
  // Text that names apv is not a run of it.
  for (const command of ['echo apv stack merge 5', 'grep -rn "apv stack merge" docs', 'cp apv /tmp/x', 'git log --grep "apv stack merge"']) {
    assert.equal(evaluateCommand(command, {}, sub).decision, 'allow', command);
  }
  // A reviewer behind a prefix is still recognised, a record with its options first too.
  assert.equal(evaluateCommand(`timeout 60 ${record('securite', 'apv:qa-securite')}`, {}, as('apv:qa-securite')).decision, 'allow');
  assert.equal(evaluateCommand(`timeout 60 ${record('securite', 'apv:implementer')}`, {}, as('apv:implementer')).decision, 'deny');
  assert.equal(evaluateCommand('apv review --domain securite record --commit abc --reviewer apv:implementer', {}, as('apv:implementer')).decision, 'deny');
  // MOYEN 3: a message or a PR body that cites the stores is data; what runs is still read.
  for (const command of ['git commit -m "feat(apv): reviews enregistrées sous apv/reviews"', 'git commit -m"apv/operator"',
    `gh pr create --title t --body "$(cat <<'EOF'\nLes magasins apv/operator et apv/reviews\nEOF\n)"`, 'gh pr edit 3 --body="apv/reviews"',
    'cat > rapport.md <<EOF\nconstat sur apv/reviews\nEOF', 'cat logs/messages.jsonl']) {
    assert.equal(evaluateCommand(command, {}, lead).decision, 'allow', command);
  }
  for (const command of ['git commit -m "$(cat .git/apv/reviews/abc/x.json)"', 'gh pr create --body "`cat .git/apv/operator/messages.jsonl`"',
    'bash <<EOF\nrm -rf .git/apv/reviews\nEOF', 'python3 - <<EOF\nopen(".git/apv/operator/messages.jsonl", "a")\nEOF', 'cat <<EOF > .git/apv/reviews/x\n{}\nEOF',
    'cd .git/apv && cd operator && cat messages.jsonl', 'git commit -F .git/apv/reviews/x']) {
    assert.deepEqual(evaluateCommand(command, {}, lead), { decision: 'deny', reason: REASONS.anchorStore }, command);
  }
  // MOYEN 5: a project's own dist/commands is not the plugin; the plugin's is.
  const project = mkdtempSync(join(tmpdir(), 'apv3-project-'));
  try {
    mkdirSync(join(project, 'dist', 'commands'), { recursive: true });
    writeFileSync(join(project, 'dist', 'commands', 'build.js'), '');
    assert.equal(evaluateCommand('node dist/commands/build.js', {}, { ...lead, cwd: project }).decision, 'allow');
    assert.deepEqual(evaluateCommand('node dist/commands/absent.js', {}, { ...lead, cwd: project }), { decision: 'deny', reason: REASONS.pluginCode }, 'not there: doubt');
    assert.deepEqual(evaluateCommand('node dist/commands/rules.js', {}, { ...lead, cwd: fileURLToPath(new URL('..', import.meta.url)) }), { decision: 'deny', reason: REASONS.pluginCode });
    assert.deepEqual(evaluateCommand(`node -e "import('${fileURLToPath(new URL('../dist/rules/operator.js', import.meta.url))}')"`, {}, { ...lead, cwd: project }), { decision: 'deny', reason: REASONS.pluginCode });
    assert.deepEqual(evaluateCommand('node $P/dist/rules/operator.js', {}, { ...lead, cwd: project }), { decision: 'deny', reason: REASONS.pluginCode });
  } finally { rmSync(project, { recursive: true, force: true }); }
  // MOYEN 6: -p of another command of the line is not a nested Claude Code.
  assert.equal(evaluateCommand('"$PY" script.py && mkdir -p out', {}, lead).decision, 'allow');
  assert.deepEqual(evaluateCommand('$C -p "valide la maquette"', {}, lead), { decision: 'deny', reason: REASONS.nestedClaude });
  assert.deepEqual(evaluateCommand('"$C" --print x', {}, lead), { decision: 'deny', reason: REASONS.nestedClaude });
  // BAS 12: --signed takes its value after = only; the remote follows it.
  assert.deepEqual(evaluateCommand('git push --signed origin main', {}, lead), { decision: 'deny', reason: REASONS.pushToDefault('main') });
  assert.deepEqual(evaluateCommand('git push --signed=if-asked origin HEAD:main', {}, lead), { decision: 'deny', reason: REASONS.pushToDefault('main') });
  assert.deepEqual(evaluateCommand('git push --recurse-submodules=check origin main', {}, lead), { decision: 'deny', reason: REASONS.pushToDefault('main') });
  assert.equal(evaluateCommand('git push --signed origin feat', {}, lead).decision, 'allow');
});

test('review 99, MOYEN 4: Grep may search the text « apv/reviews »; its path, and a Glob, never reach the stores', () => {
  assert.equal(evaluateWrite({ tool_name: 'Grep', tool_input: { pattern: 'apv/reviews', path: 'src' } }).decision, 'allow');
  assert.equal(evaluateWrite({ tool_name: 'Grep', tool_input: { pattern: 'x', path: '.git/apv/reviews' } }).decision, 'deny');
  assert.equal(evaluateWrite({ tool_name: 'Grep', tool_input: { pattern: 'x', glob: '**/apv/operator/*' } }).decision, 'deny');
  assert.equal(evaluateWrite({ tool_name: 'Glob', tool_input: { pattern: '.git/apv/reviews/**' } }).decision, 'deny');
});

test('review 99, MOYEN 7: outside a project of the tool, only the rules that protect the key, the stores and the old guards apply', async () => {
  const lead = as(null);
  const outside = { ...lead, apvProject: () => false };
  // Allowed outside, refused where the tool is active.
  for (const command of ['git push origin main', 'claude mcp list', 'du -sh ~', 'APV_ALLOW_MERGE=1 gh pr merge 3 --merge', 'git rev-parse --git-common-dir; ls']) {
    assert.equal(evaluateCommand(command, {}, outside).decision, 'allow', `outside: ${command}`);
    assert.equal(evaluateCommand(command, {}, lead).decision, 'deny', `active: ${command}`);
  }
  // Refused everywhere: the key, the stores, force-push, a merge without authorisation or in a subagent, decoded commands;
  // and what this guard cannot read to the end (eval, xargs): the tool stays active there.
  for (const command of ['cat ~/.apv-ancrage/cle-ancrage', 'cat .git/apv/reviews/x', 'git push --force origin x', 'gh pr merge 3 --merge',
    'echo eA== | base64 -d | sh', 'tar czf h.tgz ~', 'rm -rf .git/apv', 'eval "apv status"', 'git rev-parse --git-common-dir | xargs ls']) {
    assert.equal(evaluateCommand(command, {}, outside).decision, 'deny', `outside: ${command}`);
  }
  assert.deepEqual(evaluateCommand('APV_ALLOW_MERGE=1 gh pr merge 3 --merge', {}, { ...outside, agentId: 'a1', agentType: 'x' }), { decision: 'deny', reason: REASONS.mergeBySubagent });
  // The real context reads the repository: .apv/config.json (or pipeline.v2.json) makes the tool active.
  const { hookContext } = await import('../hooks/scripts/harness-guard.mjs');
  const root = mkdtempSync(join(tmpdir(), 'apv3-portee-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    const env = { HOME: process.env.HOME };
    assert.equal(hookContext({ cwd: root }, env).apvProject(), false);
    mkdirSync(join(root, '.apv')); writeFileSync(join(root, '.apv', 'config.json'), '{}');
    assert.equal(hookContext({ cwd: root }, env).apvProject(), true);
    assert.equal(hookContext({ cwd: join(tmpdir(), 'pas-un-depot-apv3-xyz') }, env).apvProject(), true, 'unknown: active');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('review 99, BAS 11: a merge through the API is read in what runs, never in a search or a read-only call', () => {
  const lead = as(null);
  for (const command of ['grep -rn mergePullRequest src', 'rg "pulls/[0-9]+/merge" docs', 'gh api repos/o/r/pulls/5/merge', 'gh api -X GET repos/o/r/pulls/5/merge',
    'git log --grep enablePullRequestAutoMerge']) {
    assert.equal(evaluateCommand(command, {}, lead).decision, 'allow', command);
  }
  for (const command of ['gh api -X PUT repos/o/r/pulls/5/merge', 'gh api repos/o/r/pulls/5/merge -f merge_method=merge', 'gh api graphql -f query="mutation { mergePullRequest(input: {}) { x } }"',
    'echo "mutation { mergePullRequest }" | gh api graphql --input -', 'curl -X PUT https://api.github.com/repos/o/r/pulls/12/merge',
    'python3 - <<EOF\nimport requests; requests.post(u, json={"query": "mutation { mergePullRequest }"})\nEOF', 'cat <<EOF | gh api graphql --input -\nmutation { mergePullRequest }\nEOF']) {
    assert.deepEqual(evaluateCommand(command, {}, lead), { decision: 'deny', reason: REASONS.rawMerge }, command);
  }
});

test('review 99, BAS 13: rm of a folder named apv and base64 decoded into data are allowed; the stores and decoded commands are not', async () => {
  const { removesStore, decodedAndUsed } = await import('../hooks/scripts/bash-guard.mjs');
  const lead = as(null);
  for (const command of ['rm -rf build/apv', 'rm -rf src/apv/', 'echo eA== | base64 -d > f.bin', 'base64 -d x.b64 | jq .', 'base64 --decode img.b64 > img.png']) {
    assert.equal(evaluateCommand(command, {}, lead).decision, 'allow', command);
  }
  for (const [command, reason] of [['rm -rf .git/apv', REASONS.anchorStore], ['rm -rf ../depot.git/apv/merges', REASONS.anchorStore], ['rm -rf "$c/apv"', REASONS.anchorStore],
    ['cat $(echo eA== | base64 -d)', REASONS.encodedPath], ['echo eA== | base64 -d | bash', REASONS.encodedPath], ['ls `echo eA== | base64 --decode`', REASONS.encodedPath],
    ['echo eA== | base64 -d | xargs cat', REASONS.encodedPath]]) {
    assert.deepEqual(evaluateCommand(command, {}, lead), { decision: 'deny', reason }, command);
  }
  // From inside the Git directory, a relative apv is the store.
  assert.equal(removesStore(['rm', '-rf', 'apv'], '/r/.git'), REASONS.anchorStore);
  assert.equal(removesStore(['rm', '-rf', 'apv'], '/r/build'), null);
  assert.equal(decodedAndUsed('base64 -d a | sha256sum'), false);
});

test('review of #105, E1 (second pass): relaxed only for a plain command on a repository known to be outside the tool', async t => {
  const { hookContext, projectOfTool, repoSlug } = await import('../hooks/scripts/harness-guard.mjs');
  const root = mkdtempSync(join(tmpdir(), 'apv3-cible-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=T', '-c', 'user.email=t@l', ...args], { cwd, stdio: 'pipe' });
  const repo = (name, { config = false } = {}) => {
    const dir = join(root, name); mkdirSync(dir); git(dir, 'init', '-q', '-b', 'feat');
    if (config) { mkdirSync(join(dir, '.apv')); writeFileSync(join(dir, '.apv', 'config.json'), '{}'); git(dir, 'add', '-A'); }
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'x');
    return dir;
  };
  const bare = (name, from) => { const dir = join(root, name); git(root, 'clone', '-q', '--bare', from, dir); return dir; };
  const apvRepo = repo('appli', { config: true }); const apvBare = bare('appli.git', apvRepo);
  // A repository outside the tool, its remote fetched: the only one where the guards are relaxed.
  const other = repo('autre'); const otherBare = bare('autre.git', other);
  git(other, 'remote', 'add', 'origin', otherBare); git(other, 'fetch', '-q', 'origin');
  const env = { HOME: root };
  const contextOf = (cwd, extra = {}) => ({ ...hookContext({ cwd }, env), ...extra });
  assert.equal(projectOfTool(other), false);
  for (const command of ['git push origin main', 'git push origin HEAD:main', 'APV_ALLOW_MERGE=1 gh pr merge 3', `cd ${other} && git push origin main`, 'claude mcp list']) {
    assert.equal(evaluateCommand(command, {}, contextOf(other)).decision, 'allow', command);
  }
  assert.deepEqual(evaluateCommand('gh pr merge 3', {}, contextOf(other)), { decision: 'deny', reason: REASONS.mergeOutside });
  // Every form the second review found, and those of the first: active, so refused.
  for (const command of ['APV_ALLOW_MERGE=1 gh pr merge https://github.com/acme/apvproj/pull/5', `git -C${apvRepo} push origin main`, `env -C ${apvRepo} git push origin main`,
    `env --chdir=${apvRepo} git push origin main`, `sudo -D ${apvRepo} git push origin main`, `export GIT_DIR=${apvRepo}/.git; git push origin main`,
    `cd ${apvRepo} && sh -c "git push origin main"`, `cd ${apvRepo} && bash -lc "git push origin main"`, `cd ${apvRepo} && eval "git push origin main"`,
    `cd ${apvRepo} && bash <<< "git push origin main"`, `cd ${apvRepo} && bash <<X\ngit push origin main\nX`, `cd $(echo ${apvRepo}) && git push origin main`,
    `pushd \`echo ${apvRepo}\` && git push origin main`, `CDPATH=${root} cd appli && git push origin main`, `git -c remote.x.url=${apvBare} push x HEAD:main`,
    `git config remote.z.url ${apvBare} && git push z HEAD:main`, `git push ${apvBare} HEAD:main`, 'git push https://github.com/acme/apvproj.git HEAD:main',
    'APV_ALLOW_MERGE=1 gh pr merge 187 -R acme/apvproj', 'GH_REPO=acme/apvproj APV_ALLOW_MERGE=1 gh pr merge 187', `git -C ${apvRepo} push origin HEAD:main`,
    `cd ${apvRepo} && APV_ALLOW_MERGE=1 gh pr merge 187`, `git --git-dir=${apvRepo}/.git push origin HEAD:main`, 'git remote add x https://github.com/acme/apvproj && git push x HEAD:main',
    `cd ${apvRepo} && claude -p x`, `cat "$(git -C ${apvRepo} rev-parse --git-common-dir)"/apv/rev*/*`, 'APV_ALLOW_MERGE=1 gh api graphql -f query="mutation { mergePullRequest(input: {}) { x } }"',
    'xargs git push origin main < remotes', 'watch git push origin main', 'cd "$X" && git push origin main']) {
    assert.equal(evaluateCommand(command, {}, contextOf(other)).decision, 'deny', command);
  }
  assert.equal(evaluateCommand('git push origin main', { GIT_DIR: `${apvRepo}/.git` }, contextOf(other)).decision, 'deny', 'GIT_DIR in the environment');
  // A remote that points to a project of the tool, or that cannot be checked: never « itself ».
  const mixed = repo('mixte'); git(mixed, 'remote', 'add', 'origin', otherBare); git(mixed, 'fetch', '-q', 'origin');
  git(mixed, 'remote', 'add', 'apv', apvBare);
  assert.equal(evaluateCommand('git push apv HEAD:main', {}, contextOf(mixed)).decision, 'deny', 'remote never fetched');
  assert.equal(evaluateCommand('APV_ALLOW_MERGE=1 gh pr merge 3', {}, contextOf(mixed)).decision, 'deny', 'gh may pick that remote');
  git(mixed, 'fetch', '-q', 'apv');
  assert.equal(projectOfTool(mixed), true, 'a fetched branch carries the configuration');
  const pushElsewhere = repo('pushurl'); git(pushElsewhere, 'remote', 'add', 'origin', otherBare); git(pushElsewhere, 'fetch', '-q', 'origin');
  git(pushElsewhere, 'config', 'remote.origin.pushurl', apvBare);
  assert.equal(evaluateCommand('git push origin HEAD:main', {}, contextOf(pushElsewhere)).decision, 'deny', 'pushurl elsewhere');
  const fresh = repo('neuf'); git(fresh, 'remote', 'add', 'origin', otherBare);
  assert.equal(evaluateCommand('git push origin main', {}, contextOf(fresh)).decision, 'deny', 'never fetched: unknown');
  // S2: marks a commit does not take away. The configuration removed by a commit, no origin/HEAD: another branch keeps it.
  git(apvRepo, 'switch', '-q', '-c', 'sans'); git(apvRepo, 'rm', '-q', '-r', '.apv'); git(apvRepo, 'commit', '-qm', 'retire');
  assert.equal(existsSync(join(apvRepo, '.apv')), false);
  assert.equal(projectOfTool(apvRepo), true, 'feat still declares it');
  assert.deepEqual(evaluateCommand('git push origin HEAD:main', {}, contextOf(apvRepo)), { decision: 'deny', reason: REASONS.pushToDefault('main') });
  git(apvRepo, 'switch', '-q', '--detach'); git(apvRepo, 'branch', '-q', '-D', 'feat', 'sans');
  assert.equal(projectOfTool(apvRepo), false, 'no mark left at all');
  mkdirSync(join(apvRepo, '.git', 'apv'));
  assert.equal(projectOfTool(apvRepo), true, 'the stores of the tool mark it');
  // S3: no repository at all, neither the working directory nor the project of the session: active.
  const loose = join(root, 'libre'); mkdirSync(loose);
  assert.equal(hookContext({ cwd: loose }, { HOME: root, CLAUDE_PROJECT_DIR: loose }).apvProject({ plain: true, dirs: [], remotes: [], slugs: [] }), true);
  assert.equal(repoSlug('https://github.com/HerbertCodex/suivie.git'), 'herbertcodex/suivie');
  assert.equal(repoSlug('git@github.com:Moi/Autre.git'), 'moi/autre');
});

test('review of #105, F5 and D3: the authorisation goes on the merging command; the store folder is reached by no redirection, dd, chmod, sed -i or script', () => {
  const lead = { ...as(null), cwd: '/r' };
  const outside = { ...lead, apvProject: () => false };
  assert.equal(evaluateCommand('echo APV_ALLOW_MERGE=1 ; curl -X PUT https://api.github.com/repos/moi/autre/pulls/1/merge', {}, outside).decision, 'deny');
  assert.equal(evaluateCommand('APV_ALLOW_MERGE=1 curl -X PUT https://api.github.com/repos/moi/autre/pulls/1/merge', {}, outside).decision, 'allow');
  for (const command of [`find .git/apv -type f -exec sh -c 'rm "$0"' {} \\;`, ': > .git/apv/receipts/x.json', 'echo x >.git/apv/receipts/x.json', 'dd if=/dev/null of=.git/apv/receipts/x.json',
    'chmod -R 000 .git/apv', 'install -m 600 /dev/null .git/apv/receipts/x.json', 'sed -i d .git/apv/receipts/x.json', `python3 -c "import shutil; shutil.rmtree('.git/apv')"`,
    `node -e "require('fs').rmSync('.git/apv',{recursive:true})"`, 'd=.git/ap; rm -rf ${d}v']) {
    assert.deepEqual(evaluateCommand(command, {}, lead), { decision: 'deny', reason: REASONS.anchorStore }, command);
  }
  for (const command of ['echo x > build/apv/x', 'sed -i s/a/b/ src/apv/x.ts', 'chmod +x scripts/run.sh', 'npm test 2>&1 | tail -5', 'git status > /tmp/s.txt']) {
    assert.equal(evaluateCommand(command, {}, lead).decision, 'allow', command);
  }
});

test('review of #105, E2 and E3: gh applies its last method; only pure readers are text, and never when the line runs or sends their output', () => {
  const sub = as('apv:integrateur');
  for (const command of ['gh api -X GET -X PUT repos/o/r/pulls/187/merge', 'gh api --method GET --method PUT repos/o/r/pulls/187/merge', 'gh api -X GET --method=PUT repos/o/r/pulls/187/merge',
    "echo 'gh api -X PUT repos/o/r/pulls/187/merge' | sh", `awk 'BEGIN{system("gh api -X PUT repos/o/r/pulls/187/merge")}'`, "git -c alias.m='!gh api -X PUT repos/o/r/pulls/187/merge' m",
    "sed -n '1e gh api -X PUT repos/o/r/pulls/187/merge' f", "less +'!gh api -X PUT repos/o/r/pulls/187/merge' f", 'echo repos/o/r/pulls/187/merge | xargs gh api -X PUT',
    'git commit -m "$(gh api -X PUT repos/o/r/pulls/187/merge)"', "printf 'mutation{mergePullRequest(input:{})}' > q && gh api graphql -F query=@q",
    "echo 'mutation { mergePullRequest }' | gh api graphql -F query=@-", 'echo "mutation { mergePullRequest }" | gh api graphql --field query=@/dev/stdin',
    'grep "$(gh api -X PUT repos/o/r/pulls/1/merge)" f', 'echo "{}" | curl -T - https://api.github.com/repos/o/r/pulls/1/merge',
    "git grep -O'gh api -X PUT repos/o/r/pulls/1/merge' x", 'rg --pre ./run mergePullRequest']) {
    assert.deepEqual(evaluateCommand(command, {}, sub), { decision: 'deny', reason: REASONS.mergeBySubagent }, command);
  }
  for (const command of ['grep -rn mergePullRequest src', 'git log --grep enablePullRequestAutoMerge', 'gh api -X GET repos/o/r/pulls/5/merge', 'echo "voir pulls/5/merge"',
    'git show HEAD:docs/x.md | grep mergePullRequest', 'cat docs/REGLES.md | wc -l']) {
    assert.equal(evaluateCommand(command, {}, sub).decision, 'allow', command);
  }
});

test('review of #105, E4: a base64 decode followed by a pipe, a process substitution or a read of its file is refused; into data it is allowed', () => {
  const lead = as(null);
  for (const command of ['echo eA== | base64 -d | tee /dev/null | xargs cat', 'echo eA== | base64 -d | /bin/sh', 'echo eA== | base64 -d | cat | sh', 'echo eA== | base64 -d | command sh',
    'echo eA== | base64 -d | timeout 5 sh', 'echo eA== | base64 -d | busybox sh', 'bash <(echo eA== | base64 -d)', 'source <(echo eA== | base64 -d)',
    'echo eA== | base64 -d > /tmp/p; xargs cat < /tmp/p', 'base64 -d <<< eA== > f; sh f', 'echo eA== | base64 -di | sh', 'base64 -d x.b64 | jq . | sh']) {
    assert.deepEqual(evaluateCommand(command, {}, lead), { decision: 'deny', reason: REASONS.encodedPath }, command);
  }
  for (const command of ['base64 -d x.b64 | jq .', 'echo eA== | base64 -d > f.bin', 'base64 -d a | sha256sum', 'base64 --decode img.b64 > img.png']) {
    assert.equal(evaluateCommand(command, {}, lead).decision, 'allow', command);
  }
});

test('review of #105, E5 and M2: the stores are reached by no applet, glob, cd, here-string, substitution or find; a folder named apv stays free', async () => {
  const { globMayMatch } = await import('../hooks/scripts/bash-guard.mjs');
  const lead = { ...as(null), cwd: '/r' };
  const outside = { ...lead, apvProject: () => false };
  for (const command of ['busybox rm -rf .git/apv', 'rm -rf .gi?/apv', 'rm -rf .gi[t]/apv', 'rm -rf .git/ap*', 'rm -rf .git/*', 'mv .git/apv /tmp/x', 'cd .git && rm -rf ./apv',
    "sh -c 'cd .git && rm -rf ./apv'", 'xargs rm -rf <<< .git/apv', 'echo .git/apv | xargs rm -rf', '\\rm -r ../depot.git/apv', 'find .git -name apv -exec rm -rf {} +',
    'find . -name apv -delete', 'cat .git/apv/rev*/*', 'truncate -s0 .git/apv/op*/*', 'cp .git/apv/me*/* /tmp/']) {
    assert.deepEqual(evaluateCommand(command, {}, lead), { decision: 'deny', reason: REASONS.anchorStore }, command);
    assert.equal(evaluateCommand(command, {}, outside).decision, 'deny', `outside: ${command}`);
  }
  for (const command of ['rm -rf $(git -C ~/p rev-parse --git-common-dir)/apv', 'rm -rf `git rev-parse --git-common-dir`/apv']) {
    assert.equal(evaluateCommand(command, {}, outside).decision, 'deny', `outside: ${command}`);
  }
  for (const command of ['rm -rf build/apv', 'rm -rf src/apv/', "find . -name '*.tmp' -delete", 'cp -r docs /tmp/docs', 'ls .git', 'rm -rf .git/hooks/pre-commit']) {
    assert.equal(evaluateCommand(command, {}, lead).decision, 'allow', command);
  }
  assert.equal(globMayMatch('*.git', '.git', false), true);
  assert.equal(globMayMatch('.gi?', '.git', false), true);
  assert.equal(globMayMatch('src', '.git', false), false);
  assert.equal(globMayMatch('a[pq]v', 'apv'), true);
  assert.equal(globMayMatch('a[!p]v', 'apv'), false);
});

test('review of #105: the seal goes to the repository where apv review record wrote, not to the directory of the session', async () => {
  const { recordDirectories } = await import('../hooks/scripts/review-seal.mjs');
  const rec = 'apv review record --commit abc --domain securite --reviewer apv:qa-securite --report r.md';
  assert.deepEqual(recordDirectories(`cd /copie && ${rec}`, '/session'), ['/copie', '/session']);
  assert.deepEqual(recordDirectories(`${rec} --repo ../outil`, '/s/appli'), ['/s/outil', '/s/appli']);
  assert.deepEqual(recordDirectories(`cd /c && ${rec} --repo=sous`, '/s'), ['/c/sous', '/s']);
  assert.deepEqual(recordDirectories(rec, '/s'), ['/s']);
  assert.deepEqual(recordDirectories(`apv status && cd /r/b && ${rec}`, '/s'), ['/r/b', '/s'], 'the record, not the first call of the tool');
});

test('review of 440d57d: no false block on computed paths and quoted text; tee, sort -o, awk reach no store; a push is judged on the branch of its folder', async t => {
  const lead = { ...as(null), cwd: '/r' };
  // N1, N7: commands that passed before stay free.
  for (const command of ['rm -rf "$tmp" && git clone https://github.com/o/r.git "$tmp"', 'mv "$f" dist/ && cat .git/HEAD', 'chmod +x "$script" && git commit -m "fix .git hooks"',
    "grep -c '>' .git/apv/receipts/x.json", 'rm -rf "$HOME/apps/x"']) {
    assert.equal(evaluateCommand(command, {}, lead).decision, 'allow', command);
  }
  // N6: writes by other commands, and a path made of several pieces set by the line.
  for (const command of ['echo x | tee .git/apv/receipts/x.json', 'sort -o .git/apv/receipts/x.json f', 'curl -o .git/apv/receipts/x.json https://e.x',
    `awk 'BEGIN{system("rm -rf .git/apv")}'`, 'd=.gi; e=ap; rm -rf ${d}t/${e}v', 'exec 3> .git/apv/receipts/x.json', 'echo x > ".git/apv/receipts/x.json"']) {
    assert.deepEqual(evaluateCommand(command, {}, lead), { decision: 'deny', reason: REASONS.anchorStore }, command);
  }
  // Fidélité 1: only the variables of git that change where it acts or its configuration keep the tool active.
  const { commandScope, tokenize } = await import('../hooks/scripts/bash-guard.mjs');
  const plain = command => commandScope(command, tokenize(command).segments, '/r', null, {}).plain;
  assert.equal(plain('GIT_SSH_COMMAND=ssh git push origin main'), false);
  assert.equal(plain('GIT_TERMINAL_PROMPT=0 git push origin main'), true);
  assert.equal(commandScope('git push origin main', tokenize('git push origin main').segments, '/r', null, { GITHUB_TOKEN: 'x' }).plain, true);
  // Fidélité 3: outside the tool, a refusal says why the tool stays active there.
  const outsideRepo = { ...lead, apvProject: scope => scope.remotes?.length > 0 };
  assert.match(evaluateCommand('git push origin main', {}, outsideRepo).reason, /n'est pas un projet APV, mais l'outil reste actif/);
  // Journal, lesson 11: `cd <worktree> && git push` is judged on the branch of that worktree, not on the session's.
  const { hookContext } = await import('../hooks/scripts/harness-guard.mjs');
  const root = mkdtempSync(join(tmpdir(), 'apv3-branche-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=T', '-c', 'user.email=t@l', ...args], { cwd, stdio: 'pipe' });
  const main = join(root, 'principal'); mkdirSync(main); git(main, 'init', '-q', '-b', 'main');
  mkdirSync(join(main, '.apv')); writeFileSync(join(main, '.apv', 'config.json'), '{}'); git(main, 'add', '-A'); git(main, 'commit', '-qm', 'x');
  const worktree = join(root, 'copie'); git(main, 'worktree', 'add', '-q', '-b', 'feat', worktree);
  const context = hookContext({ cwd: main }, { HOME: root });
  assert.equal(evaluateCommand(`cd ${worktree} && git push`, {}, context).decision, 'allow', 'the branch of the worktree');
  assert.equal(evaluateCommand(`git -C ${worktree} push`, {}, context).decision, 'allow');
  assert.deepEqual(evaluateCommand('git push', {}, context), { decision: 'deny', reason: REASONS.pushToDefault('main') });
  assert.deepEqual(evaluateCommand('cd "$X" && git push', {}, context), { decision: 'deny', reason: REASONS.pushToDefault('main') }, 'unknown folder');
});

test('review of 4dc674e: a failed cd leaves the push on main; quoted redirections, grouped options, .github and HOME are read right', async t => {
  const { hookContext } = await import('../hooks/scripts/harness-guard.mjs');
  const root = mkdtempSync(join(tmpdir(), 'apv3-cd-rate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=T', '-c', 'user.email=t@l', ...args], { cwd, stdio: 'pipe' });
  const main = join(root, 'principal'); mkdirSync(main); git(main, 'init', '-q', '-b', 'main');
  mkdirSync(join(main, '.apv')); writeFileSync(join(main, '.apv', 'config.json'), '{}'); git(main, 'add', '-A'); git(main, 'commit', '-qm', 'x');
  const feat = join(root, 'copie'); git(main, 'worktree', 'add', '-q', '-b', 'feat', feat);
  writeFileSync(join(root, 'fichier'), '');
  // From the checkout on main: ÉLEVÉ 1, the shell stays there when the cd fails; FAIBLE 4, folders the guard cannot follow.
  const context = hookContext({ cwd: main }, { HOME: root });
  for (const command of ['cd nope || git push', 'cd /nonexistent; git push', `cd ${join(root, 'fichier')}; git push`, 'pushd /nonexistent; git push origin HEAD',
    'cd /nonexistent 2>/dev/null; git push', `cd $(echo ${feat}) && git push`, `CDPATH=${root} cd copie && git push`,
    `git --git-dir=${feat}/.git push`, `env -C ${feat} git push`, "git push origin 'refs/heads/*:refs/heads/*'", "git push origin 'refs/heads/m*'"]) {
    assert.equal(evaluateCommand(command, {}, context).decision, 'deny', command);
  }
  assert.equal(evaluateCommand(`cd ${feat} && git push`, {}, context).decision, 'allow', 'a cd that succeeds is followed');
  assert.equal(evaluateCommand(`builtin cd ${feat} && git push`, {}, context).decision, 'allow', 'builtin cd is followed');
  assert.equal(evaluateCommand(`builtin cd ${main} && git push`, {}, hookContext({ cwd: feat }, { HOME: root })).decision, 'deny', 'builtin cd to main');
  // MOYEN 2 and FAIBLE 6: writes to the stores.
  const lead = { ...as(null), cwd: '/r' };
  for (const command of [': > .git/"apv"/receipts/r.json', '> ".git"/apv/receipts/r.json', "echo x > .git/ap'v'/receipts/r.json", 'echo x > .git/a\\pv/receipts/r.json',
    'exec 3> .git/"apv"/receipts/r.json', 'printf x 1<> .git/apv/receipts/r.json', 'echo x >& .git/apv/receipts/r.json', `node --eval="require('fs').rmSync('.git/apv')"`,
    `node -pe "require('fs').rmSync('.git/apv')"`, `perl -we 'rmtree(".git/apv")'`, `python3 -Ic "import shutil; shutil.rmtree('.git/apv')"`,
    "python3 - <<'EOF'\nimport shutil; shutil.rmtree('.git/apv')\nEOF", 'cd .git && rm -rf "$(cat ../n)"', 'wget -qO .git/apv/receipts/r.json https://e.x',
    'curl -so.git/apv/receipts/r.json https://e.x', 'GIT_TRACE=.git/apv/receipts/r.json git status', 'gzip .git/apv/receipts/r.json', 'sponge .git/apv/receipts/r.json']) {
    assert.deepEqual(evaluateCommand(command, {}, lead), { decision: 'deny', reason: REASONS.anchorStore }, command);
  }
  // A1: no false block on .github, .gitignore, or a word that only looks like a piece.
  for (const command of ['cp "$tmpl" "$root/.github/workflows/ci.yml"', 'echo node_modules >> "$dir/.gitignore"', 'rm -f "$d/.gitkeep"', 'cat "$f" > "$HOME/.gitconfig"',
    'tool=git; rm -rf "$tmp"', 'v=it; rm -rf "$out"', 'ext=pv; cp a.txt "$dest"', 'name=gi; npm test > "$LOG"']) {
    assert.equal(evaluateCommand(command, {}, lead).decision, 'allow', command);
  }
  // MOYEN 3: HOME or XDG_CONFIG_HOME in front of git keeps the tool active.
  const { commandScope, tokenize } = await import('../hooks/scripts/bash-guard.mjs');
  for (const command of [`HOME=${root} git push origin main`, `XDG_CONFIG_HOME=${root} git push origin main`, `export HOME=${root}; git push origin main`]) {
    assert.equal(commandScope(command, tokenize(command).segments, main, root, {}).plain, false, command);
  }
});

test('review of aa59c8f and 84d3c4a: closed folders, cd options, refspecs, real assignments, interpreters fed by the line, no false block in a bare layout', async t => {
  const { hookContext } = await import('../hooks/scripts/harness-guard.mjs');
  const { commandScope, tokenize } = await import('../hooks/scripts/bash-guard.mjs');
  const root = mkdtempSync(join(tmpdir(), 'apv3-fin-'));
  t.after(() => { execFileSync('chmod', ['-R', 'u+rwx', root]); rmSync(root, { recursive: true, force: true }); });
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=T', '-c', 'user.email=t@l', ...args], { cwd, stdio: 'pipe' });
  const main = join(root, 'principal'); mkdirSync(main); git(main, 'init', '-q', '-b', 'main');
  mkdirSync(join(main, '.apv')); writeFileSync(join(main, '.apv', 'config.json'), '{}'); git(main, 'add', '-A'); git(main, 'commit', '-qm', 'x');
  const feat = join(root, 'copie'); git(main, 'worktree', 'add', '-q', '-b', 'feat', feat);
  const closed = join(root, 'ferme'); mkdirSync(closed); execFileSync('chmod', ['000', closed]);
  const context = hookContext({ cwd: main }, { HOME: root });
  // From the checkout on main: every push that may land on main is refused.
  for (const command of [`cd ${closed}; git push`, `cd ${closed} || git push`, `pushd ${closed}; git push`, `cd -P $(echo ${feat}) && git push`, `cd -- $(echo ${feat}) && git push`,
    `git clone ${main} ${join(root, 'neuf')} && cd ${join(root, 'neuf')} && git push`, "git push origin 'refs/*:refs/*'", "git push origin 'r*:r*'", 'git push origin HEAD:heads/main',
    'git push origin :']) {
    assert.equal(evaluateCommand(command, {}, context).decision, 'deny', command);
  }
  const fromFeat = hookContext({ cwd: feat }, { HOME: root });
  assert.equal(evaluateCommand('git switch --ignore-other-worktrees main && git push', {}, fromFeat).decision, 'deny', 'branch changed by the line');
  assert.equal(evaluateCommand('git push', {}, fromFeat).decision, 'allow', 'a working branch');
  for (const command of [`read HOME < f; git push origin main`, `printf -v HOME %s ${root}; git push origin main`]) {
    assert.equal(commandScope(command, tokenize(command).segments, main, root, {}).plain, false, command);
  }
  // Stores: what reads is free, what writes is refused.
  const lead = { ...as(null), cwd: '/r' };
  for (const command of ['dd if=.git/apv/receipts/r.json of=/tmp/x', 'f=.git/apv/receipts/r.json; jq . "$f"', 'R=.git/apv/receipts; ls "$R"', 'echo key=.git/apv',
    'python3 tools/x.py - < .git/apv/receipts/r.json']) {
    assert.equal(evaluateCommand(command, {}, lead).decision, 'allow', command);
  }
  for (const command of ["python3 <<'EOF'\nimport shutil; shutil.rmtree('.git/apv')\nEOF", "node <<'EOF'\nrequire('fs').rmSync('.git/apv', {recursive: true})\nEOF",
    "cat <<'EOF' | python3 -\nimport shutil; shutil.rmtree('.git/apv')\nEOF", 'd=.gi; e=${d}t; f=a; rm -rf "$e/${f}pv"', 'rm -rf .git/$(echo apv)',
    'echo "$(echo x > .git/apv/receipts/r.json)"', 'echo -->.git/apv/receipts/r.json']) {
    assert.deepEqual(evaluateCommand(command, {}, lead), { decision: 'deny', reason: REASONS.anchorStore }, command);
  }
  // A worktree of a bare repository named x.git: its folder is no Git directory.
  const bare = { ...as(null), cwd: '/srv/proj.git/feat2' };
  for (const command of ['rm -rf "$tmp"', 'echo x > "$OUT"', 'curl -so "$f" https://e.x']) assert.equal(evaluateCommand(command, {}, bare).decision, 'allow', command);
});

test('review of 3871d24: scripts split per interpreter, exported variables, bare Git directories, new branches, literal text, scripts of the line', async t => {
  const { hookContext } = await import('../hooks/scripts/harness-guard.mjs');
  const lead = { ...as(null), cwd: '/r' };
  // MOYEN 1 (sec) and F2 (data): the script of each interpreter, its operands, awk's program after its options.
  for (const command of [`ruby -rfileutils -e 'FileUtils.rm_rf(".git/apv")'`, `python3 -E -c "import shutil; shutil.rmtree('.git/apv')"`, `python3 -Werror -c "import shutil; shutil.rmtree('.git/apv')"`,
    `node -p -e "require('fs').rmSync('.git/apv')"`, `perl -Mstrict -e 'unlink ".git/apv/x"'`, `awk -v x=1 'BEGIN{system("rm -rf .git/apv")}'`, `awk -F , 'BEGIN{system("rm -rf .git/apv")}'`,
    "perl -e 'unlink @ARGV' .git/apv/receipts/r.json", "python3 -c 'import shutil,sys; shutil.rmtree(sys.argv[1])' .git/apv", "awk '{print > FILENAME}' .git/apv/receipts/r.json"]) {
    assert.deepEqual(evaluateCommand(command, {}, lead), { decision: 'deny', reason: REASONS.anchorStore }, command);
  }
  // F2 (sec), F3 (data): variables exported or set for a command.
  for (const command of ['export GIT_TRACE=.git/apv/receipts/r.json; git status', 'env GIT_TRACE=.git/apv/receipts/r.json git status', 'declare -x GIT_TRACE=.git/apv/receipts/r.json',
    'set -a; GIT_TRACE=.git/apv/receipts/r.json; git status', 'GIT_TRACE=.git/apv/receipts/r.json; export GIT_TRACE; git status', 'export d=.git/ap; rm -rf "${d}v"',
    'G=.git; cd "$G" && rm -rf apv', 'cd "$(git rev-parse --git-dir)" && rm -rf apv']) {
    assert.deepEqual(evaluateCommand(command, {}, lead), { decision: 'deny', reason: REASONS.anchorStore }, command);
  }
  // F3 (sec): the Git directory of a bare repository, reached by cd or as the working directory.
  const bare = { ...as(null), cwd: '/srv/proj.git/feat2' };
  for (const command of ['cd .. && rm -rf "$x"', 'cd /srv/proj.git && rm -rf "$(cat n)"']) assert.equal(evaluateCommand(command, {}, bare).decision, 'deny', command);
  assert.equal(evaluateCommand('rm -rf "$x"', {}, { ...as(null), cwd: '/srv/proj.git' }).decision, 'deny', 'in the bare Git directory');
  // F1 (data), F5 (sec): literal text between apostrophes or escaped is no command; F4 (data): an interpreter reads only its own input.
  for (const command of ["git commit -m 'docs: cite `git push origin main` et $(rm -rf .git/apv)'", "rg -n '`claude -p' docs/", "grep -rn '$(git push origin main)' docs",
    'echo "\\$(git push origin main)"', "cat > f <<'EOF'\nvoir .git/apv\nEOF\nnode --version", "git commit -F - <<EOF\nvoir .git/apv\nEOF\npython3 -V",
    'cat .git/apv/receipts/*.json', 'ls .git/apv/receipts/*']) {
    assert.equal(evaluateCommand(command, {}, lead).decision, 'allow', command);
  }
  // In doubt, refused: an interpreter whose line names the store, a glob of the stores on a line that does more than read.
  for (const command of ["perl -ne 'print' .git/apv/receipts/r.json", 'cat .git/apv/receipts/*.json | head']) {
    assert.deepEqual(evaluateCommand(command, {}, lead), { decision: 'deny', reason: REASONS.anchorStore }, command);
  }
  // F4 and F6 (sec): new branches, a branch changed inside a script, substitutions judged where they run, `@`.
  const root = mkdtempSync(join(tmpdir(), 'apv3-fin2-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=T', '-c', 'user.email=t@l', ...args], { cwd, stdio: 'pipe' });
  const main = join(root, 'principal'); mkdirSync(main); git(main, 'init', '-q', '-b', 'main');
  mkdirSync(join(main, '.apv')); writeFileSync(join(main, '.apv', 'config.json'), '{}'); git(main, 'add', '-A'); git(main, 'commit', '-qm', 'x');
  const feat = join(root, 'copie'); git(main, 'worktree', 'add', '-q', '-b', 'feat', feat);
  const fromFeat = hookContext({ cwd: feat }, { HOME: root });
  for (const command of ['git checkout -b fix && git push -u origin HEAD', 'git switch -c fix && git push', 'git checkout -- src/x.ts && git push']) {
    assert.equal(evaluateCommand(command, {}, fromFeat).decision, 'allow', command);
  }
  for (const command of [`bash -c 'git switch --ignore-other-worktrees main' && git push`, 'git symbolic-ref HEAD refs/heads/main && git push', `cd ${main} && echo "$(git push)"`]) {
    assert.equal(evaluateCommand(command, {}, fromFeat).decision, 'deny', command);
  }
  assert.equal(evaluateCommand('git push origin @', {}, hookContext({ cwd: main }, { HOME: root })).decision, 'deny', '@ is HEAD');
});

test('review of 7e28f63: options of any interpreter, receipts globbed by a loop, failed branch creation, normalized paths, global options of git', async t => {
  const { hookContext } = await import('../hooks/scripts/harness-guard.mjs');
  const lead = { ...as(null), cwd: '/r' };
  for (const command of [`perl -MFile::Path -le 'rmtree(".git/apv")'`, `perl -l -e 'unlink ".git/apv/x"'`, `perl -0 -e 'unlink ".git/apv/x"'`, `ruby -x -e 'File.delete(".git/apv/x")'`,
    `awk -- 'BEGIN{system("rm -rf .git/apv")}'`, `awk -v p=.git/apv 'BEGIN{system("rm -rf " p)}'`, `python3 -c"import shutil; shutil.rmtree('.git/apv')"`,
    "perl -ne 'unlink $ARGV' .git/apv/receipts/r.json", 'gawk -i inplace 1 .git/apv/receipts/r.json',
    'for f in .git/apv/receipts/*; do rm -f "$f"; done', 'set -- .git/apv/receipts/*; rm -f "$@"', 'rm $(ls .git/apv/receipts/*)',
    'cat /r/.git/apv/receipts/../o*/m*', 'cat .git/apv/./o*/m*', 'd=.git; export GIT_TRACE=$PWD/$d/apv/x; git status']) {
    assert.deepEqual(evaluateCommand(command, {}, lead), { decision: 'deny', reason: REASONS.anchorStore }, command);
  }
  const root = mkdtempSync(join(tmpdir(), 'apv3-fin3-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=T', '-c', 'user.email=t@l', ...args], { cwd, stdio: 'pipe' });
  const main = join(root, 'principal'); mkdirSync(main); git(main, 'init', '-q', '-b', 'main');
  mkdirSync(join(main, '.apv')); writeFileSync(join(main, '.apv', 'config.json'), '{}'); writeFileSync(join(main, 'package-lock.json'), '{}'); git(main, 'add', '-A'); git(main, 'commit', '-qm', 'x');
  const feat = join(root, 'copie'); git(main, 'worktree', 'add', '-q', '-b', 'feat', feat);
  const fromMain = hookContext({ cwd: main }, { HOME: root }); const fromFeat = hookContext({ cwd: feat }, { HOME: root });
  for (const command of ['git checkout -b feat ; git push origin HEAD', 'git switch -c feat; git push', 'git checkout -b feat || true; git push']) {
    assert.equal(evaluateCommand(command, {}, fromMain).decision, 'deny', command);
  }
  assert.equal(evaluateCommand('git -C . switch main && git push', {}, fromFeat).decision, 'deny', 'global options of git');
  for (const command of ['git checkout -b fix && git push -u origin HEAD', 'git checkout package-lock.json && git push',
    "git commit -m \"$(cat <<'EOF'\nretour : git checkout et git switch cités\nEOF\n)\" && git push"]) {
    assert.equal(evaluateCommand(command, {}, fromFeat).decision, 'allow', command);
  }
});

test('review of c65f8c5: the operator after the creation itself, files from a commit, a folder named as a branch, rg and tree, a glob that climbs', async t => {
  const { hookContext } = await import('../hooks/scripts/harness-guard.mjs');
  const lead = { ...as(null), cwd: '/r' };
  // Any program the guard does not know to only read, handed a path in a store, may write it (review of c65f8c5, high).
  for (const command of ['python3 -m json.tool /tmp/forged.json .git/apv/receipts/run/01-tests.json', 'python3 -m compileall .git/apv/receipts',
    'python3 tools/inspect.py .git/apv/receipts', 'python3.12 -m gzip .git/apv/receipts/run/x.json', 'node --loader x .git/apv/receipts/x', 'deno run s.ts .git/apv/receipts/x',
    'uv run x.py .git/apv/receipts/r.json', 'bash script.sh .git/apv/receipts', './tools/fix .git/apv/receipts/r.json', 'sed -n p .git/apv/receipts/r.json',
    "LESSOPEN='|rm %s' less .git/apv/receipts/r.json", 'more .git/apv/receipts/r.json', 'bat --pager=sh .git/apv/receipts/r.json', 'less .git/apv/receipts/*.json']) {
    assert.deepEqual(evaluateCommand(command, {}, lead), { decision: 'deny', reason: REASONS.anchorStore }, command);
  }
  for (const command of ["rg --pre rm '' .git/apv", 'rg --pre=sh x .', 'rg --hostname-bin=./x foo', 'rg x .git/apv/receipts/*', 'tree -o .git/apv/receipts/r.json .git/apv/receipts',
    'tree .git/apv/receipts/*', 'cat .git/apv/receipts/.?/o*/m*', 'cat .git/apv/receipts/..*/operator/x']) {
    assert.deepEqual(evaluateCommand(command, {}, lead), { decision: 'deny', reason: REASONS.anchorStore }, command);
  }
  for (const command of ['rg -n TODO src', 'ls .git/apv/receipts/*', 'cat .git/apv/receipts/*/summary.json']) assert.equal(evaluateCommand(command, {}, lead).decision, 'allow', command);
  // Review of dc0a075: rg with a configuration file, a recursive search of the Git directory, `<` stuck to its file.
  for (const command of ["RIPGREP_CONFIG_PATH=/tmp/c rg '' .git/apv/receipts", "export RIPGREP_CONFIG_PATH=/tmp/c; rg x src", "rg '' .git/apv", "rg '' .git",
    'grep -r . .git/apv', 'grep -R x .git', 'grep --recursive x /r/.git/apv', 'egrep -rn x .git/']) {
    assert.deepEqual(evaluateCommand(command, {}, lead), { decision: 'deny', reason: REASONS.anchorStore }, command);
  }
  for (const command of ["grep -e x -r .git", "rg -f p.txt .git", "export RIPGREP_CONF''IG_PATH=/tmp/c; rg '' .git/apv/receipts", 'grep -d recurse x .git/apv',
    'grep --directories recurse x .git/apv', 'grep -drecurse x .git', 'diff -rN .git/apv /tmp/vide', 'zcat -rf .git/apv']) assert.deepEqual(evaluateCommand(command, {}, lead), { decision: 'deny', reason: REASONS.anchorStore }, command);
  for (const command of ['grep -r x .git/apv/receipts', 'grep -rn TODO src', 'python3 x.py <.git/apv/receipts/r.json', 'python3 x.py 0<.git/apv/receipts/r.json',
    'grep -rn ".git" src', 'rg -n "\\.git/" src', 'echo RIPGREP_CONFIG_PATH; rg x src']) {
    assert.equal(evaluateCommand(command, {}, lead).decision, 'allow', command);
  }
  const root = mkdtempSync(join(tmpdir(), 'apv3-fin4-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=T', '-c', 'user.email=t@l', ...args], { cwd, stdio: 'pipe' });
  const main = join(root, 'principal'); mkdirSync(main); git(main, 'init', '-q', '-b', 'main');
  mkdirSync(join(main, '.apv')); writeFileSync(join(main, '.apv', 'config.json'), '{}'); writeFileSync(join(main, 'package-lock.json'), '{}'); git(main, 'add', '-A'); git(main, 'commit', '-qm', 'x');
  const feat = join(root, 'copie'); git(main, 'worktree', 'add', '-q', '-b', 'feat', feat);
  mkdirSync(join(feat, 'main'));
  const fromMain = hookContext({ cwd: main }, { HOME: root }); const fromFeat = hookContext({ cwd: feat }, { HOME: root });
  // A failed creation (`feat` exists) leaves the shell on main, even with `feat &&` further on the line.
  assert.equal(evaluateCommand('git checkout -b feat; git commit -am "wip feat" && git push origin HEAD', {}, fromMain).decision, 'deny');
  for (const command of ['git switch -c fix origin/main && git push -u origin HEAD', 'git checkout -b fix main && git push -u origin HEAD',
    'git checkout HEAD package-lock.json && git push', 'git checkout main package-lock.json && git push']) {
    assert.equal(evaluateCommand(command, {}, fromFeat).decision, 'allow', command);
  }
  assert.equal(evaluateCommand('git checkout main && git push', {}, fromFeat).decision, 'deny', 'a folder named as a branch');
  // Review of ffcdb9e: the created branch holds along its chain of `&&` only, in its own folder; send-pack is a push.
  for (const command of ['git checkout -b fix && echo ok; git push', 'git checkout -b fix && true || git push', 'git -C ../autre checkout -b fix && git push',
    'git send-pack origin HEAD:refs/heads/main']) {
    assert.equal(evaluateCommand(command, {}, fromMain).decision, 'deny', command);
  }
  assert.equal(evaluateCommand('git switch -C fix && git commit -m x && git push -u origin HEAD', {}, fromMain).decision, 'allow', 'switch -C is a creation');
  // A path given with its option is read like an operand.
  for (const command of ['tar -C.git/apv -xf a.tar', 'cp -t.git/apv/receipts f', 'node w.js --out=.git/apv/receipts/x']) {
    assert.deepEqual(evaluateCommand(command, {}, lead), { decision: 'deny', reason: REASONS.anchorStore }, command);
  }
  assert.equal(evaluateCommand('tar -C dist -cf a.tar .', {}, lead).decision, 'allow');
  // A reader is the command of the system; a climbing path is judged normalized.
  for (const command of ['./cat .git/apv/receipts/r.json', 'cat() { :; }; cat .git/apv/receipts/r.json', 'cat .git/apv/receipts/../operator/x.json']) {
    assert.deepEqual(evaluateCommand(command, {}, lead), { decision: 'deny', reason: REASONS.anchorStore }, command);
  }
  for (const command of ['cat .git/apv/receipts/r.json', '/usr/bin/cat .git/apv/receipts/r.json']) assert.equal(evaluateCommand(command, {}, lead).decision, 'allow', command);
  // The seal follows one record only: two different ids printed, nothing is sealed.
  const { recordId } = await import('../hooks/scripts/review-seal.mjs');
  assert.equal(recordId({ stdout: 'Enregistrement 20261001T000000Z-0000000a\nEnregistrement 20261001T000000Z-0000000b' }), null);
  assert.equal(recordId({ stdout: 'Enregistrement 20261001T000000Z-0000000a', output: 'Enregistrement 20261001T000000Z-0000000a' }), '20261001T000000Z-0000000a');
});
