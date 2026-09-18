export { Pipeline, summarize } from './engine/pipeline.js';
export type { StartOptions, ExecuteOptions } from './engine/pipeline.js';
export { taskSchema, configSchema, agentOutputSchema, receiptSchema, validateReceipt, validateConfig, VERSION } from './domain/contracts.js';
export type { Task, Config, Gate, GateReceipt, Run, Lane, RunEvent } from './domain/contracts.js';
export { PipelineError } from './domain/errors.js';
export { classify, planGates, assertScope } from './policy/policy.js';

export { Lifecycle } from './lifecycle/service.js';
export { specSchema, replanSchema, qaSchema, designProposalSchema, securityPlanSchema, threatModelSchema, validateSpec, validateQa, specHash, approvalHash, specMarkdown } from './lifecycle/contracts.js';
export type { Spec, SpecRecord, QaReport, DesignProposal, DesignRecord, ScopeAmendment, PlanRevision } from './lifecycle/contracts.js';
export { inspectProject, planInstallation, applyInstallation, doctor } from './lifecycle/onboarding.js';
export { publishSpec,syncSpec } from './lifecycle/github.js';

export { readRole, catalog, guidanceFor, guidanceAudit, installedAssets } from './knowledge/catalog.js';
export { roleNames, skillNames, skillsSchema } from './domain/knowledge.js';
export { providerProfile, providerSupport } from './adapters/providers.js';

export { bootstrapProposalSchema, planBootstrap, refineBootstrap, applyBootstrap } from './lifecycle/bootstrap.js';
export { decisionSchema, decisionLedgerSchema, decisionCoverageSchema, semanticReviewSchema, validateDecisionLedger, loadDecisionLedger, ledgerHash, confirmedDecisions, ambiguousDecisions, ambiguousApprovalFragments } from './lifecycle/decisions.js';
export type { Decision, DecisionLedger, DecisionCoverage, SemanticReview } from './lifecycle/decisions.js';

export { inspectRepository } from './knowledge/repository.js';
export type { RepositoryIntelligence, RepositorySymbol } from './knowledge/repository.js';

export { owaspTopicIds, owaspCatalog, securityProfileSchema, securityContextSchema, assessSecurity, neutralSecurityContext, topicById } from './security/owasp.js';
export type { OwaspTopicId, OwaspTopic, SecurityProfile, SecurityContext } from './security/owasp.js';

export { compactProposal } from './lifecycle/compact.js';
export { roleAgent, modelChoice, modelPlan } from './adapters/routing.js';
export { modelSelectionSchema, validateModelSelection, applyModelSelection } from './adapters/model-selection.js';
export type { ModelSelection } from './adapters/model-selection.js';
export { invocationTotals } from './adapters/invocations.js';
export { evaluationReport } from './evaluation/report.js';

export { qualityCheckSchema, qualityContext, validationEvidence, validateQualityChecks } from './quality/review.js';
