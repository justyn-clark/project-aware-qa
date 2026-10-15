/**
 * Verification orchestration (Phase 6 + 7).
 *
 * Runs the safe-check ladder - registry validation, install check, typecheck, lint,
 * tests, targeted route probes, screenshots - honouring brakes (install + full test run
 * + screenshots are opt-in). Every executed command writes a full log under its run's
 * `.qa/runs/<id>/findings/` directory and every result carries either evidence or a skip reason, so the
 * report can never claim "done" without backing.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { type ChangeSelection, selectChanges } from "../change-selection.js";
import { dependencyGraph, surfaceRoots } from "../dependency-graph.js";
import { detectPlaywright } from "../detectors/playwright.js";
import { runDiagnostics } from "../diagnostics/run.js";
import { readRegistry, writeArtifact } from "../io.js";
import { validateRegistry } from "../registry/schema.js";
import { clearFileCache, walkRepo } from "../scanner/files.js";
import { matchesScope } from "../scope.js";
import { scanStacks } from "../stacks/index.js";
import { readTeamConfig, repoPath } from "../team-config.js";
import { analyzeTeam, type TeamInsights } from "../team-insights.js";
import type { ProjectInfo, StackInfo, SurfaceRegistry } from "../types.js";
import type { PolicyEvaluation } from "../verification-policy.js";
import { runBehaviorChecks, validateBehaviorChecks } from "./behavior.js";
import {
	packageManagerInstall,
	type RunResult,
	runCommand,
	stopProcessTree,
	tail,
} from "./commands.js";
import {
	calibrateServer,
	captureScreenshots,
	probeRoutes,
	type RouteProbe,
	reprobeBrokenVariants,
	resolveBaseUrl,
	type ScreenshotResult,
	selectVisualRoutes,
	summarizeRouteProbes,
	summarizeScreenshots,
	waitForServer,
} from "./playwright.js";

export type CheckStatus = "passed" | "failed" | "skipped" | "inconclusive";

export interface CheckResult {
	id: string;
	title: string;
	status: CheckStatus;
	command?: string;
	cwd?: string;
	exitCode?: number | null;
	durationMs?: number;
	reason?: string;
	summary?: string;
	/** Path (relative to .qa) of the saved command log. */
	evidencePath?: string;
	attachments?: string[];
	surfaceIds?: string[];
	behaviorTests?: { expected: number; unexpected: number; flaky: number; skipped: number };
}

export interface VerifyOptions {
	root: string;
	/** Internal run directory relative to .qa; commands still execute in root. */
	artifactPrefix?: string;
	/** Cancel active checks and clean up any owned child processes/server. */
	signal?: AbortSignal;
	scope?: string;
	/** Lift the install brake and run `<pm> install`. */
	runInstall?: boolean;
	/** Lift the long-running-tests brake. */
	runTests?: boolean;
	runDiagnostics?: boolean;
	runCloud?: boolean;
	/** Lift the screenshot brake (needs a running app). */
	runScreenshots?: boolean;
	/** Start the project's dev server before route probes/screenshots, then stop it. */
	startDevServer?: boolean;
	baseUrl?: string;
	/** Service root for visual probes when multiple applications share route paths. */
	service?: string;
	maxRoutes?: number;
	timeoutMs?: number;
	/** Restrict checks and routes to changes since this Git ref, plus local changes. */
	changedSince?: string;
	/** Check ids or id prefixes that must run and pass. */
	requiredChecks?: string[];
	/** Promote every skipped or inconclusive check to a policy failure. */
	failOnIncomplete?: boolean;
	/** Additional CI artifacts written beside the verification record. */
	exportFormats?: Array<"junit" | "sarif">;
}

export interface VerifyResult {
	root: string;
	generatedAt: string;
	project: ProjectInfo;
	registry: SurfaceRegistry | null;
	checks: CheckResult[];
	probes: RouteProbe[];
	screenshots: ScreenshotResult[];
	baseUrl: string;
	selection?: ChangeSelection;
	policy?: PolicyEvaluation;
	team?: TeamInsights;
	runId?: string;
}

function artifactPath(prefix: string | undefined, path: string): string {
	if (prefix && (isAbsolute(prefix) || prefix.split(/[\\/]/).includes(".."))) {
		throw new Error("artifactPrefix must be a directory relative to .qa");
	}
	return prefix ? `${prefix.replace(/\/$/, "")}/${path}` : path;
}

function saveLog(root: string, id: string, run: RunResult, prefix?: string): string {
	const body =
		`$ ${run.command}\n(cwd: ${run.cwd})\n` +
		`exit: ${run.exitCode}  duration: ${run.durationMs}ms  timedOut: ${run.timedOut}  aborted: ${run.aborted ?? false}\n\n` +
		`--- stdout ---\n${run.stdout}\n\n--- stderr ---\n${run.stderr}\n`;
	const path = artifactPath(prefix, `findings/${id}.log`);
	writeArtifact(root, path, body);
	return path;
}

function checkFromRun(
	id: string,
	title: string,
	run: RunResult,
	root: string,
	prefix?: string,
): CheckResult {
	const evidencePath = saveLog(root, id, run, prefix);
	const ok = run.exitCode === 0 && !run.timedOut && !run.aborted;
	return {
		id,
		title,
		status: ok ? "passed" : "failed",
		command: run.command,
		cwd: run.cwd,
		exitCode: run.exitCode,
		durationMs: run.durationMs,
		summary: run.timedOut
			? "timed out"
			: run.aborted
				? "cancelled"
				: ok
					? "exit 0"
					: `exit ${run.exitCode}: ${tail(run.stderr || run.stdout, 4).slice(0, 200)}`,
		evidencePath,
	};
}

export async function runVerification(options: VerifyOptions): Promise<VerifyResult> {
	options.signal?.throwIfAborted();
	const root = options.root;
	const artifact = (path: string) => artifactPath(options.artifactPrefix, path);
	artifact(""); // Validate before starting commands or writing artifacts.
	const generatedAt = new Date().toISOString();
	// The file-content cache is process-global and survives across commands in a long-lived
	// Pi session; clear it so verify never reads a package.json/config stale from an earlier scan.
	clearFileCache();
	const repo = walkRepo(root, { maxFiles: 8000 });
	const { project } = scanStacks(repo);
	const playwright = detectPlaywright(repo);
	const registry = readRegistry(root);
	const checks: CheckResult[] = [];
	const timeoutMs = options.timeoutMs;
	const config = readTeamConfig(root);
	const graph = dependencyGraph(root, project, config);
	if (repo.truncated)
		throw new Error("Verification discovery was truncated; narrow the project root.");
	if (registry) validateBehaviorChecks(root, config, registry);
	const team = registry ? analyzeTeam(root, registry, config) : undefined;
	const service = options.service === undefined ? undefined : repoPath(options.service);
	if (service !== undefined && !graph.roots.includes(service))
		throw new Error(`Unknown service root: ${options.service}`);

	// 1. Registry validation.
	if (!registry) {
		checks.push({
			id: "registry",
			title: "Surface registry present & valid",
			status: "skipped",
			reason: "No .qa/surface-registry.json - run /qa-scan first",
		});
	} else {
		const { valid, errors } = validateRegistry(registry);
		checks.push({
			id: "registry",
			title: "Surface registry present & valid",
			status: valid ? "passed" : "failed",
			summary: valid
				? `${registry.surfaces.length} surfaces, schema OK`
				: `${errors.length} schema errors (e.g. ${errors[0]?.path}: ${errors[0]?.message})`,
		});
	}
	let selection: ChangeSelection | undefined;
	if (options.changedSince) {
		if (!registry) throw new Error("Change-aware verification requires a surface registry.");
		selection = selectChanges(root, registry, project, options.changedSince);
		const selectionPath = artifact("change-selection.json");
		writeArtifact(root, selectionPath, `${JSON.stringify(selection, null, 2)}\n`);
		checks.push({
			id: "change-selection",
			title: "Change-aware verification selection",
			status: "passed",
			summary: `${selection.changedFiles.length} changed files | ${selection.stackRoots.length} stacks | ${selection.surfaceIds.length} directly affected surfaces`,
			evidencePath: selectionPath,
		});
	}

	// 2-5. Per-stack check ladder: deps/install -> typecheck -> lint -> tests. Each stack runs
	// its own commands in its own subdir (monorepo-aware); brakes are honoured per stack.
	const selectedStacks = selection
		? project.stacks.filter((stack) => selection?.stackRoots.includes(stack.rootRel))
		: project.stacks;
	const multi = project.stacks.length > 1;
	for (const stack of selectedStacks) {
		await runStackLadder(stack, { root, multi, options, timeoutMs }, checks);
		options.signal?.throwIfAborted();
	}
	if (registry)
		checks.push(...(await runBehaviorChecks(config, registry, options, selection?.surfaceIds)));
	checks.push(...(await runDiagnostics(config.diagnostics ?? [], options)));
	if (team?.suppressions.some((entry) => entry.status !== "active"))
		checks.push({
			id: "suppressions",
			title: "Suppression expiry and mappings",
			status: "inconclusive",
			reason:
				"Expired or unmatched suppressions require review; see team-report.md. They were not applied.",
		});
	if (config.policy.failOnNewHighRisk)
		checks.push({
			id: "baseline",
			title: "No new unaccepted high-risk surfaces",
			status: !team?.baseline || team.baseline.newHighRisk.length ? "failed" : "passed",
			reason: !team?.baseline ? "failOnNewHighRisk requires a configured baseline" : undefined,
			summary: team?.baseline
				? `${team.baseline.newHighRisk.length} new/worsened high-risk surfaces`
				: undefined,
			surfaceIds: team?.baseline?.newHighRisk,
		});

	// 6. Targeted route probes + 7. screenshots.
	const baseUrl = resolveBaseUrl({
		explicit: options.baseUrl,
		playwrightBaseUrl: playwright.baseUrl,
		playwrightUrl: playwright.webServerUrl,
		port: playwright.webServerPort,
	});
	let probes: RouteProbe[] = [];
	let screenshots: ScreenshotResult[] = [];

	const candidates =
		registry?.surfaces.filter(
			(surface) =>
				matchesScope(surface, options.scope) &&
				(!selection || selection.surfaceIds.includes(surface.id)) &&
				(service === undefined || surfaceRoots(surface, graph.roots).includes(service)),
		) ?? [];
	const visualOwners = new Set(
		candidates
			.filter((surface) => surface.type === "visual-page")
			.flatMap((surface) => surfaceRoots(surface, graph.roots)),
	);
	const ambiguous = visualOwners.size > 1;
	if (ambiguous)
		checks.push({
			id: "route-service",
			title: "Route service selection",
			status: "inconclusive",
			reason:
				"Multiple applications selected. Specify --service <repo-relative-root> and --base-url for this visual run, or use per-service behavior checks.",
		});
	const visualSurfaces =
		registry && !ambiguous
			? selectVisualRoutes(
					{ ...registry, surfaces: candidates },
					{ max: options.maxRoutes ?? 15, scope: options.scope },
				)
			: [];
	const routePaths = visualSurfaces.map((s) => s.frontendRoute as string);
	let devServer: ReturnType<typeof spawn> | undefined;
	let devRun: RunResult | undefined;
	let devCheck: CheckResult | undefined;
	const serverLifetime = new AbortController();
	const readinessSignal = options.signal
		? AbortSignal.any([options.signal, serverLifetime.signal])
		: serverLifetime.signal;
	const serverStartedAt = Date.now();
	try {
		if (options.startDevServer && routePaths.length) {
			const readinessMs = timeoutMs ?? 90_000;
			const alreadyUp = await waitForServer(
				baseUrl,
				Math.min(readinessMs, 750),
				150,
				options.signal,
			);
			options.signal?.throwIfAborted();
			const devStack = selectedStacks.find(
				(s) => s.checks.dev && (!visualOwners.size || visualOwners.has(s.rootRel)),
			);
			const dev = devStack?.checks.dev;
			if (alreadyUp) {
				checks.push({
					id: "dev-server",
					title: "Start dev server",
					status: "passed",
					summary: `Using existing server at ${baseUrl}`,
				});
			} else if (!dev) {
				checks.push({
					id: "dev-server",
					title: "Start dev server",
					status: "skipped",
					reason: "No dev command discovered for this project",
				});
			} else {
				const [command, ...args] = dev.command.split(/\s+/);
				devRun = {
					command: dev.command,
					cwd: join(root, dev.cwd),
					exitCode: null,
					stdout: "",
					stderr: "",
					durationMs: 0,
					timedOut: false,
				};
				devServer = spawn(command as string, args, {
					cwd: devRun.cwd,
					env: { ...process.env, CI: "1" },
					detached: process.platform !== "win32",
					stdio: ["ignore", "pipe", "pipe"],
				});
				const log = devRun;
				devServer.stdout?.on("data", (chunk: Buffer) => {
					log.stdout += chunk.toString("utf8").slice(0, Math.max(0, 1_000_000 - log.stdout.length));
				});
				devServer.stderr?.on("data", (chunk: Buffer) => {
					log.stderr += chunk.toString("utf8").slice(0, Math.max(0, 1_000_000 - log.stderr.length));
				});
				devServer.once("error", (error) => {
					log.stderr += `\n${error.message}`;
					log.exitCode = 127;
					serverLifetime.abort();
				});
				devServer.once("exit", (code) => {
					log.exitCode = code;
					serverLifetime.abort();
				});
				const ready = await waitForServer(baseUrl, readinessMs, 150, readinessSignal);
				options.signal?.throwIfAborted();
				log.timedOut = !ready && !serverLifetime.signal.aborted;
				devCheck = {
					id: "dev-server",
					title: "Start dev server",
					command: dev.command,
					status: ready ? "passed" : "failed",
					summary: ready ? `up at ${baseUrl}` : undefined,
					reason: ready
						? undefined
						: `Dev server did not become reachable at ${baseUrl} within ${readinessMs}ms${log.stderr ? `: ${tail(log.stderr, 3)}` : ""}`,
					evidencePath: artifact("findings/dev-server.log"),
				};
				checks.push(devCheck);
			}
		}

		options.signal?.throwIfAborted();
		if (routePaths.length === 0) {
			checks.push({
				id: "route-probe",
				title: "Targeted route checks",
				status: "skipped",
				reason: registry
					? selection
						? "No renderable routes selected for this change/service scope"
						: "No renderable routes selected for this scope"
					: "No registry - run /qa-scan",
			});
		} else if (devCheck?.status === "failed") {
			checks.push({
				id: "route-probe",
				title: "Targeted route checks",
				status: "skipped",
				reason: "Dev server failed to start; see dev-server evidence",
			});
		} else {
			// Calibrate first: learn whether this server's status codes can validate routes at
			// all (distinguishes real 404s) or returns a SPA catch-all (status is meaningless).
			const calibration = await calibrateServer(baseUrl, options.timeoutMs, options.signal);
			probes = await probeRoutes(baseUrl, routePaths, options.timeoutMs, options.signal);
			// When status is meaningful, rescue 404s that are mere normalization artifacts.
			if (calibration.mode === "distinguishes") {
				await reprobeBrokenVariants(baseUrl, probes, {
					timeoutMs: options.timeoutMs,
					signal: options.signal,
				});
			}
			writeArtifact(
				root,
				artifact("findings/route-probe.json"),
				`${JSON.stringify({ calibration, probes }, null, 2)}\n`,
			);
			const verdict = summarizeRouteProbes(probes, baseUrl, calibration);
			checks.push({
				id: "route-probe",
				title: "Targeted route checks",
				status: verdict.status,
				summary: verdict.summary,
				reason: verdict.reason,
				evidencePath: artifact("findings/route-probe.json"),
			});
		}

		// Screenshots (gated brake).
		options.signal?.throwIfAborted();
		if (!options.runScreenshots) {
			checks.push({
				id: "screenshots",
				title: "Visual screenshots",
				status: "skipped",
				reason: "Screenshots are gated (needs a running app). Re-run with screenshots enabled.",
			});
			// Always emit the screenshot plan so the agent can capture them via the Playwright MCP.
			if (routePaths.length) {
				writeArtifact(
					root,
					artifact("screenshots/plan.json"),
					`${JSON.stringify({ baseUrl, routes: routePaths, viewports: ["desktop", "mobile"] }, null, 2)}\n`,
				);
			}
		} else if (devCheck?.status === "failed") {
			checks.push({
				id: "screenshots",
				title: "Visual screenshots",
				status: "skipped",
				reason: "Dev server failed to start; see dev-server evidence",
			});
		} else {
			const out = await captureScreenshots({
				root,
				artifactPrefix: options.artifactPrefix,
				signal: options.signal,
				baseUrl,
				routes: routePaths,
				timeoutMs: timeoutMs ?? 20_000,
			});
			screenshots = out.results;
			if (!out.available) {
				checks.push({
					id: "screenshots",
					title: "Visual screenshots",
					status: "skipped",
					reason: out.reason,
				});
			} else {
				// Verdict from the rendered DOM (authoritative for SPA/catch-all servers).
				const verdict = summarizeScreenshots(screenshots);
				writeArtifact(
					root,
					artifact("findings/screenshots.json"),
					`${JSON.stringify(screenshots, null, 2)}\n`,
				);
				checks.push({
					id: "screenshots",
					title: "Visual screenshots (rendered-DOM check)",
					status: verdict.status,
					summary: verdict.summary,
					reason: verdict.reason,
					evidencePath: artifact("findings/screenshots.json"),
				});
			}
		}
	} finally {
		serverLifetime.abort();
		if (devServer) {
			await stopProcessTree(devServer);
			devServer.stdout?.destroy();
			devServer.stderr?.destroy();
		}
		if (devRun) {
			devRun.durationMs = Date.now() - serverStartedAt;
			devRun.aborted = options.signal?.aborted ?? false;
			saveLog(root, "dev-server", devRun, options.artifactPrefix);
			if (devCheck) devCheck.durationMs = devRun.durationMs;
		}
	}
	options.signal?.throwIfAborted();
	return {
		root,
		generatedAt,
		project,
		registry,
		checks,
		probes,
		screenshots,
		baseUrl,
		selection,
		team,
	};
}

function safeId(s: string): string {
	return (
		s
			.replace(/[^a-z0-9]+/gi, "-")
			.replace(/^-+|-+$/g, "")
			.toLowerCase() || "stack"
	);
}

/** Per-stack dependency directory presence (where it's knowable) and install command. */
function stackDeps(stack: StackInfo, root: string): { ready: boolean; install?: string } {
	const cwd = join(root, stack.rootRel);
	const pm = stack.packageManager;
	if (pm === "npm" || pm === "pnpm" || pm === "yarn" || pm === "bun") {
		const { command, args } = packageManagerInstall(pm);
		let dependencyRoot = resolve(cwd);
		let ready = false;
		while (true) {
			if (existsSync(join(dependencyRoot, "node_modules"))) {
				ready = true;
				break;
			}
			if (dependencyRoot === resolve(root) || dirname(dependencyRoot) === dependencyRoot) break;
			dependencyRoot = dirname(dependencyRoot);
		}
		return {
			ready,
			install: `${command} ${args.join(" ")}`,
		};
	}
	if (pm === "mix") return { ready: existsSync(join(cwd, "deps")), install: "mix deps.get" };
	if (pm === "bundler")
		return { ready: existsSync(join(cwd, "vendor/bundle")) || true, install: "bundle install" };
	if (pm === "cargo") return { ready: true, install: "cargo fetch" };
	if (pm === "pip") return { ready: true, install: "pip install -r requirements.txt" };
	// go/gradle/maven/dotnet/etc. fetch on demand - assume ready, command captures failures.
	return { ready: true };
}

async function runCommandCheck(
	id: string,
	title: string,
	command: string,
	cwd: string,
	root: string,
	timeoutMs: number,
	checks: CheckResult[],
	prefix?: string,
	signal?: AbortSignal,
): Promise<void> {
	signal?.throwIfAborted();
	const [bin, ...args] = command.split(/\s+/);
	const run = await runCommand(bin as string, args, { cwd: join(root, cwd), timeoutMs, signal });
	checks.push(checkFromRun(id, title, run, root, prefix));
	signal?.throwIfAborted();
}

interface LadderCtx {
	root: string;
	multi: boolean;
	options: VerifyOptions;
	timeoutMs?: number;
}

/** Run install/typecheck/lint/test for one stack, honouring the brakes. */
async function runStackLadder(
	stack: StackInfo,
	ctx: LadderCtx,
	checks: CheckResult[],
): Promise<void> {
	const { root, multi, options } = ctx;
	options.signal?.throwIfAborted();
	const tag = multi ? `:${stack.adapter}${stack.rootRel ? `@${stack.rootRel}` : ""}` : "";
	// Slugs alone collapse distinct package roots such as apps/a-b and apps/a/b.
	const stackId = stack.rootRel
		? `${safeId(stack.rootRel).slice(0, 64)}-${createHash("sha256").update(stack.rootRel).digest("hex").slice(0, 16)}`
		: "root";
	const sid = (k: string) => `${safeId(`${k}-${stack.adapter}`)}-${stackId}`;
	const { ready, install } = stackDeps(stack, root);

	// Dependencies (gated brake).
	if (ready) {
		checks.push({
			id: sid("install"),
			title: `Dependencies${tag}`,
			status: "passed",
			summary: "present",
		});
	} else if (options.runInstall && install) {
		await runCommandCheck(
			sid("install"),
			`Install deps${tag}`,
			install,
			stack.rootRel,
			root,
			ctx.timeoutMs ?? 600_000,
			checks,
			options.artifactPrefix,
			options.signal,
		);
	} else {
		checks.push({
			id: sid("install"),
			title: `Dependencies${tag}`,
			status: "skipped",
			reason: install
				? `Not installed - gated. Re-run with install enabled to execute \`${install}\`.`
				: "Dependency state unknown for this stack",
		});
	}
	const depsReady = ready || checks.find((c) => c.id === sid("install"))?.status === "passed";

	// Typecheck + lint.
	for (const kind of ["typecheck", "lint"] as const) {
		const cmd = stack.checks[kind];
		const title = `${kind === "typecheck" ? "Type check" : "Lint"}${tag}`;
		if (!cmd) {
			checks.push({
				id: sid(kind),
				title,
				status: "skipped",
				reason: `No ${kind} command for this stack`,
			});
		} else if (!depsReady) {
			checks.push({
				id: sid(kind),
				title,
				status: "skipped",
				reason: "Dependencies not installed (gated)",
			});
		} else {
			await runCommandCheck(
				sid(kind),
				`${title} (${cmd.command})`,
				cmd.command,
				cmd.cwd,
				root,
				ctx.timeoutMs ?? 240_000,
				checks,
				options.artifactPrefix,
				options.signal,
			);
		}
	}

	// Tests (gated brake - long running).
	const test = stack.checks.test;
	const testTitle = `Tests${tag}`;
	if (!test) {
		checks.push({
			id: sid("test"),
			title: testTitle,
			status: "skipped",
			reason: "No test command for this stack",
		});
	} else if (!depsReady) {
		checks.push({
			id: sid("test"),
			title: testTitle,
			status: "skipped",
			reason: "Dependencies not installed (gated)",
		});
	} else if (!options.runTests) {
		checks.push({
			id: sid("test"),
			title: testTitle,
			status: "skipped",
			reason: `Full test run is gated (can be long). Re-run with tests enabled to execute \`${test.command}\`.`,
		});
	} else {
		await runCommandCheck(
			sid("test"),
			`${testTitle} (${test.command})`,
			test.command,
			test.cwd,
			root,
			ctx.timeoutMs ?? 600_000,
			checks,
			options.artifactPrefix,
			options.signal,
		);
	}
}
