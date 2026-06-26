/**
 * High-level orchestration shared by the CLI scripts and the Pi extension.
 *
 * Each `run*` function performs one workflow step, writes the relevant `.qa/` artifacts,
 * and returns a structured result plus a short human summary suitable for a terminal
 * notification. Keeping this in one place means the scripts and the extension stay in
 * lockstep.
 */
import { existsSync, readFileSync } from "node:fs";
import {
	ensureQaDirs,
	qaPath,
	readRegistry,
	registryExists,
	writeArtifact,
	writeJsonArtifact,
} from "./io.js";
import { validateRegistry } from "./registry/schema.js";
import {
	renderCrudMatrix,
	renderRiskReport,
	renderScanReport,
	renderTestPlan,
} from "./report/markdown.js";
import { renderQaReport } from "./report/summary.js";
import { renderVerificationReport } from "./report/verification.js";
import { type ScanResult, scanRepo } from "./scanner/index.js";
import { runVerification, type VerifyOptions, type VerifyResult } from "./verify/index.js";

export interface StepResult {
	ok: boolean;
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
	options: { maxFiles?: number; generatedAt?: string } = {},
): ScanStepResult {
	const written: string[] = [];
	try {
		const scan = scanRepo(root, options);
		const { valid, errors } = validateRegistry(scan.registry);
		ensureQaDirs(root);
		written.push(writeJsonArtifact(root, "surface-registry.json", scan.registry));
		written.push(writeArtifact(root, "scan-report.md", renderScanReport(scan)));
		written.push(
			writeArtifact(root, "crud-matrix.md", renderCrudMatrix(scan.flows, scan.registry)),
		);
		written.push(writeArtifact(root, "risk-report.md", renderRiskReport(scan.registry)));

		const { high, medium, low } = scan.registry.stats.byRisk;
		const summary =
			`Scanned ${scan.registry.stats.scannedFiles} files · ${scan.registry.surfaces.length} surfaces ` +
			`(${high} high / ${medium} medium / ${low} low) · ${scan.flows.length} CRUD flows. ` +
			`Registry ${valid ? "valid ✅" : `INVALID ❌ (${errors.length} errors)`}.`;
		return {
			ok: true,
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
			summary: "No surface registry found — run /qa-scan first.",
			writtenFiles: [],
			error: "missing .qa/surface-registry.json",
		};
	}
	ensureQaDirs(root);
	const md = renderTestPlan(registry, { scope: options.scope });
	const file = writeArtifact(root, "test-plan.md", md);
	const scope = options.scope?.toLowerCase();
	const inScope = scope
		? registry.surfaces.filter(
				(s) =>
					s.title.toLowerCase().includes(scope) || (s.entity ?? "").toLowerCase().includes(scope),
			).length
		: registry.surfaces.length;
	return {
		ok: true,
		summary: `Test plan written for ${options.scope ? `scope "${options.scope}" (~${inScope} surfaces)` : `${registry.surfaces.length} surfaces`}.`,
		writtenFiles: [file],
	};
}

export interface VerifyStepResult extends StepResult {
	verify?: VerifyResult;
}

/** Phase 6-7: run the safe-check ladder and write the evidence report. */
export async function runVerify(options: VerifyOptions): Promise<VerifyStepResult> {
	const root = options.root;
	if (!registryExists(root)) {
		return {
			ok: false,
			summary: "No surface registry found — run /qa-scan first.",
			writtenFiles: [],
			error: "missing .qa/surface-registry.json",
		};
	}
	try {
		ensureQaDirs(root);
		const verify = await runVerification(options);
		const file = writeArtifact(root, "verification-report.md", renderVerificationReport(verify));
		const passed = verify.checks.filter((c) => c.status === "passed").length;
		const failed = verify.checks.filter((c) => c.status === "failed").length;
		const skipped = verify.checks.filter((c) => c.status === "skipped").length;
		const inconclusive = verify.checks.filter((c) => c.status === "inconclusive").length;
		const incBit = inconclusive ? ` · ${inconclusive} inconclusive` : "";
		return {
			ok: failed === 0,
			summary: `Verification: ${passed} passed · ${failed} failed · ${skipped} skipped${incBit}. Evidence in .qa/findings/.`,
			writtenFiles: [file],
			verify,
		};
	} catch (e) {
		return {
			ok: false,
			summary: "Verification failed to run",
			writtenFiles: [],
			error: e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e),
		};
	}
}

function countVerification(
	root: string,
): { passed: number; failed: number; skipped: number } | undefined {
	// Prefer the structured findings; fall back to undefined when not present.
	const probe = qaPath(root, "findings", "route-probe.json");
	const report = qaPath(root, "verification-report.md");
	if (!existsSync(report) && !existsSync(probe)) return undefined;
	// We re-derive a coarse count from the verification report's header line when present.
	try {
		if (!existsSync(report)) return undefined;
		const text = readFileSync(report, "utf8");
		const m = /\*\*(\d+) passed · (\d+) failed · (\d+) skipped(?: · \d+ inconclusive)?\*\*/.exec(
			text,
		);
		if (m) return { passed: Number(m[1]), failed: Number(m[2]), skipped: Number(m[3]) };
	} catch {
		/* ignore */
	}
	return undefined;
}

/** Phase 9: aggregate everything into qa-report.md. */
export function runReport(root: string): StepResult {
	const registry = readRegistry(root);
	if (!registry) {
		return {
			ok: false,
			summary: "No surface registry found — run /qa-scan first.",
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
		verification: countVerification(root),
	});
	const file = writeArtifact(root, "qa-report.md", md);
	const { high, medium } = registry.stats.byRisk;
	return {
		ok: true,
		summary: `QA report written. ${high} high / ${medium} medium risk surfaces across ${registry.surfaces.length} total.`,
		writtenFiles: [file],
	};
}
