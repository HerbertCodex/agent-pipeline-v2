import { validateConfig, agentSchema } from '../domain/contracts.js';
import { providerProfile } from '../adapters/providers.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { publishSpec, syncSpec } from './github.js';
import { Lifecycle } from './service.js';
import { planInstallation, applyInstallation, doctor, type InstallPlan } from './onboarding.js';
import { specMarkdown, type SpecRecord } from './contracts.js';
import { invariant } from '../domain/errors.js';
import { parseJson } from '../domain/schema.js';
import { Git } from '../execution/git.js';
import { planBootstrap, refineBootstrap, applyBootstrap, type BootstrapPlan } from './bootstrap.js';
import type { Document } from '../persistence/store.js';
import { planGarbage, collectGarbage, planPurge, purgeDocuments, purgeProtections } from './maintenance.js';
import { planLedgerUpdate, applyLedgerUpdate } from './ledger-update.js';
export const lifecycleHelp = `
Full lifecycle (local trusted projects; explicit approval boundaries):
  apv2 bootstrap --repo PATH --request TEXT --provider codex|claude [--review-mode solo|team|regulated]
  apv2 bootstrap show PLAN_ID
  apv2 bootstrap refine PLAN_ID --request TEXT
  apv2 bootstrap apply PLAN_ID --hash HASH --approve [--reviewer NAME] [--note TEXT] --commit
  apv2 onboard --repo PATH [--provider codex|claude | --agent FILE] [--review-mode solo|team|regulated] [--assist] [--config FILE]
  apv2 onboard show PLAN_ID
  apv2 onboard apply PLAN_ID --hash HASH --approve [--reviewer NAME] [--note TEXT] [--commit]
  apv2 onboard recover PLAN_ID --confirm-stopped
  apv2 doctor --repo PATH [--config FILE] [--execute]
  apv2 spec compact --repo PATH --request TEXT --file TASK_JSON [--config FILE]
  apv2 spec draft --repo PATH --request TEXT [--pathway auto|standard|structural] [--file SPEC_JSON] [--config FILE]
  apv2 ask --repo PATH --request TEXT       Alias for spec draft, not implicit execution
  apv2 spec plan-resume SPEC_ID            Resume retained Product/Design checkpoints
  apv2 spec budget SPEC_ID --file LIMITS_JSON --approve --note TEXT
  apv2 spec refine SPEC_ID --request TEXT [--file SPEC_JSON]
  apv2 spec show SPEC_ID [--output SPEC_MD]  Full content + next action
  apv2 spec list [--active] | apv2 spec events SPEC_ID | apv2 spec diff SPEC_ID
  apv2 spec approve SPEC_ID --hash HASH --approve [--reviewer NAME] [--note TEXT]
  apv2 spec run SPEC_ID [--manual-qa] [--accept-current] [--accept-cost]
  apv2 spec qa SPEC_ID --file QA_JSON       Explicit external QA report import
  apv2 spec review SPEC_ID --sha SHA --approve [--reviewer NAME] [--note TEXT]
  apv2 spec reject SPEC_ID --note TEXT
  apv2 spec verify SPEC_ID                 Revalidate; invalidates QA + approvals
  apv2 spec amend SPEC_ID --amendment AMENDMENT_ID --approve [--reviewer NAME] [--note TEXT]
  apv2 spec criterion SPEC_ID --criterion AC_ID --file CORRECTION_JSON
                                           Propose a correction of one acceptance criterion of a
                                           running spec ({description, verification, reason, and
                                           optional requirements: [{id, verification}] linked to it})
  apv2 spec criterion SPEC_ID --amendment AMENDMENT_ID --hash HASH --approve [--reviewer NAME] [--note TEXT]
  apv2 spec retry SPEC_ID --confirm        Authorize one new failed-task attempt
  apv2 spec recover SPEC_ID --confirm-stopped
  apv2 spec deliver SPEC_ID --output NEW_DIRECTORY
  apv2 spec branch SPEC_ID --name BRANCH --confirm
  apv2 spec publish SPEC_ID --repository OWNER/REPO --remote origin --name BRANCH --target main --confirm-push --confirm-pr [--for-review]
                                           --for-review opens the draft PR before approval, for reading
  apv2 spec sync SPEC_ID                   Observe merge; never merge automatically
  apv2 spec close SPEC_ID --target MAIN_BRANCH --sha MERGED_HEAD --reviewer NAME --note TEXT

Maintenance:
  apv2 decisions plan --repo PATH --file UPDATE_JSON   Preview a Decision Ledger change and its hash
  apv2 decisions apply --repo PATH --file UPDATE_JSON --hash HASH --approve --note TEXT [--commit]
  apv2 gc [--confirm]                      Dry-run by default; removes obsolete workspaces only
  apv2 prune [--id DOCUMENT_ID] [--older-than DAYS] [--confirm]
                                           Dry-run by default; removes abandoned or terminal
                                           lifecycle documents, their runs and their workspaces

--model MODEL and --effort low|medium|high select native bootstrap/onboard execution.
--request-file FILE may replace --request. --quiet suppresses progress on stderr.
Product and QA use read-only role invocations with Codex, Claude Code or a compatible command worker.
No operator approval is inferred from a model response. No deploy command.
`;
export async function lifecycleCommand(command: string, positionals: string[], values: Record<string, string | boolean | undefined>, root: string, signal: AbortSignal): Promise<boolean> {
    if (!['bootstrap','onboard', 'doctor', 'spec', 'ask', 'gc', 'prune', 'decisions'].includes(command))
        return false;
    const str = (key: string): string | undefined => typeof values[key] === 'string' ? values[key] as string : undefined;
    const required = (key: string): string => { const v = str(key); invariant(v, 'ARGUMENT', `Missing --${key}`); return v; };
    const load = (file: string): unknown => { const text = readFileSync(resolve(file), 'utf8'); invariant(text.length <= 2000000, 'INPUT_SIZE', 'Input exceeds 2 MB'); return parseJson(text); };
    const textRequest = (): string => { if (str('request-file')) {
        const text = readFileSync(resolve(str('request-file')!), 'utf8');
        invariant(text.length <= 30000, 'INPUT_SIZE', 'Request too large');
        return text;
    } return required('request'); };
    const repo = resolve(str('repo') ?? '.');
    const chosenProvider = (name: string) => agentSchema.parse({ ...providerProfile(name), ...(str('model') ? { model: str('model') } : {}), ...(str('effort') ? { effort: str('effort') } : {}) });
    const config = (): unknown => load(str('config') ?? join(repo, 'pipeline.v2.json'));
    const approval = async (targetRepo: string): Promise<{ reviewer:string; note:string }> => {
        invariant(values['approve'] === true || str('reviewer') !== undefined || str('note') !== undefined, 'CONFIRM', 'Use --approve to record explicit operator approval');
        const reviewer = str('reviewer') ?? await new Git().configValue(targetRepo, 'user.name');
        invariant(reviewer && reviewer.trim().length >= 3, 'REVIEW', 'Configure git user.name or provide --reviewer NAME');
        return { reviewer: reviewer.trim(), note: (str('note') ?? 'Explicit operator approval of the exact reviewed content.').trim() };
    };
    const life = new Lifecycle(root);
    if (!values['quiet'])
        life.store.onProgress = (source, id, type, data) => {
            if (/started|completed|failed|blocked|created|reused|proposed|finished|review_ready/.test(type))
                console.error(JSON.stringify({ progress: true, source, id, event: type, ...(typeof data['taskId'] === 'string' ? { task: data['taskId'] } : {}), ...(typeof data['gateId'] === 'string' ? { gate: data['gateId'] } : {}), ...(typeof data['role'] === 'string' ? { role: data['role'] } : {}), ...(typeof data['status'] === 'string' ? { status: data['status'] } : {}) }));
        };
    try {
        if (command === 'bootstrap') {
            const [sub, id] = positionals.slice(1);
            if (!sub) {
                invariant(str('provider'), 'ARGUMENT', 'Bootstrap requires --provider codex|claude');
                const reviewMode = (str('review-mode') ?? 'team') as 'solo' | 'team' | 'regulated';
                invariant(['solo','team','regulated'].includes(reviewMode), 'ARGUMENT', 'Choose --review-mode solo|team|regulated');
                const doc = await planBootstrap(life.store, repo, textRequest(), chosenProvider(str('provider')!), signal, reviewMode);
                console.log(JSON.stringify({ id: doc.id, ...doc.data, nextAction: doc.data.proposal.questions.length || doc.data.semanticReview.verdict !== 'pass' ? `Refine bootstrap ${doc.id}; only bootstrap blockers and semantic conflicts prevent apply` : `apv2 bootstrap apply ${doc.id} --hash ${doc.data.hash} --approve --commit` }, null, 2));
                process.exitCode = doc.data.proposal.questions.length || doc.data.semanticReview.verdict !== 'pass' ? 2 : 0;
                return true;
            }
            invariant(id, 'ARGUMENT', 'Missing PLAN_ID');
            if (sub === 'show') {
                const doc = life.store.document<BootstrapPlan>(id, 'bootstrap');
                console.log(JSON.stringify({ id: doc.id, ...doc.data }, null, 2));
                process.exitCode = doc.data.proposal.questions.length || doc.data.semanticReview.verdict !== 'pass' ? 2 : 0;
                return true;
            }
            if (sub === 'refine') {
                const doc = await refineBootstrap(life.store, id, textRequest(), signal);
                console.log(JSON.stringify({ id: doc.id, ...doc.data, nextAction: doc.data.proposal.questions.length || doc.data.semanticReview.verdict !== 'pass' ? 'Resolve bootstrap consistency findings or bootstrap-only questions, then refine again' : `apv2 bootstrap apply ${doc.id} --hash ${doc.data.hash} --approve --commit` }, null, 2));
                process.exitCode = doc.data.proposal.questions.length || doc.data.semanticReview.verdict !== 'pass' ? 2 : 0;
                return true;
            }
            if (sub === 'apply') {
                const plan = life.store.document<BootstrapPlan>(id, 'bootstrap');
                const a = await approval(plan.data.directory);
                const result = await applyBootstrap(life.store, id, required('hash'), a.reviewer, a.note, values['commit'] === true);
                console.log(JSON.stringify({ bootstrap: { id: result.bootstrap.id, ...result.bootstrap.data }, onboarding: { id: result.onboarding.id, ...result.onboarding.data }, nextAction: result.onboarding.data.questions.length ? `Resolve onboarding questions for ${result.onboarding.id}` : `apv2 onboard apply ${result.onboarding.id} --hash ${result.onboarding.data.hash} --approve --commit` }, null, 2));
                process.exitCode = result.onboarding.data.questions.length ? 2 : 0;
                return true;
            }
            throw new Error(`Unknown bootstrap command ${sub}`);
        }
        if (command === 'onboard') {
            const [sub, id] = positionals.slice(1);
            let doc: Document<InstallPlan>;
            if (!sub) {
                invariant(!(str('provider') && str('agent')), 'ARGUMENT', 'Choose --provider or --agent, not both');
                invariant(!(str('provider') && str('config')), 'ARGUMENT', 'With --config select providers in that reviewed file');
                invariant(!(str('model') || str('effort')) || str('provider'), 'ARGUMENT', '--model/--effort require --provider; with --config tune its role definitions');
                const chosen = str('provider') ? chosenProvider(str('provider')!) : str('agent') ? load(str('agent')!) : undefined;
                const reviewMode = str('review-mode');
                invariant(!reviewMode || ['solo','team','regulated'].includes(reviewMode), 'ARGUMENT', 'Choose --review-mode solo|team|regulated');
                doc = await planInstallation(life.store, repo, { ...(str('config') ? { config: config() } : {}), ...(chosen ? { agent: chosen } : {}), ...(reviewMode ? { reviewMode: reviewMode as 'solo'|'team'|'regulated' } : {}), assist: values['assist'] === true, signal });
            }
            else {
                invariant(id, 'ARGUMENT', 'Missing PLAN_ID');
                if (sub === 'apply') {
                    const plan = life.store.document<InstallPlan>(id, 'install');
                    const a = await approval(plan.data.repo);
                    doc = await applyInstallation(life.store, id, required('hash'), a.reviewer, a.note, values['commit'] === true);
                }
                else if (sub === 'show')
                    doc = life.store.document<InstallPlan>(id, 'install');
                else if (sub === 'recover') {
                    life.store.recoverDocument(id, values['confirm-stopped'] === true);
                    doc = life.store.document<InstallPlan>(id, 'install');
                }
                else
                    throw new Error(`Unknown onboard command ${sub}`);
            }
            console.log(JSON.stringify({ id: doc.id, ...doc.data, nextAction: doc.data.applied ? `Commit the proposed files if not already done, then apv2 doctor --repo ${JSON.stringify(doc.data.repo)} --execute` : `apv2 onboard apply ${doc.id} --hash ${doc.data.hash} --approve --commit` }, null, 2));
            process.exitCode = doc.data.questions.length ? 2 : 0;
            return true;
        }
        if (command === 'doctor') {
            const report = await doctor(life.pipeline, repo, config(), values['execute'] === true, signal);
            console.log(JSON.stringify(report, null, 2));
            process.exitCode = report.passed === false ? 1 : 0;
            return true;
        }
        if (command === 'gc') {
            const items = planGarbage(life);
            const bytes = items.reduce((n, x) => n + x.bytes, 0);
            if (values['confirm'] !== true) {
                console.log(JSON.stringify({ dryRun: true, items, totalBytes: bytes, next: items.length ? 'Review the list, then run apv2 gc --confirm. The SQLite history, deliveries and source repositories are never removed.' : 'Nothing to collect.' }, null, 2));
                return true;
            }
            const result = await collectGarbage(life, items);
            console.log(JSON.stringify({ dryRun: false, removed: result.removed, failed: result.failed, freedBytes: result.removed.reduce((n, x) => n + x.bytes, 0) }, null, 2));
            process.exitCode = result.failed.length ? 1 : 0;
            return true;
        }
        if (command === 'prune') {
            const ids = [...positionals.slice(1), ...(str('id') ? [str('id')!] : [])];
            const olderThan = str('older-than') ? Number(str('older-than')) : undefined;
            invariant(olderThan === undefined || (Number.isFinite(olderThan) && olderThan >= 0), 'ARGUMENT', '--older-than expects a number of days');
            const items = planPurge(life, { ...(ids.length ? { ids } : {}), ...(olderThan === undefined ? {} : { olderThanDays: olderThan }) });
            if (values['confirm'] !== true) {
                console.log(JSON.stringify({ dryRun: true, items, kept: purgeProtections(life), totalBytes: items.reduce((n, x) => n + x.bytes, 0),
                    next: items.length ? 'Read the list: purging deletes these documents, their runs and their receipts from the local history, without any backup. Then run the same command with --confirm.' : 'Nothing to purge.' }, null, 2));
                return true;
            }
            invariant(items.length > 0, 'ARGUMENT', 'Nothing matches; run without --confirm to see the plan');
            const result = await purgeDocuments(life, items);
            console.log(JSON.stringify({ dryRun: false, purged: result.purged.map(x => ({ id: x.id, kind: x.kind, status: x.status, reason: x.reason })), failed: result.failed, freedBytes: result.purged.reduce((n, x) => n + x.bytes, 0) }, null, 2));
            process.exitCode = result.failed.length ? 1 : 0;
            return true;
        }
        if (command === 'decisions') {
            const action = positionals[1];
            invariant(action === 'plan' || action === 'apply', 'ARGUMENT', 'Use apv2 decisions plan|apply --repo PATH --file UPDATE_JSON');
            const update = load(required('file'));
            if (action === 'plan') {
                const plan = await planLedgerUpdate(repo, update);
                console.log(JSON.stringify({ ...plan, next: `Review the resulting ledger, then: apv2 decisions apply --repo ${plan.repo} --file ${str('file')} --hash ${plan.hash} --approve --note "why" --commit` }, null, 2));
                return true;
            }
            const { reviewer, note } = await approval(repo);
            invariant(str('note'), 'REVIEW', 'Provide --note explaining the ledger change');
            const applied = await applyLedgerUpdate(repo, update, required('hash'), reviewer, note, values['commit'] === true);
            console.log(JSON.stringify({ applied: true, added: applied.added, superseded: applied.superseded, ledgerHash: applied.ledgerHash, commitSha: applied.commitSha }, null, 2));
            return true;
        }
        const [sub, id] = command === 'ask' ? ['draft', undefined] : positionals.slice(1);
        const specId = (): string => { invariant(id, 'ARGUMENT', 'Missing SPEC_ID'); return id; };
        let doc: Document<SpecRecord>;
        switch (sub) {
            case 'compact': {
                const conf = validateConfig(config()); const request = textRequest();
                doc = await life.draft({ repo, config: conf, request, compactTask: load(required('file')), signal });
                life.store.documentEvent(doc.id, 'planning.compact', { productCalls: 0 });
                break;
            }
            case 'draft':
                invariant(!str('pathway') || ['auto', 'standard', 'structural'].includes(str('pathway')!), 'ARGUMENT', 'Choose --pathway auto|standard|structural');
                doc = await life.draft({ repo, config: config(), request: textRequest(), ...(str('pathway') ? { pathway: str('pathway') as 'auto' | 'standard' | 'structural' } : {}), ...(str('file') ? { proposal: load(str('file')!) } : {}), signal });
                break;
            case 'plan-resume':
                doc = await life.resumePlanning(specId(), signal);
                break;
            case 'budget': {
                const current = life.get(specId()); const a = await approval(current.data.repo);
                invariant(str('note'), 'REVIEW', 'Explain the budget amendment with --note');
                doc = life.amendBudget(specId(), load(required('file')), a.reviewer, a.note);
                break;
            }
            case 'refine':
                doc = await life.refine(specId(), textRequest(), str('file') ? load(str('file')!) : undefined, signal);
                break;
            case 'approve': {
                const current = life.get(specId()); const a = await approval(current.data.repo);
                doc = await life.approveSpec(specId(), required('hash'), a.reviewer, a.note);
                break;
            }
            case 'run':
                doc = await life.run(specId(), { signal, manualQa: values['manual-qa'] === true, acceptCurrent: values['accept-current'] === true, acceptCost: values['accept-cost'] === true });
                break;
            case 'qa':
                doc = await life.importQa(specId(), load(required('file')));
                break;
            case 'review': {
                const current = life.get(specId()); const a = await approval(current.data.repo);
                doc = await life.review(specId(), required('sha'), a.reviewer, a.note);
                break;
            }
            case 'criterion': {
                const current = life.get(specId());
                if (str('amendment')) {
                    const a = await approval(current.data.repo);
                    invariant(str('note'), 'REVIEW', 'Provide --note explaining why the approved criterion cannot hold');
                    doc = life.approveCriterionAmendment(specId(), str('amendment')!, required('hash'), a.reviewer, a.note);
                    break;
                }
                const correction = load(required('file')) as { description?: unknown; verification?: unknown; reason?: unknown; requirements?: unknown };
                invariant(typeof correction.description === 'string' && typeof correction.verification === 'string' && typeof correction.reason === 'string',
                    'ARGUMENT', 'The correction file needs description, verification and reason');
                const requirements = correction.requirements ?? [];
                invariant(Array.isArray(requirements) && requirements.every(x => x && typeof x.id === 'string' && typeof x.verification === 'string'),
                    'ARGUMENT', 'requirements must be a list of {id, verification}');
                doc = life.planCriterionAmendment(specId(), required('criterion'), { description: correction.description, verification: correction.verification, reason: correction.reason, requirements: requirements as { id: string; verification: string }[] });
                const proposed = (doc.data.criterionAmendments ?? []).filter(x => x.status === 'pending').at(-1)!;
                console.log(JSON.stringify({ ...life.summary(doc), criterionAmendment: proposed,
                    next: `apv2 spec criterion ${doc.id} --amendment ${proposed.id} --hash ${proposed.hash} --approve --note "why the approved criterion cannot hold"` }, null, 2));
                return true;
            }
            case 'amend': {
                const current = life.get(specId()); const a = await approval(current.data.repo);
                doc = await life.approveScopeAmendment(specId(), required('amendment'), a.reviewer, a.note);
                break;
            }
            case 'reject':
                doc = life.reject(specId(), required('note'));
                break;
            case 'verify':
                doc = await life.verify(specId(), signal);
                break;
            case 'retry':
                doc = await life.retry(specId(), values['confirm'] === true);
                break;
            case 'recover':
                doc = life.recover(specId(), values['confirm-stopped'] === true);
                break;
            case 'deliver':
                doc = await life.deliver(specId(), required('output'));
                break;
            case 'branch':
                doc = await life.branch(specId(), required('name'), values['confirm'] === true);
                break;
            case 'publish':
                doc = await publishSpec(life, specId(), { repository: required('repository'), remote: str('remote') ?? 'origin', branch: required('name'), base: required('target'), confirmPush: values['confirm-push'] === true, confirmPr: values['confirm-pr'] === true, forReview: values['for-review'] === true, signal });
                break;
            case 'sync':
                doc = await syncSpec(life, specId(), signal);
                break;
            case 'close':
                doc = await life.closeLocal(specId(), required('target'), required('sha'), required('reviewer'), required('note'));
                break;
            case 'list':
                console.log(JSON.stringify(life.store.documents<SpecRecord>('spec').filter(d => values['active'] !== true || !['closed', 'rejected'].includes(d.data.status)).map(d => life.summary(d)), null, 2));
                return true;
            case 'show': {
                doc = life.get(specId());
                if (str('output')) {
                    writeFileSync(resolve(str('output')!), specMarkdown(doc.data, doc.id), { flag: 'wx', mode: 0o600 });
                }
                console.log(JSON.stringify({ ...life.summary(doc), spec: doc.data.content, productApproval: doc.data.approval, activeProcesses: life.store.documentProcesses(doc.id) }, null, 2));
                return true;
            }
            case 'events': {
                doc = life.get(specId());
                const events: unknown[] = [...life.store.documentEvents(doc.id).map(e => ({ source: 'lifecycle', ...e }))];
                for (const runId of new Set([...doc.data.attempts.map(a => a.runId), ...doc.data.validationRunIds, ...(doc.data.finalRunId ? [doc.data.finalRunId] : [])]))
                    events.push(...life.store.events(runId).map(e => ({ source: 'run', ...e })));
                for (const event of events)
                    console.log(JSON.stringify(event));
                return true;
            }
            case 'diff':
                doc = life.get(specId());
                invariant(doc.data.currentSha !== doc.data.baseSha, 'CANDIDATE', 'No candidate yet');
                process.stdout.write(await new Git().patch(doc.data.repo, doc.data.baseSha, doc.data.currentSha));
                return true;
            default: throw new Error(`Unknown spec command ${sub ?? ''}. See apv2 --help.`);
        }
        console.log(JSON.stringify(life.summary(doc), null, 2));
        process.exitCode = doc.data.error?.code === 'CANCELLED' ? 130 : ['blocked', 'rejected'].includes(doc.data.status) ? 1 : doc.data.status === 'awaiting_review' || (doc.data.status === 'draft' && doc.data.content?.questions.length) ? 2 : 0;
        return true;
    }
    finally {
        life.close();
    }
}
