import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { qaPath, writeArtifact } from "../io.js";
import { matchesScope } from "../scope.js";
import { localInput, type TeamConfig } from "../team-config.js";
import type { SurfaceRegistry } from "../types.js";
import { runCommand } from "./commands.js";
import type { CheckResult, VerifyOptions } from "./index.js";

function stamp(root: string, path: string): string | undefined {
	try {
		const file = localInput(root, path, 64 * 1024 * 1024);
		const stat = statSync(file);
		return `${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
	} catch {
		return undefined;
	}
}

export function validateBehaviorChecks(
	root: string,
	config: TeamConfig,
	registry: SurfaceRegistry,
): void {
	for (const check of config.behaviorChecks) {
		for (const id of check.surfaceIds)
			if (!registry.surfaces.some((surface) => surface.id === id))
				throw new Error(
					`Behavior check ${check.id} references unknown surface ${id}; update its explicit mapping after scanning.`,
				);
		const cwd = realpathSync(resolve(root, check.cwd));
		if (relative(realpathSync(root), cwd).startsWith("..") || !statSync(cwd).isDirectory())
			throw new Error(`Invalid behavior check cwd: ${check.cwd}`);
	}
}

/** Run existing assertion suites with declared surface mappings. No coverage is inferred from filenames. */
export async function runBehaviorChecks(
	config: TeamConfig,
	registry: SurfaceRegistry,
	options: VerifyOptions,
	affected?: string[],
): Promise<CheckResult[]> {
	const results: CheckResult[] = [];
	const artifact = (path: string) =>
		options.artifactPrefix ? `${options.artifactPrefix}/${path}` : path;
	for (const check of config.behaviorChecks) {
		const mapped = registry.surfaces.filter((surface) => check.surfaceIds.includes(surface.id));
		if (
			!mapped.some(
				(surface) =>
					matchesScope(surface, options.scope) && (!affected || affected.includes(surface.id)),
			)
		)
			continue;
		options.signal?.throwIfAborted();
		const result: CheckResult = {
			id: `behavior-${check.id}`,
			title: `Behavior: ${check.id}`,
			status: "skipped",
			surfaceIds: check.surfaceIds,
			attachments: [],
		};
		results.push(result);
		if (!options.runTests) {
			result.reason =
				"Behavior checks require --tests; configured commands can interact with the target application.";
			continue;
		}
		const missing = check.requiredEnv.filter((name) => !process.env[name]);
		if (missing.length) {
			result.status = "inconclusive";
			result.reason = `Missing environment variables: ${missing.join(", ")}`;
			continue;
		}
		const secrets = check.requiredEnv
			.map((name) => process.env[name] as string)
			.sort((a, b) => b.length - a.length);
		const redact = (value: string) =>
			secrets.reduce((out, secret) => out.split(secret).join("[REDACTED]"), value);
		const outputs = [
			...new Set([...check.artifacts, ...(check.playwrightReport ? [check.playwrightReport] : [])]),
		];
		const previous = new Map(outputs.map((path) => [path, stamp(options.root, path)]));
		const run = await runCommand(check.command[0] as string, check.command.slice(1), {
			cwd: resolve(options.root, check.cwd),
			timeoutMs: options.timeoutMs ?? 120_000,
			signal: options.signal,
		});
		result.status = run.exitCode === 0 && !run.timedOut && !run.aborted ? "passed" : "failed";
		result.command = redact(JSON.stringify(check.command));
		result.cwd = check.cwd;
		result.exitCode = run.exitCode;
		result.durationMs = run.durationMs;
		result.summary = run.aborted
			? "cancelled"
			: run.timedOut
				? "timed out"
				: `exit ${run.exitCode}; declared mapping to ${check.surfaceIds.length} surface(s), not exhaustive coverage`;
		result.evidencePath = artifact(`findings/behavior-${check.id}.log`);
		writeArtifact(
			options.root,
			result.evidencePath,
			redact(
				`$ ${JSON.stringify(check.command)}\nexit: ${run.exitCode}\ntimedOut: ${run.timedOut}\naborted: ${run.aborted ?? false}\n--- stdout ---\n${run.stdout}\n--- stderr ---\n${run.stderr}\n`,
			),
		);
		for (const [index, path] of outputs.entries()) {
			try {
				const current = stamp(options.root, path);
				if (!current || current === previous.get(path))
					throw new Error("missing, unreadable or unchanged since before the command");
				const content = readFileSync(localInput(options.root, path, 64 * 1024 * 1024));
				if (path === check.playwrightReport) {
					const report = JSON.parse(content.toString("utf8"));
					const stats = report.stats;
					if (
						!stats ||
						!["expected", "unexpected", "flaky", "skipped"].every(
							(key) => Number.isSafeInteger(stats[key]) && stats[key] >= 0,
						) ||
						!Array.isArray(report.errors)
					)
						throw new Error("invalid Playwright JSON report");
					result.behaviorTests = {
						expected: stats.expected,
						unexpected: stats.unexpected,
						flaky: stats.flaky,
						skipped: stats.skipped,
					};
					if (stats.unexpected || report.errors.length) result.status = "failed";
					else if (result.status === "passed" && (!stats.expected || stats.flaky || stats.skipped))
						result.status = "inconclusive";
					result.summary = `${result.summary}; Playwright: ${stats.expected} expected, ${stats.unexpected} unexpected, ${stats.flaky} flaky, ${stats.skipped} skipped`;
				}
				// Never archive a declared credential. Binary traces cannot be safely rewritten.
				if (secrets.some((secret) => content.includes(Buffer.from(secret))))
					throw new Error(
						"contains a declared credential; configure the test runner to omit secrets from artifacts",
					);
				const target = artifact(`attachments/${check.id}/${index}-${basename(path)}`);
				const full = qaPath(options.root, target);
				mkdirSync(dirname(full), { recursive: true });
				writeFileSync(full, content, { flag: "wx" });
				result.attachments?.push(target);
			} catch (error) {
				if (result.status === "passed") result.status = "inconclusive";
				result.reason =
					`${result.reason ?? ""} Artifact ${path}: ${(error as Error).message}.`.trim();
			}
		}
		options.signal?.throwIfAborted();
	}
	return results;
}
