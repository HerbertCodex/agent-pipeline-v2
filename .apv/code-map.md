# Carte du code

Générée par `apv map` à partir des fichiers du dépôt, sans modèle. À lire avant de créer un composant, un module ou une route : réutiliser une entrée existante, ou l'étendre de façon générique (paramètre, variante) ; un élément utilisé par deux fonctionnalités devient partagé. Ne pas modifier à la main : l'intégration la régénère (`apv map`), et le contrôle `apv map --check` de la suite complète échoue quand elle ne correspond plus au code.

Composants génériques : 0. Autres composants partagés : 0. Modules partagés : 168. Routes : 0. Propres à une fonctionnalité : 0 composant(s), 0 module(s). Laissés de côté : 89 test(s), 318 fichier(s) ignoré(s), 5 module(s) sans export ni import.

## Dossiers

Arborescence commentée, conventions et points d'entrée : carte de l'architecture `docs/carte-architecture.md` (apv structure map l'écrit si elle manque), à lire avant cette carte.

Dossiers à plat (plus de 12 fichiers de code) : ne pas y ajouter de fichier (le contrôle `structure` le refuse) ; placer un nouveau fichier dans le sous-dossier proposé qui lui correspond.

- `src/commands/` : 30 fichiers.

## Composants génériques (socle et structure)

Aucun composant générique (dossiers de primitives, ou composants partagés nommés par leur seul rôle).

## Autres composants partagés

Aucun autre composant partagé (dossiers de `reuse.shared`).

## Modules partagés

### hooks/scripts

- `bash-guard.mjs` : PreToolUse guard for the Bash tool (APV3 spec, sections 11 and 18.2). Exporte : REASONS, anchorInCommand(), apvArguments(), apvCall(), branchChange(), commandScope(), et 25 autre(s). Utilisé par 1 fichier (hooks/scripts/review-seal.mjs).
- `harness-guard.mjs` : Harness guards of the Bash PreToolUse hook (APV3 spec, section 18.2): process kills… Exporte : EMPTY_CONTEXT, HARNESS_REASONS, cdTarget(), commandWords(), dockerTargets(), flockHeldBy(), et 20 autre(s). Utilisé par 2 fichiers (hooks/scripts/bash-guard.mjs, …).
- `lib.mjs` : Shared helpers for the APV plugin hooks. Exporte : ANCHOR_FRAGMENTS, ANCHOR_STORES, APV_IGNORED, DOMAIN_REVIEWERS, agentName, ensureApvGitignore(), et 6 autre(s). Utilisé par 7 fichiers (hooks/scripts/bash-guard.mjs, …).
- `operator-journal.mjs` : UserPromptSubmit hook: keeps what the operator types himself in the session, in the Git… Exporte : MAX_MESSAGE, OPERATOR_SOURCES, hookKeyFile(), isClaudeProcess(), operatorEntry(), procProcess(), et 1 autre(s). Utilisé nulle part.
- `review-seal.mjs` : PostToolUse hook for Bash: seals a review record right after 'apv review record' ran,… Exporte : recordCommit(), recordDirectories(), recordId(), sealRequest(). Utilisé nulle part.
- `scope-reminder.mjs` : PostToolUse hook on file writes (APV3 spec, section 11): reminds an implementer of the… Exporte : TASK_MARKER, findTaskRoot(), loadTaskScope(), scopeReminder(), writtenFile(). Utilisé nulle part.
- `session-start.mjs` : SessionStart hook: gives the lead a short resume context when the project uses APV… Exporte : buildResumeContext(), describeQuota(), freshnessLines(), lastLine(), loadFreshness(), loadRunSummary(), et 2 autre(s). Utilisé nulle part.
- `stop-journal.mjs` : Stop hook: appends one timestamped line to '.apv/state/journal.log' so that a resume… Exporte : journalLine(). Utilisé nulle part.
- `write-guard.mjs` : PreToolUse guard for the Write, Edit, MultiEdit, NotebookEdit, Read, Grep and Glob… Exporte : WRITE_REASON, evaluateWrite(). Utilisé nulle part.

### src/commands

- `audit.ts` : sans description. Exporte : run(), usage. Utilisé par 1 fichier (src/commands/index.ts).
- `common.ts` : Exit codes shared by every 'apv' command. Exporte : EXIT, UsageError, guard(), json(), list(), parse(), et 2 autre(s). Utilisé par 25 fichiers (src/commands/audit.ts, …).
- `dast.ts` : sans description. Exporte : run(), usage. Utilisé par 1 fichier (src/commands/index.ts).
- `db.ts` : sans description. Exporte : dbHelp, run(). Utilisé par 1 fichier (src/commands/index.ts).
- `design.ts` : sans description. Exporte : run(), usage. Utilisé par 1 fichier (src/commands/index.ts).
- `gates.ts` : sans description. Exporte : run(), usage. Utilisé par 1 fichier (src/commands/index.ts).
- `index.ts` : Every 'apv' command lives in 'src/commands/<name>.ts' and exports 'run(args, io)'. Exporte : CommandModule, commands, dispatch(), helpText(). Utilisé par 1 fichier (src/cli.ts).
- `init.ts` : sans description. Exporte : ApvWriter, BRIEF_TEMPLATE, InitContent, InitResult, PLUGIN_ROOT, ReuseSetup, et 14 autre(s). Utilisé par 2 fichiers (src/commands/index.ts, …).
- `io.ts` : sans description. Exporte : CommandIO. Utilisé par 30 fichiers (src/cli.ts, …).
- `ledger.ts` : sans description. Exporte : run(), usage. Utilisé par 1 fichier (src/commands/index.ts).
- `lock.ts` : sans description. Exporte : lockHelp, run(). Utilisé par 1 fichier (src/commands/index.ts).
- `map.ts` : Stale only because the map predates the « Dossiers » section of 3.0.0-alpha.11: 'apv… Exporte : MapResult, comparableMap(), currentMap(), mapPath(), run(), usage, et 2 autre(s). Utilisé par 4 fichiers (src/commands/index.ts, …).
- `metrics.ts` : sans description. Exporte : run(), usage. Utilisé par 1 fichier (src/commands/index.ts).
- `onboard.ts` : sans description. Exporte : ExistingReuse, OnboardResult, onboardProject(), run(), usage. Utilisé par 1 fichier (src/commands/index.ts).
- `preview.ts` : sans description. Exporte : run(), usage. Utilisé par 1 fichier (src/commands/index.ts).
- `procs.ts` : sans description. Exporte : DEFAULT_GRACE_SECONDS, MAX_GRACE_SECONDS, run(), usage. Utilisé par 1 fichier (src/commands/index.ts).
- `quota.ts` : How many executions ('/apv:run') may run side by side at each level: as many as free… Exporte : levelText, run(), runQuota(), runsText, usage. Utilisé par 1 fichier (src/commands/index.ts).
- `reuse.ts` : sans description. Exporte : formatReuse(), run(), usage. Utilisé par 1 fichier (src/commands/index.ts).
- `review.ts` : sans description. Exporte : PlanQuota, run(), usage. Utilisé par 1 fichier (src/commands/index.ts).
- `rules.ts` : sans description. Exporte : run(), usage. Utilisé par 1 fichier (src/commands/index.ts).
- `run.ts` : sans description. Exporte : run(), usage. Utilisé par 1 fichier (src/commands/index.ts).
- `scope.ts` : Paths of 'git status --porcelain=v1 -z'; a rename or copy entry is followed by its… Exporte : porcelainPaths(), run(), usage. Utilisé par 1 fichier (src/commands/index.ts).
- `spec.ts` : Kebab-case spec id: lower-case letters and digits separated by single hyphens. Exporte : SPEC_ID, run(), specTemplate(), usage. Utilisé par 1 fichier (src/commands/index.ts).
- `stack.ts` : sans description. Exporte : STACK_LOG, freshnessText(), run(), stackRules(), transcript(), usage. Utilisé par 1 fichier (src/commands/index.ts).
- `stacks.ts` : sans description. Exporte : run(), usage. Utilisé par 1 fichier (src/commands/index.ts).
- `status.ts` : sans description. Exporte : ApvStatus, apvStatus(), metricsLine(), run(), usage. Utilisé par 1 fichier (src/commands/index.ts).
- `structure.ts` : sans description. Exporte : formatReport(), run(), trackedFiles(), usage. Utilisé par 1 fichier (src/commands/index.ts).
- `tests.ts` : sans description. Exporte : formatTests(), run(), usage. Utilisé par 1 fichier (src/commands/index.ts).
- `wait.ts` : 0 and 1 name a process group and init; our own pid would never end while we wait. Exporte : run(), usage. Utilisé par 1 fichier (src/commands/index.ts).
- `web.ts` : , e2e/**, .github/**, *.md à la racine, docs/** par défaut ; .apv/config.json,… Exporte : metricText(), run(), usage. Utilisé par 1 fichier (src/commands/index.ts).

### src/config

- `apv-files.ts` : The project directory of APV3: configuration, ledger, specs and state, versioned with… Exporte : APV_DIR, APV_IGNORED, apvGitignoreMissing(), ensureApvGitignore(). Utilisé par 5 fichiers (src/commands/init.ts, …).
- `load.ts` : V3 project configuration, versioned with the project. Exporte : ApvConfig, CONFIG_FILE, DAST_PLACEHOLDERS, DEFAULT_DAST_RESOURCE, DEFAULT_DAST_TIMEOUT_MS, DEFAULT_FULL_SUITE, et 35 autre(s). Utilisé par 38 fichiers (src/commands/dast.ts, …).

### src/db

- `checks.ts` : Object the finding is about, as used by 'exceptions[].target'. Exporte : Finding, RULES, Severity, SuppressedFinding, applyExceptions(), checkModel(), et 1 autre(s). Utilisé par 3 fichiers (src/db/code-scan.ts, …).
- `code-scan.ts` : Text of the call arguments starting at 'open' (the index of '('), bounded to keep the… Exporte : scanCode(), scanSelectStar(). Utilisé par 1 fichier (src/db/index.ts).
- `config.ts` : Migration glob(s), applied in file name order. Exporte : DEFAULT_DB_CONFIG, DbConfig, DbException, DbExplainQuery, LoadedConfig, loadDbConfig(), et 2 autre(s). Utilisé par 6 fichiers (src/commands/review.ts, …).
- `french.ts` : Common French domain words refused in identifiers. Exporte : SNAKE_CASE, foldAccents(), frenchWords(). Utilisé par 1 fichier (src/db/checks.ts).
- `glob.ts` : Converts a glob ('**', '*', '?', '{a,b}') into an anchored regular expression over '/'… Exporte : expandGlobs(), globToRegExp(). Utilisé par 9 fichiers (src/db/checks.ts, …).
- `index.ts` : Test seam for '--live'. Exporte : DbCheckOptions, DbCheckReport, formatHuman(), formatJson(), runDbCheck(). Utilisé par 1 fichier (src/commands/db.ts).
- `live.ts` : One line per executed check, for the human report. Exporte : EXPLAIN_SQL, FK_INDEX_SQL, LIVE_RULES, LiveReport, PsqlRunner, READ_ONLY_PREFIX, et 9 autre(s). Utilisé par 1 fichier (src/db/index.ts).
- `model.ts` : Schema model rebuilt from the migrations, in order. Exporte : Column, DbFunction, DbType, ForeignKey, Grant, Index, et 7 autre(s). Utilisé par 3 fichiers (src/db/checks.ts, …).
- `parser.ts` : Supabase grants EXECUTE on new functions of schema 'public' to anon, authenticated and… Exporte : MigrationFile, MigrationParser, ParseOptions, parseMigrations(), splitTopLevel(), tokensText. Utilisé par 1 fichier (src/db/index.ts).
- `tokenizer.ts` : Light SQL tokenizer for Postgres migrations: enough to follow DDL, not a full grammar. Exporte : SqlSyntaxError, Statement, Token, TokenKind, splitStatements(), tokenize(). Utilisé par 1 fichier (src/db/parser.ts).

### src/design

- `attributes.ts` : Root attributes file of the repository, where the validated-mockup line is written. Exporte : DesignAttributeResult, DesignAttributeStatus, GITATTRIBUTES, designAttributeLine, designAttributeState(), designWhitespaceUnset(), et 3 autre(s). Utilisé par 5 fichiers (src/commands/design.ts, …).
- `config.ts` : Default folder of validated mockups, relative to the repository root ('design.dir'… Exporte : DEFAULT_DESIGN_DIR, DesignGroup, DesignSection, DesignSettings, RESERVED_GROUP, declaredGroups(), et 8 autre(s). Utilisé par 12 fichiers (src/commands/design.ts, …).
- `links.ts` : Whether 'rel' is a repository-relative path that stays inside the repository, lexically. Exporte : assertNoLink(), assertRealFolder(), lexicallyInside(), linkedComponent(), realInside(). Utilisé par 2 fichiers (src/design/organize.ts, …).
- `organize.ts` : A validated mockup to move into the folder of its group. Exporte : OrganizeBlock, OrganizeMove, OrganizeReference, OrganizeResult, organizeMockups(). Utilisé par 1 fichier (src/commands/design.ts).
- `registry.ts` : Lowercase words joined by single dashes; short enough for the decision id (80… Exporte : DECISION_ID, DesignConfig, MockupPlacement, MockupState, RegisterInput, RegisterResult, et 13 autre(s). Utilisé par 5 fichiers (src/commands/design.ts, …).

### src/domain

- `contracts.ts` : When a check runs: 'task' after every task (fast feedback), 'full' only in the complete… Exporte : AgentConfig, ChangeSet, CommandSpec, Config, DEFAULT_GENERATED_PATHS, DEFAULT_LIMITS, et 35 autre(s). Utilisé par 22 fichiers (src/commands/gates.ts, …).
- `errors.ts` : sans description. Exporte : PipelineError, errorMessage(), invariant(). Utilisé par 80 fichiers (src/commands/common.ts, …).
- `hash.ts` : Hash raw bytes, distinct from the canonical-JSON identity helper. Exporte : canonical(), hash(), hashFile(), sha256(). Utilisé par 9 fichiers (src/commands/run.ts, …).
- `issues.ts` : One validation problem. Exporte : Issue, IssueList, jsonSchemaIssues(), schemaIssues(). Utilisé par 4 fichiers (src/config/load.ts, …).
- `knowledge.ts` : Old configurations opt into no new skills. Exporte : KnowledgeConfig, LanguageProfile, RoleName, SkillsConfig, exportRules, knowledgeSchema, et 5 autre(s). Utilisé par 3 fichiers (src/config/load.ts, …).
- `paths.ts` : Absolute path with every symlink of its longest existing ancestor resolved, the missing… Exporte : canonicalPath(). Utilisé par 10 fichiers (src/commands/common.ts, …).
- `schema.ts` : A deliberately small schema vocabulary: runtime parsing and JSON Schema share the same… Exporte : Infer, JsonSchema, Schema, parseJson(), s. Utilisé par 23 fichiers (src/config/load.ts, …).
- `time.ts` : Times shown to a human, in the local time zone of the machine (Intl, the zone of the… Exporte : LocalTimeOptions, localTime(), localTimeZone, parseUntil(). Utilisé par 7 fichiers (src/commands/lock.ts, …).

### src/engine

- `diagnostic.ts` : Maximum characters of a failed gate diagnostic kept in a receipt and handed to a repair. Exporte : MAX_DIAGNOSTIC_CHARS, failureExcerpt(), failureFingerprint(). Utilisé par 1 fichier (src/gates/run.ts).
- `scheduler.ts` : A receipt that counts as passed: 'passed_after_retry' too (every test passed on the… Exporte : ScheduleOptions, schedule(), success. Utilisé par 3 fichiers (src/commands/stack.ts, …).

### src/evidence

- `key.ts` : Try the next PATH entry. Exporte : environmentIdentity(), executableIdentity(), proofKey(). Utilisé par 1 fichier (src/gates/run.ts).

### src/execution

- `git.ts` : The tool command that created the commit, written as the 'Generated-by' trailer. Exporte : CommitMessage, Git, GitIdentity, candidateSubject(), isInside(). Utilisé par 24 fichiers (src/commands/design.ts, …).
- `process.ts` : The command signals on file descriptor 3 (a pipe) when its real work starts, for… Exporte : PIPE_GRACE_MS, ProcessHooks, ProcessOptions, environment(), expandCommand(), redact(), et 1 autre(s). Utilisé par 13 fichiers (src/commands/stack.ts, …).
- `procs.ts` : Processes of a repository, read from '/proc' (Linux): the working directory of each… Exporte : PROC_ROOT, PROTECTED_TOOLS, ProcessInfo, StopOutcome, StopRefusal, assertProcSupported(), et 12 autre(s). Utilisé par 6 fichiers (src/commands/procs.ts, …).
- `wait.ts` : Bounded waits for a session that may not sleep ('apv wait'). Exporte : DEFAULT_POLL_MS, FileWatch, MAX_WAIT_SECONDS, WaitCondition, WaitOptions, WaitResult, et 2 autre(s). Utilisé par 1 fichier (src/commands/wait.ts).

### src/freshness

- `check.ts` : Bounds of the walk of one glob: entries visited, files kept, depth below '**'. Exporte : FreshnessEntry, FreshnessOptions, FreshnessReport, expandPattern(), freshnessLines(), freshnessReport(), et 3 autre(s). Utilisé par 1 fichier (src/commands/status.ts).
- `config.ts` : Freshness of the living state and resume files ('apv status', SessionStart hook): a… Exporte : DEFAULT_FRESHNESS, DEFAULT_FRESHNESS_IGNORE, DEFAULT_FRESHNESS_PATHS, FreshnessSettings, PatternRoot, SplitPattern, et 4 autre(s). Utilisé par 3 fichiers (src/commands/status.ts, …).

### src/gates

- `base-gates.ts` : The checks of the base (docs/CLI.md, « Contrôles de la base »). Exporte : BaseGates, GateDifference, GateDifferenceKind, RemoteCheck, applyBaseGates(), baseGatesLine(), et 2 autre(s). Utilisé par 2 fichiers (src/commands/gates.ts, …).
- `infrastructure.ts` : A check that failed because of its infrastructure, not of the code it tests: a variable… Exporte : InfrastructureCause, InfrastructureKind, classifyFailures(), infrastructureAdvice(), infrastructureCause(), infrastructureText(). Utilisé par 3 fichiers (src/commands/gates.ts, …).
- `proof-scope.ts` : Scope of the proof of a check ('skipWhenOnly', docs/APV3-SPEC.md, section 21): a change… Exporte : ALWAYS_REQUIRED, ChangedFile, NOT_SEARCHED, ScopeDecision, ScopeInput, commandPaths(), et 8 autre(s). Utilisé par 5 fichiers (src/commands/gates.ts, …).
- `repeat.ts` : Repetition of the changed test files ('repeatChanged' of a check, docs/APV3-SPEC.md,… Exporte : FixedWait, REPEAT_PLACEHOLDER, Rename, RenamedPaths, RepeatPlan, RepeatSettings, et 23 autre(s). Utilisé par 7 fichiers (src/commands/gates.ts, …).
- `run.ts` : Receipts of 'apv gates run', one directory per execution. Exporte : ENVIRONMENT_ID, GateRunOptions, GateRunResult, NEAR_TIMEOUT, RECEIPTS_DIR, SharedCopy, et 15 autre(s). Utilisé par 4 fichiers (src/commands/gates.ts, …).
- `since.ts` : Incremental proof after corrections ('apv gates run --stage task --since <commit… Exporte : SinceCheck, checkSince(). Utilisé par 1 fichier (src/commands/gates.ts).
- `spread.ts` : A full suite spread over several declared test stacks (docs/APV3-SPEC.md, section… Exporte : MainSetup, SpreadAssignment, SpreadCopy, SpreadPlan, planSpread(), prepareCopies(), et 5 autre(s). Utilisé par 1 fichier (src/gates/run.ts).
- `store.ts` : Shared receipt store of a repository: '<git common dir>/apv/receipts/<run>/', common to… Exporte : DEFAULT_RECEIPT_RETENTION, ExportResult, MANIFEST, Manifest, PruneResult, RUN_DIR, et 15 autre(s). Utilisé par 5 fichiers (src/commands/gates.ts, …).
- `suite.ts` : The full suite of 'apv gates run' (docs/APV3-SPEC.md, section 17): the machine queue… Exporte : CleanupRecord, FLOCK_TIMEOUT_EXIT, GateLock, LEASE_TTL_SECONDS, PortProcess, PortsRecord, et 18 autre(s). Utilisé par 4 fichiers (src/gates/run.ts, …).
- `verify.ts` : Commit to verify: any revision Git resolves to a commit, compared by its full SHA. Exporte : AlteredRun, EvidenceState, GateEvidence, ReceiptSource, VerifyOptions, VerifyResult, et 1 autre(s). Utilisé par 4 fichiers (src/commands/gates.ts, …).

### src/knowledge

- `code-map.ts` : The code map ('.apv/code-map.md'): what exists in the project, short enough for an… Exporte : BuildOptions, CodeMap, MapComponent, MapFolders, MapModule, MapRoute, et 15 autre(s). Utilisé par 8 fichiers (src/commands/map.ts, …).
- `focus.ts` : Select relevant declarations for a fresh task; report omissions and preserve repository… Exporte : focusedIntelligence(). Utilisé nulle part.
- `inventory.ts` : A text source file whose technology has no declaration grammar: indexed as a whole, by… Exporte : Inventory, InventoryDelta, InventoryOptions, InventorySymbol, InventoryUnit, WORKTREE, et 9 autre(s). Utilisé par 6 fichiers (src/commands/init.ts, …).
- `languages.ts` : sans description. Exporte : CompiledLanguage, builtinLanguages, extensionOf(), isExported(), isTestPath(), nonSourceExtensions, et 1 autre(s). Utilisé par 3 fichiers (src/knowledge/inventory.ts, …).
- `repository.ts` : Existing test files that reference the focus paths (a task's allowedPaths);… Exporte : RepositoryIntelligence, RepositoryOptions, RepositorySymbol, inspectRepository(). Utilisé par 2 fichiers (src/knowledge/focus.ts, …).

### src/lifecycle

- `contracts.ts` : sans description. Exporte : CriterionAmendment, DesignProposal, DesignRecord, PlanRevision, Publication, QaRecord, et 27 autre(s). Utilisé par 5 fichiers (src/commands/run.ts, …).
- `decisions.ts` : Kebab-case spec id, as in '.apv/specs/<id>.json'. Exporte : Decision, DecisionCoverage, DecisionLedger, DecisionScope, DecisionTarget, LEDGER_FILE, et 25 autre(s). Utilisé par 14 fichiers (src/commands/init.ts, …).
- `ledger-update.ts` : Operator-authored change to the Decision Ledger after bootstrap. Exporte : LedgerUpdate, LedgerUpdatePlan, applyLedgerUpdate(), ledgerUpdateSchema, planLedgerUpdate(). Utilisé par 2 fichiers (src/commands/ledger.ts, …).
- `pathways.ts` : A bounded Product transport. Exporte : Architecture, ExecutionPath, adaptiveConfig(), architectureSchema, briefSpecSchema, expandBrief(), et 5 autre(s). Utilisé par 1 fichier (src/lifecycle/contracts.ts).

### src/lock

- `run.ts` : Delay between SIGTERM forwarded to the command and SIGKILL. Exporte : LOCK_WAIT_TIMEOUT_EXIT, RunLockedOptions, TIMEOUT_EXIT, describeHolder(), runLocked(), signalExitCode(), et 1 autre(s). Utilisé par 8 fichiers (src/commands/gates.ts, …).
- `store.ts` : Who holds (or waits for) a lock. Exporte : AcquireResult, LockEvent, LockOwner, LockRecord, LockSnapshot, LockStore, et 10 autre(s). Utilisé par 13 fichiers (src/commands/dast.ts, …).

### src/metrics

- `pr.ts` : Time measure of one pull request (docs/SHIFT-LEFT.md, section 11): opened, ready, first… Exporte : BASELINE_PRS, PrBaseline, PrCommit, PrData, PrKind, PrMetrics, et 8 autre(s). Utilisé par 2 fichiers (src/commands/metrics.ts, …).
- `run.ts` : Time measure of one spec execution (docs/SHIFT-LEFT.md, section 11), computed from what… Exporte : BASELINE_RUNS, CriticalPath, MeasureInput, PHASES, PHASE_LABEL, PhaseMeasure, et 17 autre(s). Utilisé par 4 fichiers (src/commands/metrics.ts, …).
- `sources.ts` : Sources of 'apv metrics', read only: nothing is written, fetched or locked. Exporte : FoundState, MAX_RUN_STATES, PR_FIELDS, STATUS_RUNS, StoredRun, commonDirOf(), et 15 autre(s). Utilisé par 2 fichiers (src/commands/metrics.ts, …).

### src/onboard

- `detect.ts` : A gate read from a project file, proposed with 'mandatory: false' until the operator… Exporte : DetectedGate, detectGates(), previewHints(). Utilisé par 1 fichier (src/commands/onboard.ts).
- `v2.ts` : What APV3 reads from a V2 'pipeline.v2.json' (spec, section 14): gates, risk,… Exporte : MAX_SPEC_BYTES, SpecCandidate, V2ConfigImport, V2LedgerImport, V2_KEPT, V2_KEPT_SECTIONS, et 7 autre(s). Utilisé par 1 fichier (src/commands/onboard.ts).

### src/policy

- `decision.ts` : Clock-free audit identity. Exporte : decisionRecord(). Utilisé par 1 fichier (src/lifecycle/pathways.ts).
- `overlap.ts` : Whether two portable globs (the syntax of 'allowedPaths': '*', '**', '?', everything… Exporte : globsOverlap(). Utilisé par 1 fichier (src/lifecycle/decisions.ts).
- `policy.ts` : Restricted portable globs: *, **, ?. Exporte : PolicyConfig, ReviewMode, ScopeReport, ScopeTask, ValidationRequirement, assertScope(), et 12 autre(s). Utilisé par 24 fichiers (src/commands/review.ts, …).

### src/preview

- `config.ts` : A command of the preview: a string runs through 'sh -c' (pipes, '&&', variables of the… Exporte : DEFAULT_BRANCH, DEFAULT_STEP_TIMEOUT_SEC, PreviewCommand, PreviewConfig, PreviewStep, STEP_NAMES, et 11 autre(s). Utilisé par 4 fichiers (src/commands/web.ts, …).
- `env.ts` : Environment variable names accepted in an env file and in 'serve.env'. Exporte : ENV_NAME, RedactingWriter, Redactor, expandVars(), parseEnvFile(). Utilisé par 3 fichiers (src/preview/config.ts, …).
- `process.ts` : Grace period after a step exits for its pipes, possibly held by a detached grandchild,… Exporte : StepResult, argv(), describeCommand(), groupAlive(), healthy(), isOurs(), et 6 autre(s). Utilisé par 1 fichier (src/preview/service.ts).
- `service.ts` : Name of the lease lock taken by 'update' and 'stop' (docs/LOCKS.md): one per project,… Exporte : DIR_MARKER, LoadedPreview, MAX_CHANGES, PreviewContext, StatusResult, StopResult, et 10 autre(s). Utilisé par 2 fichiers (src/commands/preview.ts, …).
- `state.ts` : Record of the preview, kept after a stop or a failed update: 'pid' null means no server… Exporte : PREVIEW_LOG, PREVIEW_PREVIOUS_LOG, PREVIEW_STATE, PREVIEW_UPDATE_LOG, PreviewState, previewStateSchema, et 2 autre(s). Utilisé par 2 fichiers (src/gates/run.ts, …).

### src/quality

- `review.ts` : What a validation produced for one candidate: the reviewed configuration, the checks… Exporte : QualityCheck, QualityContext, ValidationSubject, assertRequiredEvidence(), findingRequiresFix(), qualityAxes, et 6 autre(s). Utilisé par 1 fichier (src/lifecycle/contracts.ts).

### src/quota

- `usage.ts` : Journal of readings, one JSON object per line, read back by 'apv status' and the… Exporte : CommandOutcome, QUOTA_COMMAND, QUOTA_LOG, QUOTA_THRESHOLDS, QUOTA_TIMEOUT_MS, QuotaLevel, et 12 autre(s). Utilisé par 3 fichiers (src/commands/quota.ts, …).

### src/reuse

- `changes.ts` : Where the base of the comparison comes from: '--base', the configured reference, or… Exporte : BaseSource, ChangeBase, Changes, collectChanges(), isAdded(), parseAddedLines(), et 4 autre(s). Utilisé par 4 fichiers (src/commands/onboard.ts, …).
- `check.ts` : Added or modified by the change (always true without base). Exporte : CheckOptions, ExcludedReason, ReuseConfig, ReuseFinding, ReuseReport, RuleSummary, et 2 autre(s). Utilisé par 3 fichiers (src/commands/onboard.ts, …).
- `config.ts` : Rules of 'apv reuse check' (docs/REUSE.md). Exporte : COMPONENT_EXTENSIONS, DEFAULT_DUPLICATES, DEFAULT_MAP_FILE, DEFAULT_MAP_MAX_BYTES, DEFAULT_MAP_MAX_ENTRIES, DEFAULT_NATIVE_ELEMENTS, et 35 autre(s). Utilisé par 12 fichiers (src/commands/map.ts, …).
- `detect.ts` : The gate of 'apv reuse check', added by 'apv init' and 'apv onboard' to a web project… Exporte : MAP_GATE, REUSE_GATE, ReuseDocument, ReuseProposal, STRUCTURE_GATE, WEB_DEPENDENCIES, et 4 autre(s). Utilisé par 7 fichiers (src/commands/audit.ts, …).
- `duplicates.ts` : Detection of copied blocks: a token-based clone detector (exact copies, whitespace and… Exporte : Clone, DuplicateOptions, Fragment, Token, TokenTable, blankImports(), et 3 autre(s). Utilisé par 1 fichier (src/reuse/check.ts).
- `markup.ts` : Readers of interface files shared by the reuse rules: comments blanked (lines kept),… Exporte : Block, ElementHit, ElementRule, blankComments(), blocks(), elementRule(), et 6 autre(s). Utilisé par 3 fichiers (src/reuse/check.ts, …).
- `names.ts` : Words that say where a component sits, not what it does: dropped from the end of a name… Exporte : COMPOSITE_FAMILIES, Clash, ClashReason, ComponentName, clashOf(), componentName(), et 2 autre(s). Utilisé par 3 fichiers (src/knowledge/code-map.ts, …).
- `styles.ts` : A style rule, its selector resolved against the enclosing rules (CSS nesting, '&'), and… Exporte : Primitives, StyleHit, StyleRule, classesOf(), compounds(), isLayoutOnly, et 4 autre(s). Utilisé par 1 fichier (src/reuse/check.ts).
- `typography.ts` : Comments and drawings left out: '<!-- 14 h -->', an '<svg>' and geometry attributes… Exporte : TYPOGRAPHY_PATTERNS, TypographyHit, TypographyPattern, breakableValues(), typographyPatterns(). Utilisé par 1 fichier (src/reuse/check.ts).

### src/review

- `config.ts` : Settings of 'apv review plan' in the 'review' section of '.apv/config.json'… Exporte : ALWAYS_REVIEWED, DEFAULT_REVIEW_PATHS, DEFAULT_REVIEW_TERMS, PATH_CLASSES, PathClass, REVIEW_DOMAINS, et 8 autre(s). Utilisé par 8 fichiers (src/commands/review.ts, …).
- `dast.ts` : 'apv dast run': the dynamic security scan (ZAP or another) that the project declares in… Exporte : DAST_INSTALL, DAST_INSTALL_MARKER, DAST_LOG, DAST_SUMMARY, DastInstall, DastRunOptions, et 11 autre(s). Utilisé par 2 fichiers (src/commands/dast.ts, …).
- `plan.ts` : 'apv review plan': the review domains proposed from the nature of a diff. Exporte : ChangeKind, DomainDecision, Hunk, PlanInput, PlannedFile, ReferenceSide, et 7 autre(s). Utilisé par 4 fichiers (src/commands/review.ts, …).
- `rename.ts` : Pure renames of class and id names, for 'apv review plan' (docs/REGLES.md, « Renommage… Exporte : HunkPlace, RenameInput, RenamePair, neutralizeLine(), pureRename(), renameKind, et 2 autre(s). Utilisé par 1 fichier (src/review/plan.ts).
- `risk.ts` : Risk level of a diff ('apv review plan', 'apv gates run --since'). Exporte : AGENT_INSTRUCTIONS, CONFIG_FILES, DiffRisk, LOCK_FILES, MANIFEST_FILES, PILOT_NOTES, et 12 autre(s). Utilisé par 4 fichiers (src/commands/review.ts, …).

### src/rules

- `anchor-status.ts` : What 'apv status' says of the anchors: the operator journal, the branch protection, the… Exporte : AnchorStatus, anchorLines(), anchorStatus(), journalLines(). Utilisé par 1 fichier (src/commands/status.ts).
- `check.ts` : What was checked, in one sentence. Exporte : DomainReview, RuleOutcome, RuleStatus, RulesInput, RulesReport, checkMergeRules(), et 2 autre(s). Utilisé par 2 fichiers (src/commands/rules.ts, …).
- `config.ts` : The rules the tool enforces before a merge ('apv rules check', 'apv stack merge', 'apv… Exporte : CAPTURE_THEMES, CAPTURE_VIEWPORTS, CaptureTheme, CaptureViewport, DEFAULT_CAPTURE_THEMES, DEFAULT_CAPTURE_VIEWPORTS, et 10 autre(s). Utilisé par 7 fichiers (src/commands/review.ts, …).
- `docs-only.ts` : The lane without code (« voie sans code », docs/REGLES.md): a pull request of the… Exporte : DocsOnlyLane, KIND_LABEL, LANE_NAME, LaneFile, LaneInput, docsOnlyLane(), et 2 autre(s). Utilisé par 2 fichiers (src/commands/review.ts, …).
- et 7 autres entrées dans ce dossier (liste complète : apv map --json).

Dossiers non listés, au-delà de la taille de la carte : src/run (6), src/security (2), src/spec (1), src/stack (5), src/stacks (2), src/structure (9), src/testcheck (1), src/web (6), workflows (2) (liste complète : apv map --json).

## Routes

Aucune route trouvée.

## Propre à une fonctionnalité

Rien de propre à une fonctionnalité.
