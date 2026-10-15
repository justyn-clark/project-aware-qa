import { repoPath } from "../team-config.js";

export const FORMATS = [
	"junit",
	"lcov",
	"go-cover",
	"cpu-profile",
	"heap-snapshot",
	"heap-profile",
	"trace",
	"opaque-profile",
	"performance",
] as const;
export type ArtifactFormat = (typeof FORMATS)[number];
export interface DiagnosticCheck {
	id: string;
	kind:
		| "bun-test"
		| "go-test"
		| "go-benchmark"
		| "go-profile"
		| "runtime-profile"
		| "collector"
		| "cloudflare";
	cwd: string;
	command?: string[];
	runtime?: "bun" | "node" | "deno" | "go";
	target?: string;
	race: boolean;
	artifacts: { path: string; format: ArtifactFormat }[];
	requiredEnv: string[];
	baseline?: string;
	budgets: Record<string, number>;
	maxRegressionPercent?: number;
	minRuns: number;
	requirePhysicalDevice: boolean;
	accountId?: string;
	worker?: string;
	expectedVersion?: string;
	tokenEnv: string;
}
export function object(value: unknown, at: string, keys?: string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw Error(`${at} must be an object`);
	const data = value as Record<string, unknown>;
	if (keys)
		for (const key of Object.keys(data))
			if (!keys.includes(key)) throw Error(`Unknown ${at} field: ${key}`);
	return data;
}
export function text(value: unknown, at: string): string {
	if (typeof value !== "string" || !value.trim() || /[\0\r\n]/.test(value))
		throw Error(`${at} must be a nonempty single-line string`);
	return value;
}
export function number(value: unknown, at: string, min = 0): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < min)
		throw Error(`${at} must be a finite number >= ${min}`);
	return value;
}
function bool(value: unknown, fallback = false): boolean {
	if (value === undefined) return fallback;
	if (typeof value !== "boolean") throw Error("Expected boolean");
	return value;
}
export function parseDiagnostics(value: unknown): DiagnosticCheck[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > 50)
		throw Error("diagnostics must be an array of at most 50 checks");
	const seen = new Set<string>();
	return value.map((raw) => {
		const d = object(raw, "diagnostic", [
			"id",
			"kind",
			"cwd",
			"command",
			"runtime",
			"target",
			"race",
			"artifacts",
			"requiredEnv",
			"baseline",
			"budgets",
			"maxRegressionPercent",
			"minRuns",
			"requirePhysicalDevice",
			"accountId",
			"worker",
			"expectedVersion",
			"tokenEnv",
		]);
		const id = text(d.id, "diagnostic.id");
		if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || seen.has(id))
			throw Error(`Invalid or duplicate diagnostic id: ${id}`);
		seen.add(id);
		const kind = text(d.kind, "diagnostic.kind") as DiagnosticCheck["kind"];
		if (
			![
				"bun-test",
				"go-test",
				"go-benchmark",
				"go-profile",
				"runtime-profile",
				"collector",
				"cloudflare",
			].includes(kind)
		)
			throw Error(`Unknown diagnostic kind: ${kind}`);
		const command =
			d.command === undefined
				? undefined
				: Array.isArray(d.command) && d.command.length
					? d.command.map((v) => text(v, "command"))
					: (() => {
							throw Error("command must be a nonempty argument array");
						})();
		if (kind === "collector" && !command) throw Error("collector requires a command");
		if (kind !== "collector" && command) throw Error("command is only valid for collector checks");
		const runtime =
			d.runtime === undefined
				? undefined
				: (text(d.runtime, "runtime") as DiagnosticCheck["runtime"]);
		if (runtime && !["bun", "node", "deno", "go"].includes(runtime))
			throw Error("Unsupported runtime");
		if (runtime && kind !== "collector" && kind !== "runtime-profile")
			throw Error("Only collector/runtime-profile checks accept a runtime override");
		const target = d.target === undefined ? undefined : text(d.target, "target");
		if (target && (!/^\.\/(?:[\w./-]+)?$/.test(target) || target.split("/").includes("..")))
			throw Error("target must be a local ./package or ./... pattern");
		if (target && !kind.startsWith("go-") && kind !== "runtime-profile")
			throw Error("target is only supported for Go or runtime-profile checks");
		if (d.artifacts !== undefined && !Array.isArray(d.artifacts))
			throw Error("artifacts must be an array");
		const artifacts = ((d.artifacts ?? []) as unknown[]).map((v) => {
			const a = object(v, "artifact", ["path", "format"]);
			const format = text(a.format, "artifact.format") as ArtifactFormat;
			if (!FORMATS.includes(format)) throw Error("Unknown artifact format");
			return { path: repoPath(text(a.path, "artifact.path")), format };
		});
		if (
			new Set(artifacts.map((a) => a.path)).size !== artifacts.length ||
			artifacts.some(
				(a) =>
					!a.path ||
					/^(command\.log|runtime\.json|receipt\.json|baseline\.json|evidence-)/.test(a.path),
			)
		)
			throw Error("Duplicate, empty or reserved artifact path");
		if (artifacts.filter((a) => a.format === "performance").length > 1)
			throw Error("Use separate checks for separate performance captures");
		if (kind === "collector" && !artifacts.length)
			throw Error("collector requires inspectable artifacts");
		if (artifacts.length && kind !== "collector")
			throw Error("artifacts are only configurable for collectors");
		if (d.requiredEnv !== undefined && !Array.isArray(d.requiredEnv))
			throw Error("requiredEnv must be an array");
		const requiredEnv = ((d.requiredEnv ?? []) as unknown[]).map((v) => text(v, "requiredEnv"));
		const tokenEnv =
			d.tokenEnv === undefined ? "CLOUDFLARE_API_TOKEN" : text(d.tokenEnv, "tokenEnv");
		if ([...requiredEnv, tokenEnv].some((v) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)))
			throw Error("Use environment variable names, never credentials");
		const budgets = Object.fromEntries(
			Object.entries(object(d.budgets ?? {}, "budgets")).map(([k, v]) => [
				k,
				number(v, `budget ${k}`),
			]),
		);
		const minRuns = number(d.minRuns ?? 3, "minRuns", 3);
		if (!Number.isInteger(minRuns) || minRuns > 10000)
			throw Error("minRuns must be an integer from 3 to 10000");
		if (kind === "runtime-profile" && (!target || !["bun", "node"].includes(runtime ?? "")))
			throw Error("runtime-profile requires runtime bun/node and a local script target");
		if (kind === "go-profile" && (!target || target.includes("...")))
			throw Error("go-profile requires one explicit local package target");
		const check: DiagnosticCheck = {
			id,
			kind,
			cwd: repoPath(d.cwd === undefined || d.cwd === "" ? "" : text(d.cwd, "cwd")),
			command,
			runtime,
			target,
			race: bool(d.race),
			artifacts,
			requiredEnv,
			budgets,
			minRuns,
			requirePhysicalDevice: bool(d.requirePhysicalDevice, true),
			tokenEnv,
		};
		if (d.baseline !== undefined) check.baseline = repoPath(text(d.baseline, "baseline"));
		if (d.maxRegressionPercent !== undefined)
			check.maxRegressionPercent = number(d.maxRegressionPercent, "maxRegressionPercent");
		for (const k of ["accountId", "worker", "expectedVersion"] as const)
			if (d[k] !== undefined) check[k] = text(d[k], k);
		if (kind === "cloudflare" && (!check.accountId || !check.worker || !check.expectedVersion))
			throw Error("cloudflare requires accountId, worker and expectedVersion");
		if (check.race && kind !== "go-test") throw Error("race is only supported for go-test");
		if (
			(Object.keys(budgets).length || check.baseline || check.maxRegressionPercent !== undefined) &&
			!artifacts.some((a) => a.format === "performance")
		)
			throw Error("Performance budgets/baselines require a performance artifact");
		if (check.maxRegressionPercent !== undefined && !check.baseline)
			throw Error("maxRegressionPercent requires a baseline");
		return check;
	});
}
