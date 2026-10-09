import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { posix } from 'node:path';
import { errorMessage } from '../domain/errors.js';
import { RESERVED_GROUP } from '../design/config.js';
import { mockupDecision } from '../design/registry.js';
import { modeChange, parseRawDiff } from '../gates/proof-scope.js';
import { decisionLedgerMarkdown, LEDGER_FILE, loadDecisionLedger, type Decision, type DecisionLedger } from '../lifecycle/decisions.js';
import { matches } from '../policy/policy.js';
import type { ReviewDomainName } from '../review/config.js';
import type { ReviewPlan } from '../review/plan.js';
import { AGENT_INSTRUCTIONS, CONFIG_FILES } from '../review/risk.js';
import type { DocsOnlyKind, RulesSettings } from './config.js';
import { anchoredQuote, sentences, VALIDATES, type OperatorMessage } from './operator.js';

/**
 * The lane without code (« voie sans code », docs/REGLES.md): a pull request of the ledger, registered mockups, specs,
 * the journal or documentation needs no review. Pilot project, 4 October 2026: such a pull request was asked for a
 * full suite and four reviews; the operator: « pourquoi il faut tout ça pour une petite PR pareille ? ».
 */

export interface LaneFile { path: string; kind: DocsOnlyKind }
export interface DocsOnlyLane {
  /** Whether the change takes the lane without code. */
  eligible: boolean;
  /** One sentence: why it does, or the first reason it does not. */
  reason: string;
  /** The files that allowed it, with their kind (every file when eligible). */
  files: LaneFile[];
  /** The files that keep the normal rules, with the reason (50 at most). */
  blocking: { path: string; why: string }[];
}

/** Name of the lane in the reports. */
export const LANE_NAME = 'voie sans code';
export const KIND_LABEL: Readonly<Record<DocsOnlyKind, string>> = {
  decisions: 'registre des décisions', mockups: 'maquette validée', drafts: 'brouillon de maquette', specs: 'spec',
  journal: 'journal du pipeline', docs: 'documentation',
};
const JOURNAL = '.apv/journal-pipeline.md';
const LEDGER_TEXT = '.apv/DECISIONS.md';
/** Extensions a file of each kind may have (the ledger and the journal are fixed paths). */
const MOCKUP_EXTENSIONS = ['.html', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.css'] as const;
const EXTENSIONS: Readonly<Partial<Record<DocsOnlyKind, readonly string[]>>> = {
  specs: ['.json'], mockups: MOCKUP_EXTENSIONS, drafts: MOCKUP_EXTENSIONS, docs: ['.md'],
};
/** Files whose `@path` imports Claude Code reads as instructions, at any depth of the tree (names compared without case). */
const IMPORTERS = new Set(['claude.md', 'claude.local.md', 'agents.md', 'gemini.md']);
const IMPORT = /(?:^|[\s([])@((?:\.{1,2}\/)?[^\s`'"()<>[\]]+)/g;
/** Hops of imports Claude Code follows from a file of instructions. */
const IMPORT_DEPTH = 5;
/** Files read to follow the imports, at most: past it, every Markdown file is held as imported (normal rules). */
const IMPORT_READS = 2000;
const SHOWN = 50;

export interface LaneInput {
  repo: string;
  mergeBase: string;
  head: string;
  /** The review plan of the same diff (its classes and its per-file risk decide what documentation is). */
  plan: ReviewPlan;
  settings: RulesSettings['docsOnly'];
  designDir: string;
  /** Sensitive paths of the high lane (`sensitivePaths` and `risk.highPaths`). */
  sensitive: readonly string[];
  messages: readonly OperatorMessage[];
  /** The anchor key (tests); default: the key of the account. */
  key?: Buffer | null;
}

const safe = (path: string, glob: string): boolean => { try { return matches(path, glob); } catch { return false; } };
/** Whether a glob matches the path, case ignored: `Docs/Claude.md` is `docs/CLAUDE.md` on a file system without case. */
const anyCase = (path: string, globs: readonly string[]): boolean => globs.some(g => safe(path.toLowerCase(), g.toLowerCase()));
const under = (path: string, dir: string): boolean => path.startsWith(`${dir}/`);
/** `.json` of `a/b.json`; null for a dotfile (`.gitattributes`) or a name without extension. */
function extensionOf(path: string): string | null {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return name.startsWith('.') || dot <= 0 ? null : name.slice(dot).toLowerCase();
}

function gitShow(repo: string, sha: string, path: string): Buffer | null {
  try {
    return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'cat-file', 'blob', `${sha}:${path}`], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024, timeout: 60_000 });
  } catch { return null; }
}
function blobHash(repo: string, sha: string, path: string): string | null {
  const data = gitShow(repo, sha, path);
  return data ? createHash('sha256').update(data).digest('hex') : null;
}
function treeFiles(repo: string, sha: string): string[] | null {
  try {
    return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'ls-tree', '-r', '-z', '--name-only', sha], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024, timeout: 60_000 }).split('\0').filter(Boolean);
  } catch { return null; }
}

function rawFiles(repo: string, base: string, head: string): ReturnType<typeof parseRawDiff> | null {
  try {
    return parseRawDiff(execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'diff', '--raw', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-abbrev', '--ignore-submodules=none', base, head, '--'],
      { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 120_000 }));
  } catch { return null; }
}

/**
 * The files imported by `@path` from every CLAUDE.md, CLAUDE.local.md, AGENTS.md and GEMINI.md of the tree, through
 * `IMPORT_DEPTH` hops as Claude Code follows them, relative paths resolved from the importing file, at the base and at
 * the head: lower-case path, with the file of instructions it comes from. Null when the trees cannot be read or the
 * reads pass `IMPORT_READS`: the caller then keeps every Markdown file out of the lane.
 */
function importedInstructions(repo: string, shas: readonly string[]): Map<string, string> | null {
  const out = new Map<string, string>();
  let reads = 0;
  for (const sha of shas) {
    const tree = treeFiles(repo, sha);
    if (!tree) return null;
    const byLower = new Map(tree.map(f => [f.toLowerCase(), f]));
    for (const root of tree.filter(f => IMPORTERS.has(posix.basename(f).toLowerCase()))) {
      let level = [root];
      const seen = new Set([root]);
      for (let hop = 1; hop <= IMPORT_DEPTH && level.length; hop++) {
        const next: string[] = [];
        for (const file of level) {
          if (++reads > IMPORT_READS) return null;
          const text = gitShow(repo, sha, file)?.toString('utf8') ?? '';
          for (const m of text.matchAll(IMPORT)) {
            const target = m[1]!.replace(/[.,;:!?]+$/, '');
            if (!target || target.startsWith('~') || target.startsWith('/')) continue;
            // From the importing file (Claude Code), and from the root of the repository (a reading an agent can make).
            for (const path of new Set([posix.normalize(posix.join(posix.dirname(file), target)), posix.normalize(target)])) {
              if (path.startsWith('..')) continue;
              if (!out.has(path.toLowerCase())) out.set(path.toLowerCase(), root);
              const real = byLower.get(path.toLowerCase());
              if (real && !seen.has(real)) { seen.add(real); next.push(real); }
            }
          }
        }
        level = next;
      }
    }
  }
  return out;
}

/** The kind of one side of a changed file, or why it keeps the normal rules. */
function kindOf(path: string, side: { added: boolean; deleted: boolean }, documentation: boolean, input: LaneInput, imports: ReadonlyMap<string, string> | null): { kind: DocsOnlyKind } | { why: string } {
  const { settings } = input;
  if (anyCase(path, settings.exclude)) return { why: 'exclu par rules.docsOnly.exclude' };
  if (anyCase(path, CONFIG_FILES)) return { why: 'configuration (outil, tests, dépendances, CI)' };
  if (anyCase(path, input.sensitive) || anyCase(path, AGENT_INSTRUCTIONS)) return { why: 'chemin sensible ou instructions des agents' };
  if (!imports && path.toLowerCase().endsWith('.md')) return { why: 'imports des instructions des agents illisibles : chaque Markdown garde les règles normales' };
  const importer = imports?.get(path.toLowerCase());
  if (importer) return { why: `importé par ${importer} (instructions des agents)` };
  const drafts = `${input.designDir}/${RESERVED_GROUP}`;
  let kind: DocsOnlyKind | null = null;
  if (path === LEDGER_FILE || path === LEDGER_TEXT) kind = 'decisions';
  else if (path === JOURNAL) kind = 'journal';
  else if (under(path, '.apv/specs')) kind = 'specs';
  else if (under(path, drafts)) kind = 'drafts';
  else if (under(path, input.designDir)) kind = 'mockups';
  else if (documentation && path.endsWith('.md') && !under(path, '.apv')) kind = 'docs';
  if (!kind) return { why: 'hors de la liste de la voie sans code (code, interface, configuration, état ou fichier non classé)' };
  const allowed = EXTENSIONS[kind];
  if (allowed && !allowed.includes(extensionOf(path) ?? '')) return { why: `${KIND_LABEL[kind]} : extension hors de la liste (${allowed.join(', ')}), jamais un script ni un fichier sans extension` };
  if (!settings.kinds.includes(kind)) return { why: `${KIND_LABEL[kind]} : type retiré de la voie par rules.docsOnly.kinds` };
  if (side.deleted && (kind === 'decisions' || kind === 'mockups')) return { why: `${KIND_LABEL[kind]} supprimé(e)` };
  // A spec of the base sets the minimum of security of its next run and carries its resolutions: it changes only reviewed.
  if (kind === 'specs' && !side.added) return { why: 'spec existante modifiée ou supprimée : seul l\'ajout d\'une spec prend la voie' };
  return { kind };
}

const sameDecision = (a: Decision, b: Decision): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Why the ledger at the head is more than the ledger at the base plus mockups registered by `apv design register`;
 * empty when it is. A decision deleted or changed, any other decision added: out of the lane (second security review
 * of PR #121: any sentence of 12 characters the operator typed in 90 days anchored a decision without relation). A
 * mockup decision added is the one register writes (from the operator, product, replacing nothing, an HTML file of
 * `design.dir` outside the drafts, at the head at its fingerprint), its quote typed by the operator, saying a
 * validation, and none of its sentences already the quote of a decision of the base or of another one of the change.
 */
function ledgerBlocking(atBase: readonly Decision[], atHead: readonly Decision[], input: LaneInput): DocsOnlyLane['blocking'] {
  const out: DocsOnlyLane['blocking'] = [];
  const at = (why: string, path: string = LEDGER_FILE): void => { out.push({ path, why }); };
  const headIds = new Set(atHead.map(d => d.id));
  const baseById = new Map(atBase.map(d => [d.id, d]));
  const spent = new Map<string, string>();
  for (const d of atBase) for (const s of sentences(d.sourceQuote)) if (!spent.has(s)) spent.set(s, d.id);
  for (const d of atBase) if (!headIds.has(d.id)) at(`décision ${d.id} supprimée : une décision fusionnée ne se retire que relue`);
  const drafts = `${input.designDir}/${RESERVED_GROUP}`;
  for (const d of atHead) {
    const before = baseById.get(d.id);
    if (before) {
      if (!sameDecision(before, d)) {
        const fields = Object.keys({ ...before, ...d }).filter(k => JSON.stringify((before as Record<string, unknown>)[k]) !== JSON.stringify((d as Record<string, unknown>)[k]));
        at(`décision ${d.id} modifiée (${fields.join(', ')}) : une décision fusionnée ne change que relue`);
      }
      continue;
    }
    const mockup = mockupDecision(d);
    if (!mockup) { at(`décision ${d.id} ajoutée : seule une maquette versée par apv design register ajoute une décision dans la voie`); continue; }
    if (d.supersedes.length) { at(`décision ${d.id} ajoutée : elle en remplace d'autres (${d.supersedes.join(', ')}) : relue`); continue; }
    if (d.source !== 'operator' || d.enforcement !== 'product') { at(`décision ${d.id} ajoutée : une maquette versée vient de l'opérateur, en décision produit`); continue; }
    if (!anchoredQuote(input.messages, d.sourceQuote, input.key)) { at(`décision ${d.id} ajoutée : sa citation n'est pas dans les messages de l'opérateur`); continue; }
    if (!sentences(d.sourceQuote).some(s => VALIDATES.test(s))) { at(`décision ${d.id} ajoutée : sa citation ne dit aucune validation`); continue; }
    const reused = sentences(d.sourceQuote).map(s => spent.get(s)).find(Boolean);
    if (reused) { at(`décision ${d.id} ajoutée : sa citation reprend une phrase de ${reused} (une validation ne sert qu'une fois)`); continue; }
    for (const s of sentences(d.sourceQuote)) spent.set(s, d.id);
    const file = mockup.file;
    if (!file || !mockup.sha256 || !under(file, input.designDir) || under(file, drafts) || !['.html', '.htm'].includes(extensionOf(file) ?? '')
      || blobHash(input.repo, input.head, file) !== mockup.sha256) {
      at(`décision ${d.id} : la maquette ${file ?? '(sans fichier)'} n'est pas à la tête avec l'empreinte enregistrée (fichier HTML de ${input.designDir}, hors brouillons)`, file ?? LEDGER_FILE);
    }
  }
  return out;
}

/**
 * The lane of a change. Decided by the tool, from the diff since the merge base with the target, never by an agent:
 * EVERY changed file (both sides of a rename, deletions included) is a regular file (mode 100644, never a link, a
 * submodule or an executable), outside `rules.docsOnly.exclude`, the sensitive paths, the instructions of the agents
 * (compared without case, and what they import by `@path`) and the configuration files, and of one of these kinds (a
 * closed list, that a project can only narrow), with an extension of its kind:
 * - `decisions`: `.apv/DECISIONS.json` (valid at the head, see `ledgerBlocking`) and `.apv/DECISIONS.md` (exactly the
 *   rendering of the JSON at the head), never deleted;
 * - `mockups`: a validated mockup under `design.dir` (drafts apart) at the sha256 its decision records, never deleted;
 * - `drafts`: `<design.dir>/brouillons/**`; `journal`: `.apv/journal-pipeline.md`;
 * - `specs`: a spec ADDED under `.apv/specs/` (`.json`);
 * - `docs`: Markdown the review plan reads as documentation, outside `.apv/`.
 * `.apv/state/**` is never in the lane: the session hook injects it into every session. Anything else, anything
 * unreadable, and the normal rules apply. Pure reading of the commits, the plan and the operator's journal.
 */
export async function docsOnlyLane(input: LaneInput): Promise<DocsOnlyLane> {
  const no = (reason: string, blocking: DocsOnlyLane['blocking'] = []): DocsOnlyLane => ({ eligible: false, reason, files: [], blocking: blocking.slice(0, SHOWN) });
  if (!input.settings.enabled) return no('voie sans code désactivée par rules.docsOnly.enabled');
  if (!input.plan.files.length) return no('diff vide');
  const raw = rawFiles(input.repo, input.mergeBase, input.head);
  if (!raw) return no('diff illisible : règles normales');
  const blocking: DocsOnlyLane['blocking'] = [];
  const files = new Map<string, DocsOnlyKind>();
  for (const f of raw) {
    const mode = modeChange(f);
    if (mode) blocking.push({ path: f.path, why: `${mode} (lien symbolique, sous-module ou exécutable)` });
  }
  const imports = importedInstructions(input.repo, [input.mergeBase, input.head]);
  for (const file of input.plan.files) {
    // Documentation as the plan reads it: neutral Markdown outside the served folders, without a word of data or GDPR.
    const documentation = file.risk === 'faible' && file.riskWhy === 'documentation';
    const sides = [{ path: file.path, added: file.status.startsWith('A'), deleted: file.status.startsWith('D') }, ...(file.from !== undefined ? [{ path: file.from, added: false, deleted: true }] : [])];
    for (const side of sides) {
      const k = kindOf(side.path, side, documentation, input, imports);
      if ('why' in k) blocking.push({ path: side.path, why: k.why });
      else if (!side.deleted || !files.has(side.path)) files.set(side.path, k.kind);
    }
  }
  const touched = [...files].filter(([, k]) => k === 'mockups' || k === 'decisions');
  if (!blocking.length && touched.length) {
    let atHead: DecisionLedger; let atBase: DecisionLedger;
    try {
      atHead = await loadDecisionLedger(input.repo, input.head, LEDGER_FILE);
      atBase = await loadDecisionLedger(input.repo, input.mergeBase, LEDGER_FILE);
    } catch (error) {
      return no(`registre des décisions illisible ou invalide : ${errorMessage(error).slice(0, 200)}`, [{ path: LEDGER_FILE, why: 'registre illisible ou invalide' }]);
    }
    blocking.push(...ledgerBlocking(atBase.decisions, atHead.decisions, input));
    // The readable version is what the agents read: the exact rendering of the ledger at the head, or nothing.
    const text = gitShow(input.repo, input.head, LEDGER_TEXT);
    if (text && text.toString('utf8') !== decisionLedgerMarkdown(atHead)) {
      blocking.push({ path: LEDGER_TEXT, why: `différent du rendu de ${LEDGER_FILE} à la tête (apv ledger apply l'écrit) : le texte que lisent les agents contredirait le registre` });
    }
    for (const [path, kind] of touched) {
      if (kind !== 'mockups') continue;
      const decision = atHead.decisions.find(d => d.source === 'operator' && mockupDecision(d)?.file === path);
      const recorded = decision ? mockupDecision(decision)!.sha256 : null;
      if (!recorded) { blocking.push({ path, why: 'aucune décision de maquette validée (source opérateur) ne porte ce fichier et son empreinte' }); continue; }
      const actual = blobHash(input.repo, input.head, path);
      if (actual !== recorded) blocking.push({ path, why: `empreinte ${actual ? actual.slice(0, 12) : 'illisible'} différente de celle de ${decision!.id} (${recorded.slice(0, 12)}) : maquette modifiée sans nouvelle décision` });
    }
  }
  if (blocking.length) {
    const first = blocking[0]!;
    return no(`${blocking.length} fichier(s) hors de la voie, dont ${first.path} : ${first.why}`, blocking);
  }
  const list: LaneFile[] = [...files].map(([path, kind]) => ({ path, kind })).sort((a, b) => a.path.localeCompare(b.path));
  const tally = new Map<DocsOnlyKind, number>();
  for (const f of list) tally.set(f.kind, (tally.get(f.kind) ?? 0) + 1);
  return { eligible: true, files: list, blocking: [],
    reason: `${list.length} fichier(s), aucun de code : ${[...tally].map(([k, n]) => `${KIND_LABEL[k]} (${n})`).join(', ')}` };
}

/**
 * The review plan in the lane without code: no domain is required by the diff, the security review included; only the
 * domains forced by the configuration (`review.always`) or by the operator (`--force`) stay. Outside the lane, the plan
 * is returned unchanged.
 */
export function planInLane(plan: ReviewPlan, lane: DocsOnlyLane, forced: { always: readonly ReviewDomainName[]; operator: readonly ReviewDomainName[] }): ReviewPlan & { lane: DocsOnlyLane } {
  if (!lane.eligible) return { ...plan, lane };
  const domains = plan.domains.map(d => {
    const by = forced.operator.includes(d.domain) ? 'operator' as const : forced.always.includes(d.domain) ? 'config' as const : null;
    if (by) return { ...d, decision: 'retained' as const, forced: by, reason: `${LANE_NAME}, mais forcée par ${by === 'operator' ? 'l\'opérateur (--force)' : 'la configuration (review.always)'}` };
    return { ...d, decision: 'skipped' as const, forced: null, files: [], fileCount: 0, reason: `${LANE_NAME} : ${lane.reason} ; aucune relecture d'agent exigée (docs/REGLES.md)` };
  });
  return { ...plan, domains, lane,
    retained: domains.filter(d => d.decision === 'retained').map(d => d.domain),
    skipped: domains.filter(d => d.decision === 'skipped').map(d => ({ domain: d.domain, reason: d.reason })) };
}

/** Lines of a lane for the text reports (`apv rules check`, `apv stack plan`, `apv review plan`). */
export function laneLines(lane: DocsOnlyLane, indent = ''): string[] {
  if (!lane.eligible) return [`${indent}Voie sans code : non retenue (${lane.reason}) : règles normales.`];
  return [`${indent}Voie sans code : RETENUE : ${lane.reason}. Fichiers qui l'ont permise :`,
    ...lane.files.slice(0, 30).map(f => `${indent}    ${f.path} (${KIND_LABEL[f.kind]})`),
    ...(lane.files.length > 30 ? [`${indent}    (et ${lane.files.length - 30} autres)`] : [])];
}
