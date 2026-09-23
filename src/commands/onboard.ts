import { existsSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { APV_DIR } from '../config/apv-files.js';
import { CONFIG_FILE, configIssues, LEGACY_CONFIG_FILE } from '../config/load.js';
import { PipelineError, errorMessage } from '../domain/errors.js';
import { LEDGER_FILE, LEGACY_LEDGER_FILE } from '../lifecycle/decisions.js';
import { detectGates, previewHints, type DetectedGate } from '../onboard/detect.js';
import { findSpecCandidates, importV2Config, importV2Ledger, specFileName, V2_SPEC_DIRS, v2FilesNotImported, type SpecCandidate } from '../onboard/v2.js';
import { gitRoot } from '../run/git-probe.js';
import { checkSpec, parseSpecDocument } from '../spec/check.js';
import { ApvWriter, PLUGIN_ROOT, readBriefTemplate, writeApvSkeleton } from './init.js';
import { EXIT, UsageError, guard, json, parse, repoPath } from './common.js';
import type { CommandIO } from './io.js';

export const usage = `Utilisation :
  apv onboard [--repo <chemin>] [--specs <dossier>] [--dry-run] [--json]

Crée .apv/ pour un projet existant, sans jamais écraser un fichier existant (la commande peut être relancée).
Projet V2 : .apv/config.json reprend de pipeline.v2.json les contrôles (gates), risk, validationRules, skills et
environment.passEnv, et ignore le reste (agents, budgets, délais, modèles, réglages), listé ; le registre
.agent-pipeline/DECISIONS.json est repris tel quel s'il passe apv ledger validate (sinon refus, rien d'écrit) ;
les specs V2 de .agent-pipeline/specs, specs, docs/specs (et --specs) sont copiées dans .apv/specs/ si
apv spec validate --draft les accepte, sinon listées avec la raison.
Projet sans V2 : contrôles détectés (package.json, Makefile, pyproject.toml) proposés avec mandatory: false.
Le reste comme apv init : brief.md, specs/, state/, .gitignore. --dry-run montre le plan sans rien écrire.
Sortie : 0 succès, 1 hors d'un dépôt Git ou fichier V2 illisible ou invalide (rien n'est écrit), 2 appel incorrect.`;

interface SpecReport { imported: { from: string; to: string; request: string | null }[]; existing: { from: string; to: string }[]; rejected: { file: string; reasons: string[] }[] }

export interface OnboardResult {
  repo: string;
  name: string;
  dryRun: boolean;
  v2: { config: string | null; ledger: string | null; notImported: string[] };
  config: { file: string; status: 'created' | 'existing'; source: 'v2' | 'detected' | null; kept: string[]; ignored: string[]; gates: string[]; detected: DetectedGate[] };
  ledger: { file: string; status: 'imported' | 'created' | 'existing'; source: string | null; decisions: number | null; hash: string | null };
  specs: SpecReport & { searched: string[] };
  previewHints: string[];
  created: string[];
  completed: string[];
  existing: string[];
  next: string[];
}

async function validateSpecs(repo: string, candidates: SpecCandidate[], report: SpecReport): Promise<SpecCandidate[]> {
  const accepted: SpecCandidate[] = [];
  const ids = new Map<string, string>();
  for (const candidate of candidates) {
    const to = specFileName(candidate.id);
    if (candidate.reasons.length || candidate.content === null) { report.rejected.push({ file: candidate.file, reasons: candidate.reasons }); continue; }
    const other = ids.get(candidate.id);
    if (other) { report.rejected.push({ file: candidate.file, reasons: [`même identifiant (${candidate.id}) que ${other}`] }); continue; }
    ids.set(candidate.id, candidate.file);
    if (existsSync(join(repo, to))) { report.existing.push({ from: candidate.file, to }); continue; }
    try {
      const result = await checkSpec({ repo, document: parseSpecDocument(candidate.document), ready: false });
      if (result.valid) accepted.push(candidate);
      else report.rejected.push({ file: candidate.file, reasons: result.issues.map(i => `[${i.code}] ${i.message}`) });
    } catch (error) {
      report.rejected.push({ file: candidate.file, reasons: [`validation impossible : ${errorMessage(error)}`] });
    }
  }
  return accepted;
}

export async function onboardProject(repo: string, options: { dryRun: boolean; specsDir?: string; pluginRoot?: string }): Promise<OnboardResult> {
  const name = basename(repo);
  // Everything is read and checked before the first write: a refusal leaves the repository untouched.
  const template = readBriefTemplate(options.pluginRoot ?? PLUGIN_ROOT);
  const hasV2Config = existsSync(join(repo, LEGACY_CONFIG_FILE));
  const hasV2Ledger = existsSync(join(repo, LEGACY_LEDGER_FILE));
  const configExists = existsSync(join(repo, CONFIG_FILE));
  const ledgerExists = existsSync(join(repo, LEDGER_FILE));

  const config: OnboardResult['config'] = { file: CONFIG_FILE, status: configExists ? 'existing' : 'created', source: null, kept: [], ignored: [], gates: [], detected: [] };
  let configText: string | undefined;
  if (!configExists && hasV2Config) {
    const imported = importV2Config(repo, name);
    Object.assign(config, { source: 'v2', kept: imported.kept, ignored: imported.ignored, gates: imported.gates });
    configText = `${JSON.stringify(imported.config, null, 2)}\n`;
  } else if (!configExists) {
    const detected = detectGates(repo);
    const document = { name, gates: detected.map(g => ({ id: g.id, command: g.command, mandatory: false })) };
    const { issues } = configIssues(document);
    if (issues.length) throw new PipelineError('ONBOARD', `Contrôles détectés refusés par le schéma : ${issues.map(i => i.message).join(' ; ')}`);
    Object.assign(config, { source: 'detected', gates: detected.map(g => g.id), detected });
    configText = `${JSON.stringify(document, null, 2)}\n`;
  }

  const ledger: OnboardResult['ledger'] = { file: LEDGER_FILE, status: ledgerExists ? 'existing' : 'created', source: null, decisions: null, hash: null };
  let ledgerFiles: { path: string; content: () => string }[] | undefined;
  if (!ledgerExists && hasV2Ledger) {
    const imported = importV2Ledger(repo);
    Object.assign(ledger, { status: 'imported', source: imported.file, decisions: imported.decisions, hash: imported.hash });
    ledgerFiles = [{ path: LEDGER_FILE, content: () => imported.text }, { path: LEDGER_FILE.replace(/\.json$/, '.md'), content: () => imported.markdown }];
  }

  const searched = [...V2_SPEC_DIRS.map(d => join(repo, d)), ...(options.specsDir ? [options.specsDir] : [])];
  const specs: OnboardResult['specs'] = { searched: [...V2_SPEC_DIRS, ...(options.specsDir ? [options.specsDir] : [])], imported: [], existing: [], rejected: [] };
  const accepted = await validateSpecs(repo, findSpecCandidates(repo, searched), specs);

  const writer = new ApvWriter(repo, options.dryRun);
  writeApvSkeleton(writer, name, template, {
    ...(configText !== undefined ? { config: () => configText } : {}),
    ...(ledgerFiles ? { ledger: ledgerFiles } : {}),
  });
  for (const candidate of accepted) {
    const to = specFileName(candidate.id);
    if (writer.file(to, () => candidate.content!)) specs.imported.push({ from: candidate.file, to, request: candidate.requestFile });
    else specs.existing.push({ from: candidate.file, to });
  }

  const baseGates = configText === undefined ? [] : ((JSON.parse(configText) as { gates?: { id: string; command: string[] }[] }).gates ?? [])
    .filter(g => g.command.some(arg => arg.includes('{{baseSha}}'))).map(g => g.id);
  const next = [
    ...(options.dryRun ? ['relancer sans --dry-run pour écrire ce plan'] : []),
    'relire .apv/config.json (contrôles, mandatory) et adapter .apv/brief.md (passages entre chevrons)',
    'apv ledger validate',
    baseGates.length ? `apv gates run --base <branche de base, par exemple main> (${baseGates.join(', ')} utilise {{baseSha}})` : 'apv gates run',
    `git add ${APV_DIR} && git commit -m "chore(apv): reprise du projet" (sur accord de l'opérateur)`,
  ];
  return {
    repo, name, dryRun: options.dryRun,
    v2: { config: hasV2Config ? LEGACY_CONFIG_FILE : null, ledger: hasV2Ledger ? LEGACY_LEDGER_FILE : null, notImported: v2FilesNotImported(repo) },
    config, ledger, specs, previewHints: previewHints(repo),
    created: writer.created, completed: writer.completed, existing: writer.existing, next,
  };
}

function text(result: OnboardResult): string {
  const lines: string[] = [];
  const v2 = [result.v2.config, result.v2.ledger].filter(Boolean);
  lines.push(`Projet « ${result.name} » : ${result.repo} (${v2.length ? `projet V2 : ${v2.join(', ')}` : 'sans V2'})`);
  if (result.dryRun) lines.push('Essai (--dry-run) : rien n\'est écrit.');
  lines.push('', `Configuration (${result.config.file}) :`);
  if (result.config.status === 'existing') lines.push('  existe déjà, inchangée (rien n\'est repris ni détecté)');
  else if (result.config.source === 'v2') {
    lines.push(`  reprise de ${LEGACY_CONFIG_FILE} : ${result.config.kept.join(', ') || 'aucune section'}`);
    lines.push(`  contrôles (${result.config.gates.length}) : ${result.config.gates.join(', ') || 'aucun'}`);
    lines.push(`  ignoré (contrôleur V2 retiré) : ${result.config.ignored.join(', ') || 'rien'}`);
  } else {
    if (!result.config.detected.length) lines.push('  aucun contrôle détecté : gates vide, à déclarer avec l\'opérateur');
    for (const g of result.config.detected) lines.push(`  ${g.id} : ${g.command.join(' ')} (${g.source}) ; ${g.note}`);
  }
  lines.push('', `Registre (${result.ledger.file}) :`);
  if (result.ledger.status === 'existing') lines.push('  existe déjà, inchangé');
  else if (result.ledger.status === 'imported') {
    lines.push(`  repris tel quel de ${result.ledger.source} : ${result.ledger.decisions} décision(s), empreinte ${result.ledger.hash}, valide pour apv ledger validate`);
    lines.push('  version lisible .apv/DECISIONS.md régénérée depuis le registre');
  } else lines.push('  aucun registre V2 : registre vide');
  lines.push('', `Specs V2 (cherchées dans : ${result.specs.searched.join(', ')}) :`);
  if (!result.specs.imported.length && !result.specs.existing.length && !result.specs.rejected.length) {
    lines.push('  aucune trouvée (V2 garde ses specs dans sa base d\'état, hors du dépôt : --specs <dossier> pour des fichiers exportés)');
  }
  for (const s of result.specs.imported) lines.push(`  ${result.dryRun ? 'à copier' : 'copiée'} : ${s.from} -> ${s.to}${s.request ? ` (avec la demande ${s.request})` : ''}`);
  for (const s of result.specs.existing) lines.push(`  existe déjà : ${s.to} (${s.from} non recopiée)`);
  for (const s of result.specs.rejected) {
    lines.push(`  non reprise : ${s.file}`);
    for (const reason of s.reasons.slice(0, 8)) lines.push(`    - ${reason}`);
    if (s.reasons.length > 8) lines.push(`    - et ${s.reasons.length - 8} autre(s) (apv spec validate ${s.file} --draft)`);
  }
  if (result.v2.notImported.length) lines.push('', `Fichiers V2 non repris (fournis par le plugin ou propres à V2) : ${result.v2.notImported.join(', ')}`);
  if (result.previewHints.length) lines.push('', `Aperçu : indices trouvés, à décrire dans la section preview (docs/PREVIEW.md) : ${result.previewHints.join(' ; ')}`);
  lines.push('');
  lines.push(result.created.length ? `${result.dryRun ? 'Serait créé' : 'Créé'} : ${result.created.join(', ')}` : 'Rien à créer : .apv/ est complet.');
  if (result.completed.length) lines.push(`${result.dryRun ? 'Serait complété' : 'Complété'} : ${result.completed.join(', ')}`);
  if (result.existing.length) lines.push(`Existait déjà (inchangé) : ${result.existing.join(', ')}`);
  if (result.v2.config || result.v2.ledger) lines.push(`Les fichiers V2 restent en place ; une fois créés, ${CONFIG_FILE} et ${LEDGER_FILE} sont lus en priorité.`);
  lines.push('', 'Suite :', ...result.next.map((n, i) => `  ${i + 1}. ${n}`));
  return `${lines.join('\n')}\n`;
}

export async function run(args: string[], io: CommandIO): Promise<number> {
  return guard(io, usage, async () => {
    const { values, positionals } = parse(args, {
      repo: { type: 'string' }, specs: { type: 'string' }, 'dry-run': { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    });
    if (values.help) { io.stdout(`${usage}\n`); return EXIT.ok; }
    if (positionals.length) throw new UsageError(`argument inattendu : ${positionals.join(' ')}`);
    let specsDir: string | undefined;
    if (values.specs !== undefined) {
      specsDir = resolve(io.cwd, values.specs);
      if (!existsSync(specsDir) || !statSync(specsDir).isDirectory()) throw new UsageError(`--specs : dossier introuvable : ${specsDir}`);
    }
    const repo = gitRoot(repoPath(io, values.repo));
    const result = await onboardProject(repo, { dryRun: values['dry-run'] === true, ...(specsDir ? { specsDir } : {}) });
    if (values.json) json(io, result); else io.stdout(text(result));
    return EXIT.ok;
  });
}
