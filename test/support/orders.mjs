// Helpers of the tests of the merge on a signed operator order (src/orders): a signer with a key generated for the
// tests (never a real key), a repository with an origin, two pull requests and the verification command of the project
// at the base, a fake GitHub and a fake production, both in process.
import { createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { canonicalJson } from '../../dist/orders/envelope.js';

export const DOMAIN = 'projet-test';
export const REPO = 'o/r';
export const PUBLICATION = 21;
export const ARTICLE = 20;
export const NONCE = '0b8f6c3e-5d1a-4c2b-9e7f-1a2b3c4d5e6f';
export const IDENTITY = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@localhost', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@localhost' };

/** A signer: an Ed25519 key pair made for the tests, its public PEM and key id. */
export function signer() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const raw = Buffer.from(createPublicKey(pem).export({ format: 'jwk' }).x, 'base64url');
  const keyId = createHash('sha256').update(raw).digest('hex').slice(0, 16);
  /** `<payload>.<signature>` of `value` signed as `kind` (the key id added), under `domain`; `prefixKind`: the kind of the prefix. */
  const signed = (kind, value, domain = DOMAIN, prefixKind = kind) => {
    const text = canonicalJson({ keyId, ...value, kind });
    const bytes = Buffer.from(text, 'utf8');
    const signature = sign(null, Buffer.concat([Buffer.from(`${domain}:signed:1:${prefixKind}\n`, 'ascii'), bytes]), privateKey);
    return `${bytes.toString('base64url')}.${signature.toString('base64url')}`;
  };
  return { pem, keyId, privateKey, signed, privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() };
}

/** A comment carrying one signed line. */
export const comment = (signed, title = 'Décision de l\'opérateur', domain = DOMAIN) => `**${title}**\n\n<!-- ${domain}-signed:1 ${signed} -->`;

const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args],
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...IDENTITY } }).trim();
export { git };

/**
 * The verification command of the project, committed at the base: for the publication step, the served file of the head
 * must be the `content` the order signed (else `content`); for the article step, the head must be the signed commit.
 * It reads the head through Git only. `{{base}} {{head}} {{step}}` are its arguments, the verified order its input.
 */
const VERIFY = `import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const [, , base, head, step] = process.argv;
const input = JSON.parse(readFileSync(0, 'utf8'));
const answer = (ok, code) => { console.log(JSON.stringify(ok ? { ok, step } : { ok, code })); process.exit(ok ? 0 : 1); };
if (!/^[0-9a-f]{40}$/.test(base)) answer(false, 'base');
if (step === 'article') answer(head === input.order.articleSha, 'head_moved');
const served = execFileSync('git', ['show', head + ':served.txt'], { encoding: 'utf8' }).trim();
answer(served === input.order.content, 'content');
`;

export function orderConfig(pem, overrides = {}) {
  return { rules: { operatorOrders: { domain: DOMAIN, publicKeys: [pem], attestation: { url: 'https://production.test/api/attestation?nonce={nonce}&challenge={challenge}' },
    verify: { publication: [process.execPath, 'scripts/verify-order.mjs', '{{base}}', '{{head}}', '{{step}}'], timeoutMs: 60_000 }, ...overrides } } };
}

/**
 * The repository: a bare origin and a clone; main with the configuration and the verification command; article/x adds
 * the proposal (the article pull request, #20), publication/x adds the served file (#21, `content` given). Returns the
 * heads and a remover.
 */
export function orderRepo(t, pem, { content = 'bonjour', config = orderConfig(pem), trap = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'apv3-ordre-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, 'origin.git');
  const dir = join(root, 'repo');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, dir);
  const put = (path, text) => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text); };
  put('.apv/config.json', `${JSON.stringify(config, null, 2)}\n`);
  put('scripts/verify-order.mjs', VERIFY);
  put('README.md', 'Projet\n');
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'base'); git(dir, 'push', '-q', 'origin', 'main');
  const base = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'switch', '-q', '-c', 'article/x', base);
  put('docs/articles/x/proposition.json', '{"sujet":"x"}\n');
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'article'); git(dir, 'push', '-q', 'origin', 'article/x');
  const article = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'switch', '-q', '-c', 'publication/x', base);
  put('served.txt', `${content}\n`);
  // A trap: the head changes the verification command so that it writes a witness and accepts anything.
  const witness = join(root, 'temoin');
  if (trap) put('scripts/verify-order.mjs', `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(witness)}, 'exécuté');\nconsole.log('{"ok":true}');\n`);
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'publication'); git(dir, 'push', '-q', 'origin', 'publication/x');
  const publication = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'switch', '-q', 'main');
  return { root, origin, dir, base, article, publication, witness };
}

/** The signed objects of an order on the article pull request at `articleSha`. */
export function orderObjects(s, articleSha, { seq = 7, now = Date.now(), life = 7 * 24 * 3600 * 1000, content = 'bonjour', nonce = NONCE, ref = '11111111-2222-4333-8444-555555555555' } = {}) {
  const issuedAt = new Date(now - 3_600_000).toISOString();
  const decision = { format: 1, repo: REPO, pr: ARTICLE, slug: 'x', decision: 'validate', articleSha, choices: {}, requestId: ref, seq };
  const order = { format: 1, repo: REPO, slug: 'x', articlePr: ARTICLE, articleSha, proposalSha256: 'a'.repeat(64), choices: {}, decisionRef: ref, decisionSeq: seq,
    issuedAt, expiresAt: new Date(Date.parse(issuedAt) + life).toISOString(), nonce, content };
  return { decision, order, decisionSigned: s.signed('decision', decision), orderSigned: s.signed('publish_order', order) };
}

/** The pull requests as `gh pr view` gives them. */
export function pullRequests(repo, extra = {}) {
  const pr = (number, branch, head) => ({ number, state: 'OPEN', isDraft: true, baseRefName: 'main', headRefName: branch, headRefOid: head, isCrossRepository: false,
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: [], url: `https://github.com/o/r/pull/${number}` });
  return { [ARTICLE]: { ...pr(ARTICLE, 'article/x', repo.article), ...extra[ARTICLE] }, [PUBLICATION]: { ...pr(PUBLICATION, 'publication/x', repo.publication), ...extra[PUBLICATION] } };
}

/** A fake `gh` in process: `gh pr view` and the comments of the article pull request; every call kept. */
export function fakeGh(state) {
  const calls = [];
  const gh = async args => {
    calls.push(args);
    const ok = stdout => ({ args, status: 0, stdout, stderr: '', error: null });
    if (args[0] === 'pr' && args[1] === 'view') {
      const pr = state.prs[args[2]];
      return pr ? ok(JSON.stringify(pr)) : { args, status: 1, stdout: '', stderr: 'no pull requests found', error: null };
    }
    const path = args.find(a => a.startsWith('repos/'));
    const m = /^repos\/o\/r\/issues\/(\d+)\/comments$/.exec(path ?? '');
    if (args[0] === 'api' && m && args.includes('--paginate')) return ok((state.comments[m[1]] ?? []).map(b => `${JSON.stringify(b)}\n`).join(''));
    return { args, status: 1, stdout: '', stderr: 'fake gh: unexpected call', error: null };
  };
  return { gh, calls };
}

/**
 * A fake production: answers the attestation of the order `order` signed by `s` when `state.mode` is `open`; other
 * modes: `down` (network error), a closed reason (404 with that code), `wrong-challenge`, `other-key` (signed by
 * `state.other`), `decision` (a signed decision instead), `wrong-nonce`. Every challenge asked is kept.
 */
export function fakeProduction(s, order, state = { mode: 'open' }) {
  const challenges = [];
  const fetch = async url => {
    const query = new URL(url).searchParams;
    const challenge = query.get('challenge');
    challenges.push(challenge);
    if (query.get('nonce') !== order.nonce) return new Response(JSON.stringify({ code: 'unknown' }), { status: 404 });
    const attestation = { format: 1, repo: order.repo, articlePr: order.articlePr, articleSha: order.articleSha, orderNonce: order.nonce, decisionSeq: order.decisionSeq,
      challenge, attestedAt: new Date().toISOString() };
    switch (state.mode) {
      case 'open': return new Response(JSON.stringify({ signed: s.signed('publish_attestation', attestation) }), { status: 200 });
      case 'down': throw new TypeError('fetch failed');
      case 'wrong-challenge': return new Response(JSON.stringify({ signed: s.signed('publish_attestation', { ...attestation, challenge: '99999999-9999-4999-8999-999999999999' }) }), { status: 200 });
      case 'other-key': return new Response(JSON.stringify({ signed: state.other.signed('publish_attestation', attestation) }), { status: 200 });
      case 'decision': return new Response(JSON.stringify({ signed: s.signed('decision', { ...attestation }) }), { status: 200 });
      // A signature of a decision whose payload says publish_attestation: the prefix differs, the signature fails.
      case 'decision-prefix': return new Response(JSON.stringify({ signed: s.signed('publish_attestation', attestation, DOMAIN, 'decision') }), { status: 200 });
      case 'wrong-nonce': return new Response(JSON.stringify({ signed: s.signed('publish_attestation', { ...attestation, orderNonce: '22222222-3333-4444-8555-666666666666' }) }), { status: 200 });
      default: return new Response(JSON.stringify({ code: state.mode }), { status: 404 });
    }
  };
  return { fetch, challenges };
}
