/**
 * Public API for project-aware-qa. The CLI scripts and the Pi extension import from here.
 */

export { type AcceptancePlan, parseAcceptancePlan } from "./acceptance/config.js";
export { type AcceptanceOptions, type AcceptanceReport, runAcceptance } from "./acceptance/run.js";
export { compareEvaluations, readEvalReport, runAgentComparison } from "./agent-evals/compare.js";
export { type EvalSuite, type EvalTask, parseEvalSuite } from "./agent-evals/config.js";
export { inspectReadiness, runAgentReadiness } from "./agent-evals/readiness.js";
export { type EvalReport, runAgentEval, type Trial } from "./agent-evals/run.js";
export { type ChangeSelection, selectChanges } from "./change-selection.js";
export {
	runPlan,
	runReport,
	runScan,
	runVerify,
	type ScanStepResult,
	type StepResult,
	type VerifyStepResult,
} from "./core.js";
export { affectedRoots, type DependencyGraph, dependencyGraph } from "./dependency-graph.js";
export { type DiagnosticCheck, parseDiagnostics } from "./diagnostics/config.js";
export {
	CTV_PLATFORMS,
	evaluatePerformance,
	METRICS,
	type PerformanceCapture,
	parsePerformance,
} from "./diagnostics/performance.js";
export { runDiagnostics } from "./diagnostics/run.js";
export { type CrudFlow, inferCrudFlows } from "./inference/crud.js";
export { type RiskInput, type RiskResult, scoreRisk } from "./inference/risk.js";
export {
	ensureQaDirs,
	qaDir,
	qaPath,
	readRegistry,
	registryExists,
	writeArtifact,
	writeJsonArtifact,
} from "./io.js";
export type { ProgressListener, RunProgress } from "./progress.js";
export { buildRegistry } from "./registry/build.js";
export { assertValidRegistry, type ValidationResult, validateRegistry } from "./registry/schema.js";
export { renderJUnit, renderSarif } from "./report/machine.js";
export { type ScanOptions, type ScanResult, scanRepo } from "./scanner/index.js";
export {
	type BehaviorCheck,
	readTeamConfig,
	type Suppression,
	type TeamConfig,
} from "./team-config.js";
export {
	analyzeTeam,
	type Baseline,
	type BaselineComparison,
	createBaseline,
	readOwnership,
	type TeamInsights,
} from "./team-insights.js";
export * from "./types.js";
export {
	evaluatePolicy,
	normalizeRequiredChecks,
	type PolicyEvaluation,
	type VerificationPolicy,
} from "./verification-policy.js";
export {
	type CheckResult,
	runVerification,
	type VerifyOptions,
	type VerifyResult,
} from "./verify/index.js";
