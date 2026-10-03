import { loadConfig } from '../config/load.js';
import { gitRoot } from '../run/git-probe.js';
import { TEST_CHECK_RULES, checkTests, type TestCheckReport, type TestCheckRule } from '../testcheck/check.js';
import { EXIT, UsageError, guard, json, parse, repoPath } from './common.js';
import type { CommandIO } from './io.js';

export const usage = `Utilisation :
  apv tests check [--base <ref>] [--repo <chemin>] [--json]

Contrôles déterministes des fichiers de test que le changement ajoute ou modifie depuis la base commune de
--base (le contrôle déclaré passe {{baseSha}}) ou de testsCheck.reference, arbre de travail et fichiers non
suivis compris ; seules les lignes ajoutées comptent :
  waitForTimeout  page.waitForTimeout( dans un test navigateur (erreur par défaut) ;
  fixedWait       autre attente à durée fixe dans un test navigateur : sleep(, delay(, await setTimeout(,
                  new Promise(r => setTimeout(r, …)) (avertissement par défaut) ;
  realClock       test unitaire qui teste un délai sur l'horloge réelle : setTimeout et Date.now() ou
                  performance.now() dans le fichier, sans faux minuteurs (avertissement par défaut) ;
  sharedData      adresse e-mail écrite par le changement dans un test navigateur et aussi dans un autre
                  test navigateur du projet (avertissement par défaut).
À déclarer comme contrôle de tâche : {"id": "tests", "command": ["apv", "tests", "check", "--base", "{{baseSha}}"]}.
Configuration facultative : section « testsCheck » de .apv/config.json (enabled, reference, e2e, unit, ignore,
severity : off, warning ou error par règle).
Sortie : 0 aucun constat de gravité error, 1 au moins un, référence introuvable ou absente, configuration
invalide, 2 appel incorrect.`;

const LABEL: Record<TestCheckRule, string> = {
  waitForTimeout: 'Attente waitForTimeout',
  fixedWait: 'Autre attente à durée fixe (test navigateur)',
  realClock: 'Délai testé sur l\'horloge réelle (test unitaire)',
  sharedData: 'Données partagées entre tests navigateur',
};
const SEVERITY = { off: 'désactivée', warning: 'avertissement', error: 'erreur' } as const;

export function formatTests(report: TestCheckReport): string {
  if (!report.enabled) return 'Tests modifiés : contrôle désactivé par le projet (testsCheck.enabled = false).\n';
  const lines = [`Tests modifiés depuis la base commune de ${report.base.ref} (${report.base.mergeBase?.slice(0, 12)}) : ${report.files.e2e.length} test(s) navigateur, ${report.files.unit.length} test(s) unitaire(s).`];
  for (const rule of TEST_CHECK_RULES) {
    const found = report.findings.filter(f => f.rule === rule);
    lines.push('', `${LABEL[rule]} (${SEVERITY[report.severity[rule]]}) : ${report.severity[rule] === 'off' ? 'règle désactivée' : `${found.length} constat(s)`}`);
    for (const f of found) lines.push(`  ${f.severity === 'error' ? '[bloquant] ' : ''}${f.file}:${f.line} : ${f.text}`, `    ${f.message}`);
  }
  const blocking = report.findings.filter(f => f.severity === 'error').length;
  lines.push('', report.ok ? 'Résultat : aucun constat bloquant.' : `Résultat : ÉCHEC, ${blocking} constat(s) bloquant(s) : attendre un fait observable, jamais une durée.`);
  return `${lines.join('\n')}\n`;
}

export async function run(args: string[], io: CommandIO): Promise<number> {
  return guard(io, usage, async () => {
    const { values, positionals } = parse(args, { base: { type: 'string' }, repo: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } });
    if (values.help) { io.stdout(`${usage}\n`); return EXIT.ok; }
    const [action, ...rest] = positionals;
    if (action !== 'check') throw new UsageError(action ? `sous-commande inconnue : tests ${action}` : 'sous-commande manquante (check)');
    if (rest.length) throw new UsageError(`argument inattendu : ${rest.join(' ')}`);
    if (values.base !== undefined && (!values.base || values.base.startsWith('-'))) throw new UsageError('--base : référence Git attendue');
    const repo = gitRoot(repoPath(io, values.repo));
    const { config } = loadConfig(repo);
    const report = checkTests(repo, config.testsCheck, values.base !== undefined ? { base: values.base } : {});
    if (values.json) json(io, report);
    else io.stdout(formatTests(report));
    return report.ok ? EXIT.ok : EXIT.failed;
  });
}
