/**
 * High-level orchestration shared by the CLI scripts and the Pi extension.
 *
 * Each `run*` function performs one workflow step, writes the relevant `.qa/` artifacts,
 * and returns a structured result plus a short human summary suitable for a terminal
 * notification. Keeping this in one place means the scripts and the extension stay in
 * lockstep.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dependencyGraph } from "./dependency-graph.js";
import {
	ensureQaDirs,
	qaPath,
	readRegistry,
	registryExists,
	writeArtifact,
	writeJsonArtifact,
} from "./io.js";
import {
	fingerprintProject,
	registryFingerprint,
	sameFingerprint,
	validateProjectRoot,
} from "./provenance.js";
import { validateRegistry } from "./registry/schema.js";
import { renderJUnit, renderSarif } from "./report/machine.js";
import {
	renderCrudMatrix,
	renderRiskReport,
	renderScanReport,
	renderTestPlan,
} from "./report/markdown.js";
import { renderQaReport } from "./report/summary.js";
import { renderVerificationReport } from "./report/verification.js";
import { type ScanResult, scanRepo } from "./scanner/index.js";
import { renderPlatforms } from "./scanner/platforms.js";
import { matchesScope } from "./scope.js";
import { readTeamConfig } from "./team-config.js";
import { analyzeTeam, createBaseline, renderTeamReport } from "./team-insights.js";
import { evaluatePolicy, normalizeRequiredChecks } from "./verification-policy.js";
import {
	captureEvidenceManifest,
	readVerificationSummary,
	type VerificationRecord,
} from "./verification-record.js";
import { runVerification, type VerifyOptions, type VerifyResult } from "./verify/index.js";
import { TOOL } from "./version.js";

export interface StepResult {
	ok: boolean;
	outcome?: "passed" | "failed" | "incomplete";
	summary: string;
	writtenFiles: string[];
	error?: string;
}

export interface ScanStepResult extends StepResult {
	scan?: ScanResult;
	validation: { valid: boolean; errorCount: number };
}

/** Phase 2-4: scan, infer, write registry + scan/crud/risk reports. */
export function runScan(
	root: string,
	options: {
		maxFiles?: number;
		generatedAt?: string;
		baseline?: string;
		saveBaseline?: boolean;
	} = {},
): ScanStepResult {
	const written: string[] = [];
	try {
		const invalidRoot = validateProjectRoot(root);
		if (invalidRoot) throw new Error(invalidRoot);
		const before = fingerprintProject(root);
		const scan = scanRepo(root, options);
		const config = readTeamConfig(root);
		if (options.baseline) config.baseline = options.baseline;
		dependencyGraph(root, scan.project, config); // Validate graph configuration before writing scan artifacts.
		const after = fingerprintProject(root);
		scan.registry.provenance = {
			...after,
			complete: sameFingerprint(before, after) && !scan.repo.truncated,
		};
		scan.registry.team = analyzeTeam(root, scan.registry, config);
		const { valid, errors } = validateRegistry(scan.registry);
		ensureQaDirs(root);
		written.push(writeJsonArtifact(root, "surface-registry.json", scan.registry));
		written.push(writeArtifact(root, "team-report.md", renderTeamReport(scan.registry.team)));
		if (options.saveBaseline)
			written.push(writeJsonArtifact(root, "baseline.json", createBaseline(scan.registry)));
		written.push(writeArtifact(root, "scan-report.md", renderScanReport(scan)));
		written.push(
			writeArtifact(
				root,
				"platform-report.md",
				renderPlatforms({
					runtimes: scan.project.runtimeDeclarations ?? [],
					infrastructure: scan.project.infrastructure ?? [],
				}),
			),
		);
		written.push(
			writeArtifact(root, "crud-matrix.md", renderCrudMatrix(scan.flows, scan.registry)),
		);
		written.push(writeArtifact(root, "risk-report.md", renderRiskReport(scan.registry)));

		const { high, medium, low } = scan.registry.stats.byRisk;
		const summary =
			`Scanned ${scan.registry.stats.scannedFiles} files | ${scan.registry.surfaces.length} surfaces ` +
			`(${high} high / ${medium} medium / ${low} low) | ${scan.flows.length} CRUD flows. ` +
			`Registry ${valid ? "valid [PASS]" : `INVALID [FAIL] (${errors.length} errors)`}.` +
			(scan.registry.provenance.complete
				? ""
				: ` Source snapshot incomplete: ${after.issues?.join("; ") || "inputs changed or discovery was truncated"}.`);
		return {
			ok: valid,
			outcome: valid ? (scan.registry.provenance.complete ? "passed" : "incomplete") : "failed",
			summary,
			writtenFiles: written,
			scan,
			validation: { valid, errorCount: errors.length },
		};
	} catch (e) {
		return {
			ok: false,
			summary: "Scan failed",
			writtenFiles: written,
			error: e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e),
			validation: { valid: false, errorCount: -1 },
		};
	}
}

/** Phase 5: turn the registry into a risk-scaled, optionally scoped test plan. */
export function runPlan(root: string, options: { scope?: string } = {}): StepResult {
	const registry = readRegistry(root);
	if (!registry) {
		return {
			ok: false,
			summary: "No surface registry found - run /qa-scan first.",
			writtenFiles: [],
			error: "missing .qa/surface-registry.json",
		};
	}
	ensureQaDirs(root);
	const md = renderTestPlan(registry, { scope: options.scope });
	const file = writeArtifact(root, "test-plan.md", md);
	const inScope = registry.surfaces.filter((surface) =>
		matchesScope(surface, options.scope),
	).length;
	return {
		ok: true,
		summary: `Test plan written for ${options.scope ? `scope "${options.scope}" (~${inScope} surfaces)` : `${registry.surfaces.length} surfaces`}.`,
		writtenFiles: [file],
	};
}

export interface VerifyStepResult extends StepResult {
	verify?: VerifyResult;
}

/** Once enabled, latest machine exports are refreshed on every attempt, including preflight failures. */
function exportFormats(options: VerifyOptions): Array<"junit" | "sarif"> {
	return [
		...new Set([
			...(options.exportFormats ?? []),
			...(["junit", "sarif"] as const).filter((format) =>
				existsSync(
					qaPath(
						options.root,
						format === "junit" ? "verification.junit.xml" : "verification.sarif.json",
					),
				),
			),
		]),
	];
}

function preflightFailure(
	options: VerifyOptions,
	message: string,
	incomplete = false,
): VerifyStepResult {
	const result: VerifyStepResult = {
		ok: false,
		outcome: incomplete ? "incomplete" : "failed",
		summary: message,
		error: message,
		writtenFiles: [],
	};
	if (validateProjectRoot(options.root)) return result;
	try {
		const registry = readRegistry(options.root);
		const verify: VerifyResult = {
			root: options.root,
			generatedAt: new Date().toISOString(),
			runId: randomUUID(),
			project: registry?.project ?? {
				root: options.root,
				packageManager: "unknown",
				frameworks: [],
				scripts: {},
				testRunners: [],
				packageJsonPaths: [],
				dependencies: {},
				stacks: [],
			},
			registry,
			checks: [
				{ id: "preflight", title: "Verification prerequisites", status: "failed", reason: message },
			],
			probes: [],
			screenshots: [],
			baseUrl: "",
		};
		const prefix = `runs/${verify.runId}`;
		const record = {
			version: 1,
			runId: verify.runId,
			tool: TOOL,
			result: verify,
			preflightError: message,
		};
		for (const path of [`${prefix}/verification.json`, "verification.json"])
			result.writtenFiles.push(writeJsonArtifact(options.root, path, record));
		for (const path of [`${prefix}/verification-report.md`, "verification-report.md"])
			result.writtenFiles.push(writeArtifact(options.root, path, renderVerificationReport(verify)));
		for (const format of exportFormats(options)) {
			const name = format === "junit" ? "verification.junit.xml" : "verification.sarif.json";
			const content = format === "junit" ? renderJUnit(verify) : renderSarif(verify);
			for (const path of [`${prefix}/${name}`, name])
				result.writtenFiles.push(writeArtifact(options.root, path, content));
		}
		result.verify = verify;
	} catch (error) {
		result.error += ` Could not persist failure evidence: ${(error as Error).message}`;
	}
	return result;
}

/** Phase 6-7: run the safe-check ladder and write the evidence report. */
export async function runVerify(options: VerifyOptions): Promise<VerifyStepResult> {
	const root = options.root;
	if (!registryExists(root)) {
		return preflightFailure(
			options,
			"No surface registry found - run /qa-scan first. Missing .qa/surface-registry.json",
		);
	}
	try {
		const config = readTeamConfig(root);
		options = {
			...options,
			requiredChecks: normalizeRequiredChecks([
				...config.policy.requiredChecks,
				...(options.requiredChecks ?? []),
			]),
			failOnIncomplete: config.policy.failOnIncomplete || options.failOnIncomplete,
		};
		ensureQaDirs(root);
		const registry = readRegistry(root);
		if (!registry || !validateRegistry(registry).valid)
			throw new Error("Invalid surface registry. Run /qa-scan again.");
		const before = fingerprintProject(root);
		if (!registry?.provenance || !sameFingerprint(registry.provenance, before)) {
			return preflightFailure(
				options,
				`Registry is stale, incomplete, or lacks source provenance. Run /qa-scan before verifying.${before.issues?.length ? ` ${before.issues.join("; ")}` : ""}`,
				true,
			);
		}
		const runId = randomUUID();
		const prefix = `runs/${runId}`;
		const verify = await runVerification({ ...options, artifactPrefix: prefix });
		verify.runId = runId;
		const after = fingerprintProject(root);
		if (!sameFingerprint(before, after)) {
			verify.checks.push({
				id: "source-stability",
				title: "Source remained unchanged during verification",
				status: "inconclusive",
				reason: "Source changed during verification. Scan and verify the new snapshot again.",
			});
		}
		let evidence = captureEvidenceManifest(root, verify);
		if (evidence.issues.length) {
			verify.checks.push({
				id: "evidence-integrity",
				title: "Verification evidence remains available and readable",
				status: "inconclusive",
				reason: `${evidence.issues.join("; ")} Run verification again to regenerate the evidence.`,
			});
		}
		if (options.requiredChecks?.length || options.failOnIncomplete) {
			const policy = evaluatePolicy(verify.checks, {
				requiredChecks: options.requiredChecks ?? [],
				failOnIncomplete: options.failOnIncomplete ?? false,
			});
			verify.policy = policy;
			verify.checks.push({
				id: "policy",
				title: "Verification policy",
				status: policy.passed ? "passed" : "failed",
				summary: policy.passed
					? `${policy.requiredChecks.length} required check patterns satisfied`
					: `${policy.violations.length} policy violation(s)`,
				reason: policy.passed ? undefined : policy.violations.join(" "),
			});
		}
		evidence = captureEvidenceManifest(root, verify);
		const machineFiles: string[] = [];
		for (const format of exportFormats(options)) {
			if (format === "junit") {
				machineFiles.push(
					writeArtifact(root, `${prefix}/verification.junit.xml`, renderJUnit(verify)),
				);
				machineFiles.push(writeArtifact(root, "verification.junit.xml", renderJUnit(verify)));
			} else if (format === "sarif") {
				machineFiles.push(
					writeArtifact(root, `${prefix}/verification.sarif.json`, renderSarif(verify)),
				);
				machineFiles.push(writeArtifact(root, "verification.sarif.json", renderSarif(verify)));
			}
		}
		const record: VerificationRecord = {
			version: 1,
			runId,
			tool: TOOL,
			scope: options.scope ?? null,
			registryHash: registryFingerprint(registry),
			sourceBefore: before,
			sourceAfter: after,
			result: verify,
			evidence,
		};
		const json = writeJsonArtifact(root, `${prefix}/verification.json`, record);
		writeJsonArtifact(root, "verification.json", record);
		const report = renderVerificationReport(verify);
		const archived = writeArtifact(root, `${prefix}/verification-report.md`, report);
		const file = writeArtifact(root, "verification-report.md", report);
		if (verify.team) {
			machineFiles.push(
				writeArtifact(root, `${prefix}/team-report.md`, renderTeamReport(verify.team)),
			);
			machineFiles.push(writeArtifact(root, "team-report.md", renderTeamReport(verify.team)));
		}
		const passed = verify.checks.filter((c) => c.status === "passed").length;
		const failed = verify.checks.filter((c) => c.status === "failed").length;
		const skipped = verify.checks.filter((c) => c.status === "skipped").length;
		const inconclusive = verify.checks.filter((c) => c.status === "inconclusive").length;
		const incBit = inconclusive ? ` | ${inconclusive} inconclusive` : "";
		return {
			ok: failed === 0,
			outcome: failed ? "failed" : skipped || inconclusive ? "incomplete" : "passed",
			summary: `Verification: ${passed} passed | ${failed} failed | ${skipped} skipped${incBit}. Evidence in .qa/${prefix}/.`,
			writtenFiles: [file, qaPath(root, "verification.json"), archived, json, ...machineFiles],
			verify,
		};
	} catch (e) {
		return preflightFailure(
			options,
			`Verification failed to run: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
}

/** Phase 9: aggregate everything into qa-report.md. */
export function runReport(root: string): StepResult {
	const registry = readRegistry(root);
	if (!registry) {
		return {
			ok: false,
			summary: "No surface registry found - run /qa-scan first.",
			writtenFiles: [],
			error: "missing .qa/surface-registry.json",
		};
	}
	ensureQaDirs(root);
	const md = renderQaReport({
		registry,
		artifacts: {
			scanReport: existsSync(qaPath(root, "scan-report.md")),
			crudMatrix: existsSync(qaPath(root, "crud-matrix.md")),
			riskReport: existsSync(qaPath(root, "risk-report.md")),
			testPlan: existsSync(qaPath(root, "test-plan.md")),
			verificationReport: existsSync(qaPath(root, "verification-report.md")),
		},
		verification: readVerificationSummary(root, registry),
	});
	const file = writeArtifact(root, "qa-report.md", md);
	const { high, medium } = registry.stats.byRisk;
	return {
		ok: true,
		summary: `QA report written. ${high} high / ${medium} medium risk surfaces across ${registry.surfaces.length} total.`,
		writtenFiles: [file],
	};
}
