import { MERGE_REFUSED, mergeStack, planStack, processGh, type GhCall, type StackOptions, type StackPlan } from '../stack/github.js';
import { EXIT, UsageError, guard, json, parse } from './common.js';
import type { CommandIO } from './io.js';

export const usage = `Utilisation :
  apv stack plan <pr...> [--target <branche>] [--ready] [--json]
  APV_ALLOW_MERGE=1 apv stack merge <pr...> [--method merge|squash|rebase] [--target <branche>] [--ready] [--json]

Pile de PR, de la base vers le sommet (numéros de PR dans l'ordre de fusion).
plan   lit chaque PR (gh pr view) et vérifie la pile : chaque PR ouverte, la base de la PR n+1 est la
       tête de la PR n (la branche cible pour la première), fusionnable, contrôles au vert ou absents.
       Toutes les anomalies sont listées. Ne modifie rien.
merge  uniquement sur ordre explicite de l'opérateur, avec APV_ALLOW_MERGE=1 devant la commande.
       Refait la vérification juste avant chaque fusion ; une fois la PR précédente fusionnée, re-cible
       la suivante sur la branche cible et vérifie la nouvelle base par une relecture ; fusionne avec
       --match-head-commit ; constate la fusion par une relecture ; s'arrête à la première anomalie.
       La sortie complète de chaque appel gh est affichée (sur la sortie d'erreur avec --json).
--target  branche d'arrivée de la pile (par défaut la base de la première PR).
--ready   retire le statut brouillon (gh pr ready) avant la fusion ; sans lui, un brouillon est une anomalie.
La variable APV_GH remplace l'exécutable gh (tests). Sortie : 0 pile cohérente ou fusionnée,
1 anomalie (rien d'autre n'est fusionné), 2 appel incorrect ou APV_ALLOW_MERGE absent.`;

const METHODS = ['merge', 'squash', 'rebase'] as const;

const quote = (arg: string): string => /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;

/** A `gh` call as printed: the command line, its whole output and its exit status. */
export function transcript(bin: string, call: GhCall): string {
  const lines = [`$ ${[bin, ...call.args].map(quote).join(' ')}`];
  if (call.stdout) lines.push(call.stdout.replace(/\n$/, ''));
  if (call.stderr) lines.push(call.stderr.replace(/\n$/, ''));
  lines.push(call.error ? `(gh : ${call.error}${call.status !== null ? `, code ${call.status}` : ''})` : `(code de sortie ${call.status})`);
  return `${lines.join('\n')}\n`;
}

function planLines(plan: StackPlan): string[] {
  return [`Cible : ${plan.target ?? 'inconnue'}`, ...plan.prs.map((p, i) => {
    const head = p.pr ? `${p.pr.headRefName} -> ${p.pr.baseRefName}${p.pr.isDraft ? ' (brouillon)' : ''}, ${p.pr.mergeable || '?'}/${p.pr.mergeStateStatus || '?'}, contrôles ${p.pr.checks.length ? `${p.pr.checks.filter(c => c.state === 'success').length}/${p.pr.checks.length} au vert` : 'absents'}` : 'illisible';
    return `${i + 1}. PR #${p.number} : ${head}${p.anomalies.length ? `\n${p.anomalies.map(a => `   ANOMALIE : ${a}`).join('\n')}` : ' : ok'}`;
  })];
}

function numbers(values: string[]): number[] {
  if (!values.length) throw new UsageError('numéros de PR manquants (dans l\'ordre de fusion, de la base vers le sommet)');
  const out = values.map(v => {
    const m = /^#?(\d{1,9})$/.exec(v);
    if (!m || Number(m[1]) === 0) throw new UsageError(`numéro de PR invalide : ${v}`);
    return Number(m[1]);
  });
  if (new Set(out).size !== out.length) throw new UsageError('une PR figure deux fois dans la pile');
  return out;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const n = value === undefined || value === '' ? NaN : Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export async function run(args: string[], io: CommandIO): Promise<number> {
  return guard(io, usage, async () => {
    const { values, positionals } = parse(args, {
      method: { type: 'string' }, target: { type: 'string' }, ready: { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    });
    if (values.help) { io.stdout(`${usage}\n`); return EXIT.ok; }
    const [action, ...rest] = positionals;
    if (action !== 'plan' && action !== 'merge') throw new UsageError(action ? `sous-commande inconnue : stack ${action}` : 'sous-commande manquante (plan ou merge)');
    const prs = numbers(rest);
    if (action === 'plan' && values.method !== undefined) throw new UsageError('--method : réservé à stack merge');
    const method = (values.method ?? 'merge') as typeof METHODS[number];
    if (!(METHODS as readonly string[]).includes(method)) throw new UsageError(`--method invalide : ${values.method} (merge, squash ou rebase)`);
    if (values.target !== undefined && !values.target.trim()) throw new UsageError('--target vide');
    if (action === 'merge' && io.env['APV_ALLOW_MERGE'] !== '1') { io.stderr(`${MERGE_REFUSED}\n`); return EXIT.usage; }
    const bin = io.env['APV_GH'] || 'gh';
    const calls: GhCall[] = [];
    const options: StackOptions = {
      gh: processGh(bin, io.env, io.cwd), ready: Boolean(values.ready),
      pollMs: positiveInt(io.env['APV_STACK_POLL_MS'], 3000), pollAttempts: positiveInt(io.env['APV_STACK_POLL_ATTEMPTS'], 20),
      onCall: call => {
        calls.push(call);
        // merge: every call in full, as it happens (stderr in JSON mode). plan writes nothing: failed calls only.
        if (action === 'merge' || call.status !== 0 || call.error) (values.json ? io.stderr : io.stdout)(transcript(bin, call));
      },
      ...(values.target !== undefined ? { target: values.target } : {}),
    };
    if (action === 'plan') {
      const plan = await planStack(prs, options);
      if (values.json) json(io, { ...plan, calls });
      else io.stdout(`${[...planLines(plan), plan.ok ? 'Pile cohérente.' : 'Pile incohérente : corriger avant toute fusion.'].join('\n')}\n`);
      return plan.ok ? EXIT.ok : EXIT.failed;
    }
    const report = await mergeStack(prs, method, options);
    if (values.json) { json(io, { ...report, calls }); return report.stopped ? EXIT.failed : EXIT.ok; }
    const lines = ['', 'Rapport de fusion :', ...planLines(report.plan).map(l => `  ${l}`),
      `Méthode : ${method} ; fusionnées : ${report.merged.length ? report.merged.map(n => `#${n}`).join(', ') : 'aucune'}`];
    if (report.stopped) {
      const left = prs.filter(n => !report.merged.includes(n));
      lines.push(`ARRÊT à la PR #${report.stopped.pr} :`, ...report.stopped.reasons.map(r => `- ${r}`),
        `Non fusionnées : ${left.map(n => `#${n}`).join(', ')}. Rien d'autre n'a été fusionné ; vérifier l'état exact (gh pr view) avant de reprendre.`);
    } else lines.push(`Pile fusionnée dans ${report.target}.`);
    io.stdout(`${lines.join('\n')}\n`);
    return report.stopped ? EXIT.failed : EXIT.ok;
  });
}
