import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { fingerprintProject } from "../provenance.js";
import { localInput, repoPath } from "../team-config.js";
import { runCommand } from "../verify/commands.js";
import type { CheckResult, VerifyOptions } from "../verify/index.js";
import { inspectCloudflare } from "./cloudflare.js";
import type { ArtifactFormat, DiagnosticCheck } from "./config.js";
import {
	type ParsedEvidence,
	parseCoverage,
	parseGoTests,
	parseJUnit,
	parseProfile,
} from "./parsers.js";
import { evaluatePerformance, parsePerformance } from "./performance.js";
import { PYTHON_PROFILE } from "./python.js";

function inside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return !isAbsolute(rel) && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\");
}
function readArtifact(dir: string, path: string): Buffer {
	return readFileSync(localInput(dir, path, 64 * 1024 * 1024));
}
/** Explicit presets write into a new run directory; external collectors receive the same contract. */
export async function runDiagnostics(
	checks: DiagnosticCheck[],
	options: VerifyOptions,
): Promise<CheckResult[]> {
	const results: CheckResult[] = [];
	for (const check of checks) {
		const result: CheckResult = {
			id: `diagnostic-${check.id}`,
			title: `Diagnostic: ${check.id}`,
			status: "skipped",
			attachments: [],
			cwd: check.cwd,
		};
		results.push(result);
		if (!options.runDiagnostics) {
			result.reason = "Requires --diagnostics; profiling and device collectors can be expensive.";
			continue;
		}
		if (check.kind === "cloudflare" && !options.runCloud) {
			result.reason = "Requires --cloud in addition to --diagnostics for provider API access.";
			continue;
		}
		if (options.scope || options.changedSince || options.service !== undefined) {
			result.status = "inconclusive";
			result.reason =
				"Diagnostic workloads are not surface-scoped. Run an unscoped verification to avoid silently narrowing a device or runtime scenario.";
			continue;
		}
		options.signal?.throwIfAborted();
		const secrets = [...check.requiredEnv, ...(check.kind === "cloudflare" ? [check.tokenEnv] : [])]
			.map((n) => process.env[n])
			.filter((v): v is string => Boolean(v))
			.sort((a, b) => b.length - a.length);
		const redact = (s: string) =>
			secrets.reduce((out, secret) => out.split(secret).join("[REDACTED]"), s);
		try {
			const missing = check.requiredEnv.filter((n) => !process.env[n]);
			if (missing.length) throw Error(`Missing environment variables: ${missing.join(", ")}`);
			const root = realpathSync(options.root);
			const cwd = realpathSync(resolve(root, check.cwd));
			if (!inside(root, cwd) || !statSync(cwd).isDirectory())
				throw Error("Diagnostic cwd leaves project");
			const qa = resolve(root, ".qa");
			mkdirSync(qa, { recursive: true });
			if (!inside(root, realpathSync(qa))) throw Error("QA directory leaves project");
			const prefix = repoPath(options.artifactPrefix ?? `runs/${randomUUID()}`);
			const path = `${prefix}/diagnostics/${check.id}-${randomUUID()}`;
			const dir = resolve(qa, path);
			// Verify each existing parent before creating child directories (no symlink escape).
			let parent = qa;
			for (const part of path.split("/")) {
				parent = resolve(parent, part);
				mkdirSync(parent, { recursive: true });
				if (!inside(qa, realpathSync(parent))) throw Error("Diagnostic directory leaves .qa");
			}
			const started = Date.now();
			const runId = prefix.split("/").at(-1) as string;
			const source = fingerprintProject(root);
			if (!source.complete) throw Error("Diagnostic source snapshot is incomplete");
			const baseline = check.baseline
				? parsePerformance(
						JSON.parse(readFileSync(localInput(root, check.baseline, 64 * 1024 * 1024), "utf8")),
					)
				: undefined;
			if (baseline && Date.parse(baseline.collectedAt) >= started)
				throw Error("Baseline must predate this run");
			const parsed: ParsedEvidence[] = [];
			const manifest: { path: string; sha256: string; bytes: number }[] = [];
			const attach = (name: string, bytes: Buffer) => {
				if (secrets.some((secret) => bytes.includes(Buffer.from(secret))))
					throw Error(
						"Artifact contains a declared credential; configure the collector to omit it",
					);
				const destination = resolve(dir, name);
				if (!inside(dir, destination)) throw Error("Invalid evidence path");
				mkdirSync(resolve(destination, ".."), { recursive: true });
				writeFileSync(destination, bytes, { flag: "wx" });
				const ref = `${path}/${name}`;
				result.attachments?.push(ref);
				manifest.push({
					path: ref,
					sha256: createHash("sha256").update(bytes).digest("hex"),
					bytes: bytes.length,
				});
			};
			if (check.kind === "cloudflare") {
				const signal = options.signal
					? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 30000)])
					: AbortSignal.timeout(options.timeoutMs ?? 30000);
				parsed.push(await inspectCloudflare(check, signal));
			} else {
				const runtime =
					check.kind === "bun-test"
						? "bun"
						: check.kind.startsWith("go-")
							? "go"
							: check.kind.startsWith("python-")
								? "python3"
								: check.kind === "rust-coverage"
									? "rustc"
									: check.kind === "cmake-test"
										? "ctest"
										: check.runtime;
				let runtimeIdentity: unknown = { name: "external", version: "collector-declared" };
				if (runtime) {
					const version = await runCommand(
						runtime,
						runtime === "go" || runtime === "zig" ? ["version"] : ["--version"],
						{ cwd, timeoutMs: 10000, signal: options.signal },
					);
					if (version.exitCode !== 0 || version.timedOut || version.aborted)
						throw Error(`Runtime unavailable: ${runtime}`);
					runtimeIdentity = {
						name: runtime,
						version: version.stdout.trim(),
						host: {
							platform: platform(),
							release: release(),
							arch: arch(),
							cpu: cpus()[0]?.model ?? "unknown",
						},
					};
				}
				let command = check.command ?? [];
				let artifacts = check.artifacts;
				if (check.kind === "rust-coverage") {
					command = [
						"cargo",
						"llvm-cov",
						"--offline",
						"--locked",
						"--lcov",
						"--output-path",
						`${dir}/lcov.info`,
					];
					artifacts = [{ path: "lcov.info", format: "lcov" }];
				} else if (check.kind === "cmake-test") {
					command = [
						"ctest",
						"--output-on-failure",
						"--no-tests=error",
						"--output-junit",
						`${dir}/junit.xml`,
					];
					artifacts = [{ path: "junit.xml", format: "junit" }];
				}
				if (check.kind === "python-test") {
					command = [
						"python3",
						"-B",
						"-m",
						"pytest",
						"-p",
						"no:cacheprovider",
						`--junitxml=${dir}/junit.xml`,
						check.target ?? ".",
					];
					artifacts = [{ path: "junit.xml", format: "junit" }];
				} else if (check.kind === "python-profile") {
					const entry = localInput(
						root,
						repoPath(
							relative(root, resolve(cwd, check.target as string))
								.split("\\")
								.join("/"),
						),
					);
					command = ["python3", "-B", "-c", PYTHON_PROFILE, entry, dir];
					artifacts = [{ path: "python-profile.json", format: "python-profile" }];
				}
				if (check.kind === "bun-test") {
					command = [
						"bun",
						"test",
						"--coverage",
						"--coverage-reporter=text",
						"--coverage-reporter=lcov",
						`--coverage-dir=${dir}/coverage`,
						"--reporter=junit",
						`--reporter-outfile=${dir}/junit.xml`,
					];
					artifacts = [
						{ path: "junit.xml", format: "junit" },
						{ path: "coverage/lcov.info", format: "lcov" },
					];
				} else if (check.kind === "go-test") {
					command = [
						"go",
						"test",
						"-json",
						"-count=1",
						`-coverprofile=${dir}/coverage.out`,
						...(check.race ? ["-race"] : []),
						check.target ?? "./...",
					];
					artifacts = [{ path: "coverage.out", format: "go-cover" }];
				} else if (check.kind === "go-benchmark")
					command = [
						"go",
						"test",
						"-json",
						"-run=^$",
						"-bench=.",
						"-benchmem",
						`-count=${check.minRuns}`,
						check.target ?? "./...",
					];
				if (check.kind === "runtime-profile") {
					const entry = localInput(
						root,
						repoPath(
							relative(root, resolve(cwd, check.target as string))
								.split("\\")
								.join("/"),
						),
					);
					command = [
						runtime as string,
						"--cpu-prof",
						`--cpu-prof-dir=${dir}`,
						"--cpu-prof-name=cpu.cpuprofile",
						"--heap-prof",
						`--heap-prof-dir=${dir}`,
						"--heap-prof-name=heap.json",
						entry,
					];
					artifacts = [
						{ path: "cpu.cpuprofile", format: "cpu-profile" },
						{ path: "heap.json", format: runtime === "bun" ? "heap-snapshot" : "heap-profile" },
					];
				} else if (check.kind === "go-profile") {
					command = [
						"go",
						"test",
						"-json",
						"-count=1",
						`-cpuprofile=${dir}/cpu.pprof`,
						`-memprofile=${dir}/memory.pprof`,
						`-trace=${dir}/execution.trace`,
						`-o=${dir}/test-binary`,
						check.target as string,
					];
					artifacts = [
						{ path: "cpu.pprof", format: "opaque-profile" },
						{ path: "memory.pprof", format: "opaque-profile" },
						{ path: "execution.trace", format: "opaque-profile" },
					];
				}
				const run = await runCommand(command[0] as string, command.slice(1), {
					cwd,
					timeoutMs: options.timeoutMs ?? 120000,
					signal: options.signal,
					maxBuffer: 8 * 1024 * 1024,
					env: {
						QA_OUTPUT_DIR: dir,
						QA_RUN_ID: runId,
						QA_SOURCE_HASH: source.inputHash,
						...(check.kind === "rust-coverage"
							? {
									CARGO_LLVM_COV_TARGET_DIR: `${dir}/target`,
									CARGO_LLVM_COV_BUILD_DIR: `${dir}/target`,
									CARGO_LLVM_COV_SETUP: "no",
								}
							: {}),
					},
				});
				result.command = redact(JSON.stringify(command));
				result.exitCode = run.exitCode;
				result.durationMs = run.durationMs;
				attach(
					"command.log",
					Buffer.from(redact(JSON.stringify({ ...run, command: result.command }, null, 2))),
				);
				result.evidencePath = `${path}/command.log`;
				attach("runtime.json", Buffer.from(redact(JSON.stringify(runtimeIdentity, null, 2))));
				if (run.exitCode !== 0 || run.timedOut || run.aborted) {
					result.status = "failed";
					result.reason = run.timedOut
						? "Diagnostic command timed out"
						: run.aborted
							? "Diagnostic command cancelled"
							: `Diagnostic command exited ${run.exitCode}`;
				}
				if (run.stdout.length >= 8 * 1024 * 1024 || run.stderr.length >= 8 * 1024 * 1024)
					throw Error("Diagnostic command output reached capture limit");
				if (
					check.kind === "go-test" ||
					check.kind === "go-benchmark" ||
					check.kind === "go-profile"
				)
					parsed.push(parseGoTests(run.stdout, check.kind === "go-benchmark"));
				for (const [i, artifact] of artifacts.entries()) {
					const bytes = readArtifact(dir, artifact.path);
					// Collector outputs must be files created inside this invocation's private output directory.
					const name = `evidence-${i}-${artifact.path.split("/").at(-1)}`;
					attach(name, bytes);
					let evidence: ParsedEvidence;
					if (artifact.format === "junit") evidence = parseJUnit(bytes.toString());
					else if (artifact.format === "lcov" || artifact.format === "go-cover")
						evidence = parseCoverage(bytes.toString(), artifact.format);
					else if (artifact.format === "performance") {
						const capture = parsePerformance(JSON.parse(bytes.toString()));
						if (capture.runId !== runId || capture.sourceHash !== source.inputHash)
							throw Error("Performance capture is from another run or source snapshot");
						const timestamp = Date.parse(capture.collectedAt);
						if (timestamp < started || timestamp > Date.now() + 1000)
							throw Error("Performance capture timestamp is outside this run");

						if (baseline) attach("baseline.json", Buffer.from(JSON.stringify(baseline)));
						const evaluation = evaluatePerformance(capture, check, baseline);
						evidence = {
							status: evaluation.status,
							summary: `Performance: ${capture.device.platform}/${capture.device.model}, ${capture.samples.length} repetitions; ${[...evaluation.violations, ...evaluation.reasons].join(" ") || "configured budgets passed"}`,
							details: {
								...evaluation,
								device: capture.device,
								scenario: capture.scenario,
								buildId: capture.buildId,
								sourceHash: capture.sourceHash,
							},
						};
					} else evidence = parseProfile(bytes, artifact.format as ArtifactFormat);
					parsed.push(evidence);
				}
			}
			const after = fingerprintProject(root);
			if (!after.complete || after.inputHash !== source.inputHash)
				throw Error("Source changed during diagnostics");
			if (result.status !== "failed")
				result.status = parsed.some((p) => p.status === "failed")
					? "failed"
					: !parsed.length || parsed.some((p) => p.status === "inconclusive")
						? "inconclusive"
						: "passed";
			result.summary = parsed.map((p) => p.summary).join("; ");
			const receipt = {
				version: 1,
				id: check.id,
				runId,
				source,
				startedAt: new Date(started).toISOString(),
				finishedAt: new Date().toISOString(),
				status: result.status,
				command: result.command,
				observations: parsed,
				artifacts: manifest,
			};
			const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
			if (secrets.some((s) => receiptBytes.includes(Buffer.from(s))))
				throw Error("Diagnostic receipt contains a declared credential");
			writeFileSync(resolve(dir, "receipt.json"), receiptBytes, { flag: "wx" });
			result.evidencePath = `${path}/receipt.json`;
		} catch (error) {
			if (result.status !== "failed") result.status = "inconclusive";
			result.reason = redact((error as Error).message);
		}
		options.signal?.throwIfAborted();
	}
	return results;
}
