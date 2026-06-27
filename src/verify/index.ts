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
import { join } from "node:path";
import { detectPlaywright } from "../detectors/playwright.js";
import { readRegistry, writeArtifact } from "../io.js";
import { validateRegistry } from "../registry/schema.js";
import { clearFileCache, walkRepo } from "../scanner/files.js";
import { scanStacks } from "../stacks/index.js";
import type { ProjectInfo, StackInfo, SurfaceRegistry } from "../types.js";
import { packageManagerInstall, type RunResult, runCommand, tail } from "./commands.js";
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
	const { project } = scanStacks(repo);
	const playwright = detectPlaywright(repo);
	const registry = readRegistry(root);
	const checks: CheckResult[] = [];
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

	// 2-5. Per-stack check ladder: deps/install → typecheck → lint → tests. Each stack runs
	// its own commands in its own subdir (monorepo-aware); brakes are honoured per stack.
	const multi = project.stacks.length > 1;
	for (const stack of project.stacks) {
		await runStackLadder(stack, { root, multi, options, timeoutMs }, checks);
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
		// Optionally bring up a dev server (the first stack that declares a `dev` command).
		let devServer: ReturnType<typeof spawn> | undefined;
		let serverStarted = false;
		const devStack = project.stacks.find((s) => s.checks.dev);
		if (options.startDevServer && devStack?.checks.dev) {
			const alreadyUp = await waitForServer(baseUrl, 1500, 500);
			if (!alreadyUp) {
				const [command, ...args] = devStack.checks.dev.command.split(/\s+/);
				devServer = spawn(command as string, args, {
					cwd: join(root, devStack.checks.dev.cwd),
					env: { ...process.env, CI: "1" },
					detached: false,
				});
				serverStarted = await waitForServer(baseUrl, 90_000, 1500);
			} else {
				serverStarted = true;
			}
			checks.push(
				serverStarted
					? {
							id: "dev-server",
							title: "Start dev server",
							status: "passed",
							summary: `up at ${baseUrl}`,
						}
					: {
							id: "dev-server",
							title: "Start dev server",
							status: "failed",
							command: devStack.checks.dev.command,
							reason: `Dev server did not become reachable at ${baseUrl} within 90s`,
						},
			);
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
		return {
			ready: existsSync(join(cwd, "node_modules")),
			install: `${command} ${args.join(" ")}`,
		};
	}
	if (pm === "mix") return { ready: existsSync(join(cwd, "deps")), install: "mix deps.get" };
	if (pm === "bundler")
		return { ready: existsSync(join(cwd, "vendor/bundle")) || true, install: "bundle install" };
	if (pm === "cargo") return { ready: true, install: "cargo fetch" };
	if (pm === "pip") return { ready: true, install: "pip install -r requirements.txt" };
	// go/gradle/maven/dotnet/etc. fetch on demand — assume ready, command captures failures.
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
): Promise<void> {
	const [bin, ...args] = command.split(/\s+/);
	const run = await runCommand(bin as string, args, { cwd: join(root, cwd), timeoutMs });
	checks.push(checkFromRun(id, title, run, root));
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
	const tag = multi ? `:${stack.adapter}${stack.rootRel ? `@${stack.rootRel}` : ""}` : "";
	const sid = (k: string) => safeId(`${k}-${stack.adapter}-${stack.rootRel || "root"}`);
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
		);
	} else {
		checks.push({
			id: sid("install"),
			title: `Dependencies${tag}`,
			status: "skipped",
			reason: install
				? `Not installed — gated. Re-run with install enabled to execute \`${install}\`.`
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
			);
		}
	}

	// Tests (gated brake — long running).
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
		);
	}
}
