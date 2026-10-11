import { s, type Infer } from '../domain/schema.js';
import { relativeGlob } from '../reuse/config.js';

/**
 * The rules the tool enforces before a merge (`apv rules check`, `apv stack merge`, `apv stack batch --merge`), docs/REGLES.md.
 * Every rule applies to every project: none can be switched off by the configuration. The only way past a refusal is
 * the correction it asks for, or a waiver the operator writes himself (src/rules/operator.ts).
 */
export const MERGE_RULES = ['preuve', 'instable', 'relecture', 'captures', 'controles', 'maquette'] as const;
export type MergeRule = typeof MERGE_RULES[number];

/** What each rule protects, in a few words (texts of the refusals and of docs/REGLES.md). */
export const RULE_TITLES: Readonly<Record<MergeRule, string>> = {
  preuve: 'suite complète prouvée au commit exact',
  instable: 'aucun contrôle réussi seulement après relance',
  relecture: 'relecture enregistrée à ce commit, sans constat critique ni haut',
  captures: 'captures de la revue de fidélité (ordinateur et téléphone, clair et sombre)',
  controles: 'contrôles de base d\'un projet web présents',
  maquette: 'maquette validée par l\'opérateur pour chaque écran nouveau ou changé',
};

export const CAPTURE_VIEWPORTS = ['desktop', 'phone', 'tablet'] as const;
export type CaptureViewport = typeof CAPTURE_VIEWPORTS[number];
export const CAPTURE_THEMES = ['light', 'dark'] as const;
export type CaptureTheme = typeof CAPTURE_THEMES[number];
/** Captures required by default for a change of interface: computer and phone, light and dark theme. */
export const DEFAULT_CAPTURE_VIEWPORTS: readonly CaptureViewport[] = ['desktop', 'phone'];
export const DEFAULT_CAPTURE_THEMES: readonly CaptureTheme[] = ['light', 'dark'];

const gateId = s.string(1, 80, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);

/**
 * Kinds of files of the lane without code (`voie sans code`, src/rules/docs-only.ts): a closed list, fixed by the tool. A
 * project can only narrow it (`rules.docsOnly.kinds`, `exclude`) or switch the lane off (`enabled: false`): never widen it.
 * `.apv/state/**` is not a kind: the session hook injects it into the context of every session (`resume.md`, the runs),
 * so it is read as instructions (security review of PR #121).
 */
export const DOCS_ONLY_KINDS = ['decisions', 'mockups', 'drafts', 'specs', 'journal', 'docs'] as const;
export type DocsOnlyKind = typeof DOCS_ONLY_KINDS[number];

export const rulesSchema = s.object({
  /**
   * Captures the fidelity review attaches to the commit of a change of interface. `themes: ["light"]` only for a
   * project without a dark theme; the tablet may be added, never less than one width.
   */
  captures: s.optional(s.object({
    viewports: s.optional(s.array(s.enum(CAPTURE_VIEWPORTS), 1, 3)),
    themes: s.optional(s.array(s.enum(CAPTURE_THEMES), 1, 2)),
  })),
  /** Checks a web project must declare, added to those of the tool (reuse, code-map, structure): an id and the start of its command. */
  requiredGates: s.optional(s.array(s.object({ id: gateId, command: s.array(s.string(1, 200), 1, 10) }), 0, 20)),
  /** Days a line of the operator journal is kept (docs/REGLES.md, « Ancrage »); default 90. */
  journalDays: s.optional(s.number(1, 3650)),
  /** Files that are screens, added to those the tool knows (routes of SvelteKit, Next, Nuxt, Astro, Remix...). */
  screens: s.optional(s.array(s.string(1, 4096), 0, 100)),
  /**
   * The lane without code (docs/REGLES.md, « Voie sans code »): on by default, with every kind. `enabled: false` switches
   * it off, `kinds` keeps only some kinds, `exclude` takes paths out of it. Nothing here can add a path to the lane.
   */
  docsOnly: s.optional(s.object({
    enabled: s.optional(s.boolean()),
    kinds: s.optional(s.array(s.enum(DOCS_ONLY_KINDS), 0, DOCS_ONLY_KINDS.length)),
    exclude: s.optional(s.array(s.string(1, 500), 0, 100)),
  })),
  /**
   * The proof by the CI (docs/REGLES.md, « Preuve par la CI »): the check run of a job of the GitHub Actions workflow
   * declared here, at the exact commit, stands in for the local receipts of the checks it covers, as long as the change
   * leaves the workflow and every file that produces the proof unchanged. Read at the base only.
   */
  ciProof: s.optional(s.object({
    /** The workflow file, under `.github/workflows/`. */
    workflow: s.string(1, 200, /^\.github\/workflows\/[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/),
    /** The key of the job in the workflow (`jobs.<job>`). */
    job: s.string(1, 100, /^[A-Za-z_][A-Za-z0-9_-]*$/),
    /** The name of its check run, the `name:` of the job (« Preuve complète »). */
    name: s.string(1, 200, /^[^\u0000-\u001f\u007f]+$/),
    /** The checks of the configuration the job proves. */
    gates: s.array(gateId, 1, 50),
    /** Files that produce the proof, added to the defaults (CI_PROTECTED_DEFAULTS); never fewer. */
    protectedPaths: s.optional(s.array(s.string(1, 500), 0, 100)),
    /** The artifact where the job leaves its receipts: for the measure only, never read by the rule. */
    artifact: s.optional(s.string(1, 100, /^[A-Za-z0-9][A-Za-z0-9._-]*$/)),
  })),
});
export type RulesSection = Infer<typeof rulesSchema>;

export interface RequiredGate { id: string; command: string[]; source: 'apv' | 'config' }
export interface RulesSettings {
  captures: { viewports: CaptureViewport[]; themes: CaptureTheme[] };
  requiredGates: RequiredGate[];
  screens: string[];
  /** The lane without code: off, or the kinds it accepts and the paths it excludes. */
  docsOnly: { enabled: boolean; kinds: DocsOnlyKind[]; exclude: string[] };
  /** The proof by the CI, or null when the project does not declare it (local proof only). */
  ciProof: CiProofSettings | null;
}

/**
 * Files that produce the proof of the CI, always protected besides the declared workflow: the workflows and local actions
 * (a reusable workflow or a composite action runs in the job), the scripts of the end-to-end and dynamic tests, the
 * configuration of Playwright and of npm (`script-shell` replaces the shell of every script), the whole package.json (a
 * script `test:*` calls others, npm runs `pre`/`post` and installation scripts by itself) and the lock files, the
 * configuration of the build tools (executed by `prepare` and the tests), the configuration of the TypeScript and Babel loaders
 * (`paths` redirects an import; the `extends` chain is added by the rule), any tracked file under node_modules. The files these name or import are added by the rule.
 */
export const CI_PROTECTED_DEFAULTS: readonly string[] = ['.github/workflows/**', '.github/actions/**', 'scripts/e2e/**', 'scripts/dast/**', 'playwright.config.*', '.npmrc',
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'svelte.config.*', 'vite.config.*',
  '**/tsconfig*.json', '**/jsconfig*.json', 'babel.config.*', '.babelrc*', '**/node_modules/**'];
export interface CiProofSettings {
  workflow: string;
  job: string;
  name: string;
  gates: string[];
  /** The workflow, the defaults and what the project adds, deduplicated. */
  protectedPaths: string[];
  artifact: string | null;
}

/** Effective settings of a `rules` section: the defaults, completed by what the project adds. Throws a CONFIG error. */
export function rulesSettings(section: RulesSection | undefined, builtIn: readonly RequiredGate[]): RulesSettings {
  const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];
  return {
    captures: {
      viewports: unique(section?.captures?.viewports ?? [...DEFAULT_CAPTURE_VIEWPORTS]),
      themes: unique(section?.captures?.themes ?? [...DEFAULT_CAPTURE_THEMES]),
    },
    requiredGates: [...builtIn, ...(section?.requiredGates ?? []).map(g => ({ id: g.id, command: [...g.command], source: 'config' as const }))],
    screens: (section?.screens ?? []).map(g => relativeGlob(g, 'rules.screens')),
    docsOnly: {
      enabled: section?.docsOnly?.enabled ?? true,
      kinds: unique(section?.docsOnly?.kinds ?? [...DOCS_ONLY_KINDS]),
      exclude: (section?.docsOnly?.exclude ?? []).map(g => relativeGlob(g, 'rules.docsOnly.exclude')),
    },
    ciProof: section?.ciProof ? {
      workflow: section.ciProof.workflow,
      job: section.ciProof.job,
      name: section.ciProof.name,
      gates: unique(section.ciProof.gates),
      protectedPaths: unique([section.ciProof.workflow, ...CI_PROTECTED_DEFAULTS, ...(section.ciProof.protectedPaths ?? []).map(g => relativeGlob(g, 'rules.ciProof.protectedPaths'))]),
      artifact: section.ciProof.artifact ?? null,
    } : null,
  };
}
