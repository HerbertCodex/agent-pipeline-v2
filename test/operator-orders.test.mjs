import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apv } from './cli-helpers.mjs';
import { waive } from './support/rules.mjs';
import { ARTICLE, DOMAIN, IDENTITY, NONCE, PUBLICATION, REPO, comment, fakeGh, fakeProduction, git, orderConfig, orderObjects, orderRepo, pullRequests, signer } from './support/orders.mjs';
import { configIssues } from '../dist/config/load.js';
import { readPublicKey, signedLines, verifySigned, publicKeys } from '../dist/orders/envelope.js';
import { verifyOrder, checkAttestation, mergeMessage, orderTrailers } from '../dist/orders/order.js';
import { mergeOnOrder, readBodies } from '../dist/orders/merge.js';
import { refusalCode } from '../dist/orders/verify-command.js';
import { processGit } from '../dist/stack/batch.js';
import { auditMerges, auditLines } from '../dist/rules/merges.js';

const fakeGhBin = fileURLToPath(new URL('./support/fake-gh.mjs', import.meta.url));
chmodSync(fakeGhBin, 0o755);

/**
 * A merge on order ready to run: the repository, the signer, the comments of the article pull request (the decision and
 * the order), a fake GitHub and a fake production. `run` calls mergeOnOrder with them; `main` reads the target of the origin.
 */
function scenario(t, options = {}) {
  const s = options.signer ?? signer();
  const repo = orderRepo(t, s.pem, options.repo);
  const objects = orderObjects(s, repo.article, options.objects);
  const comments = options.comments?.(objects, s, repo) ?? [comment(objects.decisionSigned), comment(objects.orderSigned, 'Ordre de publication de l\'opérateur')];
  const state = { prs: pullRequests(repo, options.prs), comments: { [ARTICLE]: comments } };
  const github = fakeGh(state);
  const production = fakeProduction(s, objects.order, options.production ?? { mode: 'open' });
  const run = (extra = {}) => mergeOnOrder({
    repo: repo.dir, remote: 'origin', publicationPr: PUBLICATION, articlePr: ARTICLE, nonce: NONCE,
    gh: github.gh, git: processGit({ ...process.env, ...IDENTITY }), env: { ...process.env, ...IDENTITY },
    rules: async () => [], fetch: production.fetch, ...extra,
  });
  const main = () => git(repo.origin, 'rev-parse', 'refs/heads/main');
  return { s, repo, objects, state, github, production, run, main };
}

const refused = (report, code) => {
  assert.equal(report.status, 'refused', JSON.stringify(report));
  assert.equal(report.code, code, report.reason);
  assert.equal(report.merged.length, 0, 'rien n\'est poussé');
};

// ---------------------------------------------------------------------------------------------------------------------
// Configuration: rules.operatorOrders validated by the loader, read by apv status.

test('configuration : clé privée, adresse en clair hors boucle locale, marque inconnue et domaine invalide refusés, sans jamais citer la clé', () => {
  const s = signer();
  const base = orderConfig(s.pem).rules.operatorOrders;
  const issues = raw => configIssues({ rules: { operatorOrders: { ...base, ...raw } } }).issues.map(i => i.message).join('\n');
  const privateKey = issues({ publicKeys: [s.privatePem] });
  assert.match(privateKey, /publicKeys\[0\] : clé privée refusée/);
  assert.doesNotMatch(privateKey, /BEGIN|PRIVATE KEY-----|[A-Za-z0-9+/]{40}/, 'la clé n\'est jamais citée');
  assert.match(issues({ publicKeys: ['pas une clé'] }), /clé publique illisible/);
  assert.match(issues({ publicKeys: [s.pem, s.pem] }), /clé déclarée deux fois/);
  assert.match(issues({ attestation: { url: 'http://production.test/a?nonce={nonce}&challenge={challenge}' } }), /HTTPS attendu/);
  assert.match(issues({ attestation: { url: 'https://production.test/a?nonce={nonce}' } }), /\{nonce\} et \{challenge\} attendus/);
  assert.match(issues({ attestation: { url: 'https://u:p@production.test/a?nonce={nonce}&challenge={challenge}' } }), /aucun identifiant/);
  assert.match(issues({ verify: { publication: ['npm', 'run', 'x', '--', '{{tete}}'] } }), /marque inconnue ou partielle \{\{tete\}\}/);
  assert.match(issues({ domain: 'Toujours Rien' }), /domain/);
  assert.match(issues({ attestation: { url: base.attestation.url, maxAgeSeconds: 3600 } }), /maxAgeSeconds/);
  const ok = configIssues(orderConfig(s.pem));
  assert.deepEqual(ok.issues, []);
  assert.equal(ok.config.rules.operatorOrders.attestation.maxAgeSeconds, 120, '120 s par défaut');
  assert.equal(configIssues({ rules: { operatorOrders: { ...base, attestation: { url: 'http://127.0.0.1:8080/a?nonce={nonce}&challenge={challenge}' } } } }).issues.length, 0, 'HTTP sur la boucle locale (tests)');
});

test('apv status affiche la déclaration des ordres signés, ou leur absence', async t => {
  const s = signer();
  const { dir } = orderRepo(t, s.pem);
  const r = await apv(dir, ['status']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`Ordres signés \\(rules.operatorOrders\\) : domaine ${DOMAIN}, clé\\(s\\) ${s.keyId} ; attestation par production.test, 120 s au plus avant la poussée`));
  const j = await apv(dir, ['status', '--json']);
  assert.equal(j.json().operatorOrders.settings.domain, DOMAIN);
  writeFileSync(join(dir, '.apv/config.json'), '{}\n');
  assert.match((await apv(dir, ['status'])).stdout, /Ordres signés \(rules.operatorOrders\) : non déclarés/);
  const rules = await apv(dir, ['rules', 'check', '--commit', 'HEAD', '--target', 'origin/main', '--offline']);
  assert.doesNotMatch(rules.stderr, /Invalid configuration/, 'apv rules check lit la configuration sans erreur');
});

// ---------------------------------------------------------------------------------------------------------------------
// Envelope and order, offline.

test('enveloppe : signature fausse, autre clé, autre kind, autre domaine, charge non canonique refusés', () => {
  const s = signer();
  const other = signer();
  const keys = publicKeys([s.pem]);
  const value = { format: 1, repo: REPO, pr: 1 };
  const [payload, signature] = s.signed('decision', value).split('.');
  assert.equal(verifySigned(DOMAIN, 'decision', payload, signature, keys).ok, true);
  // One byte of the payload changed, signature kept.
  const altered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url')), pr: 2 }).replace(/\s/g, ''), 'utf8').toString('base64url');
  assert.equal(verifySigned(DOMAIN, 'decision', altered, signature, keys).code, 'signature');
  assert.equal(verifySigned(DOMAIN, 'decision', ...other.signed('decision', value).split('.'), keys).code, 'key');
  assert.equal(verifySigned(DOMAIN, 'publish_order', payload, signature, keys).code, 'kind', 'une décision ne vérifie jamais comme un ordre');
  assert.equal(verifySigned('autre-projet', 'decision', payload, signature, keys).code, 'signature', 'le préfixe vient du domaine déclaré');
  const spaced = Buffer.from('{"format": 1}', 'utf8').toString('base64url');
  assert.equal(verifySigned(DOMAIN, 'decision', spaced, signature, keys).code, 'malformed');
  const big = Buffer.from(JSON.stringify({ kind: 'decision', keyId: s.keyId, x: 'a'.repeat(5000) }), 'utf8').toString('base64url');
  assert.equal(verifySigned(DOMAIN, 'decision', big, signature, keys).code, 'malformed', 'plus de 4 Kio');
  assert.equal(readPublicKey(s.privatePem).problem, 'private');
  // Two signed lines in one comment: neither is read.
  assert.equal(signedLines(DOMAIN, [`${comment(s.signed('decision', value))}\n<!-- ${DOMAIN}-signed:1 ${s.signed('decision', value)} -->`]).length, 0);
});

test('ordre hors ligne : un refus distinct par cas (séquence, conflits, échéance, tête, dépôt)', () => {
  const s = signer();
  const keys = publicKeys([s.pem]);
  const head = 'c'.repeat(40);
  const base = orderObjects(s, head);
  const check = (bodies, extra = {}) => verifyOrder({ domain: DOMAIN, keys, bodies, repo: REPO, pr: ARTICLE, head, nonce: NONCE, now: Date.now(), ...extra });
  const order = comment(base.orderSigned);
  assert.equal(check([comment(base.decisionSigned), order]).ok, true);
  // Lower sequence: « Changements demandés » seq 9 after the validation seq 7, and the copy of seq 7 posted after it.
  const changes = s.signed('decision', { ...base.decision, decision: 'changes', seq: 9, requestId: '99999999-2222-4333-8444-555555555555' });
  assert.equal(check([comment(base.decisionSigned), order, comment(changes)]).code, 'superseded');
  assert.equal(check([comment(changes), comment(base.decisionSigned), order, comment(base.decisionSigned)]).code, 'superseded', 'ni l\'ordre des commentaires ni une copie ne comptent');
  const otherAtNine = s.signed('decision', { ...base.decision, decision: 'refuse', seq: 9, requestId: '99999999-2222-4333-8444-555555555555' });
  assert.equal(check([comment(base.decisionSigned), order, comment(changes), comment(otherAtNine)]).code, 'decision_conflict');
  assert.equal(check([order]).code, 'decision_missing');
  const twin = s.signed('publish_order', { ...base.order, content: 'autre' });
  assert.equal(check([comment(base.decisionSigned), order, comment(twin)]).code, 'nonce_conflict');
  assert.equal(check([comment(base.decisionSigned), order, order]).ok, true, 'copies identiques tolérées');
  const expired = orderObjects(s, head, { now: Date.now() - 8 * 24 * 3600 * 1000 });
  assert.equal(check([comment(expired.decisionSigned), comment(expired.orderSigned)]).code, 'expired');
  const tooLong = orderObjects(s, head, { life: 8 * 24 * 3600 * 1000 });
  assert.equal(check([comment(tooLong.decisionSigned), comment(tooLong.orderSigned)]).code, 'malformed', 'plus de 7 jours de vie');
  assert.equal(check([comment(base.decisionSigned), order], { head: 'd'.repeat(40) }).code, 'head_moved');
  assert.equal(check([comment(base.decisionSigned), order], { repo: 'o/autre' }).code, 'repo');
  assert.equal(check([comment(base.decisionSigned), order], { pr: 99 }).code, 'pr');
  assert.equal(check([comment(base.decisionSigned), comment(signer().signed('publish_order', base.order))]).code, 'key');
  assert.equal(check([comment(base.decisionSigned), `<!-- ${DOMAIN}-signed:1 ${base.orderSigned.split('.')[0]}.${'A'.repeat(86)} -->`]).code, 'signature');
  assert.equal(check(['Ordre de publication de l\'opérateur, sans signature']).code, 'malformed');
});

test('attestation : défi différent, autre clé, décision rejouée comme attestation, autre ordre refusés', () => {
  const s = signer();
  const keys = publicKeys([s.pem]);
  const { order } = orderObjects(s, 'c'.repeat(40));
  const read = { repo: REPO, articlePr: ARTICLE, articleSha: order.articleSha, decisionRef: order.decisionRef, decisionSeq: order.decisionSeq, nonce: NONCE };
  const challenge = '12345678-1234-4123-8123-123456789abc';
  const attestation = { format: 1, repo: REPO, articlePr: ARTICLE, articleSha: order.articleSha, orderNonce: NONCE, decisionSeq: 7, challenge, attestedAt: 'x' };
  assert.deepEqual(checkAttestation(DOMAIN, keys, s.signed('publish_attestation', attestation), read, challenge), { ok: true });
  assert.equal(checkAttestation(DOMAIN, keys, s.signed('publish_attestation', attestation), read, '00000000-1234-4123-8123-123456789abc').code, 'challenge');
  assert.equal(checkAttestation(DOMAIN, keys, signer().signed('publish_attestation', attestation), read, challenge).code, 'key');
  assert.equal(checkAttestation(DOMAIN, keys, s.signed('decision', attestation), read, challenge).code, 'kind');
  assert.equal(checkAttestation(DOMAIN, keys, s.signed('publish_attestation', attestation, DOMAIN, 'decision'), read, challenge).code, 'signature');
  assert.equal(checkAttestation(DOMAIN, keys, s.signed('publish_attestation', { ...attestation, orderNonce: '22222222-3333-4444-8555-666666666666' }), read, challenge).code, 'order');
  assert.equal(checkAttestation(DOMAIN, keys, s.signed('publish_attestation', { ...attestation, decisionSeq: 6 }), read, challenge).code, 'order');
});

test('pied de fusion et lectures : le pied se relit, les commentaires se lisent ligne à ligne, un code court se reprend', () => {
  const message = mergeMessage({ pr: 21, step: 'publication', nonce: NONCE, digest: 'f'.repeat(64), head: 'a'.repeat(40) });
  assert.deepEqual(orderTrailers([message, 'autre commit']), [{ nonce: NONCE, step: 'publication' }]);
  assert.match(message, /^Apv-Merged-Head: a{40}$/m);
  assert.deepEqual(readBodies('"a\\nb"\n"c"\nnull\n'), ['a\nb', 'c']);
  assert.equal(readBodies('pas du json\n'), null);
  assert.equal(refusalCode('trace\n{"ok":false,"code":"content"}\n'), 'content');
  assert.equal(refusalCode('{"ok":false,"code":"Rien ; rm -rf"}'), null);
});

// ---------------------------------------------------------------------------------------------------------------------
// apv stack merge --order: each refusal pushes nothing.

test('fusion sur ordre : signature fausse refusée, rien n\'est poussé', async t => {
  // The signature of another payload (content changed after the signature) kept under the payload of the order.
  const sc = scenario(t, { comments: (o, s) => [comment(o.decisionSigned), comment(`${o.orderSigned.split('.')[0]}.${s.signed('publish_order', { ...o.order, content: 'autre' }).split('.')[1]}`)] });
  const before = sc.main();
  refused(await sc.run(), 'signature');
  assert.equal(sc.main(), before);
  assert.equal(sc.production.challenges.length, 0, 'aucune attestation demandée');
});

test('fusion sur ordre : ordre signé par une clé que la base ne déclare pas refusé', async t => {
  const intruder = signer();
  const sc = scenario(t, { comments: o => [comment(intruder.signed('decision', o.decision)), comment(intruder.signed('publish_order', o.order))] });
  refused(await sc.run(), 'key');
});

test('fusion sur ordre : séquence inférieure (une décision plus récente remplace celle de l\'ordre) refusée', async t => {
  const sc = scenario(t, { comments: (o, s) => [comment(o.decisionSigned), comment(o.orderSigned),
    comment(s.signed('decision', { ...o.decision, decision: 'changes', seq: 9, requestId: '99999999-2222-4333-8444-555555555555' })),
    comment(o.decisionSigned)] });
  refused(await sc.run(), 'superseded');
});

test('fusion sur ordre : ordre échu refusé', async t => {
  const sc = scenario(t, { objects: { now: Date.now() - 8 * 24 * 3600 * 1000 } });
  refused(await sc.run(), 'expired');
});

test('fusion sur ordre : contenu différent de celui signé refusé par la commande du projet, lancée depuis la base (le script piégé de la tête ne tourne jamais)', async t => {
  const sc = scenario(t, { repo: { content: 'texte écrit à la main', trap: true } });
  const report = await sc.run();
  refused(report, 'verify');
  assert.equal(report.projectCode, 'content');
  assert.equal(existsSync(sc.repo.witness), false, 'le script de la tête n\'est jamais exécuté');
  assert.equal(git(sc.repo.dir, 'worktree', 'list').split('\n').length, 1, 'copie propre retirée');
});

test('fusion sur ordre : tête de publication qui ne descend pas de la cible refusée (base)', async t => {
  const sc = scenario(t);
  git(sc.repo.dir, 'commit', '-q', '--allow-empty', '-m', 'main avance');
  git(sc.repo.dir, 'push', '-q', 'origin', 'main');
  refused(await sc.run(), 'base');
});

test('fusion sur ordre : règles avant fusion manquantes refusées', async t => {
  const sc = scenario(t);
  const report = await sc.run({ rules: async head => [`  preuve : aucune preuve complète à ${head.slice(0, 12)}`] });
  refused(report, 'rules');
  assert.match(report.reason, /preuve/);
});

test('fusion sur ordre : PR d\'article déplacée après la décision refusée (head_moved)', async t => {
  const sc = scenario(t, { prs: { [ARTICLE]: { headRefOid: 'e'.repeat(40) } } });
  refused(await sc.run(), 'head_moved');
});

test('fusion sur ordre : sans rules.operatorOrders à la base, refus (config)', async t => {
  const s = signer();
  const sc = scenario(t, { signer: s, repo: { config: {} } });
  refused(await sc.run(), 'config');
});

for (const [mode, reason] of [['down', /unavailable/], ['superseded', /superseded/], ['merged', /merged/], ['wrong-challenge', /challenge/],
  ['decision', /kind/], ['decision-prefix', /signature/], ['wrong-nonce', /order/]]) {
  test(`fusion sur ordre : attestation ${mode} refusée, rien n'est poussé`, async t => {
    const sc = scenario(t, { production: { mode } });
    const before = sc.main();
    const report = await sc.run();
    refused(report, 'attestation');
    assert.match(report.reason, reason);
    assert.equal(sc.main(), before);
  });
}

test('fusion sur ordre : attestation signée par une autre clé refusée', async t => {
  const sc = scenario(t, { production: { mode: 'other-key', other: signer() } });
  const report = await sc.run();
  refused(report, 'attestation');
  assert.match(report.reason, /key/);
});

test('fusion sur ordre : attestation périmée au moment de la poussée, nouvelle demande avec un nouveau défi, puis refus si elle reste périmée', async t => {
  const sc = scenario(t);
  let clock = 0;
  // The push of the publication step comes 121 s after its attestation: a new one is asked, then the push follows at once.
  const report = await sc.run({ monotonic: () => clock, beforePush: async step => { if (step === 'publication') clock += 121_000; } });
  assert.equal(report.status, 'merged', report.reason);
  assert.equal(report.attestations, 3, 'publication : deux demandes, article : une');
  assert.equal(new Set(sc.production.challenges).size, 3, 'un défi neuf à chaque demande');
  const stale = scenario(t);
  let always = 0;
  const refusedReport = await stale.run({ monotonic: () => (always += 121_000) });
  refused(refusedReport, 'attestation');
  assert.match(refusedReport.reason, /trop ancienne/);
});

test('fusion sur ordre : poussée non rapide (la cible a bougé) refusée par git, revérifiée, jamais forcée', async t => {
  const sc = scenario(t);
  let moved = null;
  const report = await sc.run({ beforePush: async () => {
    if (moved) return;
    git(sc.repo.dir, 'commit', '-q', '--allow-empty', '-m', 'quelqu\'un d\'autre pousse');
    git(sc.repo.dir, 'push', '-q', 'origin', 'HEAD:main');
    moved = git(sc.repo.dir, 'rev-parse', 'HEAD');
  } });
  refused(report, 'base');
  assert.equal(sc.main(), moved, 'la cible garde le commit poussé par l\'autre, rien n\'est forcé');
});

test('fusion sur ordre : deux exécutions en même temps, une seule fusion par étape, la seconde sort already_done', async t => {
  const sc = scenario(t);
  let other = null;
  const report = await sc.run({ beforePush: async step => { if (step === 'publication' && !other) { other = 'en cours'; other = await sc.run(); } } });
  assert.equal(other.status, 'merged', other.reason);
  assert.equal(report.status, 'already_done', report.reason);
  const trailers = git(sc.repo.origin, 'log', '--first-parent', '--format=%B', 'main').match(/^Apv-Order-Step: \w+$/gm);
  assert.deepEqual(trailers, ['Apv-Order-Step: article', 'Apv-Order-Step: publication'], 'un seul pied par étape');
});

test('fusion sur ordre : les deux étapes fusionnent exactement les têtes vérifiées, parents (cible, tête), pied Apv-Order, puis ordre rejoué : already_done', async t => {
  const sc = scenario(t);
  const before = sc.main();
  // The publication branch moves after the verification: H read at the start is merged, not the new head.
  const report = await sc.run({ beforePush: async step => {
    if (step !== 'publication') return;
    git(sc.repo.dir, 'switch', '-q', 'publication/x');
    git(sc.repo.dir, 'commit', '-q', '--allow-empty', '-m', 'poussé après la preuve');
    git(sc.repo.dir, 'push', '-q', 'origin', 'publication/x');
    git(sc.repo.dir, 'switch', '-q', 'main');
  } });
  assert.equal(report.status, 'merged', report.reason);
  assert.deepEqual(report.merged.map(m => m.step), ['publication', 'article']);
  const [publication, article] = report.merged;
  assert.equal(git(sc.repo.origin, 'rev-parse', `${publication.mergeCommit}^1`), before);
  assert.equal(git(sc.repo.origin, 'rev-parse', `${publication.mergeCommit}^2`), sc.repo.publication, 'H lu au début');
  assert.equal(git(sc.repo.origin, 'rev-parse', `${article.mergeCommit}^1`), publication.mergeCommit);
  assert.equal(git(sc.repo.origin, 'rev-parse', `${article.mergeCommit}^2`), sc.repo.article);
  assert.equal(sc.main(), article.mergeCommit);
  assert.equal(git(sc.repo.origin, 'rev-parse', `${publication.mergeCommit}^{tree}`), git(sc.repo.origin, 'rev-parse', `${sc.repo.publication}^{tree}`));
  const message = git(sc.repo.origin, 'log', '-1', '--format=%B', publication.mergeCommit);
  assert.match(message, new RegExp(`^Apv-Order: ${NONCE}$`, 'm'));
  assert.match(message, /^Apv-Order-Step: publication$/m);
  assert.match(message, /^Apv-Order-Sha256: [0-9a-f]{64}$/m);
  assert.equal(report.attestations, 2, 'une attestation par étape');
  // The same order again: consumed by its trailers.
  const again = await sc.run();
  assert.equal(again.status, 'already_done');
  assert.deepEqual(again.consumed, ['publication', 'article']);
  assert.equal(sc.main(), article.mergeCommit);
  // apv audit merges recognises both merges on order (structural check, listed with their reference).
  git(sc.repo.dir, 'fetch', '-q', 'origin');
  const common = git(sc.repo.dir, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const audit = auditMerges(sc.repo.dir, common, 'origin/main', { since: new Date(Date.now() - 3_600_000).toISOString() });
  assert.deepEqual(audit.orderMerges.map(o => o.step), ['article', 'publication']);
  assert.match(auditLines(audit).join('\n'), /2 fusion\(s\) sur ordre signé/);
});

test('fusion sur ordre : un pied de l\'étape article sans l\'étape publication rend l\'ordre inutilisable (nonce_used)', async t => {
  const sc = scenario(t);
  git(sc.repo.dir, 'commit', '-q', '--allow-empty', '-m', `forgé\n\nApv-Order: ${NONCE}\nApv-Order-Step: article`);
  git(sc.repo.dir, 'push', '-q', 'origin', 'main');
  git(sc.repo.dir, 'switch', '-q', 'publication/x');
  git(sc.repo.dir, 'merge', '-q', '--no-edit', 'main');
  git(sc.repo.dir, 'push', '-q', 'origin', 'publication/x');
  git(sc.repo.dir, 'switch', '-q', 'main');
  refused(await sc.run(), 'nonce_used');
});

// ---------------------------------------------------------------------------------------------------------------------
// The command line.

test('apv stack merge --order : APV_ALLOW_MERGE exigé, deux PR, référence UUID, options d\'une fusion ordinaire refusées', async t => {
  const s = signer();
  const { dir } = orderRepo(t, s.pem);
  const base = ['stack', 'merge', String(PUBLICATION), String(ARTICLE), '--order', NONCE];
  assert.equal((await apv(dir, base, { APV_ALLOW_MERGE: '' })).code, 2);
  const allow = { APV_ALLOW_MERGE: '1', APV_GH: '/bin/false' };
  assert.match((await apv(dir, [...base, '--method', 'squash'], allow)).stderr, /--method : sans objet avec --order/);
  assert.match((await apv(dir, ['stack', 'merge', '21', '--order', NONCE], allow)).stderr, /exactement deux PR/);
  assert.match((await apv(dir, ['stack', 'merge', '21', '20', '--order', 'pas-un-uuid'], allow)).stderr, /UUID/);
  assert.match((await apv(dir, ['stack', 'plan', '21', '20', '--order', NONCE], allow)).stderr, /--order : réservé à stack merge/);
});

test('apv stack merge --order de bout en bout : faux gh, production locale en HTTP, règles de l\'outil, deux fusions poussées', async t => {
  const s = signer();
  const server = createServer();
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/attestation?nonce={nonce}&challenge={challenge}`;
  const config = orderConfig(s.pem);
  config.rules.operatorOrders.attestation = { url };
  const repo = orderRepo(t, s.pem, { config });
  const objects = orderObjects(s, repo.article);
  server.on('request', (request, response) => {
    const query = new URL(request.url, 'http://x').searchParams;
    const o = objects.order;
    const signed = s.signed('publish_attestation', { format: 1, repo: o.repo, articlePr: o.articlePr, articleSha: o.articleSha, orderNonce: query.get('nonce'),
      decisionSeq: o.decisionSeq, challenge: query.get('challenge'), attestedAt: new Date().toISOString() });
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ signed }));
  });
  // The operator waived the rules for both heads: these tests are about the order, not the proof.
  waive(repo.dir, repo.publication);
  waive(repo.dir, repo.article);
  const file = join(repo.root, 'gh.json');
  writeFileSync(file, JSON.stringify({ prs: pullRequests(repo), comments: { [ARTICLE]: [comment(objects.decisionSigned), comment(objects.orderSigned)] }, behavior: {}, calls: [] }));
  const env = { APV_GH: fakeGhBin, FAKE_GH_STATE: file, APV_ALLOW_MERGE: '1', ...IDENTITY };
  const r = await apv(repo.dir, ['stack', 'merge', String(PUBLICATION), String(ARTICLE), '--order', NONCE], env);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /étape publication : PR #21 fusionnée/);
  assert.match(r.stdout, /Ordre exécuté : les deux étapes sont fusionnées\./);
  const calls = JSON.parse(readFileSync(file, 'utf8')).calls;
  assert.equal(calls.some(c => c[0] === 'pr' && c[1] === 'merge'), false, 'jamais gh pr merge');
  assert.equal(calls.some(c => c.includes('-X')), false, 'aucune écriture par l\'API de GitHub');
  const again = await apv(repo.dir, ['stack', 'merge', String(PUBLICATION), String(ARTICLE), '--order', NONCE, '--json'], env);
  assert.equal(again.code, 0);
  assert.equal(again.json().status, 'already_done');
});
