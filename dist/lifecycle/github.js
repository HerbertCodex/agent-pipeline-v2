import { runProcess, environment, redact } from '../execution/process.js';
import { invariant } from '../domain/errors.js';
import { parseJson } from '../domain/schema.js';
import { Git } from '../execution/git.js';
export function githubRepository(url) {
    const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url);
    invariant(match && match[1] && !match[1].split('/').some(x => x === '.' || x === '..'), 'REMOTE', 'Only explicit github.com HTTPS/SSH remotes without embedded credentials are supported');
    return match[1];
}
const fields = 'number,url,state,headRefOid,headRefName,baseRefName,isCrossRepository,mergedAt,mergeCommit';
function parsePr(value, pub) {
    invariant(value && typeof value === 'object' && !Array.isArray(value), 'FORGE', 'Invalid PR response');
    const p = value;
    invariant(typeof p['number'] === 'number' && Number.isSafeInteger(p['number']) && p['number'] > 0, 'FORGE', 'Invalid PR number');
    const expected = `https://github.com/${pub.repository}/pull/${p['number']}`;
    invariant(typeof p['url'] === 'string' && p['url'].toLowerCase() === expected.toLowerCase(), 'FORGE', 'PR URL does not match authorized repository');
    invariant(p['headRefOid'] === pub.candidateSha && p['headRefName'] === pub.branch && p['baseRefName'] === pub.base && p['isCrossRepository'] === false, 'FORGE_DRIFT', 'PR head/base no longer matches the exact validated publication');
    invariant(['OPEN', 'CLOSED', 'MERGED'].includes(String(p['state'])), 'FORGE', 'Unknown PR state');
    const mergedAt = p['mergedAt'];
    const merge = p['mergeCommit'];
    const mergeSha = merge && typeof merge['oid'] === 'string' ? merge['oid'] : null;
    if (p['state'] === 'MERGED')
        invariant(typeof mergedAt === 'string' && Number.isFinite(Date.parse(mergedAt)) && mergeSha && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(mergeSha), 'FORGE', 'Merged state lacks merge evidence');
    return { number: p['number'], url: p['url'], state: p['state'], headRefOid: pub.candidateSha, headRefName: pub.branch, baseRefName: pub.base, isCrossRepository: false, mergedAt: typeof mergedAt === 'string' ? mergedAt : null, mergeSha };
}
function transportFor(life, id) {
    return async (options) => {
        const children = new Map();
        const env = { ...environment(['PATH', 'HOME', 'LANG', 'TMPDIR', 'TMP', 'TEMP', 'SSH_AUTH_SOCK', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_CONFIG_DIR']), GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' };
        const result = await runProcess({ ...options, env, timeoutMs: 120000, maxOutputBytes: 1024 * 1024, onStart: pid => { children.set(pid, life.store.startDocumentChild(id, pid)); }, onFinish: pid => {
                const child = children.get(pid);
                if (child)
                    life.store.finishDocumentChild(child);
            } });
        invariant(result.status === 'passed' && !result.truncated, 'FORGE', `Forge command ${result.status}: ${redact(result.stderr.slice(-4000), env)}`);
        return result.stdout;
    };
}
export async function publishSpec(life, id, options, transport) {
    invariant(options.confirmPush && options.confirmPr, 'CONFIRM', 'Publishing requires separate explicit push and draft-PR consent');
    invariant(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repository) && !options.repository.split('/').some(x => x === '.' || x === '..'), 'FORGE', 'Expected owner/repository');
    invariant(/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(options.remote), 'REMOTE', 'Invalid remote name');
    invariant(options.branch !== options.base, 'BRANCH', 'Never push to the integration branch');
    const token = life.store.acquireDocument(id);
    try {
        const doc = life.get(id);
        const r = doc.data;
        const run = await life.publicationCandidate(id);
        const git = new Git(options.signal);
        await git.exec(r.repo, ['check-ref-format', `refs/heads/${options.branch}`]);
        await git.exec(r.repo, ['check-ref-format', `refs/heads/${options.base}`]);
        const send = transport ?? transportFor(life, id);
        const call = (command, input) => send({ command, cwd: r.repo, ...(input !== undefined ? { input } : {}), ...(options.signal ? { signal: options.signal } : {}) });
        // Both fetch and push destinations must resolve to the explicitly named repository.
        for (const flags of [[], ['--push']]) {
            const urls = (await call(['git', 'remote', 'get-url', ...flags, '--all', options.remote])).trim().split('\n');
            invariant(urls.length === 1 && githubRepository(urls[0]).toLowerCase() === options.repository.toLowerCase(), 'REMOTE', 'Remote destination differs from authorized GitHub repository');
        }
        const pub = { remote: options.remote, repository: options.repository, branch: options.branch, base: options.base, candidateSha: run.candidateSha, url: null, state: 'intent', mergedAt: null, mergeSha: null };
        if (r.publication) {
            for (const key of ['remote', 'repository', 'branch', 'base', 'candidateSha'])
                invariant(r.publication[key] === pub[key], 'PUBLICATION_MISMATCH', 'A publication intent already exists with different parameters');
        }
        else {
            r.publication = pub;
            life.store.saveDocument(doc, 'publication.intent', { ...pub, consent: { push: true, draftPr: true } });
        }
        const current = r.publication;
        const existing = parseJson(await call(['gh', 'pr', 'list', '--repo', options.repository, '--head', options.branch, '--base', options.base, '--state', 'all', '--limit', '100', '--json', fields]));
        invariant(Array.isArray(existing), 'FORGE', 'Invalid PR list');
        invariant(existing.length <= 1, 'FORGE', 'Ambiguous PR history for this head; inspect manually');
        if (existing.length === 1) {
            const pr = parsePr(existing[0], current);
            current.url = pr.url;
            current.state = 'pr_open';
            life.store.saveDocument(doc, 'publication.reconciled', { url: pr.url, head: pr.headRefOid, observedState: pr.state, next: 'spec sync' });
            return doc;
        }
        const refs = (await call(['git', 'ls-remote', '--heads', options.remote, `refs/heads/${options.base}`, `refs/heads/${options.branch}`])).trim().split('\n').filter(Boolean);
        const remoteRefs = new Map(refs.map(line => { const parts = line.split(/\s+/); invariant(parts.length === 2 && /^[a-f0-9]{40,64}$/.test(parts[0]), 'REMOTE', 'Malformed remote refs'); return [parts[1], parts[0]]; }));
        invariant(remoteRefs.get(`refs/heads/${options.base}`) === r.baseSha, 'BASE_MOVED', 'Remote base differs from the approved spec base; rebase through an explicit new validation/spec, not an implicit merge');
        const head = remoteRefs.get(`refs/heads/${options.branch}`);
        invariant(!head || head === run.candidateSha, 'REMOTE_BRANCH_CONFLICT', 'Remote branch contains another candidate; never force-push');
        const ref = `refs/heads/${options.branch}`;
        const local = (await git.exec(r.repo, ['for-each-ref', '--format=%(refname) %(objectname)', ref])).trim();
        if (local)
            invariant(local === `${ref} ${run.candidateSha}`, 'BRANCH_CONFLICT', 'Local branch differs from candidate');
        else
            await git.exec(r.repo, ['update-ref', ref, run.candidateSha, '0'.repeat(run.candidateSha.length)]);
        if (!head)
            await call(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.ext.allow=never', 'push', '--porcelain', options.remote, `${run.candidateSha}:${ref}`]);
        const observed = (await call(['git', 'ls-remote', '--heads', options.remote, ref])).trim().split(/\s+/);
        invariant(observed[0] === run.candidateSha && observed[1] === ref, 'REMOTE_BRANCH_CONFLICT', 'Pushed head is not the validated candidate');
        current.state = 'pushed';
        life.store.saveDocument(doc, 'publication.pushed', { branch: options.branch, candidateSha: run.candidateSha });
        const body = `Agent Pipeline V2\n\nSpec: ${id}, revision ${r.revision}\nApproved spec hash: ${r.contentHash}\nCandidate: ${run.candidateSha}\nBase: ${r.baseSha}\n\nLocal checks: ${run.receipts.map(g => g.gateId + '=' + g.status).join(', ')}\nQA: ${r.qa?.report.verdict ?? 'not required by approved policy'}\n\nLocal reviewer labels are not authenticated GitHub reviews. Required CI and branch protection remain authoritative. This draft PR does not authorize merge or deployment.\n`;
        const url = (await call(['gh', 'pr', 'create', '--repo', options.repository, '--head', options.branch, '--base', options.base, '--draft', '--no-maintainer-edit', '--title', r.content.title, '--body-file', '-'], body)).trim();
        invariant(new RegExp('^https://github\\.com/' + options.repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/pull/[1-9][0-9]*$', 'i').test(url), 'FORGE', 'Unexpected created PR URL; inspect remote outcome before retry');
        const pr = parsePr(parseJson(await call(['gh', 'pr', 'view', url, '--repo', options.repository, '--json', fields])), current);
        current.url = pr.url;
        current.state = 'pr_open';
        life.store.saveDocument(doc, 'publication.pr_created', { url: pr.url, candidateSha: pr.headRefOid });
        return doc;
    }
    finally {
        life.store.releaseDocument(id, token);
    }
}
export async function syncSpec(life, id, signal, transport) {
    const token = life.store.acquireDocument(id);
    try {
        const doc = life.get(id);
        const r = doc.data;
        const pub = r.publication;
        invariant(pub?.url, 'PUBLICATION', 'No known PR to observe');
        const send = transport ?? transportFor(life, id);
        const raw = await send({ command: ['gh', 'pr', 'view', pub.url, '--repo', pub.repository, '--json', fields], cwd: r.repo, ...(signal ? { signal } : {}) });
        const pr = parsePr(parseJson(raw), pub);
        if (pr.state === 'MERGED') {
            invariant(r.status !== 'rejected', 'STATE', 'A rejected spec was merged externally; manual reconciliation required');
            pub.state = 'merged';
            pub.mergeSha = pr.mergeSha;
            pub.mergedAt = pr.mergedAt;
            r.status = 'closed';
            life.store.saveDocument(doc, 'spec.closed', { source: 'github-observation', url: pub.url, candidateSha: pub.candidateSha, mergeSha: pr.mergeSha, mergedAt: pr.mergedAt, notADeployment: true });
        }
        else {
            if (pr.state === 'CLOSED') {
                r.status = 'blocked';
                r.error = { code: 'PR_CLOSED', message: 'PR closed without merge; spec is not delivered by integration.' };
            }
            life.store.saveDocument(doc, 'publication.observed', { state: pr.state, url: pr.url, candidateSha: pr.headRefOid });
        }
        return doc;
    }
    finally {
        life.store.releaseDocument(id, token);
    }
}
//# sourceMappingURL=github.js.map