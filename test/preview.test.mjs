import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from './helpers.mjs';
import { s } from '../dist/domain/schema.js';
import { Redactor, RedactingWriter, expandVars, parseEnvFile } from '../dist/preview/env.js';
import { previewSchema, resolvePreviewDir } from '../dist/preview/config.js';
import { configIssues } from '../dist/config/load.js';
import { LockStore } from '../dist/lock/store.js';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const SECRET = 'tres-secret-valeur-123';

/** A free TCP port on the loopback (listen on 0, read, close). */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

/** Runs the real `apv` binary in a child process, as an operator would. */
function apv(project, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, args[0], '--repo', project.repo, ...args.slice(1)], { env: project.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

async function get(port, path = '/') {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(2000) });
    return { status: response.status, body: await response.text() };
  } catch { return null; }
}

const files = {
  '.gitignore': 'node_modules/\n',
  'version.txt': 'v1\n',
  // Steps: trivial node scripts that leave a trace in the copy.
  'scripts/install.mjs': "import { writeFileSync } from 'node:fs'; writeFileSync('installed.txt', 'ok'); console.log('install ok');\n",
  'scripts/migrate.mjs': "import { readFileSync } from 'node:fs'; if (readFileSync('version.txt', 'utf8').includes('broken')) { console.error('migration cassée'); process.exit(3); } console.log('migrate ok');\n",
  'scripts/build.mjs': "import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'; mkdirSync('build', { recursive: true }); writeFileSync('build/version.txt', readFileSync('version.txt', 'utf8').trim()); console.log('build ok, dir', process.env.APV_PREVIEW_DIR === process.cwd());\n",
  'scripts/seed.mjs': "console.log('seed avec la clé ' + process.env.API_SECRET_KEY);\n",
  // The server: answers with the built version, prints a secret to its log.
  'server.mjs': [
    "import { createServer } from 'node:http';",
    "import { readFileSync } from 'node:fs';",
    "const version = readFileSync('build/version.txt', 'utf8');",
    "console.log('démarrage, clé ' + process.env.APP_KEY);",
    "createServer((req, res) => {",
    "  if (req.url === '/key') { res.end(process.env.APP_KEY); return; }",
    "  if (req.url === '/port') { res.end(process.env.PORT); return; }",
    "  res.end(version);",
    "}).listen(Number(process.env.PORT), '127.0.0.1', () => console.log('à l\\'écoute'));",
    '',
  ].join('\n'),
};

/** Temporary project: a git repo with the preview config, a preview dir, a lock dir and an env file outside the repo. */
async function project(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'apv-preview-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'version 1');
  const port = await freePort();
  const envFile = join(root, 'preview.env');
  writeFileSync(envFile, `# fichier d'environnement de l'aperçu\nAPI_SECRET_KEY="${SECRET}"\nexport NODE_BIN=${process.execPath}\nSHORT=5190\n`);
  const preview = {
    dir: join(root, 'preview'),
    envFile,
    steps: {
      install: [process.execPath, 'scripts/install.mjs'],
      migrate: [process.execPath, 'scripts/migrate.mjs'],
      build: '"$NODE_BIN" scripts/build.mjs && echo build-shell-ok',
      seed: ['${NODE_BIN}', 'scripts/seed.mjs'],
    },
    serve: { command: [process.execPath, 'server.mjs'], port, env: { APP_KEY: '${API_SECRET_KEY}' } },
    health: { path: '/', timeoutSec: 15 },
    ...overrides,
  };
  mkdirSync(join(repo, '.apv'), { recursive: true });
  writeFileSync(join(repo, '.apv', 'config.json'), `${JSON.stringify({ preview }, null, 2)}\n`);
  const env = {
    ...process.env, APV_LOCK_DIR: join(root, 'locks'), APV_LOCK_POLL_MS: '20', APV_LOCK_HELD: '', XDG_STATE_HOME: join(root, 'state'),
  };
  const p = { root, repo, port, envFile, env, dir: preview.dir, lockFile: join(root, 'locks', 'preview.lock') };
  t.after(async () => {
    await apv(p, ['preview', 'stop']);
    rmSync(root, { recursive: true, force: true });
  });
  return p;
}

function state(p) {
  const file = join(p.repo, '.apv', 'state', 'preview.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test('update, status, second update with the new commit, stop', async (t) => {
  const p = await project(t);
  const first = git(p.repo, 'rev-parse', 'HEAD');
  // An uncommitted change never reaches the preview: the copy comes from git archive.
  writeFileSync(join(p.repo, 'version.txt'), 'modification non commitée\n');

  const up = await apv(p, ['preview', 'update']);
  assert.equal(up.code, 0, up.stderr);
  assert.match(up.stdout, new RegExp(`aperçu prêt : http://localhost:${p.port} \\(branche main, commit ${first.slice(0, 7)}\\)`));
  assert.match(up.stdout, /Premier aperçu/);
  assert.equal((await get(p.port))?.body, 'v1');
  assert.equal((await get(p.port, '/port'))?.body, String(p.port));
  assert.ok(existsSync(join(p.dir, '.apv-preview')));
  assert.ok(existsSync(join(p.dir, 'installed.txt')));
  assert.equal(existsSync(p.lockFile), false, 'verrou libéré');
  const s1 = state(p);
  assert.equal(s1.commit, first);
  assert.equal(s1.branch, 'main');
  assert.ok(alive(s1.pid), 'le serveur survit à la fin de apv');
  assert.match(readFileSync(join(p.repo, '.apv', '.gitignore'), 'utf8'), /state\/preview\.json/);

  const status = await apv(p, ['preview', 'status']);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, new RegExp(`Aperçu en marche : http://localhost:${p.port} \\(branche main, commit ${first.slice(0, 7)}\\)`));
  const statusJson = JSON.parse((await apv(p, ['preview', 'status', '--json'])).stdout);
  assert.equal(statusJson.running, true);
  assert.equal(statusJson.state.pid, s1.pid);

  git(p.repo, 'checkout', '-q', '--', 'version.txt');
  writeFileSync(join(p.repo, 'version.txt'), 'v2\n');
  git(p.repo, 'commit', '-qam', 'version 2');
  const second = git(p.repo, 'rev-parse', 'HEAD');
  const again = await apv(p, ['preview', 'update', 'main']);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, new RegExp(`commit ${second.slice(0, 7)}\\)`));
  assert.match(again.stdout, new RegExp(`Changements depuis ${first.slice(0, 7)} : 1 commit\\n  ${second.slice(0, 7)} version 2`));
  assert.equal((await get(p.port))?.body, 'v2');
  const s2 = state(p);
  assert.notEqual(s2.pid, s1.pid);
  assert.equal(alive(s1.pid), false, 'l\'ancien serveur est arrêté');
  assert.equal(s2.commit, second);

  const same = await apv(p, ['preview', 'update', '--json']);
  assert.equal(same.code, 0, same.stderr);
  const sameJson = JSON.parse(same.stdout);
  assert.equal(sameJson.previousCommit, second);
  assert.equal(sameJson.changes, null);

  const stop = await apv(p, ['preview', 'stop']);
  assert.equal(stop.code, 0, stop.stderr);
  assert.match(stop.stdout, /Aperçu arrêté/);
  assert.equal(await get(p.port), null);
  assert.equal(alive(state(p).pid ?? sameJson.pid), false);
  assert.equal(state(p).commit, second, 'le dernier aperçu reste enregistré');
  const stopped = await apv(p, ['preview', 'status']);
  assert.equal(stopped.code, 1);
  assert.match(stopped.stdout, /Aperçu arrêté/);
  assert.match((await apv(p, ['preview', 'stop'])).stdout, /Aucun aperçu en marche/);
  assert.equal(existsSync(p.lockFile), false);
});

test('a failing step is reported, releases the lock and leaves no server', async (t) => {
  const p = await project(t);
  const ok = await apv(p, ['preview', 'update']);
  assert.equal(ok.code, 0, ok.stderr);
  const running = state(p).pid;

  writeFileSync(join(p.repo, 'version.txt'), 'broken\n');
  git(p.repo, 'commit', '-qam', 'migration cassée');
  const failed = await apv(p, ['preview', 'update']);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /Échec de l'étape « migrate » \(branche main, commit [0-9a-f]{7}\) : code de sortie 3/);
  assert.match(failed.stderr, /migration cassée/);
  assert.match(failed.stderr, /Journal de la mise à jour : .*preview-update\.log/);
  assert.equal(existsSync(p.lockFile), false, 'verrou libéré malgré l\'échec');
  assert.equal(alive(running), false, 'l\'ancien serveur est arrêté');
  assert.equal(await get(p.port), null, 'aucun serveur ne reste');
  assert.equal(state(p).pid, null);
  assert.equal(state(p).lastFailure.step, 'migrate');
  assert.ok(!existsSync(join(p.dir, 'build')), 'build et seed ne sont pas lancés');
  const status = await apv(p, ['preview', 'status']);
  assert.equal(status.code, 1);
  assert.match(status.stdout, /Dernier échec : étape « migrate »/);
  assert.match(readFileSync(join(p.repo, '.apv', 'state', 'preview-update.log'), 'utf8'), /échec de l'étape migrate/);

  const json = JSON.parse((await apv(p, ['preview', 'update', '--json'])).stdout);
  assert.equal(json.ok, false);
  assert.equal(json.step, 'migrate');
});

test('a port used by a foreign process is refused, never freed', async (t) => {
  const p = await project(t);
  const foreign = createServer(socket => socket.end());
  await new Promise(resolve => foreign.listen(p.port, '127.0.0.1', resolve));
  t.after(() => foreign.close());
  const result = await apv(p, ['preview', 'update']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, new RegExp(`Échec de l'étape « port ».*le port ${p.port} est déjà utilisé par un processus qui n'est pas l'aperçu`));
  assert.ok(foreign.listening, 'le processus étranger tourne toujours');
  assert.equal(existsSync(p.dir), false, 'aucune étape lancée');
  assert.equal(existsSync(p.lockFile), false);
});

test('env file values are masked in logs and output, and reach steps and server', async (t) => {
  const p = await project(t);
  const up = await apv(p, ['preview', 'update']);
  assert.equal(up.code, 0, up.stderr);
  assert.equal((await get(p.port, '/key'))?.body, SECRET, '${VAR} de serve.env vient du fichier d\'environnement');
  assert.ok(!`${up.stdout}${up.stderr}`.includes(SECRET));
  const updateLog = readFileSync(join(p.repo, '.apv', 'state', 'preview-update.log'), 'utf8');
  assert.ok(!updateLog.includes(SECRET));
  assert.match(updateLog, /seed avec la clé \[masqué:API_SECRET_KEY\]/);
  assert.match(updateLog, /build-shell-ok/);
  assert.match(updateLog, /étape install : \[masqué:NODE_BIN\] scripts\/install\.mjs/, 'le chemin long de l\'env est masqué aussi');
  assert.ok(!updateLog.includes(process.execPath));
  const logs = await apv(p, ['preview', 'logs']);
  assert.equal(logs.code, 0, logs.stderr);
  assert.match(logs.stdout, /démarrage, clé \[masqué:API_SECRET_KEY\]/);
  assert.ok(!logs.stdout.includes(SECRET));
  const updateLogs = await apv(p, ['preview', 'logs', '--update', '--lines', '3']);
  assert.equal(updateLogs.code, 0);
  assert.equal(updateLogs.stdout.trimEnd().split('\n').length, 3);
  assert.equal((await apv(p, ['preview', 'logs', '--lines', 'zéro'])).code, 2);
});

test('a failing step prints its output masked; a foreign preview dir is never emptied', async (t) => {
  const p = await project(t, { steps: { seed: ['${NODE_BIN}', '-e', 'console.log(process.env.API_SECRET_KEY); process.exit(4)'] } });
  const failed = await apv(p, ['preview', 'update']);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /« seed »/);
  assert.match(failed.stderr, /\[masqué:API_SECRET_KEY\]/);
  assert.ok(!failed.stderr.includes(SECRET));

  const other = await project(t, { dir: undefined });
  const config = JSON.parse(readFileSync(join(other.repo, '.apv', 'config.json'), 'utf8'));
  config.preview.dir = join(other.root, 'personnel');
  mkdirSync(config.preview.dir);
  writeFileSync(join(config.preview.dir, 'important.txt'), 'à garder');
  writeFileSync(join(other.repo, '.apv', 'config.json'), JSON.stringify(config));
  const refused = await apv(other, ['preview', 'update']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /« copie ».*n'a pas été créé par apv/);
  assert.equal(readFileSync(join(config.preview.dir, 'important.txt'), 'utf8'), 'à garder');
});

test('usage errors and missing configuration', async (t) => {
  const p = await project(t);
  assert.equal((await apv(p, ['preview'])).code, 2);
  assert.equal((await apv(p, ['preview', 'dance'])).code, 2);
  assert.equal((await apv(p, ['preview', 'status', '--wait', '1'])).code, 2);
  const help = await apv(p, ['preview', '--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /apv preview update \[branche\]/);
  const unknown = await apv(p, ['preview', 'update', 'nulle-part']);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /« branche ».*introuvable/);
  const option = await apv(p, ['preview', 'update', '--', '--upload-pack=x']);
  assert.equal(option.code, 1);
  assert.match(option.stderr, /Nom de branche invalide/);
  writeFileSync(join(p.repo, '.apv', 'config.json'), '{}');
  const none = await apv(p, ['preview', 'update']);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /Aucune section « preview »/);
});

test('env file parsing, expansion and masking', () => {
  const vars = parseEnvFile([
    '# commentaire', '', 'export A=simple # commentaire', 'B="deux\\nlignes \\"citées\\""', "C='litt\\eral $X'", 'D=', 'E="sur',
    'deux lignes"', 'F=a#b',
  ].join('\n'));
  assert.deepEqual(vars, { A: 'simple', B: 'deux\nlignes "citées"', C: 'litt\\eral $X', D: '', E: 'sur\ndeux lignes', F: 'a#b' });
  assert.throws(() => parseEnvFile('PAS UNE LIGNE'), /ligne 1 : attendu NOM=valeur/);
  assert.throws(() => parseEnvFile('X="ouvert'), /guillemet non fermé/);
  assert.throws(() => parseEnvFile("X='ouvert"), /apostrophe non fermée/);
  assert.equal(Object.getPrototypeOf(parseEnvFile('__proto__=x')), Object.prototype);

  assert.equal(expandVars('${A}-$${A}-$HOME', { A: '1' }, 'ici'), '1-${A}-$HOME');
  assert.throws(() => expandVars('${ABSENTE}', {}, 'preview.serve.env.X'), /preview\.serve\.env\.X : variable inconnue \$\{ABSENTE\}/);

  const redactor = new Redactor({ API_KEY: 'abcd', LONG: 'valeur-longue', LONGER: 'valeur-longue-encore', PORT: '5190', FLAG: 'true' });
  assert.equal(redactor.redact('abcd valeur-longue-encore valeur-longue 5190 true'),
    '[masqué:API_KEY] [masqué:LONGER] [masqué:LONG] 5190 true');
  const out = [];
  const writer = new RedactingWriter(redactor, s => out.push(s));
  writer.push('début valeur-'); writer.push('longue\nfin val'); writer.push('eur-longue');
  writer.flush();
  assert.equal(out.join(''), 'début [masqué:LONG]\nfin [masqué:LONG]');
});

test('preview configuration schema', () => {
  const minimal = previewSchema.parse({ serve: { command: 'npm run preview', port: 5190 } });
  assert.deepEqual(minimal.health, { path: '/', timeoutSec: 60 });
  assert.deepEqual(minimal.steps, {});
  assert.deepEqual(minimal.serve.env, {});
  assert.equal('dir' in minimal, false);
  assert.throws(() => previewSchema.parse({ serve: { command: [], port: 5190 } }), /no alternative matches/);
  assert.throws(() => previewSchema.parse({ serve: { command: 'x', port: 70000 } }), /port/);
  assert.throws(() => previewSchema.parse({ serve: { command: 'x', port: 1, env: { 'MAUVAIS-NOM': 'x' } } }), /invalid key/);
  assert.throws(() => previewSchema.parse({ serve: { command: 'x', port: 1 }, steps: { deploy: 'x' } }), /unknown property deploy/);
  assert.throws(() => previewSchema.parse({ serve: { command: 'x', port: 1 }, health: { path: 'sans-barre' } }), /health\.path/);
  const { issues } = configIssues({ preview: { serve: { port: 1 } } });
  assert.match(issues.map(i => i.message).join('\n'), /preview\.serve\.command/);
  assert.equal(configIssues({ preview: { serve: { command: ['node', 's.mjs'], port: 5190 } } }).issues.length, 0);

  const root = mkdtempSync(join(tmpdir(), 'apv-preview-dir-'));
  const repo = join(root, 'mon projet');
  mkdirSync(repo);
  try {
    const env = { HOME: join(root, 'home'), XDG_STATE_HOME: join(root, 'xdg') };
    assert.equal(resolvePreviewDir(repo, minimal, env), join(root, 'xdg', 'apv', 'preview', 'mon_projet'));
    assert.throws(() => resolvePreviewDir(repo, { ...minimal, dir: 'apercu' }, env), /dans le dépôt/);
    assert.throws(() => resolvePreviewDir(join(repo, 'a', 'b'), { ...minimal, dir: '..' }, env), /contient le dépôt/);
    assert.throws(() => resolvePreviewDir('/srv/x', { ...minimal, dir: '~' }, env), /dossier personnel/);
    assert.equal(resolvePreviewDir('/srv/x', { ...minimal, dir: '~/apercu' }, env), join(root, 'home', 'apercu'));
    assert.throws(() => resolvePreviewDir('/srv/x', { ...minimal, dir: '/' }, env), /contient le dépôt/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('schema helpers: optional, record, union', () => {
  const schema = s.object({ a: s.optional(s.string()), m: s.record(/^[a-z]+$/, s.number(0, 9)), u: s.union(s.string(), s.array(s.string(), 1)) });
  assert.deepEqual(schema.json.required, ['m', 'u']);
  assert.deepEqual(schema.parse({ m: { x: 1 }, u: 'x' }), { m: { x: 1 }, u: 'x' });
  assert.deepEqual(schema.parse({ a: 'y', m: {}, u: ['x'] }), { a: 'y', m: {}, u: ['x'] });
  assert.throws(() => schema.parse({ m: { X: 1 }, u: 'x' }), /invalid key X/);
  assert.throws(() => schema.parse({ m: { x: 10 }, u: 'x' }), /\$\.m\.x/);
  assert.throws(() => schema.parse({ m: {}, u: 3 }), /no alternative matches/);
  const proto = s.record(/^.+$/, s.string()).parse(JSON.parse('{"__proto__":"x"}'));
  assert.equal(Object.getPrototypeOf(proto), Object.prototype);
  assert.equal(proto.__proto__ === 'x' || Object.keys(proto).includes('__proto__'), true);
});

test('a server that dies before answering is reported with its log; a held lock makes update wait then give up', async (t) => {
  const p = await project(t, { serve: { command: 'echo "le serveur plante"; exit 1', port: 0 } });
  const config = JSON.parse(readFileSync(join(p.repo, '.apv', 'config.json'), 'utf8'));
  config.preview.serve.port = p.port;
  writeFileSync(join(p.repo, '.apv', 'config.json'), JSON.stringify(config));
  const dead = await apv(p, ['preview', 'update']);
  assert.equal(dead.code, 1);
  assert.match(dead.stderr, /Échec de l'étape « health ».*s'est arrêté avant de répondre/);
  assert.match(dead.stderr, /le serveur plante/);
  assert.match(dead.stderr, /Journal du serveur : .*preview\.log/);
  assert.equal(state(p), null, 'aucun serveur enregistré');

  rmSync(p.dir, { recursive: true, force: true });
  const store = new LockStore(join(p.root, 'locks'), { pollMs: 20 });
  const held = await store.acquire('preview', { owner: { pid: process.pid, host: store.host, label: 'autre-agent' }, ttlSeconds: 60, waitSeconds: 1 });
  assert.ok(held.ok);
  try {
    const waited = await apv(p, ['preview', 'update', '--wait', '1']);
    assert.equal(waited.code, 1);
    assert.match(waited.stderr, /Verrou « preview » non obtenu après 1 s : tenu par autre-agent/);
    assert.equal(existsSync(p.dir), false, 'rien n\'est lancé sans le verrou');
  } finally {
    // Released here: the project cleanup (apv preview stop) takes the same lock.
    await store.release('preview', { token: held.record.token });
  }
});
