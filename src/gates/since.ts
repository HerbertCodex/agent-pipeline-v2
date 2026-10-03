import { loadConfigAtCommit, type ApvConfig } from '../config/load.js';
import { loadDbConfigAtCommit } from '../db/config.js';
import { designDir } from '../design/config.js';
import { PipelineError } from '../domain/errors.js';
import { Git } from '../execution/git.js';
import { sensitivePaths } from '../policy/policy.js';
import { reviewPlanSettings } from '../review/config.js';
import { planReviews } from '../review/plan.js';
import type { DiffRisk } from '../review/risk.js';
import { verifyGates } from './verify.js';

/**
 * Incremental proof after corrections (`apv gates run --stage task --since <commit prouvé>`). Pilot project, 3 October
 * 2026: a pull request of tests and texts ran the full suite of 30 minutes after each round of corrections. A round of
 * corrections that follows a commit with a green full proof, and whose diff since that commit is of low risk (the
 * classification of `apv review plan`, src/review/risk.ts), runs the checks of the task stage from that commit: the
 * targeted commands (`affected`, `{{baseSha}}` = the proven commit) and the repetition of the changed test files
 * (`repeatChanged`). It never proves the full suite: `apv gates verify` and `apv rules check` still require the full
 * suite at the exact commit merged, run once on the final commit.
 */
export interface SinceCheck {
  /** The proven commit (full SHA). */
  commit: string;
  head: string;
  /** Checks proven by the full suite at the proven commit. */
  proven: string[];
  risk: DiffRisk;
}

/**
 * Refuses (`GATE_SINCE`) unless: the working tree is clean (an uncommitted change would escape the classification),
 * HEAD strictly descends from `since`, the full suite is proven at `since` with this configuration of the checks and
 * without any check passed only after a relaunch, and the diff from `since` to HEAD is of low risk, classified with the
 * review settings read at `since` (a correction never reclassifies its own files).
 */
export async function checkSince(repo: string, config: ApvConfig, configFile: string | null, since: string): Promise<SinceCheck> {
  const git = new Git();
  const root = await git.root(repo);
  // Each refusal says what to do in its own case.
  const FULL = 'Lancer la suite complète (apv gates run --stage full --base <base de la branche>) : la preuve incrémentale ne vaut qu\'après une preuve complète verte, pour un diff de risque faible.';
  const refuse = (text: string, todo: string): never => {
    throw new PipelineError('GATE_SINCE', `--since ${since} refusé : ${text}\n${todo}`);
  };
  let sha: string;
  try { sha = (await git.exec(root, ['rev-parse', '--verify', '--quiet', `${since}^{commit}`])).trim(); } catch { sha = ''; }
  if (!sha) refuse('commit introuvable', 'Donner le commit où la suite complète a passé (colonne « reçu » de apv gates verify, ou git log).');
  const head = await git.sha(root);
  if ((await git.exec(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])) !== '') {
    refuse('l\'arbre de travail a des modifications non commitées (le diff classé est celui des commits)', 'Commiter les corrections (ou retirer ces fichiers), puis relancer la même commande.');
  }
  if (sha === head) refuse('HEAD est le commit donné lui-même : rien de nouveau à vérifier', 'Vérifier la preuve de ce commit par apv gates verify --commit HEAD (sortie 0 : la suite complète y est prouvée ; sinon, la lancer).');
  let ancestor = true;
  try { await git.exec(root, ['merge-base', '--is-ancestor', sha, head]); } catch { ancestor = false; }
  if (!ancestor) refuse(`HEAD (${head.slice(0, 12)}) ne descend pas de ${sha.slice(0, 12)}`, 'Donner un commit prouvé dont descend HEAD ; après un rebase, la preuve ne suit pas : lancer la suite complète (apv gates run --stage full --base <base de la branche>).');
  const proof = await verifyGates({ repo: root, config, commit: sha, stage: 'full', configFile });
  if (!proof.ok) {
    const missing = proof.gates.filter(g => g.state !== 'passed').map(g => `${g.gateId} (${g.state})`);
    refuse(`suite complète non prouvée à ${sha.slice(0, 12)} avec cette configuration des contrôles : ${missing.join(', ') || 'aucun contrôle prouvé'}`, FULL);
  }
  if (proof.flaky.length) {
    refuse(`à ${sha.slice(0, 12)}, contrôle(s) réussi(s) seulement après relance : ${proof.flaky.join(', ')}`,
      'Une preuve instable ne sert pas de point de départ : stabiliser le test (constat d\'instabilité), puis lancer la suite complète.');
  }
  // The classification as the proven commit declares it: review paths, sensitive paths, migrations of both sides.
  const atSince = loadConfigAtCommit(root, sha).config;
  const migrations = [...new Set([...loadDbConfigAtCommit(root, sha).config.migrations, ...loadDbConfigAtCommit(root, head).config.migrations])];
  const plan = planReviews({ repo: root, base: sha, head, settings: reviewPlanSettings(atSince.review), migrations,
    designDir: designDir(atSince.design), sensitive: [...sensitivePaths, ...atSince.risk.highPaths], force: [] });
  if (plan.risk.level !== 'faible') {
    const files = plan.risk.files.slice(0, 20).map(f => `  ${f.path} : ${f.why}`).join('\n');
    refuse(`diff de risque élevé depuis ${sha.slice(0, 12)} : ${plan.risk.reason}\n${files}${plan.risk.fileCount > 20 ? `\n  ... et ${plan.risk.fileCount - 20} autre(s)` : ''}`, FULL);
  }
  return { commit: sha, head, proven: proof.required, risk: plan.risk };
}
