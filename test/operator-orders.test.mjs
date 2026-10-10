import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apv } from './cli-helpers.mjs';
import { waive } from './support/rules.mjs';
import { ARTICLE, DOMAIN, IDENTITY, NONCE, PUBLICATION, REPO, comment, fakeGh, fakeProduction, git, orderConfig, orderObjects, orderRepo, pullRequests, signer } from './support/orders.mjs';
import { configIssues } from '../dist/config/load.js';
import { readPublicKey, signedLines, verifySigned, publicKeys } from '../dist/orders/envelope.js';
import { verifyOrder, checkAttestation, mergeMessage, orderMergeCommits, readHistory } from '../dist/orders/order.js';
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
  assert.match(issues({ attestation: { url: 'http://127.0.0.1:8080/a?nonce={nonce}&challenge={challenge}' } }), /HTTPS attendu/, 'pas d\'exception pour la boucle locale');
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
  // Read as git log --first-parent HISTORY_LOG_FORMAT writes it: NUL separators, a chain of first parents; only a commit
  // of two parents whose second is the merged head, with the trailer in the last paragraph of its own message.
  const sha = n => String(n).repeat(40);
  const record = (id, parents, body) => `${sha(id)}\0${parents.join(' ')}\0${body}\0`;
  const history = readHistory([record(1, [sha(2), 'a'.repeat(40)], message), record(2, [sha(3)], message), record(3, [sha(4), 'c'.repeat(40)], message), record(4, [], 'racine')].join('\n') + '\n');
  assert.deepEqual(orderMergeCommits(history).map(c => [c.sha[0], c.step, c.digest[0]]), [['1', 'publication', 'f']], 'un parent, ou second parent différent : ignoré');
  assert.equal(readHistory(`${record(1, [sha(2)], 'x')}\n${record(3, [], 'y')}\n`), null, 'premier parent qui n\'est pas le commit suivant : refus');
  assert.equal(readHistory(`${'z'.repeat(40)}\0\0x\0\n`), null, 'identifiant hors 40 caractères hexadécimaux : refus');
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
  // The trapped script is allowed by the paths of this test: what is checked is the copy it runs from.
  const s = signer();
  const sc = scenario(t, { signer: s, repo: { content: 'texte écrit à la main', trap: true, config: (() => { const c = orderConfig(s.pem); c.rules.operatorOrders.paths.publication.push('scripts/verify-order.mjs'); return c; })() } });
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
  // apv audit merges does not launder them: no signed trace here, both stay unaccounted, said with their unverified trailer.
  git(sc.repo.dir, 'fetch', '-q', 'origin');
  const common = git(sc.repo.dir, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const audit = auditMerges(sc.repo.dir, common, 'origin/main', { since: new Date(Date.now() - 3_600_000).toISOString() });
  assert.deepEqual(audit.unaccounted.filter(u => u.order).map(u => u.order.step), ['article', 'publication']);
  assert.match(auditLines(audit).join('\n'), /pied Apv-Order non vérifié : ordre /);
});

test('fusion sur ordre : une fusion de l\'étape article faite par APV sans l\'étape publication rend l\'ordre inutilisable (nonce_used)', async t => {
  const sc = scenario(t);
  const dir = sc.repo.dir;
  const M = git(dir, 'rev-parse', 'main');
  const digest = createHash('sha256').update(Buffer.from(sc.objects.orderSigned.split('.')[0], 'base64url')).digest('hex');
  const tree = git(dir, 'merge-tree', '--write-tree', M, sc.repo.article).split('\n')[0];
  const c = git(dir, 'commit-tree', tree, '-p', M, '-p', sc.repo.article, '-m', mergeMessage({ pr: ARTICLE, step: 'article', nonce: NONCE, digest, head: sc.repo.article }));
  git(dir, 'push', '-q', 'origin', `${c}:refs/heads/main`);
  git(dir, 'switch', '-q', 'publication/x'); git(dir, 'merge', '-q', '--no-edit', c); git(dir, 'push', '-q', 'origin', 'publication/x'); git(dir, 'switch', '-q', 'main');
  sc.state.prs[PUBLICATION].headRefOid = git(dir, 'rev-parse', 'publication/x');
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

test('apv stack merge --order de bout en bout : faux gh, production simulée (fetch du processus), règles de l\'outil à la base exacte, deux fusions poussées', async t => {
  const s = signer();
  const repo = orderRepo(t, s.pem);
  const objects = orderObjects(s, repo.article);
  // The network of the process is replaced, never the declared address (HTTPS only): the command runs in this process.
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeProduction(s, objects.order).fetch;
  t.after(() => { globalThis.fetch = realFetch; });
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

// ---------------------------------------------------------------------------------------------------------------------
// Security review of PR #132 (c49686f): each proof of attack, inverted, must end in a refusal.

const put = (dir, path, text) => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text); };

test('E1 (PoC A) : le script de la tête de publication ne tourne jamais, même à l\'étape article (copie de la base d\'origine)', async t => {
  // The trapped script is allowed by the paths of this test: what is checked is the copy it runs from.
  const s = signer();
  const sc = scenario(t, { signer: s, repo: { trap: true, config: (() => { const c = orderConfig(s.pem); c.rules.operatorOrders.paths.publication.push('scripts/verify-order.mjs'); return c; })() } });
  const report = await sc.run();
  assert.equal(report.status, 'merged', report.reason);
  assert.equal(existsSync(sc.repo.witness), false, 'le script de H n\'est exécuté à aucune étape');
});

test('E1 (PoC B) : clés réécrites par la tête de publication, ordre et décision forgés : l\'étape article est refusée, le commit non signé jamais fusionné', async t => {
  const attacker = signer();
  const sc = scenario(t);
  const dir = sc.repo.dir;
  git(dir, 'switch', '-q', 'publication/x');
  put(dir, '.apv/config.json', JSON.stringify(orderConfig(attacker.pem), null, 2));
  git(dir, 'commit', '-qam', 'config'); git(dir, 'push', '-q', 'origin', 'publication/x');
  sc.state.prs[PUBLICATION].headRefOid = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'switch', '-q', 'article/x');
  put(dir, '.github/workflows/evil.yml', 'on: push\n');
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'non signé');
  const X = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'switch', '-q', 'main');
  const forged = orderObjects(attacker, X);
  const fakeProd = fakeProduction(attacker, forged.order, { mode: 'open' });
  let stepNow = 'publication';
  const report = await sc.run({
    fetch: (url, init) => (stepNow === 'publication' ? sc.production.fetch(url, init) : fakeProd.fetch(url, init)),
    beforePush: async step => {
      if (step !== 'publication') return;
      stepNow = 'article';
      git(dir, 'push', '-q', 'origin', 'article/x');
      sc.state.prs[ARTICLE].headRefOid = X;
      sc.state.comments[ARTICLE].push(comment(forged.decisionSigned), comment(forged.orderSigned));
    },
  });
  // A publication head that changes .apv/ is refused by APV itself (refusal list), before any merge.
  refused(report, 'paths');
  assert.throws(() => git(sc.repo.origin, 'merge-base', '--is-ancestor', X, 'main'), 'X n\'est jamais sur la cible');
});

test('M1 (PoC C) : un pied recopié dans un commit ordinaire de la cible ne consomme rien, les deux étapes sont fusionnées', async t => {
  const sc = scenario(t);
  const dir = sc.repo.dir;
  git(dir, 'commit', '-q', '--allow-empty', '-m', `Squash de la PR #99 (#99)\n\n* fix\n\nApv-Order: ${NONCE}\nApv-Order-Step: publication\n`);
  git(dir, 'push', '-q', 'origin', 'main');
  git(dir, 'switch', '-q', 'publication/x'); git(dir, 'merge', '-q', '--no-edit', 'main'); git(dir, 'push', '-q', 'origin', 'publication/x'); git(dir, 'switch', '-q', 'main');
  sc.state.prs[PUBLICATION].headRefOid = git(dir, 'rev-parse', 'publication/x');
  const report = await sc.run();
  assert.equal(report.status, 'merged', report.reason);
  assert.deepEqual(report.consumed, []);
  assert.deepEqual(report.merged.map(m => m.step), ['publication', 'article']);
  assert.equal(git(sc.repo.origin, 'ls-tree', '--name-only', 'main').split('\n').includes('served.txt'), true);
});

test('M1 : un commit de fusion au pied bien formé mais d\'une autre empreinte d\'ordre ne consomme rien et bloque l\'ordre (nonce_used, à examiner)', async t => {
  const sc = scenario(t);
  const dir = sc.repo.dir;
  const M = git(dir, 'rev-parse', 'main');
  git(dir, 'switch', '-q', '-c', 'autre', M); put(dir, 'autre.txt', 'x\n'); git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'autre');
  const E = git(dir, 'rev-parse', 'HEAD'); git(dir, 'switch', '-q', 'main');
  const tree = git(dir, 'merge-tree', '--write-tree', M, E).split('\n')[0];
  const c = git(dir, 'commit-tree', tree, '-p', M, '-p', E, '-m', mergeMessage({ pr: 21, step: 'publication', nonce: NONCE, digest: '0'.repeat(64), head: E }));
  git(dir, 'push', '-q', 'origin', `${c}:refs/heads/main`);
  git(dir, 'switch', '-q', 'publication/x'); git(dir, 'merge', '-q', '--no-edit', 'origin/main'); git(dir, 'push', '-q', 'origin', 'publication/x'); git(dir, 'switch', '-q', 'main');
  sc.state.prs[PUBLICATION].headRefOid = git(dir, 'rev-parse', 'publication/x');
  const report = await sc.run();
  refused(report, 'nonce_used');
  assert.equal(git(sc.repo.origin, 'ls-tree', '--name-only', 'main').split('\n').includes('served.txt'), false);
});

test('E2 (PoC D) : un commit de fusion poussé à la main avec un pied forgé reste signalé par apv audit merges', async t => {
  const sc = scenario(t);
  const dir = sc.repo.dir;
  const M = git(dir, 'rev-parse', 'main');
  git(dir, 'switch', '-q', '-c', 'evil', M);
  put(dir, 'evil.txt', 'non relu\n'); git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'evil');
  const E = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'switch', '-q', 'main');
  const tree = git(dir, 'merge-tree', '--write-tree', M, E).split('\n')[0];
  const c = git(dir, 'commit-tree', tree, '-p', M, '-p', E, '-m', `Merge\n\nApv-Order: 12345678-1234-4234-8234-123456789abc\nApv-Order-Step: publication\nApv-Merged-Head: ${E}\n`);
  git(dir, 'push', '-q', 'origin', `${c}:refs/heads/main`);
  git(dir, 'fetch', '-q', 'origin');
  const audit = auditMerges(dir, join(dir, '.git'), 'origin/main', { since: new Date(Date.now() - 3_600_000).toISOString() });
  const found = audit.unaccounted.find(u => u.sha === c);
  assert.ok(found, 'toujours signalé');
  assert.equal(found.order, undefined, 'pied incomplet (sans empreinte) : simple fusion signalée');
});

test('faibles : branche HEAD, tête qui n\'est pas un commit de 40 caractères, PR de publication d\'une autre branche que celle de l\'ordre refusées', async t => {
  refused(await scenario(t, { prs: { [PUBLICATION]: { headRefName: 'HEAD' } } }).run(), 'pr');
  refused(await scenario(t, { prs: { [PUBLICATION]: { headRefOid: 'main' } } }).run(), 'pr');
  const s = signer();
  const config = orderConfig(s.pem, { publicationBranch: 'publication/{slug}' });
  const other = scenario(t, { signer: s, repo: { config }, prs: { [PUBLICATION]: { headRefName: 'publication/y' } } });
  refused(await other.run(), 'pr');
  const right = scenario(t, { signer: s, repo: { config } });
  assert.equal((await right.run()).status, 'merged');
});

test('faible : la cible rafraîchie après une poussée refusée qui change rules.operatorOrders ou batch.setup est refusée (config)', async t => {
  const sc = scenario(t);
  const dir = sc.repo.dir;
  let done = false;
  const report = await sc.run({ beforePush: async () => {
    if (done) return; done = true;
    const config = orderConfig(signer().pem);
    put(dir, '.apv/config.json', JSON.stringify(config, null, 2));
    git(dir, 'commit', '-qam', 'clés changées'); git(dir, 'push', '-q', 'origin', 'main');
    git(dir, 'switch', '-q', 'publication/x'); git(dir, 'merge', '-q', '--no-edit', 'main'); git(dir, 'push', '-q', 'origin', 'publication/x'); git(dir, 'switch', '-q', 'main');
  } });
  refused(report, 'config');
});

test('faible : attestation en HTTP refusée, boucle locale comprise, sans aucun mode qui la permette', () => {
  const s = signer();
  const raw = { rules: { operatorOrders: { ...orderConfig(s.pem).rules.operatorOrders, attestation: { url: 'http://127.0.0.1:8080/a?nonce={nonce}&challenge={challenge}' } } } };
  for (const env of [{}, { [['APV', 'ATTESTATION', 'LOOPBACK'].join('_')]: '1' }]) {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try { assert.match(configIssues(raw).issues.map(i => i.message).join('\n'), /HTTPS attendu/); }
    finally { for (const key of Object.keys(env)) if (!(key in saved)) delete process.env[key]; }
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// The tree pushed is the tree verified (faible 3), and a push bounded in time (faible 4), through a fake git.

/** processGit whose `merge-tree` answers `forge(tree, args)` instead of the real tree (a git that lies about the merge). */
function lyingGit(forge) {
  const real = processGit({ ...process.env, ...IDENTITY });
  return { run: async (cwd, args) => {
    const r = await real.run(cwd, args);
    if (!args.includes('merge-tree') || !r.ok) return r;
    const tree = r.stdout.trim().split('\n')[0];
    return { ...r, stdout: `${forge(tree, args, cwd) ?? tree}\n` };
  } };
}
/** A tree: `tree` with `path` (nested or not) set to a blob of `text`, written through a temporary index. */
function treeWith(cwd, tree, path, text) {
  const env = { ...process.env, GIT_INDEX_FILE: join(cwd, '.git', `index-faux-${process.pid}`) };
  const run = (args, input) => execFileSync('git', args, { cwd, env, input, encoding: 'utf8' }).trim();
  const blob = run(['hash-object', '-w', '--stdin'], text);
  run(['read-tree', tree]);
  run(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`]);
  return run(['write-tree']);
}

test('faible 3 : étape publication, un arbre de fusion différent de l\'arbre de H est refusé (merge_conflict), rien n\'est poussé', async t => {
  const sc = scenario(t);
  const before = sc.main();
  const report = await sc.run({ git: lyingGit((tree, _args, cwd) => treeWith(cwd, tree, 'ajout.txt', 'hors de H\n')) });
  refused(report, 'merge_conflict');
  assert.match(report.reason, /n'est pas celui de la tête vérifiée/);
  assert.equal(sc.main(), before);
  assert.equal(sc.production.challenges.length, 0, 'refusé avant l\'attestation');
});

test('faible 3 : étape article, un chemin que la PR ne change pas, ou un blob différent du commit signé, est refusé (merge_conflict)', async t => {
  for (const [path, text] of [['hors-pr.txt', 'jamais dans la PR\n'], ['docs/articles/x/proposition.json', '{"sujet":"autre"}\n']]) {
    const sc = scenario(t);
    const report = await sc.run({ git: lyingGit((tree, args, cwd) => (args.includes(sc.repo.article) ? treeWith(cwd, tree, path, text) : null)) });
    assert.equal(report.status, 'refused', path);
    assert.equal(report.code, 'merge_conflict', report.reason);
    assert.match(report.reason, new RegExp(`change ${path.replace(/[.]/g, '\\.')} autrement que le commit signé`));
    assert.deepEqual(report.merged.map(m => m.step), ['publication'], 'seule l\'étape publication, vérifiée, est poussée');
  }
});

test('faible 4 : poussée qui dépasse le délai, refus push « issue inconnue » ; la relance lit le pied et ne refait pas l\'étape', async t => {
  const sc = scenario(t);
  // A fake git first in PATH: the push lands, then the process hangs past the limit (the worst case: done but unknown).
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const bin = join(sc.repo.root, 'faux-git');
  mkdirSync(bin);
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nfor a in "$@"; do if [ "$a" = push ]; then ${realGit} "$@"; s=$?; sleep 5; exit $s; fi; done\nexec ${realGit} "$@"\n`, { mode: 0o755 });
  const slow = await sc.run({ env: { ...process.env, ...IDENTITY, PATH: `${bin}:${process.env.PATH}` }, pushTimeoutMs: 1000 });
  refused(slow, 'push');
  assert.match(slow.reason, /issue inconnue/);
  const landed = sc.main();
  assert.match(git(sc.repo.origin, 'log', '-1', '--format=%B', landed), /^Apv-Order-Step: publication$/m, 'la poussée a bien eu lieu');
  const again = await sc.run();
  assert.equal(again.status, 'merged', again.reason);
  assert.deepEqual(again.consumed, ['publication']);
  assert.deepEqual(again.merged.map(m => m.step), ['article']);
  assert.equal(git(sc.repo.origin, 'rev-parse', `${again.merged[0].mergeCommit}^1`), landed, 'l\'étape article part de la fusion de publication poussée');
  assert.equal(git(sc.repo.origin, 'log', '--first-parent', '--format=%B', 'main').match(/^Apv-Order-Step: publication$/gm).length, 1, 'une seule fusion de publication');
});

// ---------------------------------------------------------------------------------------------------------------------
// Counter-review of PR #132 at a0ffa2f: E1-bis and the weak findings, each proof inverted into a refusal.

test('E1-bis (PoC F) : reprise après une étape publication, cible réécrite par l\'agent : la base de confiance reste le premier parent de la fusion de publication, jamais la cible', async t => {
  const s = signer();
  const attacker = signer();
  const sc = scenario(t, { signer: s });
  const dir = sc.repo.dir;
  // First run: the publication step is merged, the article step stopped by the production (superseded).
  let calls = 0;
  const first = await sc.run({ fetch: async (u, i) => (++calls === 1 ? sc.production.fetch(u, i) : new Response('{"code":"superseded"}', { status: 404 })) });
  assert.equal(first.code, 'attestation', first.reason);
  assert.deepEqual(first.merged.map(m => m.step), ['publication']);
  // The agent pushes on the target itself: its key in .apv/config.json and a trapped verification script; then an
  // unsigned commit X on the article branch, a new publication head on the new target, a forged decision and order.
  const witness = join(sc.repo.root, 'temoin-F');
  git(dir, 'fetch', '-q', 'origin');
  git(dir, 'switch', '-q', '-c', 'agent', 'origin/main');
  put(dir, '.apv/config.json', JSON.stringify(orderConfig(attacker.pem), null, 2));
  put(dir, 'scripts/verify-order.mjs', `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(witness)}, 'exécuté');\nconsole.log('{"ok":true}');\n`);
  git(dir, 'commit', '-qam', 'clé de l\'agent'); git(dir, 'push', '-q', 'origin', 'HEAD:main');
  git(dir, 'switch', '-q', '-c', 'x2', 'origin/article/x');
  put(dir, '.github/workflows/evil.yml', 'on: push\n'); git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'non signé');
  const X = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'push', '-q', 'origin', `${X}:refs/heads/article/x`);
  sc.state.prs[ARTICLE].headRefOid = X;
  git(dir, 'switch', '-q', 'agent');
  put(dir, 'h2.txt', 'h2\n'); git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'H2');
  git(dir, 'push', '-q', '--force', 'origin', 'HEAD:refs/heads/publication/x');
  sc.state.prs[PUBLICATION].headRefOid = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'switch', '-q', 'main');
  const forged = orderObjects(attacker, X, { seq: 99, ref: '22222222-2222-4333-8444-555555555555' });
  sc.state.comments[ARTICLE].push(comment(forged.decisionSigned), comment(forged.orderSigned));
  const second = await sc.run({ fetch: fakeProduction(attacker, forged.order).fetch });
  assert.equal(second.status, 'refused', second.reason);
  assert.equal(second.trustedBase, first.merged[0].base, 'premier parent de la fusion de publication');
  assert.deepEqual(second.merged, []);
  assert.equal(existsSync(witness), false, 'le script poussé par l\'agent ne tourne pas');
  assert.throws(() => git(sc.repo.origin, 'merge-base', '--is-ancestor', X, 'main'), 'X jamais fusionné');
});

test('faible 1 (PoC E) : une fusion de publication forgée mais bien formée (empreinte réelle) ne fait pas sauter l\'étape : refus nonce_used', async t => {
  for (const exact of [false, true]) {
    const sc = scenario(t);
    const dir = sc.repo.dir;
    const digest = createHash('sha256').update(Buffer.from(sc.objects.orderSigned.split('.')[0], 'base64url')).digest('hex');
    const M = git(dir, 'rev-parse', 'main');
    git(dir, 'switch', '-q', '-c', 'y', M); put(dir, 'y.txt', 'y\n'); git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'y');
    const Y = git(dir, 'rev-parse', 'HEAD'); git(dir, 'switch', '-q', 'main');
    const tree = git(dir, 'merge-tree', '--write-tree', M, Y).split('\n')[0];
    // Not the message APV writes, or exactly it but with a second parent that is not the publication head given.
    const message = exact ? mergeMessage({ pr: PUBLICATION, step: 'publication', nonce: NONCE, digest, head: Y })
      : `Merge pull request #30 from y\n\nApv-Order: ${NONCE}\nApv-Order-Step: publication\nApv-Order-Sha256: ${digest}\nApv-Merged-Head: ${Y}\n`;
    git(dir, 'push', '-q', 'origin', `${git(dir, 'commit-tree', tree, '-p', M, '-p', Y, '-m', message)}:refs/heads/main`);
    const report = await sc.run();
    refused(report, 'nonce_used');
    assert.equal(git(sc.repo.origin, 'ls-tree', '--name-only', 'main').split('\n').includes('served.txt'), false);
    assert.equal(git(dir, 'for-each-ref', 'refs/apv/'), '', 'aucune référence privée laissée');
  }
});

test('E1-bis (b) : une tête de publication qui change .apv/ ou pipeline.v2.json est refusée par APV lui-même (paths)', async t => {
  for (const [path, text] of [['.apv/DECISIONS.json', '{}\n'], ['pipeline.v2.json', '{}\n']]) {
    const sc = scenario(t);
    const dir = sc.repo.dir;
    git(dir, 'switch', '-q', 'publication/x'); put(dir, path, text); git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'config');
    git(dir, 'push', '-q', 'origin', 'publication/x'); git(dir, 'switch', '-q', 'main');
    sc.state.prs[PUBLICATION].headRefOid = git(dir, 'rev-parse', 'publication/x');
    const report = await sc.run();
    refused(report, 'paths');
    assert.match(report.reason, new RegExp(`refuse toujours \\(${path.replace(/[.]/g, '\\.')}\\)`));
  }
});

test('faible 3 : références privées propres au lancement, celles d\'un autre lancement jamais touchées, toutes retirées à la fin', async t => {
  const sc = scenario(t);
  const dir = sc.repo.dir;
  git(dir, 'update-ref', `refs/apv/orders/${NONCE}/autre-lancement/cible`, 'main');
  let seen = [];
  const report = await sc.run({ beforePush: async () => { seen = git(dir, 'for-each-ref', '--format=%(refname)', `refs/apv/orders/${NONCE}/`).split('\n'); } });
  assert.equal(report.status, 'merged', report.reason);
  const own = seen.filter(r => !r.includes('/autre-lancement/'));
  assert.ok(own.length >= 2);
  assert.equal(new Set(own.map(r => r.split('/')[4])).size, 1, 'un seul identifiant de lancement');
  assert.match(own[0].split('/')[4], /^[0-9a-f-]{36}$/);
  assert.equal(git(dir, 'for-each-ref', '--format=%(refname)', 'refs/apv/'), `refs/apv/orders/${NONCE}/autre-lancement/cible`);
});

test('faible 4 : les règles avant fusion sont vérifiées contre la base exacte lue par APV, jamais une branche distante locale', async t => {
  const sc = scenario(t);
  const dir = sc.repo.dir;
  git(dir, 'update-ref', '-d', 'refs/remotes/origin/main');
  const calls = [];
  const report = await sc.run({ rules: async (head, base) => { calls.push([head, base]); return []; } });
  assert.equal(report.status, 'merged', report.reason);
  assert.deepEqual(calls, [[sc.repo.publication, sc.repo.base], [sc.repo.article, report.merged[0].mergeCommit]]);
});

// ---------------------------------------------------------------------------------------------------------------------
// Third review of PR #132 at 6823cba: G (history read through separators a message may hold), the allow list of paths,
// the trusted base given to the command of the project.

test('G (PoC G) : un faux enregistrement de git log caché dans le message d\'un commit ordinaire ne choisit jamais la base de confiance', async t => {
  const s = signer();
  const attacker = signer();
  const sc = scenario(t, { signer: s });
  const dir = sc.repo.dir;
  const witness = join(sc.repo.root, 'temoin-G');
  git(dir, 'switch', '-q', '-c', 'agent', 'main');
  put(dir, '.apv/config.json', JSON.stringify(orderConfig(attacker.pem), null, 2));
  put(dir, 'scripts/verify-order.mjs', `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(witness)}, 'exécuté');\nconsole.log('{"ok":true}');\n`);
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'outil'); git(dir, 'push', '-q', 'origin', 'agent');
  const X = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'switch', '-q', '-c', 'y', sc.repo.article);
  put(dir, '.github/workflows/evil.yml', 'on: push\n'); git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'non signé');
  const Y = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'push', '-q', '--force', 'origin', `${Y}:refs/heads/article/x`);
  sc.state.prs[ARTICLE].headRefOid = Y;
  const forged = orderObjects(attacker, Y, { seq: 99, ref: '22222222-2222-4333-8444-555555555555' });
  sc.state.comments[ARTICLE].push(comment(forged.decisionSigned), comment(forged.orderSigned));
  const digest = createHash('sha256').update(Buffer.from(forged.orderSigned.split('.')[0], 'base64url')).digest('hex');
  const H = sc.repo.publication;
  const fake = `${'f'.repeat(40)}\x1f${X} ${H}\x1fApv-Order: ${NONCE}\nApv-Order-Step: publication\nApv-Order-Sha256: ${digest}\nApv-Merged-Head: ${H}\x1f${mergeMessage({ pr: PUBLICATION, step: 'publication', nonce: NONCE, digest, head: H })}`;
  git(dir, 'switch', '-q', 'main');
  put(dir, 'docs/note.md', 'note\n'); git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', `docs : une note\n\nRien de spécial.\x1e${fake}`);
  git(dir, 'push', '-q', 'origin', 'main');
  const report = await sc.run({ fetch: fakeProduction(attacker, forged.order).fetch });
  assert.equal(report.status, 'refused', report.reason);
  assert.notEqual(report.trustedBase, X);
  assert.equal(report.trustedBase, git(dir, 'rev-parse', 'main'), 'la cible elle-même : aucune fusion sur ordre dans son histoire');
  assert.deepEqual(report.merged, []);
  assert.equal(existsSync(witness), false);
  assert.throws(() => git(sc.repo.origin, 'merge-base', '--is-ancestor', Y, 'main'));
  // The audit reads the same history with NUL separators: the real commit is listed, never a forged record.
  git(dir, 'fetch', '-q', 'origin');
  const audit = auditMerges(dir, join(dir, '.git'), 'origin/main', { since: new Date(Date.now() - 3_600_000).toISOString() });
  assert.ok(audit.unaccounted.some(u => u.sha === git(dir, 'rev-parse', 'main')));
  assert.equal(audit.unaccounted.some(u => u.sha === 'f'.repeat(40)), false);
});

test('chemins : hors de la liste de l\'étape publication, puis de l\'étape article, refusés (paths)', async t => {
  const pub = scenario(t);
  git(pub.repo.dir, 'switch', '-q', 'publication/x'); put(pub.repo.dir, 'src/autre.ts', 'x\n'); git(pub.repo.dir, 'add', '.'); git(pub.repo.dir, 'commit', '-qm', 'hors liste');
  git(pub.repo.dir, 'push', '-q', 'origin', 'publication/x'); git(pub.repo.dir, 'switch', '-q', 'main');
  pub.state.prs[PUBLICATION].headRefOid = git(pub.repo.dir, 'rev-parse', 'publication/x');
  const first = await pub.run();
  refused(first, 'paths');
  assert.match(first.reason, /hors de rules\.operatorOrders\.paths\.publication \(src\/autre\.ts\)/);
  // Article: a second file beside the proposal, in the signed commit itself.
  const s = signer();
  const art = scenario(t, { signer: s, repo: { articleExtra: { 'docs/autre.md': 'x\n' } } });
  const report = await art.run();
  assert.equal(report.code, 'paths', report.reason);
  assert.match(report.reason, /paths\.article \(docs\/autre\.md\)/);
  assert.deepEqual(report.merged.map(m => m.step), ['publication']);
});

test('chemins : {slug} d\'un autre article refusé, liste absente refusée, liste de refus d\'APV même sous un motif permis', async t => {
  const s = signer();
  const slugged = orderConfig(s.pem, { paths: { publication: ['content/{slug}.txt', 'served.txt'], article: ['docs/articles/{slug}/proposition.json'] } });
  const other = scenario(t, { signer: s, repo: { config: slugged } });
  git(other.repo.dir, 'switch', '-q', 'publication/x'); put(other.repo.dir, 'content/autre-article.txt', 'x\n'); git(other.repo.dir, 'add', '.'); git(other.repo.dir, 'commit', '-qm', 'autre slug');
  git(other.repo.dir, 'push', '-q', 'origin', 'publication/x'); git(other.repo.dir, 'switch', '-q', 'main');
  other.state.prs[PUBLICATION].headRefOid = git(other.repo.dir, 'rev-parse', 'publication/x');
  refused(await other.run(), 'paths');
  const own = scenario(t, { signer: s, repo: { config: slugged } });
  git(own.repo.dir, 'switch', '-q', 'publication/x'); put(own.repo.dir, 'content/x.txt', 'x\n'); git(own.repo.dir, 'add', '.'); git(own.repo.dir, 'commit', '-qm', 'son slug');
  git(own.repo.dir, 'push', '-q', 'origin', 'publication/x'); git(own.repo.dir, 'switch', '-q', 'main');
  own.state.prs[PUBLICATION].headRefOid = git(own.repo.dir, 'rev-parse', 'publication/x');
  assert.equal((await own.run()).status, 'merged', 'content/x.txt : le slug signé');
  const config = orderConfig(s.pem);
  delete config.rules.operatorOrders.paths;
  const absent = await scenario(t, { signer: s, repo: { config } }).run();
  refused(absent, 'paths');
  assert.match(absent.reason, /non déclaré/);
  const docs = orderConfig(s.pem, { paths: { publication: ['served.txt', 'docs/*'], article: ['docs/articles/{slug}/proposition.json'] } });
  const deny = scenario(t, { signer: s, repo: { config: docs } });
  git(deny.repo.dir, 'switch', '-q', 'publication/x'); put(deny.repo.dir, 'docs/CLAUDE.md', 'consigne\n'); git(deny.repo.dir, 'add', '.'); git(deny.repo.dir, 'commit', '-qm', 'consigne');
  git(deny.repo.dir, 'push', '-q', 'origin', 'publication/x'); git(deny.repo.dir, 'switch', '-q', 'main');
  deny.state.prs[PUBLICATION].headRefOid = git(deny.repo.dir, 'rev-parse', 'publication/x');
  const denied = await deny.run();
  refused(denied, 'paths');
  assert.match(denied.reason, /refuse toujours \(docs\/CLAUDE\.md\)/);
});

test('chemins et gabarits : le chargeur refuse un motif qui couvre la liste de refus et {{base}} sans {{trusted}}', () => {
  const s = signer();
  const base = orderConfig(s.pem).rules.operatorOrders;
  const issues = raw => configIssues({ rules: { operatorOrders: { ...base, ...raw } } }).issues.map(i => i.message).join('\n');
  assert.match(issues({ paths: { publication: ['*'], article: ['docs/articles/{slug}/proposition.json'] } }), /paths\.publication : le motif \* couvre un chemin que la fusion sur ordre refuse toujours/);
  assert.match(issues({ paths: { publication: ['.github/*'], article: ['x'] } }), /couvre/);
  assert.match(issues({ paths: { publication: ['src/{a,b}.ts'], article: ['x'] } }), /illisible/);
  assert.match(issues({ verify: { publication: ['node', 'v.mjs', '{{base}}'] } }), /\{\{base\}\} sans \{\{trusted\}\}/);
  assert.deepEqual(configIssues(orderConfig(s.pem)).issues, []);
});

test('{{trusted}} vaut la base de confiance aux deux étapes, {{base}} la base de la fusion (M, puis la fusion de publication)', async t => {
  const s = signer();
  const config = orderConfig(s.pem);
  const record = join(mkdtempSync(join(tmpdir(), 'apv3-gabarits-')), 'appels.jsonl');
  t.after(() => rmSync(dirname(record), { recursive: true, force: true }));
  config.rules.operatorOrders.verify.publication.push(record);
  const sc = scenario(t, { signer: s, repo: { config } });
  const report = await sc.run();
  assert.equal(report.status, 'merged', report.reason);
  const calls = readFileSync(record, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(calls, [
    { trusted: sc.repo.base, base: sc.repo.base, head: sc.repo.publication, step: 'publication' },
    { trusted: sc.repo.base, base: report.merged[0].mergeCommit, head: sc.repo.article, step: 'article' },
  ]);
});

// ---------------------------------------------------------------------------------------------------------------------
// Fourth review of PR #132 at 34c87f0: names a case- or dot-insensitive disk folds, broad globs, file modes.

/** A publication head with `edit(dir)` applied on top of the publication branch; the pull request points to it. */
function publicationEdit(sc, edit) {
  const dir = sc.repo.dir;
  git(dir, 'switch', '-q', 'publication/x'); edit(dir); git(dir, 'commit', '-q', '-m', 'modification');
  git(dir, 'push', '-q', 'origin', 'publication/x'); git(dir, 'switch', '-q', 'main');
  sc.state.prs[PUBLICATION].headRefOid = git(dir, 'rev-parse', 'publication/x');
}

test('faible 1 : noms que Windows ou macOS replient (point ou espace final, caractère invisible, nom court 8.3) refusés', async t => {
  const { refusedPath } = await import('../dist/orders/paths.js');
  for (const path of ['.claude./settings.json', '.github /workflows/x.yml', '.c‌laude/settings.json', 'PROGRA~1/x.txt', 'docs/note.md.', 'é/x.txt', 'a\tb/x']) {
    assert.equal(refusedPath(path), true, JSON.stringify(path));
  }
  assert.equal(refusedPath('src/lib/server/guides/content/mon-article.ts'), false);
  const s = signer();
  const config = orderConfig(s.pem, { paths: { publication: ['served.txt', '*/settings.json'], article: ['docs/articles/{slug}/proposition.json'] } });
  const sc = scenario(t, { signer: s, repo: { config } });
  publicationEdit(sc, dir => { put(dir, '.claude./settings.json', '{"hooks":{}}\n'); git(dir, 'add', '.'); });
  const report = await sc.run();
  refused(report, 'paths');
  assert.match(report.reason, /refuse toujours \(\.claude\.\/settings\.json\)/);
});

test('faible 2 : ** refusé par le chargeur, liste de refus complétée (paquets, déploiement, environnement, configuration de la pile, éditeur)', async () => {
  const { refusedPath } = await import('../dist/orders/paths.js');
  for (const path of ['.npmrc', '.yarnrc', '.yarnrc.yml', '.pnpmfile.cjs', 'vercel.json', '.env', '.env.production', 'svelte.config.js', 'vite.config.ts',
    'tsconfig.json', 'jsconfig.json', 'src/hooks.server.ts', 'src/hooks.client.js', '.vscode/settings.json', '.devcontainer/devcontainer.json', '.envrc', 'app/.npmrc']) {
    assert.equal(refusedPath(path), true, path);
  }
  const s = signer();
  const base = orderConfig(s.pem).rules.operatorOrders;
  const issues = raw => configIssues({ rules: { operatorOrders: { ...base, ...raw } } }).issues.map(i => i.message).join('\n');
  assert.match(issues({ paths: { publication: ['src/**/x.ts'], article: ['docs/articles/{slug}/proposition.json'] } }), /paths\.publication : \*\* refusé/);
  assert.match(issues({ paths: { publication: ['served.txt'], article: ['docs/**'] } }), /paths\.article : \*\* refusé/);
  assert.match(issues({ paths: { publication: ['*.json'], article: ['x'] } }), /couvre/, 'un * qui couvre vercel.json ou tsconfig.json');
  assert.deepEqual(issues({ paths: { publication: ['src/lib/server/guides/content/{slug}.ts', 'src/*/types.ts'], article: ['docs/articles/{slug}/proposition.json'] } }), '');
});

test('faible 3 : seul le mode 100644 passe ; exécutable, lien symbolique et sous-module refusés ; suppression acceptée seulement si la liste la permet', async t => {
  const s = signer();
  const config = orderConfig(s.pem, { paths: { publication: ['served.txt', 'lien.txt', 'module', 'README.md'], article: ['docs/articles/{slug}/proposition.json'] } });
  const cases = [
    ['exécutable', dir => { chmodSync(join(dir, 'served.txt'), 0o755); git(dir, 'add', 'served.txt'); }, /served\.txt \(100755\)/],
    ['lien symbolique', dir => { symlinkSync('served.txt', join(dir, 'lien.txt')); git(dir, 'add', 'lien.txt'); }, /lien\.txt \(120000\)/],
    ['sous-module', dir => { git(dir, 'update-index', '--add', '--cacheinfo', `160000,${sc0Base},module`); }, /module \(160000\)/],
  ];
  let sc0Base = null;
  for (const [name, edit, reason] of cases) {
    const sc = scenario(t, { signer: s, repo: { config } });
    sc0Base = sc.repo.base;
    publicationEdit(sc, edit);
    const report = await sc.run();
    refused(report, 'paths');
    assert.match(report.reason, reason, name);
  }
  const deleted = scenario(t, { signer: s, repo: { config } });
  publicationEdit(deleted, dir => git(dir, 'rm', '-q', 'README.md'));
  assert.equal((await deleted.run()).status, 'merged', 'suppression d\'un chemin que la liste permet');
  const outside = scenario(t, { signer: s });
  publicationEdit(outside, dir => git(dir, 'rm', '-q', 'README.md'));
  refused(await outside.run(), 'paths');
});
