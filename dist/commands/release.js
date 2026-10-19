import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PipelineError, errorMessage } from '../domain/errors.js';
import { loadConfig, loadConfigAtCommit, suiteSettings } from '../config/load.js';
import { runGates } from '../gates/run.js';
import { verifyGates } from '../gates/verify.js';
import { LockStore } from '../lock/store.js';
import { gitRoot, resolveCommit } from '../run/git-probe.js';
import { commonDir } from '../stacks/idle.js';
import { journalEntry } from './stack.js';
import { EXIT, UsageError, guard, json, parse, repoPath } from './common.js';
export const usage = `Utilisation :
  apv release [<sha>] [--dry-run] [--json] [--repo <chemin>]
  apv release auto [--dry-run] [--json] [--repo <chemin>]

Mise en ligne découplée de la fusion (section release de .apv/config.json, lue sur la branche from distante) :
la branche de production (release.branch) n'avance qu'en avance rapide vers un commit de release.from dont la
suite complète est prouvée au commit exact (apv gates verify --commit <sha>, instable refusé).
<sha> (défaut : tête distante de from) doit être un ancêtre de cette tête, et la production distante un ancêtre
de <sha> (jamais de retour en arrière, jamais de force). Puis git push origin <sha>:refs/heads/<branch>, sortie
affichée, branche distante relue. --dry-run vérifie tout et ne pousse rien.
auto : pour un lancement périodique (cron) ; rien à publier : 0 ; suite déjà prouvée à la tête de from : publie ;
reçus rouges ou instables à ce commit : 1 sans relancer ; sinon suite complète dans une copie détachée (batch.setup),
sans attendre la file des suites (occupée : 0, plus tard), puis publie si elle est verte au premier passage.
Historique : .apv/state/stack.log (event release). Sortie : 0 publié ou rien à faire, 1 refus, 2 appel incorrect.`;
const REMOTE = 'origin';
const short = (sha) => sha ? sha.slice(0, 12) : 'absente';
function git(repo, args) {
    const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 300_000 });
    return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? errorMessage(r.error) : '') };
}
const isAncestor = (repo, a, b) => git(repo, ['merge-base', '--is-ancestor', a, b]).status === 0;
/** The remote heads of `from` and `branch` (ls-remote), `from` fetched; the settings must be those committed on `from`. */
function remoteState(repo) {
    const local = loadConfig(repo).config.release;
    if (!local)
        throw new PipelineError('RELEASE', 'section release absente de .apv/config.json : la mise en ligne découplée n\'est pas déclarée');
    const listed = git(repo, ['ls-remote', REMOTE, `refs/heads/${local.from}`, `refs/heads/${local.branch}`]);
    if (listed.status !== 0)
        throw new PipelineError('RELEASE', `git ls-remote ${REMOTE} en échec : ${listed.stderr.trim()}`);
    const heads = new Map(listed.stdout.split('\n').filter(Boolean).map(l => { const [sha, ref] = l.split('\t'); return [ref, sha]; }));
    const fromHead = heads.get(`refs/heads/${local.from}`);
    if (!fromHead)
        throw new PipelineError('RELEASE', `branche distante ${REMOTE}/${local.from} absente`);
    const fetched = git(repo, ['fetch', '--no-tags', REMOTE, `+refs/heads/${local.from}:refs/remotes/${REMOTE}/${local.from}`]);
    if (fetched.status !== 0)
        throw new PipelineError('RELEASE', `git fetch ${REMOTE} ${local.from} en échec : ${fetched.stderr.trim()}`);
    const published = loadConfigAtCommit(repo, fromHead).config.release;
    if (!published || published.branch !== local.branch || published.from !== local.from) {
        throw new PipelineError('RELEASE', `section release de ${REMOTE}/${local.from} (${short(fromHead)}) ${published ? `différente (${published.from} vers ${published.branch})` : 'absente'} : seule la configuration de ${local.from} fait foi`);
    }
    return { settings: published, fromHead, production: heads.get(`refs/heads/${local.branch}`) ?? null };
}
async function fullProof(repo, sha, from) {
    return verifyGates({ repo, config: loadConfigAtCommit(repo, sha).config, commit: sha, stage: 'full', configFile: null, reuseReference: `refs/remotes/${REMOTE}/${from}` });
}
const proofLines = (proof) => proof.gates.filter(g => g.state !== 'passed').map(g => `${g.gateId} (${g.state})`);
/** Checks a release of `sha` and, unless `dryRun`, pushes it fast-forward. */
async function release(repo, state, sha, dryRun) {
    const { settings: { branch, from }, fromHead, production } = state;
    const base = { ok: false, published: false, sha, branch, from, previous: production, lines: [] };
    const refuse = (line) => ({ ...base, lines: [`Mise en ligne refusée : ${line}`] });
    if (!production)
        return refuse(`branche distante ${REMOTE}/${branch} absente : l'opérateur la crée une première fois`);
    if (!isAncestor(repo, sha, fromHead))
        return refuse(`${short(sha)} n'est pas dans ${REMOTE}/${from} (${short(fromHead)})`);
    if (!isAncestor(repo, production, sha))
        return refuse(`${REMOTE}/${branch} (${short(production)}) n'est pas un ancêtre de ${short(sha)} : avance rapide seulement, jamais de retour en arrière`);
    if (production === sha)
        return { ...base, ok: true, lines: [`${REMOTE}/${branch} est déjà à ${short(sha)} : rien à publier.`] };
    const proof = await fullProof(repo, sha, from);
    if (!proof.ok)
        return refuse(`suite complète non prouvée à ${short(sha)} : ${proofLines(proof).join(', ')} (apv gates run --stage full dans une copie à ce commit)`);
    if (proof.flaky.length)
        return refuse(`réussi(s) seulement après relance à ${short(sha)} : ${proof.flaky.join(', ')} (règle instable)`);
    const said = `suite complète prouvée à ${short(sha)} (${proof.required.length} contrôle(s), aucun instable) ; ${REMOTE}/${branch} ${short(production)} vers ${short(sha)} en avance rapide`;
    if (dryRun)
        return { ...base, ok: true, lines: [`Mise en ligne possible : ${said}. --dry-run : rien n'est poussé.`] };
    const push = git(repo, ['push', REMOTE, `${sha}:refs/heads/${branch}`]);
    const after = git(repo, ['ls-remote', REMOTE, `refs/heads/${branch}`]).stdout.split('\t')[0]?.trim() ?? '';
    git(repo, ['fetch', '--no-tags', REMOTE, `+refs/heads/${branch}:refs/remotes/${REMOTE}/${branch}`]);
    const done = push.status === 0 && after === sha;
    return { ...base, ok: done, published: done, push,
        lines: [done ? `Mis en ligne : ${said}. ${REMOTE}/${branch} relue à ${short(after)}.` : `Mise en ligne en échec : git push sorti en ${push.status}, ${REMOTE}/${branch} relue à ${short(after || null)}.`] };
}
function report(io, asJson, outcome, history, mode) {
    if (history) {
        const failed = journalEntry(io, { event: 'release', mode, commit: outcome.sha, branch: outcome.branch, from: outcome.from, previous: outcome.previous, ok: outcome.ok, published: outcome.published, detail: outcome.lines.join(' ') });
        if (failed)
            outcome.lines.push(`Historique non écrit (.apv/state/stack.log) : ${failed}`);
    }
    if (asJson)
        json(io, { ...outcome, push: outcome.push ? { status: outcome.push.status, stdout: outcome.push.stdout, stderr: outcome.push.stderr } : null });
    else {
        if (outcome.push)
            io.stdout(`$ git push ${REMOTE} ${outcome.sha}:refs/heads/${outcome.branch}\n${outcome.push.stdout}${outcome.push.stderr}`);
        io.stdout(`${outcome.lines.join('\n')}\n`);
    }
    return outcome.ok ? EXIT.ok : EXIT.failed;
}
/** `apv release auto`: one pass, never waiting; a lock of the repository keeps two passes apart. */
async function auto(io, repo, dryRun, asJson) {
    const common = commonDir(repo);
    const store = new LockStore(join(common, 'apv', 'locks'));
    const lock = await store.tryAcquire('release-auto', { pid: process.pid, host: store.host, label: `apv release auto (${repo})` }, 6 * 3600, 'apv release auto');
    if (!lock.ok) {
        io.stdout(`apv release auto déjà en cours (verrou release-auto) : plus tard.\n`);
        return EXIT.ok;
    }
    try {
        const state = remoteState(repo);
        const { settings: { branch, from }, fromHead, production } = state;
        const base = { ok: true, published: false, sha: fromHead, branch, from, previous: production };
        if (production === fromHead)
            return report(io, asJson, { ...base, lines: [`Rien à publier : ${REMOTE}/${branch} est à la tête de ${from} (${short(fromHead)}).`] }, false, 'auto');
        const proof = await fullProof(repo, fromHead, from);
        if ((!proof.ok && proof.gates.some(g => g.state === 'failed')) || (proof.ok && proof.flaky.length)) {
            const what = proof.flaky.length ? `instable(s) : ${proof.flaky.join(', ')}` : `en échec : ${proofLines(proof).join(', ')}`;
            return report(io, asJson, { ...base, ok: false, lines: [`Suite complète déjà passée à ${short(fromHead)}, ${what} : rien n'est publié ni relancé (corriger sur ${from}).`] }, !dryRun, 'auto');
        }
        if (!proof.ok) {
            if (!production || !isAncestor(repo, production, fromHead))
                return report(io, asJson, await release(repo, state, fromHead, true), !dryRun, 'auto');
            if (dryRun)
                return report(io, asJson, { ...base, lines: [`Suite complète à lancer à ${short(fromHead)} (${proofLines(proof).join(', ')}), puis mise en ligne. --dry-run : rien n'est lancé.`] }, false, 'auto');
            const suite = await runCopy(io, repo, common, fromHead, production);
            if (suite.busy)
                return report(io, asJson, { ...base, lines: [`Machine occupée (${suite.busy}) : plus tard.`] }, false, 'auto');
            if (!suite.ok)
                return report(io, asJson, { ...base, ok: false, lines: [`Suite complète rouge ou instable à ${short(fromHead)} : ${suite.summary} ; rien n'est publié.`] }, true, 'auto');
        }
        return report(io, asJson, await release(repo, state, fromHead, dryRun), !dryRun, 'auto');
    }
    finally {
        await store.release('release-auto', { token: lock.record.token }).catch(() => undefined);
    }
}
/** The full suite of `sha` in a detached copy under the Git common directory, prepared by batch.setup, then removed. */
async function runCopy(io, repo, common, sha, production) {
    const dir = join(common, 'apv', 'release', sha.slice(0, 12));
    mkdirSync(join(common, 'apv', 'release'), { recursive: true });
    if (existsSync(dir))
        git(repo, ['worktree', 'remove', '--force', dir]);
    const added = git(repo, ['worktree', 'add', '--detach', dir, sha]);
    if (added.status !== 0)
        throw new PipelineError('RELEASE', `copie ${dir} non créée : ${added.stderr.trim()}`);
    try {
        const config = loadConfigAtCommit(repo, sha).config;
        const suite = suiteSettings(config);
        const noWait = { ...config, suite: { ports: suite.ports, queue: { ...suite.queue, waitMs: 0 } } };
        const result = await runGates({ repo: dir, config: noWait, stage: 'full', base: production, repeatReference: production, reference: production, repeatCeiling: false,
            batchSetup: true, env: io.env, log: line => io.stderr(`${line}\n`) });
        const failed = result.receipts.filter(r => !['passed', 'passed_after_retry', 'cached', 'not_required'].includes(r.status)).map(r => `${r.gateId} (${r.status})`);
        return { ok: result.ok && !result.flaky.length, summary: `${failed.length ? `en échec : ${failed.join(', ')}` : ''}${result.flaky.length ? ` instable(s) : ${result.flaky.join(', ')}` : ''} ; exécution ${result.runId}` };
    }
    catch (error) {
        if (error instanceof PipelineError && ['SUITE_QUEUE', 'GATE_BUSY'].includes(error.code))
            return { ok: false, busy: error.message.slice(0, 300), summary: '' };
        throw error;
    }
    finally {
        const removed = git(repo, ['worktree', 'remove', '--force', dir]);
        if (removed.status !== 0)
            io.stderr(`Copie ${dir} non retirée : ${removed.stderr.trim()}\n`);
    }
}
export async function run(args, io) {
    return guard(io, usage, async () => {
        const { values, positionals } = parse(args, {
            'dry-run': { type: 'boolean' }, json: { type: 'boolean' }, repo: { type: 'string' }, help: { type: 'boolean', short: 'h' },
        });
        if (values.help) {
            io.stdout(`${usage}\n`);
            return EXIT.ok;
        }
        if (positionals.length > 1)
            throw new UsageError(`argument inattendu : ${positionals.slice(1).join(' ')}`);
        const repo = gitRoot(repoPath(io, values.repo));
        const dryRun = values['dry-run'] === true;
        if (positionals[0] === 'auto')
            return auto(io, repo, dryRun, values.json === true);
        const state = remoteState(repo);
        const sha = positionals[0] === undefined ? state.fromHead : resolveCommit(repo, positionals[0]);
        if (!sha)
            throw new UsageError(`commit inconnu : ${positionals[0]}`);
        return report(io, values.json === true, await release(repo, state, sha, dryRun), !dryRun, 'manuel');
    });
}
//# sourceMappingURL=release.js.map