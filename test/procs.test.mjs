import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, git } from './helpers.mjs';
import { apv, write } from './cli-helpers.mjs';
import { assertProcSupported, listProcesses, protectedTool, sameProcessAlive } from '../dist/execution/procs.js';
import { globsOverlap } from '../dist/policy/overlap.js';

const linux = process.platform === 'linux';
const skip = linux ? false : 'apv procs lit /proc (Linux seulement)';

/**
 * A fake test server: a node process in `cwd` listening on a free loopback port; `stubborn` ignores SIGTERM. With
 * `script`, the code is written to that file and run from it (its path is then on the command line).
 */
function server(t, cwd, { stubborn = false, listen = true, script } = {}) {
  const code = [stubborn ? "process.on('SIGTERM', () => {});" : '',
    listen ? "require('node:net').createServer().listen(0, '127.0.0.1', function () { console.log(this.address().port); });"
      : "console.log(0); setInterval(() => {}, 1000);"].join('\n');
  if (script) { mkdirSync(dirname(script), { recursive: true }); writeFileSync(script, code); }
  const child = spawn(process.execPath, script ? [script] : ['-e', code], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* already stopped */ } });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  return new Promise((resolve, reject) => {
    child.stdout.once('data', chunk => resolve({ pid: child.pid, port: Number(String(chunk).trim()), exited }));
    child.once('error', reject);
  });
}

/** Repository with a linked worktree (the copy of a task) and a folder outside the repository. */
function project(t, config) {
  const f = fixture(t, config ? { files: { '.apv/config.json': `${JSON.stringify(config, null, 2)}\n` } } : {});
  const worktree = join(f.root, 'tache-1');
  git(f.repo, 'worktree', 'add', '-q', worktree, '-b', 'apv/tache-1');
  const outside = join(f.root, 'ailleurs');
  mkdirSync(outside);
  return { ...f, worktree: realpathSync(worktree), outside: realpathSync(outside), repo: realpathSync(f.repo) };
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const byPid = (json, pid) => json.processes.find(p => p.pid === pid);

test('procs list shows the servers of the ports: in a worktree stoppable, outside the repository refused', { skip }, async t => {
  const p = project(t);
  const inside = await server(t, p.worktree);
  const foreign = await server(t, p.outside);
  const r = await apv(p.repo, ['procs', 'list', '--port', String(inside.port), '--port', String(foreign.port), '--json']);
  assert.equal(r.code, 0, r.stderr);
  const json = r.json();
  assert.equal(json.mode, 'ports');
  assert.deepEqual(json.worktrees, [p.repo, p.worktree]);
  assert.deepEqual([byPid(json, inside.pid).worktree, byPid(json, inside.pid).stoppable, byPid(json, inside.pid).ports], [p.worktree, true, [inside.port]]);
  assert.deepEqual([byPid(json, foreign.pid).worktree, byPid(json, foreign.pid).refusal], [null, 'outside']);
  const human = await apv(p.repo, ['procs', 'list', '--port', String(inside.port)]);
  assert.match(human.stdout, new RegExp(`${inside.pid}\\s+${inside.port}\\s+${p.worktree.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+arrêtable`));
  assert.ok(alive(inside.pid) && alive(foreign.pid), 'list stops nothing');
});

test('procs stop stops a server of the repository (SIGTERM), never one outside it, and says so by its exit code', { skip }, async t => {
  const p = project(t);
  const inside = await server(t, p.worktree);
  const foreign = await server(t, p.outside);
  const refused = await apv(p.repo, ['procs', 'stop', '--port', String(foreign.port), '--json']);
  assert.equal(refused.code, 1);
  assert.equal(byPid(refused.json(), foreign.pid).refusal, 'outside');
  assert.ok(alive(foreign.pid), 'a process outside the repository is never stopped');
  const human = await apv(p.repo, ['procs', 'stop', '--port', String(foreign.port)]);
  assert.equal(human.code, 1);
  assert.match(human.stdout, /hors du dépôt : non arrêté/);

  const stopped = await apv(p.worktree, ['procs', 'stop', '--port', String(inside.port), '--json']);
  assert.equal(stopped.code, 0, stopped.stdout + stopped.stderr);
  assert.equal(byPid(stopped.json(), inside.pid).outcome, 'terminated');
  assert.equal((await inside.exited).signal, 'SIGTERM');
  assert.ok(alive(foreign.pid));
  // The port is free now: nothing more to stop, exit 0.
  const again = await apv(p.repo, ['procs', 'stop', '--port', String(inside.port)]);
  assert.equal(again.code, 0);
  assert.match(again.stdout, /Aucun processus à arrêter\.[\s\S]*Ports libres : /);
});

test('procs stop escalates to SIGKILL after the grace delay', { skip }, async t => {
  const p = project(t);
  const stubborn = await server(t, p.worktree, { stubborn: true });
  const r = await apv(p.repo, ['procs', 'stop', '--port', String(stubborn.port), '--grace', '1', '--json']);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(byPid(r.json(), stubborn.pid).outcome, 'killed');
  assert.equal((await stubborn.exited).signal, 'SIGKILL');
});

test('procs stop --repo <copie> stops every process started in that copy, listening or not; the main checkout is refused', { skip }, async t => {
  const p = project(t);
  const listening = await server(t, p.worktree);
  const quiet = await server(t, join(p.worktree, 'src'), { listen: false });
  const main = await server(t, p.repo, { listen: false });
  const listed = (await apv(p.repo, ['procs', 'list', '--repo', p.worktree, '--json'])).json();
  assert.equal(listed.mode, 'copy');
  assert.deepEqual(listed.processes.map(x => x.pid).sort(), [listening.pid, quiet.pid].sort());
  const r = await apv(p.repo, ['procs', 'stop', '--repo', p.worktree]);
  assert.equal(r.code, 0, r.stdout);
  await Promise.all([listening.exited, quiet.exited]);
  assert.ok(alive(main.pid), 'a process of another worktree is not a target of the copy');
  const refused = await apv(p.repo, ['procs', 'stop', '--repo', p.repo]);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /copie principale/);
  assert.ok(alive(main.pid));
  const nowhere = await apv(p.repo, ['procs', 'stop', '--repo', p.outside]);
  assert.equal(nowhere.code, 1, 'outside any repository: refused');
});

test('procs stop without option targets the declared test ports (resources.<id>.ports); none declared: usage error', { skip }, async t => {
  const bare = project(t);
  const none = await apv(bare.repo, ['procs', 'stop']);
  assert.equal(none.code, 2);
  assert.match(none.stderr, /aucun port de test déclaré \(resources\.<ressource>\.ports/);

  const free = await new Promise(resolve => { const s = createServer().listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
  const p = project(t, { name: 'demo', gates: [], resources: { e2e: { ports: [free, 1], description: 'pile de test' } } });
  assert.equal((await apv(p.repo, ['status'])).code, 0);
  const orphan = await server(t, p.worktree);
  // The fake server listens on its own port: declare it as the second stack.
  write(p.repo, '.apv/config.json', { name: 'demo', gates: [], resources: { e2e: { ports: [free] }, 'e2e-2': { ports: [orphan.port] } } });
  const listed = (await apv(p.repo, ['procs', 'list', '--json'])).json();
  assert.equal(listed.mode, 'all');
  assert.deepEqual(listed.declaredPorts, { [free]: ['e2e'], [orphan.port]: ['e2e-2'] });
  assert.ok(byPid(listed, orphan.pid)?.stoppable);
  const r = await apv(p.repo, ['procs', 'stop']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`ports .*${orphan.port} \\(e2e-2\\)`));
  assert.match(r.stdout, /1 processus arrêté\(s\)\./);
  await orphan.exited;
});

test('the configuration refuses a malformed resources section', { skip }, async t => {
  const p = project(t, { name: 'demo', gates: [], resources: { bad: { ports: [70000] } } });
  const r = await apv(p.repo, ['procs', 'list', '--port', '1']);
  assert.match(r.stderr, /configuration illisible, ports de test déclarés ignorés[\s\S]*resources\.bad\.ports\[0\]: expected a value in \[1, 65535\]/);
  write(p.repo, '.apv/config.json', { name: 'demo', gates: [], resources: { e2e: { ports: [4173, 4173] } } });
  assert.match((await apv(p.repo, ['procs', 'list', '--port', '1'])).stderr, /resources\.e2e\.ports: duplicate port/);
  write(p.repo, '.apv/config.json', { name: 'demo', gates: [], resources: { e2e: { ports: [] } } });
  assert.match((await apv(p.repo, ['procs', 'list', '--port', '1'])).stderr, /resources\.e2e\.ports/);
});

test('procs never stops apv itself nor its parents, even on a targeted port', { skip }, async t => {
  const p = project(t);
  const own = createServer();
  await new Promise(resolve => own.listen(0, '127.0.0.1', resolve));
  t.after(() => own.close());
  const r = await apv(p.repo, ['procs', 'stop', '--port', String(own.address().port), '--json']);
  assert.equal(r.code, 1);
  assert.equal(byPid(r.json(), process.pid).refusal, 'protected');
  assert.ok(own.listening);
});

test('procs: a process of the main checkout is protected, stopped only with --include-main on a declared test port', { skip }, async t => {
  const p = project(t);
  const main = await server(t, p.repo);
  const linked = await server(t, p.worktree);
  const listed = await apv(p.repo, ['procs', 'list', '--port', `${main.port},${linked.port}`, '--json']);
  assert.equal(listed.code, 0, listed.stderr);
  assert.deepEqual([byPid(listed.json(), main.pid).worktree, byPid(listed.json(), main.pid).stoppable, byPid(listed.json(), main.pid).refusal], [p.repo, false, 'main-checkout']);
  assert.equal(byPid(listed.json(), linked.pid).stoppable, true);
  const human = await apv(p.repo, ['procs', 'list', '--port', String(main.port)]);
  assert.match(human.stdout, new RegExp(`${main.pid}\\s+${main.port}\\s+.*protégé : checkout principal`));
  assert.doesNotMatch(human.stdout, /arrêtable/);

  const refused = await apv(p.repo, ['procs', 'stop', '--port', String(main.port)]);
  assert.equal(refused.code, 1, refused.stdout);
  assert.match(refused.stdout, /protégé : checkout principal[\s\S]*jamais arrêtés par défaut[\s\S]*--include-main/);
  assert.ok(alive(main.pid), 'the main checkout is never stopped by default');
  const undeclared = await apv(p.repo, ['procs', 'stop', '--port', String(main.port), '--include-main']);
  assert.equal(undeclared.code, 2);
  assert.match(undeclared.stderr, new RegExp(`--include-main ne sert qu'à un port de test déclaré.*non déclaré : ${main.port}`));
  assert.equal((await apv(p.repo, ['procs', 'stop', '--repo', p.worktree, '--include-main'])).code, 2, '--include-main needs ports');
  assert.ok(alive(main.pid));

  write(p.repo, '.apv/config.json', { name: 'demo', gates: [], resources: { e2e: { ports: [main.port] } } });
  const stillRefused = await apv(p.repo, ['procs', 'stop', '--json']);
  assert.equal(stillRefused.code, 1);
  assert.equal(byPid(stillRefused.json(), main.pid).refusal, 'main-checkout');
  const stopped = await apv(p.repo, ['procs', 'stop', '--include-main', '--json']);
  assert.equal(stopped.code, 0, stopped.stdout + stopped.stderr);
  assert.equal(byPid(stopped.json(), main.pid).outcome, 'terminated');
  await main.exited;
  assert.ok(alive(linked.pid), 'a port not targeted is left alone');
});

test('procs never stops an editor server, a language server or an MCP server, even with --include-main', { skip }, async t => {
  const p = project(t);
  const vscode = await server(t, p.repo, { script: join(p.root, 'home', '.vscode-server', 'bin', 'abc123', 'out', 'server-main.js') });
  const linkedMcp = await server(t, p.worktree, { script: join(p.root, 'npx', 'node_modules', '@sveltejs', 'mcp', 'index.js') });
  write(p.repo, '.apv/config.json', { name: 'demo', gates: [], resources: { e2e: { ports: [vscode.port, linkedMcp.port] } } });
  const listed = (await apv(p.repo, ['procs', 'list', '--include-main', '--json'])).json();
  assert.deepEqual([byPid(listed, vscode.pid).refusal, byPid(listed, vscode.pid).tool], ['tool', "serveur d'éditeur distant (VS Code, Cursor, Windsurf)"]);
  assert.deepEqual([byPid(listed, linkedMcp.pid).refusal, byPid(listed, linkedMcp.pid).tool], ['tool', 'serveur MCP']);
  const r = await apv(p.repo, ['procs', 'stop', '--include-main', '--grace', '0']);
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stdout, /protégé : outil \(serveur d'éditeur distant/);
  assert.ok(alive(vscode.pid) && alive(linkedMcp.pid), 'protected tools are never stopped');
  for (const [info, label] of [
    [{ exe: '/home/u/.vscode-server/bin/2242eb/node', command: 'node --dns-result-order=ipv4first out/bootstrap-fork' }, "serveur d'éditeur distant (VS Code, Cursor, Windsurf)"],
    [{ exe: '/usr/bin/node', command: 'node /home/u/.vscode-server/extensions/svelte.svelte-vscode-109/node_modules/svelte-language-server/bin/server.js --stdio' }, "serveur d'éditeur distant (VS Code, Cursor, Windsurf)"],
    [{ exe: '/usr/bin/node', command: 'node /opt/lib/node_modules/typescript/lib/tsserver.js' }, 'serveur de langage'],
    [{ exe: '/usr/bin/node', command: 'npm exec @sveltejs/mcp' }, 'serveur MCP'],
    [{ exe: '/home/u/.local/share/claude/versions/2.1/claude', command: 'claude --print' }, 'session Claude Code'],
    [{ exe: '/usr/bin/node', command: 'node /repo/node_modules/.bin/vite preview --port 4173' }, null],
    [{ exe: '/usr/bin/node', command: 'node /repo/node_modules/@playwright/test/cli.js test' }, null]]) {
    assert.equal(protectedTool(info), label, info.command);
  }
});

test('procs list shows by default what stop would stop and what holds a targeted port; --all shows the rest', { skip }, async t => {
  const p = project(t);
  const quietMain = await server(t, p.repo, { listen: false });
  const quietLinked = await server(t, p.worktree, { listen: false });
  const listed = (await apv(p.repo, ['procs', 'list', '--json'])).json();
  assert.equal(listed.mode, 'all');
  assert.equal(byPid(listed, quietMain.pid), undefined, 'a process of the main checkout on no targeted port is hidden');
  assert.equal(byPid(listed, quietLinked.pid).stoppable, true);
  assert.ok(listed.hidden >= 1);
  assert.ok(listed.processes.every(x => x.stoppable || x.ports.length), 'only stoppable processes or holders of a targeted port');
  const human = await apv(p.repo, ['procs', 'list']);
  assert.match(human.stdout, /autre\(s\) processus des worktrees masqué\(s\)[\s\S]*--all pour tout voir/);
  const everything = (await apv(p.repo, ['procs', 'list', '--all', '--json'])).json();
  assert.equal(byPid(everything, quietMain.pid).refusal, 'main-checkout');
  assert.equal(everything.hidden, 0);
  assert.equal((await apv(p.repo, ['procs', 'stop', '--all'])).code, 2, '--all is for list only');
});

test('procs list never shows the other commands of the pipeline that runs it', { skip }, async t => {
  const p = project(t);
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const quote = s => `'${s.replaceAll("'", "'\\''")}'`;
  const line = `sleep 2.71828 | ${quote(process.execPath)} ${quote(cli)} procs list --all --json | cat`;
  const child = spawn('sh', ['-c', line], { cwd: p.repo, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = []; child.stdout.on('data', c => out.push(c));
  const code = await new Promise(resolve => child.once('exit', resolve));
  assert.equal(code, 0);
  const json = JSON.parse(Buffer.concat(out).toString());
  const inRepo = json.processes.filter(x => x.cwd === p.repo);
  assert.deepEqual(inRepo.filter(x => /^(sleep 2\.71828|cat|sh -c .*)$/.test(x.command)).map(x => x.command), [], 'no command of the running pipeline, nor its shell');
  assert.ok(!json.processes.some(x => x.command.includes('procs list --all --json')), 'apv itself is not listed');
});

test('procs refuses wrong calls, and a system without /proc clearly', async t => {
  assert.throws(() => assertProcSupported('/chemin/sans/proc'), /PROCS_UNSUPPORTED|Linux seulement/);
  if (!linux) return;
  const p = project(t);
  for (const [args, message] of [[['procs'], /sous-commande manquante/], [['procs', 'kill'], /sous-commande inconnue/], [['procs', 'stop', '--port', '0'], /--port invalide/],
    [['procs', 'stop', '--port', '4173', '--grace', '61'], /--grace invalide/], [['procs', 'list', '--grace', '1'], /--grace ne sert qu'à stop/]]) {
    const r = await apv(p.repo, args);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.stderr, message);
  }
  const me = listProcesses().find(x => x.pid === process.pid);
  assert.equal(me.cwd, realpathSync(process.cwd()));
  assert.ok(sameProcessAlive(me));
  assert.ok(!sameProcessAlive({ pid: process.pid, start: me.start + 1 }), 'a reused pid (other start time) is another process');
});

test('glob overlap: exact on the portable syntax', () => {
  for (const [a, b] of [['src/routes/accueil/**', 'src/routes/**'], ['src/**', 'src/lib/x.ts'], ['**/*.svelte', 'src/routes/+page.svelte'], ['src/*/page.ts', 'src/a/*.ts'],
    ['docs/design/*.html', 'docs/**'], ['**', 'anything/at/all'], ['src/routes/(app)/[id]/**', 'src/routes/(app)/[id]/+page.ts'], ['a?c', 'abc']]) {
    assert.ok(globsOverlap(a, b), `${a} / ${b}`); assert.ok(globsOverlap(b, a), `${b} / ${a}`);
  }
  for (const [a, b] of [['src/routes/accueil/**', 'src/routes/compte/**'], ['src/*.ts', 'src/lib/x.ts'], ['docs/**', 'src/**'], ['**/*.svelte', 'src/lib/x.ts'],
    ['a?c', 'ac'], ['src/routes/(app)/**', 'src/routes/app/x.ts']]) {
    assert.ok(!globsOverlap(a, b), `${a} / ${b}`); assert.ok(!globsOverlap(b, a), `${b} / ${a}`);
  }
  assert.throws(() => globsOverlap('{a,b}', 'a'), /Unsupported glob/);
});
