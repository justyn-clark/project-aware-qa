/**
 * Verification orchestration (Phase 6 + 7).
 *
 * Runs the safe-check ladder — registry validation, install check, typecheck, lint,
 * tests, targeted route probes, screenshots — honouring brakes (install + full test run
 * + screenshots are opt-in). Every executed command writes a full log under
 * `.qa/findings/` and every result carries either evidence or a skip reason, so the
 * report can never claim "done" without backing.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { detectPlaywright } from "../detectors/playwright.js";
import { readRegistry, writeArtifact } from "../io.js";
import { validateRegistry } from "../registry/schema.js";
import { clearFileCache, walkRepo } from "../scanner/files.js";
import { scanPackages } from "../scanner/package.js";
import type { ProjectInfo, SurfaceRegistry } from "../types.js";
import {
	packageManagerInstall,
	packageManagerRun,
	type RunResult,
	runCommand,
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
}

export interface VerifyOptions {
	root: string;
	scope?: string;
	/** Lift the install brake and run `<pm> install`. */
	runInstall?: boolean;
	/** Lift the long-running-tests brake. */
	runTests?: boolean;
	/** Lift the screenshot brake (needs a running app). */
	runScreenshots?: boolean;
	/** Start the project's dev server before screenshots, then stop it. */
	startDevServer?: boolean;
	baseUrl?: string;
	maxRoutes?: number;
	timeoutMs?: number;
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
}

function saveLog(root: string, id: string, run: RunResult): string {
	const body =
		`$ ${run.command}\n(cwd: ${run.cwd})\n` +
		`exit: ${run.exitCode}  duration: ${run.durationMs}ms  timedOut: ${run.timedOut}\n\n` +
		`--- stdout ---\n${run.stdout}\n\n--- stderr ---\n${run.stderr}\n`;
	writeArtifact(root, `findings/${id}.log`, body);
	return `findings/${id}.log`;
}

function checkFromRun(id: string, title: string, run: RunResult, root: string): CheckResult {
	const evidencePath = saveLog(root, id, run);
	const ok = run.exitCode === 0 && !run.timedOut;
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
			: ok
				? "exit 0"
				: `exit ${run.exitCode}: ${tail(run.stderr || run.stdout, 4).slice(0, 200)}`,
		evidencePath,
	};
}

export async function runVerification(options: VerifyOptions): Promise<VerifyResult> {
	const root = options.root;
	const generatedAt = new Date().toISOString();
	// The file-content cache is process-global and survives across commands in a long-lived
	// Pi session; clear it so verify never reads a package.json/config stale from an earlier scan.
	clearFileCache();
	const repo = walkRepo(root, { maxFiles: 8000 });
	const { project } = scanPackages(repo);
	const playwright = detectPlaywright(repo);
	const registry = readRegistry(root);
	const checks: CheckResult[] = [];
	const pm = project.packageManager;
	const timeoutMs = options.timeoutMs;

	// 1. Registry validation.
	if (!registry) {
		checks.push({
			id: "registry",
			title: "Surface registry present & valid",
			status: "skipped",
			reason: "No .qa/surface-registry.json — run /qa-scan first",
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

	// 2. Install check (gated brake).
	const nmPresent = existsSync(`${root.replace(/\/$/, "")}/node_modules`);
	if (nmPresent) {
		checks.push({
			id: "install",
			title: "Dependencies installed",
			status: "passed",
			summary: "node_modules present",
		});
	} else if (options.runInstall) {
		const { command, args } = packageManagerInstall(pm);
		const run = await runCommand(command, args, { cwd: root, timeoutMs: timeoutMs ?? 600_000 });
		checks.push(checkFromRun("install", `Install dependencies (${pm})`, run, root));
	} else {
		const { command, args } = packageManagerInstall(pm);
		checks.push({
			id: "install",
			title: "Dependencies installed",
			status: "skipped",
			reason: `node_modules absent — install is gated. Re-run with install enabled to execute \`${command} ${args.join(" ")}\`.`,
		});
	}
	const depsReady = checks.find((c) => c.id === "install")?.status === "passed";

	// 3. Typecheck.
	await runScriptCheck(
		"typecheck",
		"Type check",
		project.checks.typecheck,
		depsReady,
		pm,
		root,
		checks,
		timeoutMs ?? 240_000,
	);
	// 4. Lint.
	await runScriptCheck(
		"lint",
		"Lint",
		project.checks.lint,
		depsReady,
		pm,
		root,
		checks,
		timeoutMs ?? 240_000,
	);

	// 5. Tests (gated brake — long running).
	if (!project.checks.test) {
		checks.push({
			id: "test",
			title: "Existing tests",
			status: "skipped",
			reason: "No test script found in package.json",
		});
	} else if (!depsReady) {
		checks.push({
			id: "test",
			title: "Existing tests",
			status: "skipped",
			reason: "Dependencies not installed (install gated)",
		});
	} else if (!options.runTests) {
		checks.push({
			id: "test",
			title: "Existing tests",
			status: "skipped",
			reason: `Full test run is gated (can be long). Re-run with tests enabled to execute \`${pm} run ${project.checks.test}\`.`,
		});
	} else {
		const { command, args } = packageManagerRun(pm, project.checks.test);
		const run = await runCommand(command, args, { cwd: root, timeoutMs: timeoutMs ?? 600_000 });
		checks.push(checkFromRun("test", "Existing tests", run, root));
	}

	// 6. Targeted route probes + 7. screenshots.
	const baseUrl = resolveBaseUrl({
		explicit: options.baseUrl,
		playwrightBaseUrl: playwright.baseUrl,
		playwrightUrl: playwright.webServerUrl,
		port: playwright.webServerPort,
	});
	let probes: RouteProbe[] = [];
	let screenshots: ScreenshotResult[] = [];

	const visualSurfaces = registry
		? selectVisualRoutes(registry, { max: options.maxRoutes ?? 15, scope: options.scope })
		: [];
	const routePaths = visualSurfaces.map((s) => s.frontendRoute as string);

	if (routePaths.length === 0) {
		checks.push({
			id: "route-probe",
			title: "Targeted route checks",
			status: "skipped",
			reason: registry
				? "No renderable routes selected for this scope"
				: "No registry — run /qa-scan",
		});
	} else {
		// Calibrate first: learn whether this server's status codes can validate routes at
		// all (distinguishes real 404s) or returns a SPA catch-all (status is meaningless).
		const calibration = await calibrateServer(baseUrl, options.timeoutMs);
		probes = await probeRoutes(baseUrl, routePaths, options.timeoutMs);
		// When status is meaningful, rescue 404s that are mere normalization artifacts.
		if (calibration.mode === "distinguishes") {
			await reprobeBrokenVariants(baseUrl, probes, { timeoutMs: options.timeoutMs });
		}
		writeArtifact(
			root,
			"findings/route-probe.json",
			`${JSON.stringify({ calibration, probes }, null, 2)}\n`,
		);
		const verdict = summarizeRouteProbes(probes, baseUrl, calibration);
		checks.push({
			id: "route-probe",
			title: "Targeted route checks",
			status: verdict.status,
			summary: verdict.summary,
			reason: verdict.reason,
			evidencePath: "findings/route-probe.json",
		});
	}

	// Screenshots (gated brake).
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
				"screenshots/plan.json",
				`${JSON.stringify({ baseUrl, routes: routePaths, viewports: ["desktop", "mobile"] }, null, 2)}\n`,
			);
		}
	} else {
		// Optionally bring up the project's dev server, then tear it down afterwards.
		let devServer: ReturnType<typeof spawn> | undefined;
		let serverStarted = false;
		if (options.startDevServer && project.checks.dev) {
			const alreadyUp = await waitForServer(baseUrl, 1500, 500);
			if (!alreadyUp) {
				const { command, args } = packageManagerRun(pm, project.checks.dev);
				devServer = spawn(command, args, {
					cwd: root,
					env: { ...process.env, CI: "1" },
					detached: false,
				});
				serverStarted = await waitForServer(baseUrl, 90_000, 1500);
			} else {
				serverStarted = true;
			}
			if (!serverStarted) {
				checks.push({
					id: "dev-server",
					title: "Start dev server",
					status: "failed",
					command: packageManagerRun(pm, project.checks.dev).command,
					reason: `Dev server did not become reachable at ${baseUrl} within 90s`,
				});
			} else {
				checks.push({
					id: "dev-server",
					title: "Start dev server",
					status: "passed",
					summary: `up at ${baseUrl}`,
				});
			}
		}
		const out = await captureScreenshots({
			root,
			baseUrl,
			routes: routePaths,
			timeoutMs: timeoutMs ?? 20_000,
		});
		if (devServer) {
			try {
				devServer.kill("SIGTERM");
			} catch {
				/* best-effort */
			}
		}
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
			writeArtifact(root, "findings/screenshots.json", `${JSON.stringify(screenshots, null, 2)}\n`);
			checks.push({
				id: "screenshots",
				title: "Visual screenshots (rendered-DOM check)",
				status: verdict.status,
				summary: verdict.summary,
				reason: verdict.reason,
				evidencePath: "findings/screenshots.json",
			});
		}
	}

	return { root, generatedAt, project, registry, checks, probes, screenshots, baseUrl };
}

async function runScriptCheck(
	id: string,
	title: string,
	script: string | undefined,
	depsReady: boolean,
	pm: ProjectInfo["packageManager"],
	root: string,
	checks: CheckResult[],
	timeoutMs: number,
): Promise<void> {
	if (!script) {
		checks.push({ id, title, status: "skipped", reason: `No ${id} script found in package.json` });
		return;
	}
	if (!depsReady) {
		checks.push({
			id,
			title,
			status: "skipped",
			reason: "Dependencies not installed (install gated)",
		});
		return;
	}
	const { command, args } = packageManagerRun(pm, script);
	const run = await runCommand(command, args, { cwd: root, timeoutMs });
	checks.push(checkFromRun(id, `${title} (${script})`, run, root));
}
