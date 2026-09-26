import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { invariant } from '../domain/errors.js';
import { loadConfig } from '../config/load.js';
import { designDir } from './config.js';
import { Git } from '../execution/git.js';
import { ambiguousApprovalFragments, readWorkingDecisionLedger, type Decision } from '../lifecycle/decisions.js';
import { applyLedgerUpdate, planLedgerUpdate } from '../lifecycle/ledger-update.js';
import { ensureDesignAttribute, type DesignAttributeResult } from './attributes.js';

export { DEFAULT_DESIGN_DIR } from './config.js';

/** Lowercase words joined by single dashes; short enough for the decision id (80 characters at most). */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG_MAX = 50;

/** Decision ids of a registration: `maquette-<slug>-validee`, then `-v2`, `-v3`... for each re-registration. */
const DECISION_ID = /^maquette-([a-z0-9]+(?:-[a-z0-9]+)*?)-validee(?:-v([0-9]+))?$/;
/** Machine-readable part of the decision value written by `register`. */
const VALUE_FILE = /fichier (\S+?),? sha256 ([0-9a-f]{64})/;
const VALUE_SCREENS = /Écrans : ([^.]+)\./;
const VALUE_ARTIFACT = /Artefact : (\S+?)\.?(?:\s|$)/;

export interface DesignConfig { dir: string; configFile: string | null }

/**
 * `design.dir` of the project configuration, read by the main loader (`.apv/config.json`, else
 * `pipeline.v2.json`): the folder must stay inside the repository.
 */
export function loadDesignConfig(repo: string): DesignConfig {
  const { file, config } = loadConfig(repo);
  return { dir: designDir(config.design), configFile: file };
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export type MockupState = 'ok' | 'drift' | 'missing' | 'legacy';

export interface RegisteredMockup {
  slug: string;
  decisionId: string;
  version: number;
  subject: string;
  /** Repository-relative path, or null for a decision written before `apv design register` (no hash). */
  file: string | null;
  sha256: string | null;
  /** Hash of the file on disk, null when absent or unknown. */
  actualSha256: string | null;
  state: MockupState;
  screens: string[];
  artifact: string | null;
  sourceQuote: string;
}

function parseMockup(repo: string, decision: Decision): RegisteredMockup | null {
  const id = DECISION_ID.exec(decision.id);
  if (!id || decision.status !== 'confirmed') return null;
  const value = VALUE_FILE.exec(decision.value);
  const screens = VALUE_SCREENS.exec(decision.value)?.[1]?.split(',').map(x => x.trim()).filter(Boolean) ?? [];
  const artifact = VALUE_ARTIFACT.exec(decision.value)?.[1] ?? null;
  const base = { slug: id[1]!, decisionId: decision.id, version: id[2] ? Number(id[2]) : 1, subject: decision.subject, screens, artifact, sourceQuote: decision.sourceQuote };
  if (!value) return { ...base, file: null, sha256: null, actualSha256: null, state: 'legacy' };
  const file = value[1]!; const expected = value[2]!;
  const path = resolve(repo, file);
  const inside = !relative(repo, path).startsWith('..') && !isAbsolute(relative(repo, path));
  const actual = inside && existsSync(path) && statSync(path).isFile() ? sha256File(path) : null;
  return { ...base, file, sha256: expected, actualSha256: actual, state: actual === null ? 'missing' : actual === expected ? 'ok' : 'drift' };
}

/** Validated mockups of the working-tree ledger, in ledger order. */
export function listMockups(repo: string): RegisteredMockup[] {
  const ledger = readWorkingDecisionLedger(repo);
  return ledger.decisions.map(d => parseMockup(repo, d)).filter((m): m is RegisteredMockup => m !== null);
}

export interface RegisterInput {
  file: string;
  slug: string;
  quote: string;
  title?: string;
  screens?: string[];
  artifact?: string;
  reviewer?: string;
  /**
   * Paths the mockup concerns (portable globs): scope of the decision, so that only the specs whose tasks may
   * change these paths must cover it. Absent: the scope of the active registration, if any, is kept.
   */
  scopePaths?: string[];
  /** Injected clock, for tests. */
  now?: Date;
}

export interface RegisterResult {
  repo: string;
  slug: string;
  decisionId: string;
  supersedes: string[];
  target: string;
  sha256: string;
  ledgerFile: string;
  ledgerMarkdown: string;
  /** True when the same content was already registered: nothing was written to the mockup or the ledger. */
  unchanged: boolean;
  /** Line of `.gitattributes` that keeps the validated mockups out of `git diff --check`, added when missing. */
  attributes: DesignAttributeResult;
}

export function validateSlug(slug: string): void {
  invariant(SLUG_PATTERN.test(slug), 'DESIGN_SLUG', `Nom invalide « ${slug} » : minuscules, chiffres et tirets simples (ex. tableau-de-bord)`);
  invariant(slug.length <= SLUG_MAX, 'DESIGN_SLUG', `Nom trop long (${slug.length} caractères, ${SLUG_MAX} au plus)`);
  invariant(!slug.split('-').includes('validee'), 'DESIGN_SLUG', `Nom invalide « ${slug} » : « validee » est ajouté par l'outil`);
}

/**
 * Registers an operator-validated mockup: copies it to `<design.dir>/<slug>-validee.html`, and records a
 * confirmed operator decision carrying the file path, its sha256 and the operator's exact words. The
 * ledger is changed through the reviewed ledger-update API (never in place): a re-registration adds
 * `maquette-<slug>-validee-v<n>` that supersedes the active one. Nothing is committed.
 */
export async function registerMockup(repoPath: string, input: RegisterInput): Promise<RegisterResult> {
  const quote = input.quote.trim();
  invariant(quote.length > 0, 'DESIGN_QUOTE', 'Citation de l\'opérateur manquante (--quote) : seule sa validation explicite, citée mot pour mot, verse une maquette. Le pipeline n\'invente jamais une approbation.');
  const partial = ambiguousApprovalFragments(quote);
  invariant(partial.length === 0, 'DESIGN_QUOTE', `La citation est une validation avec réserve (« ${partial[0]} ») : ce n'est pas une validation. Traitez les réserves, puis enregistrez la validation sans réserve.`);
  validateSlug(input.slug);
  const git = new Git();
  const repo = await git.root(repoPath);
  const source = resolve(repoPath, input.file);
  invariant(existsSync(source) && statSync(source).isFile(), 'DESIGN_FILE', `Fichier introuvable : ${input.file}`);
  invariant(['.html', '.htm'].includes(extname(source).toLowerCase()), 'DESIGN_FILE', `La maquette doit être un fichier HTML : ${input.file}`);
  invariant(statSync(source).size > 0, 'DESIGN_FILE', `Fichier vide : ${input.file}`);
  const { dir } = loadDesignConfig(repo);
  const target = `${dir}/${input.slug}-validee.html`;
  const targetPath = join(repo, target);
  const sha = sha256File(source);

  const current = listMockups(repo).filter(m => m.slug === input.slug);
  const active = current.sort((a, b) => b.version - a.version)[0];
  const activeDecision = active ? readWorkingDecisionLedger(repo).decisions.find(d => d.id === active.decisionId) : undefined;
  // Absent: the scope of the active registration is kept; given (even empty): it replaces it.
  const scopePaths = input.scopePaths === undefined ? [...(activeDecision?.scope?.paths ?? [])] : [...new Set(input.scopePaths.map(x => x.trim()).filter(Boolean))];
  const sameScope = JSON.stringify(activeDecision?.scope?.paths ?? []) === JSON.stringify(scopePaths);
  if (active && active.sha256 === sha && active.file === target && active.actualSha256 === sha && sameScope) {
    return { repo, slug: input.slug, decisionId: active.decisionId, supersedes: [], target, sha256: sha, ledgerFile: '', ledgerMarkdown: '', unchanged: true,
      attributes: ensureDesignAttribute(repo, dir) };
  }
  const version = active ? Math.max(...current.map(m => m.version)) + 1 : 1;
  const decisionId = version === 1 ? `maquette-${input.slug}-validee` : `maquette-${input.slug}-validee-v${version}`;
  const title = input.title?.trim() || input.slug;
  const screens = (input.screens ?? []).map(x => x.trim()).filter(Boolean);
  invariant(screens.every(x => !/[,.]/.test(x)), 'DESIGN_SCREENS', 'Un nom d\'écran ne contient ni virgule ni point');
  const artifact = input.artifact?.trim();
  invariant(!artifact || /^https:\/\/\S+$/.test(artifact), 'DESIGN_ARTIFACT', `Adresse d'artefact invalide : ${artifact}`);
  const day = (input.now ?? new Date()).toISOString().slice(0, 10);
  const value = [
    `La maquette « ${title} », validée par l'opérateur le ${day}, est la référence absolue (structure, textes mot pour mot, couleurs, états, thèmes, largeurs) : fichier ${target}, sha256 ${sha}.`,
    screens.length ? `Écrans : ${screens.join(', ')}.` : '',
    artifact ? `Artefact : ${artifact}` : '',
  ].filter(Boolean).join(' ');
  const decision = {
    id: decisionId, subject: `Maquette validée : ${title}`, value, enforcement: 'product', status: 'confirmed', source: 'operator', sourceQuote: quote,
    rationale: 'Validation explicite de l\'opérateur après itérations sur l\'artefact ; les implementers la reproduisent et la revue de fidélité compare à ce fichier. Enregistrée par apv design register.',
    supersedes: active ? [active.decisionId] : [], clarificationQuestion: '', interpretations: [],
    ...(scopePaths.length || activeDecision?.scope?.specs ? { scope: { ...(scopePaths.length ? { paths: scopePaths } : {}), ...(activeDecision?.scope?.specs ? { specs: activeDecision.scope.specs } : {}) } } : {}),
  };
  const update = { decisions: [decision] };
  const plan = await planLedgerUpdate(repo, update);

  const previous = existsSync(targetPath) ? readFileSync(targetPath) : null;
  if (resolve(source) !== resolve(targetPath)) { mkdirSync(dirname(targetPath), { recursive: true }); copyFileSync(source, targetPath); }
  invariant(sha256File(targetPath) === sha, 'DESIGN_FILE', `Copie altérée : ${target}`);
  try {
    await applyLedgerUpdate(repo, update, plan.hash, input.reviewer ?? 'apv design register', `Maquette validée ${input.slug} (${sha.slice(0, 12)})`, false);
  } catch (error) {
    if (resolve(source) !== resolve(targetPath)) { if (previous) writeFileSync(targetPath, previous); else rmSync(targetPath, { force: true }); }
    throw error;
  }
  return { repo, slug: input.slug, decisionId, supersedes: decision.supersedes, target, sha256: sha, ledgerFile: plan.file, ledgerMarkdown: plan.file.replace(/\.json$/, '.md'), unchanged: false,
    attributes: ensureDesignAttribute(repo, dir) };
}

/** Normalized screen name, for `list --screen`: case, accents and separators ignored. */
export function screenKey(name: string): string {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function matchesScreen(mockup: RegisteredMockup, screen: string): boolean {
  const key = screenKey(screen);
  return screenKey(mockup.slug) === key || mockup.screens.some(s => screenKey(s) === key);
}
