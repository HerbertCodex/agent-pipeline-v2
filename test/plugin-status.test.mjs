import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareVersions, newRules, pluginLines, pluginStatus } from '../dist/rules/plugin-status.js';

/**
 * apv status and the plugin (projet pilote, 3 octobre 2026): a project under APV without its plugin, and a version of
 * the tool whose merge rules the installed plugin cannot satisfy, are said before they block, with the commands to run.
 */

const git = (cwd, ...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=T', '-c', 'user.email=t@l', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const catalog = ids => JSON.stringify({ needs: { plugin: 'le plugin actif', cle: 'la clé' },
  rules: ids.map(id => ({ id, since: id === 'nouvelle' ? '3.0.0-alpha.13' : '3.0.0-alpha.12', needs: id === 'nouvelle' ? ['plugin', 'cle'] : [], summary: id })) });

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'apv3-plugin-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // The tool: a checkout whose second commit adds a merge rule, pushed to its upstream.
  const origin = join(root, 'outil.git'); git(root, 'init', '-q', '--bare', '-b', 'apv3', origin);
  const tool = join(root, 'outil'); git(root, 'clone', '-q', origin, tool); git(tool, 'switch', '-q', '-c', 'apv3');
  mkdirSync(join(tool, 'docs'));
  writeFileSync(join(tool, 'package.json'), '{"version":"3.0.0-alpha.12"}');
  writeFileSync(join(tool, 'docs', 'merge-rules.json'), catalog(['preuve', 'relecture']));
  git(tool, 'add', '-A'); git(tool, 'commit', '-qm', 'v12'); const old = git(tool, 'rev-parse', 'HEAD');
  writeFileSync(join(tool, 'docs', 'merge-rules.json'), catalog(['preuve', 'relecture', 'nouvelle']));
  writeFileSync(join(tool, 'package.json'), '{"version":"3.0.0-alpha.13"}');
  git(tool, 'commit', '-qam', 'v13'); const next = git(tool, 'rev-parse', 'HEAD');
  git(tool, 'push', '-q', '-u', 'origin', 'apv3');
  const project = join(root, 'projet'); mkdirSync(join(project, '.apv'), { recursive: true });
  const claude = join(root, 'claude'); mkdirSync(join(claude, 'plugins'), { recursive: true });
  const install = (sha, { enabled = true, installPath = join(root, 'cache') } = {}) => {
    writeFileSync(join(claude, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'apv@herbertcodex-apv': [{ scope: 'user', installPath, version: '3.0.0-alpha.12', gitCommitSha: sha }] } }));
    writeFileSync(join(claude, 'settings.json'), JSON.stringify({ enabledPlugins: { 'apv@herbertcodex-apv': enabled } }));
  };
  return { root, tool, old, next, project, claude, install, env: { CLAUDE_CONFIG_DIR: claude } };
}

test('a project under APV without its plugin, or with the plugin turned off, is said with the command to run', t => {
  const s = setup(t);
  let lines = pluginLines(pluginStatus(s.project, s.env, s.tool));
  assert.match(lines[0], /ATTENTION : aucun plugin APV installé.*claude plugin install apv@herbertcodex-apv/);
  s.install(s.next, { enabled: false });
  lines = pluginLines(pluginStatus(s.project, s.env, s.tool));
  assert.match(lines[0], /installé mais désactivé.*claude plugin enable apv@herbertcodex-apv/);
  // Turned on by the settings of the project: enabled.
  mkdirSync(join(s.project, '.claude')); writeFileSync(join(s.project, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'apv@herbertcodex-apv': true } }));
  assert.equal(pluginStatus(s.project, s.env, s.tool).install.enabled, true);
});

test('merge rules the installed plugin does not know are said, with what they need and the update command', t => {
  const s = setup(t);
  // The plugin installed from the old commit (its copy without a catalog: read at its commit in the checkout).
  s.install(s.old, { installPath: join(s.root, 'absent') });
  const status = pluginStatus(s.project, s.env, s.tool);
  assert.deepEqual(status.unknownToPlugin.map(r => r.id), ['nouvelle']);
  const lines = pluginLines(status);
  assert.match(lines.join('\n'), /ne connaît pas : nouvelle \(exige : le plugin actif ; la clé\).*claude plugin update apv@herbertcodex-apv/);
  // Up to date: nothing to say.
  s.install(s.next, { installPath: join(s.root, 'absent') });
  assert.deepEqual(pluginStatus(s.project, s.env, s.tool).unknownToPlugin, []);
});

test('the rules of the next version (upstream branch as fetched) are said before the update', t => {
  const s = setup(t);
  git(s.tool, 'reset', '-q', '--hard', s.old);
  s.install(s.old, { installPath: join(s.root, 'absent') });
  const status = pluginStatus(s.project, s.env, s.tool);
  assert.equal(status.upcoming.ref, 'origin/apv3');
  assert.equal(status.upcoming.behind, 1);
  assert.deepEqual(status.upcoming.rules.map(r => r.id), ['nouvelle']);
  assert.match(pluginLines(status).join('\n'), /Mise à jour à venir \(origin\/apv3, 1 commit\(s\)\) : nouvelles règles de fusion nouvelle \(exige/);
});

test('versions compare with their tags; without a catalog, rules count by the version they come with', () => {
  assert.ok(compareVersions('3.0.0-alpha.13', '3.0.0-alpha.12') > 0);
  assert.ok(compareVersions('3.0.0', '3.0.0-alpha.12') > 0);
  assert.equal(compareVersions('3.0.0-alpha.12', '3.0.0-alpha.12'), 0);
  const next = { needs: {}, rules: [{ id: 'a', since: '3.0.0-alpha.12', needs: [], summary: '' }, { id: 'b', since: '3.0.0-alpha.13', needs: [], summary: '' }] };
  assert.deepEqual(newRules(next, null, '3.0.0-alpha.12').map(r => r.id), ['b']);
  assert.deepEqual(newRules(next, { needs: {}, rules: [next.rules[0]] }, null).map(r => r.id), ['b']);
});

test('the catalog of merge rules names exactly the rules apv rules check applies', async () => {
  const { readFileSync } = await import('node:fs');
  const catalog = JSON.parse(readFileSync(new URL('../docs/merge-rules.json', import.meta.url), 'utf8'));
  const source = readFileSync(new URL('../src/rules/check.ts', import.meta.url), 'utf8');
  const applied = [...new Set([...source.matchAll(/outcome\('([a-z]+)'/g)].map(m => m[1]))].sort();
  assert.deepEqual(catalog.rules.map(r => r.id).sort(), applied);
  for (const rule of catalog.rules) for (const need of rule.needs) assert.ok(catalog.needs[need], `${rule.id} : ${need}`);
});

test('run from the installed copy: no rule said unknown to itself; the next version is read in the folder of the marketplace', t => {
  const s = setup(t);
  const cache = join(s.root, 'cache'); mkdirSync(join(cache, 'docs'), { recursive: true });
  writeFileSync(join(cache, 'package.json'), '{"version":"3.0.0-alpha.12"}');
  writeFileSync(join(cache, 'docs', 'merge-rules.json'), catalog(['preuve', 'relecture']));
  s.install(s.old, { installPath: cache });
  writeFileSync(join(s.claude, 'plugins', 'known_marketplaces.json'), JSON.stringify({ 'herbertcodex-apv': { source: { source: 'directory', path: s.tool } } }));
  git(s.tool, 'reset', '-q', '--hard', s.old);
  const status = pluginStatus(s.project, s.env, cache);
  assert.equal(status.tool.root, cache);
  assert.deepEqual(status.unknownToPlugin, []);
  assert.deepEqual(status.upcoming.rules.map(r => r.id), ['nouvelle']);
  assert.match(pluginLines(status).join('\n'), /Mise à jour à venir \(origin\/apv3 de .*outil, 1 commit\(s\)\)/);
});

test('review of b189216 and 16eabca: outdated hooks, unreadable files, disableAllHooks and a forged catalog are said, never printed raw', async t => {
  const { parseCatalog } = await import('../dist/rules/plugin-status.js');
  const s = setup(t);
  // C1: the plugin installed from a commit whose hooks changed since, same rules on both sides.
  mkdirSync(join(s.tool, 'hooks')); writeFileSync(join(s.tool, 'hooks', 'garde.mjs'), 'v1');
  git(s.tool, 'add', '-A'); git(s.tool, 'commit', '-qm', 'crochet'); const installedSha = git(s.tool, 'rev-parse', 'HEAD');
  writeFileSync(join(s.tool, 'hooks', 'garde.mjs'), 'v2'); git(s.tool, 'commit', '-qam', 'crochet corrigé');
  s.install(installedSha, { installPath: join(s.root, 'absent') });
  let status = pluginStatus(s.project, s.env, s.tool);
  assert.equal(status.pluginBehind, 'changed');
  assert.match(pluginLines(status).join('\n'), /plus ancien que l'outil.*hors de Claude Code/);
  // Installed from a commit this checkout does not know: said too.
  s.install('0123456789abcdef0123456789abcdef01234567', { installPath: join(s.root, 'absent') });
  assert.equal(pluginStatus(s.project, s.env, s.tool).pluginBehind, 'unknown');
  // B2: a file that exists but cannot be read is said, never taken for « not installed ».
  writeFileSync(join(s.claude, 'plugins', 'installed_plugins.json'), '{ pas du json');
  status = pluginStatus(s.project, s.env, s.tool);
  assert.match(pluginLines(status)[0], /état illisible/);
  // Format 1 (one object per plugin) is read as well.
  writeFileSync(join(s.claude, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'apv@herbertcodex-apv': { scope: 'user', version: '3.0.0-alpha.13', gitCommitSha: s.next } } }));
  assert.equal(pluginStatus(s.project, s.env, s.tool).install.version, '3.0.0-alpha.13');
  // C3: disableAllHooks turns every hook off.
  writeFileSync(join(s.claude, 'settings.json'), JSON.stringify({ enabledPlugins: { 'apv@herbertcodex-apv': true }, disableAllHooks: true }));
  assert.match(pluginLines(pluginStatus(s.project, s.env, s.tool)).join('\n'), /disableAllHooks/);
  // A forged catalog: ids and needs that are not plain names are left out, texts lose their control characters.
  const forged = parseCatalog(JSON.stringify({ needs: { cle: 'la clé\u001b[2J' }, rules: [{ id: 'x\u001b[31mFAUX', since: '3.0.0' }, { id: 'ok', since: '3.0.0', needs: ['cle', 'a\nb'], summary: 'r\u0007' }] }));
  assert.deepEqual(forged.rules.map(r => r.id), ['ok']);
  assert.deepEqual(forged.rules[0].needs, ['cle']);
  assert.doesNotMatch(JSON.stringify(forged), /\\u001b|\\u0007/);
});

test('review of 84d3c4a: dist compared, plugin ahead or diverged, settings unreadable, precedence, older format, forged key and sha, FIFO', async t => {
  const { execFileSync: run } = await import('node:child_process');
  const s = setup(t);
  // E1: only dist/ changed since the install: still behind.
  mkdirSync(join(s.tool, 'dist')); writeFileSync(join(s.tool, 'dist', 'cli.js'), 'v1');
  git(s.tool, 'add', '-A'); git(s.tool, 'commit', '-qm', 'dist'); const installed = git(s.tool, 'rev-parse', 'HEAD');
  writeFileSync(join(s.tool, 'dist', 'cli.js'), 'v2'); git(s.tool, 'commit', '-qam', 'dist 2'); const head = git(s.tool, 'rev-parse', 'HEAD');
  s.install(installed, { installPath: join(s.root, 'absent') });
  assert.equal(pluginStatus(s.project, s.env, s.tool).pluginBehind, 'changed');
  // E2: the tool behind the plugin, or on another branch.
  git(s.tool, 'reset', '-q', '--hard', installed);
  s.install(head, { installPath: join(s.root, 'absent') });
  let status = pluginStatus(s.project, s.env, s.tool);
  assert.equal(status.pluginBehind, 'ahead');
  assert.match(pluginLines(status).join('\n'), /plus récent que cette copie de l'outil/);
  writeFileSync(join(s.tool, 'dist', 'cli.js'), 'autre'); git(s.tool, 'commit', '-qam', 'autre branche');
  assert.equal(pluginStatus(s.project, s.env, s.tool).pluginBehind, 'diverged');
  // E4b: an unreadable settings file is said, never read as « disabled ».
  writeFileSync(join(s.claude, 'settings.json'), '{ pas du json');
  assert.match(pluginLines(pluginStatus(s.project, s.env, s.tool))[0], /état illisible/);
  // E4c: disableAllHooks follows the precedence of the settings (local false wins over account true).
  writeFileSync(join(s.claude, 'settings.json'), JSON.stringify({ enabledPlugins: { 'apv@herbertcodex-apv': true }, disableAllHooks: true }));
  mkdirSync(join(s.project, '.claude'), { recursive: true });
  writeFileSync(join(s.project, '.claude', 'settings.local.json'), JSON.stringify({ disableAllHooks: false }));
  assert.equal(pluginStatus(s.project, s.env, s.tool).hooksDisabled, false);
  // E3: an entry of the older format without scope is the account's.
  writeFileSync(join(s.claude, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'apv@herbertcodex-apv': { version: '3.0.0-alpha.13', gitCommitSha: head } } }));
  assert.equal(pluginStatus(s.project, s.env, s.tool).install.version, '3.0.0-alpha.13');
  // Security B: a key that is not a plain name never reaches a command line; A: a forged sha never reaches git.
  writeFileSync(join(s.claude, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'apv@evilmk; touch /tmp/pwned #': [{ scope: 'user', gitCommitSha: head }] } }));
  assert.equal(pluginStatus(s.project, s.env, s.tool).install, null);
  const cache = join(s.root, 'cache-copie'); mkdirSync(join(cache, 'docs'), { recursive: true });
  writeFileSync(join(s.claude, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'apv@herbertcodex-apv': [{ scope: 'user', installPath: cache, gitCommitSha: `--output=${join(s.root, 'inject')}` }] } }));
  writeFileSync(join(s.claude, 'plugins', 'known_marketplaces.json'), JSON.stringify({ 'herbertcodex-apv': { source: { source: 'directory', path: s.tool } } }));
  pluginStatus(s.project, s.env, cache);
  assert.equal(readdirSync(s.root).some(f => f.startsWith('inject')), false);
  // Security D: a FIFO in place of a settings file never blocks apv status.
  rmSync(join(s.project, '.claude', 'settings.local.json')); run('mkfifo', [join(s.project, '.claude', 'settings.local.json')]);
  const started = Date.now();
  pluginStatus(s.project, s.env, s.tool);
  assert.ok(Date.now() - started < 3000);
});

test('review of 84d3c4a: a review the seal hook could not seal is said under its own label', async () => {
  const { journalLines } = await import('../dist/rules/anchor-status.js');
  const lines = journalLines({ file: 'j', key: true, keyProblem: null, keyCreatedAt: null, messages: 3, ignored: 0, last: '2026-10-03T10:00:00Z',
    refused: { at: '2026-10-03T10:00:00Z', reason: 'relecture 20261003T100000Z-0123abcd non scellée : dépôt introuvable' } });
  assert.match(lines.join('\n'), /n'a pas scellé une relecture/);
  assert.doesNotMatch(lines.join('\n'), /a refusé le dernier message/);
});

test('review of 3871d24: a forged key is said, the main checkout settings count from a worktree, a sealed review lifts the note', async t => {
  const { clearSealRefusal, recordRefusal } = await import('../dist/rules/operator.js');
  const { existsSync } = await import('node:fs');
  const s = setup(t);
  writeFileSync(join(s.claude, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'apv@x; rm -rf ~': [{ scope: 'user' }] } }));
  assert.match(pluginLines(pluginStatus(s.project, s.env, s.tool))[0], /état illisible.*nom de plugin apv invalide/);
  // An install for the project, enabled in the local settings of its main checkout, seen from a worktree of it.
  git(s.project, 'init', '-q'); git(s.project, 'commit', '-q', '--allow-empty', '-m', 'x');
  const worktree = join(s.root, 'arbre'); git(s.project, 'worktree', 'add', '-q', '-b', 'w', worktree);
  writeFileSync(join(s.claude, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'apv@herbertcodex-apv': [{ scope: 'local', projectPath: s.project, gitCommitSha: s.next }] } }));
  writeFileSync(join(s.claude, 'settings.json'), '{}');
  mkdirSync(join(s.project, '.claude'), { recursive: true });
  writeFileSync(join(s.project, '.claude', 'settings.local.json'), JSON.stringify({ enabledPlugins: { 'apv@herbertcodex-apv': true } }));
  assert.equal(pluginStatus(worktree, s.env, s.tool).install.enabled, true);
  // The note of a review the hook could not seal goes away once a review is sealed; a refused message stays.
  const common = join(s.root, 'commun'); mkdirSync(common);
  recordRefusal(common, 'relecture X non scellée : dépôt introuvable');
  clearSealRefusal(common);
  assert.equal(existsSync(join(common, 'apv', 'operator', 'refused.json')), false);
  recordRefusal(common, 'message hors de la session');
  clearSealRefusal(common);
  assert.equal(existsSync(join(common, 'apv', 'operator', 'refused.json')), true);
});
