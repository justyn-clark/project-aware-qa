/**
 * Public API for project-aware-qa. The CLI scripts and the Pi extension import from here.
 */

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
export { buildRegistry } from "./registry/build.js";
export { assertValidRegistry, type ValidationResult, validateRegistry } from "./registry/schema.js";
export { renderJUnit, renderSarif } from "./report/machine.js";
export { type ScanOptions, type ScanResult, scanRepo } from "./scanner/index.js";
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
