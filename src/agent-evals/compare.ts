import { readFileSync, statSync } from "node:fs";
import type { StepResult } from "../core.js";
import { digest } from "./config.js";
import type { EvalReport } from "./run.js";

export function readEvalReport(path: string): EvalReport {
	if (statSync(path).size > 4 * 1024 * 1024) throw new Error("Evaluation report too large");
	const raw = readFileSync(path, "utf8");
	if (readFileSync(`${path}.sha256`, "utf8").trim() !== digest(raw))
		throw new Error("Evaluation report checksum mismatch");
	const r = JSON.parse(raw) as EvalReport;
	validateReport(r);
	return r;
}
function validateReport(r: EvalReport): void {
	if (
		r.version !== 1 ||
		r.kind !== "agent-eval" ||
		typeof r.completedAt !== "string" ||
		!/^[a-f0-9]{64}$/.test(r.compatibilityHash) ||
		!Array.isArray(r.trials) ||
		!r.trials.length ||
		!Array.isArray(r.controls) ||
		!r.controls.length
	)
		throw new Error("Invalid or incomplete evaluation report");
	if (
		r.controls.some((c) => c.valid !== true || typeof c.task !== "string") ||
		r.trials.some(
			(t) =>
				!["passed", "failed"].includes(t.status) ||
				!Number.isInteger(t.trial) ||
				t.trial < 1 ||
				typeof t.task !== "string" ||
				!Number.isFinite(t.durationMs) ||
				t.durationMs < 0,
		)
	)
		throw new Error("Cannot compare inconclusive evaluations");
	const keys = r.trials.map((t) => `${t.task}:${t.trial}`);
	if (
		new Set(keys).size !== keys.length ||
		new Set(r.controls.map((c) => c.task)).size !== r.controls.length ||
		r.controls.some((c) => !r.trials.some((t) => t.task === c.task)) ||
		r.trials.some((t) => !r.controls.some((c) => c.task === t.task))
	)
		throw new Error("Invalid trial identities");
}
export function compareEvaluations(
	before: EvalReport,
	after: EvalReport,
): {
	beforeRate: number;
	afterRate: number;
	delta: number;
	paired: number;
	regressions: string[];
	improvements: string[];
	preliminary: boolean;
} {
	validateReport(before);
	validateReport(after);
	if (
		!before.completedAt ||
		!after.completedAt ||
		!before.trials.length ||
		!after.trials.length ||
		[...before.controls, ...after.controls].some((c) => !c.valid)
	)
		throw new Error("Comparisons require completed reports with valid controls");
	if (
		new Set(before.trials.map((t) => `${t.task}:${t.trial}`)).size !== before.trials.length ||
		new Set(after.trials.map((t) => `${t.task}:${t.trial}`)).size !== after.trials.length
	)
		throw new Error("Duplicate trial identities");
	if (before.compatibilityHash !== after.compatibilityHash)
		throw new Error("Incompatible task, grader, runner, image, network or budget configuration");
	const key = (t: EvalReport["trials"][number]) => `${t.task}:${t.trial}`;
	const previous = new Map(before.trials.map((t) => [key(t), t]));
	if (
		before.trials.length !== after.trials.length ||
		after.trials.some((t) => !previous.has(key(t))) ||
		[...before.trials, ...after.trials].some((t) => t.status === "inconclusive")
	)
		throw new Error("Comparisons require complete matching trials");
	const rate = (r: EvalReport) =>
		r.trials.filter((t) => t.status === "passed").length / r.trials.length;
	const beforeRate = rate(before),
		afterRate = rate(after);
	return {
		beforeRate,
		afterRate,
		delta: afterRate - beforeRate,
		paired: after.trials.length,
		regressions: after.trials
			.filter((t) => previous.get(key(t))?.status === "passed" && t.status === "failed")
			.map(key),
		improvements: after.trials
			.filter((t) => previous.get(key(t))?.status === "failed" && t.status === "passed")
			.map(key),
		preliminary: true,
	};
}
export function runAgentComparison(
	before: string,
	after: string,
): StepResult & { comparison: ReturnType<typeof compareEvaluations> } {
	const comparison = compareEvaluations(readEvalReport(before), readEvalReport(after));
	return {
		ok: comparison.regressions.length === 0,
		summary: `Verified completion: ${(comparison.beforeRate * 100).toFixed(1)}% -> ${(comparison.afterRate * 100).toFixed(1)}% across ${comparison.paired} paired trials. Preliminary descriptive evidence; no causal or statistical significance claim.`,
		writtenFiles: [],
		comparison,
	};
}
