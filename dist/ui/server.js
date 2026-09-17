import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { Lifecycle } from '../lifecycle/service.js';
import { asset, packageRoot } from '../knowledge/catalog.js';
import { collectGarbage, planGarbage, planPurge, purgeProtections } from '../lifecycle/maintenance.js';
import { Git } from '../execution/git.js';
import { PipelineError, errorMessage, invariant } from '../domain/errors.js';
const HOST = '127.0.0.1';
const MAX_BODY = 64 * 1024;
const STATIC = {
    '/': { file: 'ui/index.html', type: 'text/html; charset=utf-8' },
    '/app.js': { file: 'ui/app.js', type: 'text/javascript; charset=utf-8' },
    '/app.css': { file: 'ui/app.css', type: 'text/css; charset=utf-8' },
};
const PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";
// A mockup is foreign markup: served in a sandbox (opaque origin, no scripts, no cookies), inline styles only.
const PREVIEW_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-ancestors 'self'";
class HttpError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}
const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const cookie = (req, name) => (req.headers.cookie ?? '').split(';').map(x => x.trim().split('=')).find(([k]) => k === name)?.[1];
/**
 * Local dashboard of the lifecycle store: every spec, its tasks, QA, designs and live activity, plus the
 * operator actions the CLI offers. Bound to 127.0.0.1. Access requires the one-time token printed at start,
 * exchanged for an HttpOnly SameSite=Strict cookie; the Host header is checked against DNS rebinding; every
 * action additionally requires the page's CSRF token and a same-origin Origin header. Approvals name the exact
 * hash or SHA the operator saw, carry a note, and record the git identity of the repository as reviewer.
 * Long operations run as separate CLI processes that survive the dashboard.
 */
export async function startUi(options) {
    const life = new Lifecycle(options.stateDir);
    const accessToken = randomBytes(32).toString('hex');
    const session = randomBytes(32).toString('hex');
    const csrf = randomBytes(32).toString('hex');
    const jobs = new Map();
    const jobsDir = join(life.store.root, 'ui-jobs');
    mkdirSync(jobsDir, { recursive: true, mode: 0o700 });
    const cli = join(packageRoot, 'dist', 'cli.js');
    const streams = new Set();
    let port = 0;
    const send = (res, status, body, type, extra = {}) => {
        res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
            'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin', 'Content-Security-Policy': PAGE_CSP, ...extra });
        res.end(body);
    };
    const json = (res, status, value) => send(res, status, JSON.stringify(value), 'application/json; charset=utf-8');
    const origins = () => [`http://${HOST}:${port}`, `http://localhost:${port}`];
    const hosts = () => [`${HOST}:${port}`, `localhost:${port}`];
    const readBody = async (req) => {
        const type = String(req.headers['content-type'] ?? '');
        if (!type.startsWith('application/json'))
            throw new HttpError(415, 'JSON attendu');
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
            size += chunk.length;
            if (size > MAX_BODY)
                throw new HttpError(413, 'Requête trop volumineuse');
            chunks.push(chunk);
        }
        const value = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        if (!value || typeof value !== 'object' || Array.isArray(value))
            throw new HttpError(400, 'Objet JSON attendu');
        return value;
    };
    const text = (body, key, min = 1, max = 30000) => {
        const value = body[key];
        if (typeof value !== 'string' || value.trim().length < min || value.length > max)
            throw new HttpError(400, `Champ « ${key} » invalide`);
        return value.trim();
    };
    const reviewerFor = async (repo) => {
        const name = await new Git().configValue(repo, 'user.name');
        if (!name || name.trim().length < 3)
            throw new HttpError(409, 'Configurez git user.name pour signer une approbation depuis le tableau de bord');
        return name.trim();
    };
    const note = (body) => `[tableau de bord] ${text(body, 'note', 10, 4000)}`;
    /** Busy whoever started the operation: this dashboard, another one, or the terminal. */
    const busy = (specId) => [...jobs.values()].some(j => j.specId === specId && j.state === 'running') || life.store.documentControllerAlive(specId) || life.store.documentProcesses(specId).some(p => p.alive);
    const startJob = (specId, label, args) => {
        if (specId && busy(specId))
            throw new HttpError(409, 'Une opération est déjà en cours sur cette spec');
        const id = randomUUID();
        const log = join(jobsDir, `${id}.log`);
        const fd = openSync(log, 'a', 0o600);
        const child = spawn(process.execPath, [cli, ...args, '--state-dir', life.store.root, '--quiet'], { detached: true, stdio: ['ignore', fd, fd], env: process.env });
        closeSync(fd);
        const job = { id, specId, label, args, log, state: 'running', exitCode: null, startedAt: Date.now(), finishedAt: null };
        jobs.set(id, job);
        child.on('exit', code => { job.exitCode = code; job.finishedAt = Date.now(); job.state = code === 0 || code === 2 ? 'succeeded' : 'failed'; });
        child.on('error', () => { job.state = 'failed'; job.finishedAt = Date.now(); });
        // A run outlives the dashboard: closing the page or the server never interrupts an agent.
        child.unref();
        return job;
    };
    const jobView = (job) => {
        let tail = '';
        try {
            const size = statSync(job.log).size;
            tail = readFileSync(job.log, 'utf8').slice(Math.max(0, size - 8000));
        }
        catch { /* not written yet */ }
        return { id: job.id, specId: job.specId, label: job.label, state: job.state, exitCode: job.exitCode, startedAt: job.startedAt, finishedAt: job.finishedAt, tail };
    };
    const lastActivity = (id) => life.store.documentEvents(id).reduce((n, e) => Math.max(n, e.at), 0);
    const specList = () => life.store.documents('spec').map(doc => ({
        ...life.summary(doc), repo: doc.data.repo, updatedAt: lastActivity(doc.id), busy: busy(doc.id),
    })).sort((a, b) => b.updatedAt - a.updatedAt);
    /**
     * A spec written before the current format lacks fields its integrity hash now covers, so `get` cannot
     * verify it. The dashboard still shows it, flagged, read-only; the store digest itself is still checked.
     */
    const specDocument = (id) => {
        try {
            return { doc: life.get(id), legacy: false };
        }
        catch (error) {
            if (!(error instanceof PipelineError && error.code === 'DB_CORRUPT'))
                throw error;
            const raw = life.store.document(id, 'spec');
            if (raw.data.securityContextHash !== undefined && raw.data.decisionLedgerHash !== undefined)
                throw error;
            return { doc: raw, legacy: true };
        }
    };
    const specDetail = (id) => {
        const { doc, legacy } = specDocument(id);
        const r = doc.data;
        const attempts = (r.attempts ?? []).map(a => {
            const run = life.pipeline.store.get(a.runId);
            return { ...a, state: run.state, lane: run.risk?.lane ?? null, summary: run.summary ?? '', error: run.error ?? null,
                receipts: run.receipts.map(x => ({ gateId: x.gateId, status: x.status, durationMs: Math.round(x.durationMs), reusedFrom: x.reusedFrom, diagnostic: x.diagnostic.slice(0, 4000) })) };
        });
        const validations = (r.validationRunIds ?? []).map(runId => {
            const run = life.pipeline.store.get(runId);
            return { runId, state: run.state, receipts: run.receipts.map(x => ({ gateId: x.gateId, status: x.status, durationMs: Math.round(x.durationMs), reusedFrom: x.reusedFrom })) };
        });
        return {
            legacy, summary: life.summary(doc), repo: r.repo, request: r.request, content: r.content, approval: r.approval, qa: r.qa ?? null, review: r.review ?? null,
            scopeAmendments: r.scopeAmendments ?? [], criterionAmendments: r.criterionAmendments ?? [], impactAdvice: r.impactAdvice ?? [], sizeAdvice: r.sizeAdvice ?? [],
            design: r.design ? { hash: r.design.hash, directory: r.design.directory, summary: r.design.proposal.summary, visualDirection: r.design.proposal.visualDirection,
                questions: r.design.proposal.questions, reusedFrom: r.design.reusedFrom ?? null, loadedStylesheets: r.design.loadedStylesheets ?? [],
                inlinedAssets: r.design.inlinedAssets ?? [], screens: r.design.proposal.screens.map((s, i) => ({ id: s.id, title: s.title, purpose: s.purpose, states: s.states,
                    file: basename(r.design.screenPaths[i] ?? ''), available: existsSync(r.design.screenPaths[i] ?? '') })) } : null,
            attempts, validations, busy: busy(id), activeProcesses: life.store.documentProcesses(id), implementer: r.config?.agent?.type ?? null,
        };
    };
    const specEvents = (id) => {
        const { doc } = specDocument(id);
        const events = life.store.documentEvents(id).map(e => ({ source: 'lifecycle', id, at: e.at, type: e.type, data: e.data }));
        for (const runId of new Set([...(doc.data.attempts ?? []).map(a => a.runId), ...(doc.data.validationRunIds ?? [])]))
            events.push(...life.pipeline.store.events(runId).map(e => ({ source: 'run', id: runId, at: e.at, type: e.type, data: e.data })));
        return events.sort((a, b) => a.at - b.at).slice(-1500);
    };
    const route = async (req, res) => {
        if (!hosts().includes(String(req.headers.host ?? '')))
            throw new HttpError(421, 'Hôte refusé');
        const url = new URL(req.url ?? '/', `http://${HOST}:${port}`);
        const method = req.method ?? 'GET';
        // Entry: the one-time token becomes an HttpOnly cookie, and leaves the address bar.
        if (method === 'GET' && url.pathname === '/' && url.searchParams.has('token')) {
            if (!same(url.searchParams.get('token') ?? '', accessToken))
                throw new HttpError(401, 'Jeton invalide');
            send(res, 303, '', 'text/plain; charset=utf-8', { Location: '/', 'Set-Cookie': `apv2_session=${session}; HttpOnly; SameSite=Strict; Path=/` });
            return;
        }
        if (!same(cookie(req, 'apv2_session') ?? '', session))
            throw new HttpError(401, 'Session absente : ouvrez l\'adresse complète affichée par « apv2 ui ».');
        if (method === 'GET' && STATIC[url.pathname]) {
            const s = STATIC[url.pathname];
            send(res, 200, asset(s.file), s.type);
            return;
        }
        if (method === 'POST') {
            const origin = String(req.headers.origin ?? '');
            if (!origins().includes(origin))
                throw new HttpError(403, 'Origine refusée');
            if (!same(String(req.headers['x-apv2-csrf'] ?? ''), csrf))
                throw new HttpError(403, 'Jeton anti-CSRF invalide');
        }
        const parts = url.pathname.split('/').filter(Boolean);
        const id = parts[2];
        if (method === 'GET') {
            if (url.pathname === '/api/session')
                return json(res, 200, { csrf, stateDir: life.store.root, version: process.env['npm_package_version'] ?? null });
            if (url.pathname === '/api/specs')
                return json(res, 200, specList());
            if (url.pathname === '/api/jobs')
                return json(res, 200, [...jobs.values()].map(jobView).reverse());
            if (url.pathname === '/api/maintenance')
                return json(res, 200, { garbage: planGarbage(life), purge: planPurge(life), kept: purgeProtections(life) });
            if (url.pathname === '/api/stream')
                return stream(req, res);
            if (parts[0] === 'api' && parts[1] === 'specs' && id && parts.length === 3)
                return json(res, 200, specDetail(id));
            if (parts[0] === 'api' && parts[1] === 'specs' && id && parts[3] === 'events')
                return json(res, 200, specEvents(id));
            if (parts[0] === 'api' && parts[1] === 'specs' && id && parts[3] === 'design' && parts[4]) {
                // Only a file this spec's design produced, by exact name: no path is ever built from the request.
                const r = life.get(id).data;
                const file = [...(r.design?.screenPaths ?? [])].find(p => basename(p) === parts[4]);
                if (!file || !existsSync(file) || !lstatSync(file).isFile())
                    throw new HttpError(404, 'Maquette introuvable');
                send(res, 200, readFileSync(file), 'text/html; charset=utf-8', { 'Content-Security-Policy': PREVIEW_CSP, 'Cross-Origin-Resource-Policy': 'same-origin' });
                return;
            }
            throw new HttpError(404, 'Introuvable');
        }
        if (method === 'POST') {
            const body = await readBody(req);
            if (url.pathname === '/api/specs') {
                const repo = resolve(text(body, 'repo', 1, 4096));
                invariant(existsSync(repo), 'ARGUMENT', 'Dépôt introuvable');
                const file = join(jobsDir, `${randomUUID()}.request.txt`);
                writeFileSync(file, text(body, 'request', 10, 30000), { mode: 0o600 });
                return json(res, 202, jobView(startJob(null, 'Nouveau brouillon', ['spec', 'draft', '--repo', repo, '--request-file', file])));
            }
            if (url.pathname === '/api/maintenance/gc') {
                if (body['confirm'] !== true)
                    throw new HttpError(400, 'Confirmation requise');
                const result = await collectGarbage(life, planGarbage(life));
                return json(res, 200, { removed: result.removed.length, failed: result.failed, freedBytes: result.removed.reduce((n, x) => n + x.bytes, 0) });
            }
            if (!(parts[0] === 'api' && parts[1] === 'specs' && id))
                throw new HttpError(404, 'Introuvable');
            const action = parts.slice(3).join('/');
            const repo = life.get(id).data.repo;
            if (action === 'approve')
                return json(res, 200, life.summary(await life.approveSpec(id, text(body, 'hash', 64, 64), await reviewerFor(repo), note(body))));
            if (action === 'review')
                return json(res, 200, life.summary(await life.review(id, text(body, 'sha', 40, 64), await reviewerFor(repo), note(body))));
            if (action === 'reject')
                return json(res, 200, life.summary(life.reject(id, note(body))));
            if (action === 'retry')
                return json(res, 200, life.summary(await life.retry(id, body['confirm'] === true)));
            if (parts[3] === 'scope-amendments' && parts[4] && parts[5] === 'approve')
                return json(res, 200, life.summary(await life.approveScopeAmendment(id, parts[4], await reviewerFor(repo), note(body))));
            if (parts[3] === 'criterion-amendments' && parts[4] && parts[5] === 'approve')
                return json(res, 200, life.summary(life.approveCriterionAmendment(id, parts[4], text(body, 'hash', 64, 64), await reviewerFor(repo), note(body))));
            const jobsByAction = {
                run: body['acceptCurrent'] === true
                    ? ['Adoption du travail conservé', ['spec', 'run', id, '--accept-current']]
                    : ['Exécution', ['spec', 'run', id]], verify: ['Revalidation', ['spec', 'verify', id]], sync: ['Synchronisation', ['spec', 'sync', id]],
            };
            if (jobsByAction[action]) {
                const [label, args] = jobsByAction[action];
                return json(res, 202, jobView(startJob(id, label, args)));
            }
            if (action === 'refine') {
                const file = join(jobsDir, `${randomUUID()}.request.txt`);
                writeFileSync(file, text(body, 'request', 1, 10000), { mode: 0o600 });
                return json(res, 202, jobView(startJob(id, 'Affinage', ['spec', 'refine', id, '--request-file', file])));
            }
            throw new HttpError(404, 'Action inconnue');
        }
        throw new HttpError(405, 'Méthode refusée');
    };
    // Live activity: the store is shared with CLI processes, so new events are polled and pushed.
    let cursor = life.store.eventCursor();
    const poll = setInterval(() => {
        if (!streams.size) {
            cursor = life.store.eventCursor();
            return;
        }
        try {
            const next = life.store.eventsSince(cursor);
            cursor = next.cursor;
            const payload = next.events.length ? `event: events\ndata: ${JSON.stringify(next.events)}\n\n` : ': heartbeat\n\n';
            for (const res of streams)
                res.write(payload);
        }
        catch { /* A transient read error must not end the dashboard. */ }
    }, options.pollMs ?? 1000);
    const stream = (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Connection: 'keep-alive' });
        res.write('retry: 2000\n\n');
        streams.add(res);
        req.on('close', () => streams.delete(res));
    };
    const server = createServer((req, res) => {
        route(req, res).catch((error) => {
            if (res.headersSent) {
                res.end();
                return;
            }
            const status = error instanceof HttpError ? error.status
                : error instanceof PipelineError ? (['NOT_FOUND'].includes(error.code) ? 404 : ['LOCKED', 'BUSY', 'STATE', 'CONFLICT'].includes(error.code) ? 409 : 422) : 500;
            json(res, status, { error: error instanceof PipelineError ? error.code : status, message: status === 500 ? 'Erreur interne' : errorMessage(error) });
        });
    });
    await new Promise((ok, fail) => { server.once('error', fail); server.listen(options.port ?? 0, HOST, () => ok()); });
    const address = server.address();
    invariant(address && typeof address === 'object', 'UI', 'Unable to bind the dashboard');
    port = address.port;
    return {
        url: `http://${HOST}:${port}/?token=${accessToken}`, port, accessToken,
        close: async () => {
            clearInterval(poll);
            for (const res of streams)
                res.end();
            await new Promise(done => server.close(() => done()));
            life.close();
            for (const job of jobs.values())
                if (job.state !== 'running')
                    rmSync(job.log, { force: true });
        },
    };
}
//# sourceMappingURL=server.js.map