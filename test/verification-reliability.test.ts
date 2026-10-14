import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runCommand } from "../src/verify/commands.js";
import { runVerification } from "../src/verify/index.js";
import { waitForServer } from "../src/verify/playwright.js";

function put(root: string, path: string, content: string): void {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(join(root, path), content);
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function assertStopped(pid: number): Promise<void> {
	const deadline = Date.now() + 1500;
	while (alive(pid) && Date.now() < deadline) await delay(25);
	assert.equal(alive(pid), false, `process ${pid} should be stopped`);
}

test("command timeout kills a TERM-resistant descendant and closes inherited pipes", {
	skip: process.platform === "win32",
}, async () => {
	const worker = `process.on('SIGTERM', () => {}); console.log('worker:' + process.pid); setInterval(() => {}, 1000)`;
	const parent = `const {spawn} = require('node:child_process'); console.log('parent:' + process.pid); spawn(process.execPath, ['-e', ${JSON.stringify(worker)}], {stdio: 'inherit'}); setInterval(() => {}, 1000)`;
	const run = await runCommand(process.execPath, ["-e", parent], { cwd: tmpdir(), timeoutMs: 600 });
	const pids = [...run.stdout.matchAll(/(?:parent|worker):(\d+)/g)].map((m) => Number(m[1]));
	try {
		assert.equal(run.timedOut, true);
		assert.equal(pids.length, 2, run.stdout);
		assert.ok(run.durationMs < 5000, `cleanup must be bounded: ${run.durationMs}ms`);
		for (const pid of pids) await assertStopped(pid);
	} finally {
		for (const pid of pids) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}
	}
});

test("AbortSignal cancels a running command without claiming timeout or success", async () => {
	const controller = new AbortController();
	const abort = setTimeout(() => controller.abort(), 300);
	try {
		const run = await runCommand(
			process.execPath,
			["-e", "console.log(process.pid); setInterval(() => {}, 1000)"],
			{
				cwd: tmpdir(),
				timeoutMs: 10_000,
				signal: controller.signal,
			},
		);
		assert.equal(run.aborted, true);
		assert.equal(run.timedOut, false);
		assert.notEqual(run.exitCode, 0);
		assert.ok(run.durationMs < 3000);
		await assertStopped(Number(run.stdout.trim()));
	} finally {
		clearTimeout(abort);
	}
});

test("readiness timeout includes an HTTP request that never returns", async () => {
	const server = createServer(() => {});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	try {
		const started = Date.now();
		assert.equal(await waitForServer(`http://127.0.0.1:${address.port}`, 150, 100), false);
		assert.ok(
			Date.now() - started < 1200,
			"readiness must not use a fixed 5-second request timeout",
		);
	} finally {
		server.closeAllConnections();
		server.close();
	}
});

async function unusedPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
	return address.port;
}

function registry(root: string): void {
	put(
		root,
		".qa/surface-registry.json",
		JSON.stringify({
			schema: "project-aware-qa",
			version: "1",
			generatedAt: new Date().toISOString(),
			project: { root, packageManager: "npm", frameworks: [], scripts: {} },
			stats: {},
			surfaces: [
				{
					id: "home",
					title: "Home",
					type: "visual-page",
					frontendRoute: "/",
					risk: "low",
					riskScore: 1,
					files: [],
					riskReasons: [],
					gaps: [],
					evidence: [],
					inferredTests: [],
				},
			],
		}),
	);
}

// A target-local Playwright substitute exercises resolution and artifact paths without browser downloads.
function fakePlaywright(root: string, launchBody?: string): void {
	put(
		root,
		"node_modules/playwright/package.json",
		JSON.stringify({ name: "playwright", type: "module", main: "index.js" }),
	);
	put(
		root,
		"node_modules/playwright/index.js",
		`
		import {writeFileSync} from 'node:fs';
		export const chromium = {launch: async () => {
			${launchBody ?? ""}
			return {close: async () => {}, newPage: async () => ({
				on() {}, setDefaultTimeout() {}, close: async () => {},
				goto: async (url) => { const res = await fetch(url); return {status: () => res.status}; },
				screenshot: async ({path}) => {writeFileSync(path, 'fixture-image');},
				title: async () => 'Home', evaluate: async () => 'Welcome home'
			})};
		}};
	`,
	);
}

test("verification starts server before probing, isolates artifacts, resolves target Playwright, and stops server", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "qa-verify-runtime-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const port = await unusedPort();
	put(
		root,
		"package.json",
		JSON.stringify({ scripts: { dev: "node server.cjs", typecheck: "node check.cjs" } }),
	);
	put(root, "check.cjs", "console.log('checked ' + process.cwd())");
	put(
		root,
		"server.cjs",
		`
		const {createServer} = require('node:http'); const {writeFileSync} = require('node:fs');
		writeFileSync('server.pid', String(process.pid));
		createServer((req,res) => {res.statusCode = req.url === '/' ? 200 : 404; res.end('Home');}).listen(${port}, '127.0.0.1');
	`,
	);
	registry(root);
	fakePlaywright(root);
	const result = await runVerification({
		root,
		baseUrl: `http://127.0.0.1:${port}`,
		startDevServer: true,
		runScreenshots: true,
		artifactPrefix: "runs/test-run",
		timeoutMs: 5000,
	});
	assert.equal(result.checks.find((c) => c.id === "dev-server")?.status, "passed");
	assert.equal(result.checks.find((c) => c.id === "route-probe")?.status, "passed");
	assert.equal(result.checks.find((c) => c.id === "screenshots")?.status, "passed");
	assert.equal(result.screenshots.length, 2);
	for (const shot of result.screenshots) {
		assert.ok(shot.file);
		assert.ok(shot.file.startsWith(join(root, ".qa/runs/test-run/screenshots")));
		assert.ok(existsSync(shot.file));
	}
	for (const check of result.checks.filter((c) => c.evidencePath)) {
		assert.ok(check.evidencePath);
		assert.ok(check.evidencePath.startsWith("runs/test-run/"));
		assert.ok(existsSync(join(root, ".qa", check.evidencePath)));
	}
	const typecheck = result.checks.find((c) => c.title.startsWith("Type check"));
	assert.equal(typecheck?.cwd, root);
	assert.equal(typecheck?.status, "passed");
	assert.equal(existsSync(join(root, ".qa/findings/route-probe.json")), false);
	await assertStopped(Number(readFileSync(join(root, "server.pid"), "utf8")));
});

test("failed browser launch is recorded and an owned server is still stopped", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "qa-verify-launch-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const port = await unusedPort();
	put(root, "package.json", JSON.stringify({ scripts: { dev: "node server.cjs" } }));
	put(
		root,
		"server.cjs",
		`require('node:fs').writeFileSync('server.pid', String(process.pid)); require('node:http').createServer((req,res) => res.end('Home')).listen(${port}, '127.0.0.1')`,
	);
	registry(root);
	fakePlaywright(root, "throw new Error('Chromium fixture cannot launch');");
	const result = await runVerification({
		root,
		baseUrl: `http://127.0.0.1:${port}`,
		startDevServer: true,
		runScreenshots: true,
		timeoutMs: 5000,
	});
	assert.equal(result.checks.find((c) => c.id === "screenshots")?.status, "failed");
	assert.match(result.screenshots[0]?.error ?? "", /Chromium fixture cannot launch/);
	assert.ok(
		existsSync(join(root, ".qa/findings/screenshots.json")),
		"default artifact paths remain supported",
	);
	await assertStopped(Number(readFileSync(join(root, "server.pid"), "utf8")));
});

test("workspace checks use hoisted dependencies and write separate package logs", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "qa-verify-workspace-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	put(root, "package.json", JSON.stringify({ private: true, workspaces: ["packages/*"] }));
	mkdirSync(join(root, "node_modules"));
	for (const name of ["a", "b"]) {
		put(
			root,
			`packages/${name}/package.json`,
			JSON.stringify({ scripts: { typecheck: "node check.cjs" } }),
		);
		put(root, `packages/${name}/check.cjs`, `console.log('${name} checked');`);
	}
	const result = await runVerification({ root, artifactPrefix: "runs/workspace", timeoutMs: 5000 });
	const checks = result.checks.filter((c) => c.title.startsWith("Type check"));
	assert.equal(checks.length, 2);
	assert.ok(checks.every((c) => c.status === "passed"));
	assert.equal(new Set(checks.map((c) => c.evidencePath)).size, 2);
	for (const name of ["a", "b"]) {
		const check = checks.find((c) => c.cwd === join(root, `packages/${name}`));
		assert.ok(check?.evidencePath);
		assert.match(
			readFileSync(join(root, ".qa", check.evidencePath), "utf8"),
			new RegExp(`${name} checked`),
		);
	}
});

test("an unexpected artifact error still cleans up the owned dev server", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "qa-verify-cleanup-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const port = await unusedPort();
	put(root, "package.json", JSON.stringify({ scripts: { dev: "node server.cjs" } }));
	put(
		root,
		"server.cjs",
		`require('node:fs').writeFileSync('server.pid', String(process.pid)); require('node:http').createServer((req,res) => res.end('Home')).listen(${port}, '127.0.0.1')`,
	);
	registry(root);
	fakePlaywright(root);
	put(root, ".qa/screenshots", "file obstructing screenshot directory");
	await assert.rejects(
		runVerification({
			root,
			baseUrl: `http://127.0.0.1:${port}`,
			startDevServer: true,
			runScreenshots: true,
			timeoutMs: 5000,
		}),
		/EEXIST/,
	);
	await assertStopped(Number(readFileSync(join(root, "server.pid"), "utf8")));
	assert.ok(existsSync(join(root, ".qa/findings/dev-server.log")));
});

test("dev-server exit records failure and skips dependent probes without the readiness wait", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "qa-verify-server-error-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const port = await unusedPort();
	put(root, "package.json", JSON.stringify({ scripts: { dev: "node missing.cjs" } }));
	registry(root);
	const started = Date.now();
	const result = await runVerification({
		root,
		baseUrl: `http://127.0.0.1:${port}`,
		startDevServer: true,
		runScreenshots: true,
		timeoutMs: 5000,
	});
	assert.equal(result.checks.find((c) => c.id === "dev-server")?.status, "failed");
	assert.equal(result.checks.find((c) => c.id === "route-probe")?.status, "skipped");
	assert.equal(result.checks.find((c) => c.id === "screenshots")?.status, "skipped");
	assert.ok(Date.now() - started < 4000);
	assert.match(readFileSync(join(root, ".qa/findings/dev-server.log"), "utf8"), /missing.cjs/);
});

async function waitForFile(path: string): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!existsSync(path) && Date.now() < deadline) await delay(20);
	assert.ok(existsSync(path), `Expected fixture marker ${path}`);
}

test("verification cancellation stops active check workers and does not start the next check", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "qa-verify-cancel-command-"));
	const controller = new AbortController();
	t.after(() => {
		controller.abort();
		rmSync(root, { recursive: true, force: true });
	});
	put(
		root,
		"package.json",
		JSON.stringify({ scripts: { typecheck: "node wait.cjs", lint: "node lint.cjs" } }),
	);
	mkdirSync(join(root, "node_modules"));
	put(
		root,
		"wait.cjs",
		"require('node:fs').writeFileSync('worker.pid', String(process.pid)); setInterval(() => {}, 1000)",
	);
	put(root, "lint.cjs", "require('node:fs').writeFileSync('lint-ran', 'yes')");
	const result = runVerification({ root, signal: controller.signal, timeoutMs: 10_000 });
	await waitForFile(join(root, "worker.pid"));
	controller.abort(new Error("fixture cancelled"));
	await assert.rejects(result, /fixture cancelled/);
	await assertStopped(Number(readFileSync(join(root, "worker.pid"), "utf8")));
	assert.equal(existsSync(join(root, "lint-ran")), false);
	assert.match(
		readFileSync(join(root, ".qa/findings/typecheck-node-root.log"), "utf8"),
		/aborted: true/,
	);
});

test("verification cancellation during readiness stops the owned dev server", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "qa-verify-cancel-server-"));
	const controller = new AbortController();
	t.after(() => {
		controller.abort();
		rmSync(root, { recursive: true, force: true });
	});
	const port = await unusedPort();
	put(root, "package.json", JSON.stringify({ scripts: { dev: "node wait.cjs" } }));
	put(
		root,
		"wait.cjs",
		"require('node:fs').writeFileSync('worker.pid', String(process.pid)); setInterval(() => {}, 1000)",
	);
	registry(root);
	const result = runVerification({
		root,
		signal: controller.signal,
		startDevServer: true,
		baseUrl: `http://127.0.0.1:${port}`,
		timeoutMs: 10_000,
	});
	await waitForFile(join(root, "worker.pid"));
	const started = Date.now();
	controller.abort(new Error("fixture cancelled"));
	await assert.rejects(result, /fixture cancelled/);
	assert.ok(Date.now() - started < 2500);
	await assertStopped(Number(readFileSync(join(root, "worker.pid"), "utf8")));
	assert.match(readFileSync(join(root, ".qa/findings/dev-server.log"), "utf8"), /aborted: true/);
});

test("verification cancellation aborts active HTTP calibration instead of waiting for its timeout", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "qa-verify-cancel-http-"));
	const controller = new AbortController();
	const server = createServer(() => {});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	t.after(() => {
		controller.abort();
		server.closeAllConnections();
		server.close();
		rmSync(root, { recursive: true, force: true });
	});
	registry(root);
	const started = Date.now();
	const timer = setTimeout(() => controller.abort(new Error("fixture cancelled")), 200);
	try {
		await assert.rejects(
			runVerification({
				root,
				signal: controller.signal,
				baseUrl: `http://127.0.0.1:${address.port}`,
				timeoutMs: 10_000,
			}),
			/fixture cancelled/,
		);
		assert.ok(Date.now() - started < 1500);
	} finally {
		clearTimeout(timer);
	}
});

test("verification cancellation closes an active browser capture and owned dev server", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "qa-verify-cancel-browser-"));
	const controller = new AbortController();
	t.after(() => {
		controller.abort();
		rmSync(root, { recursive: true, force: true });
	});
	const port = await unusedPort();
	put(root, "package.json", JSON.stringify({ scripts: { dev: "node server.cjs" } }));
	put(
		root,
		"server.cjs",
		`require('node:fs').writeFileSync('server.pid', String(process.pid)); require('node:http').createServer((req,res) => res.end('Home')).listen(${port}, '127.0.0.1')`,
	);
	registry(root);
	fakePlaywright(root);
	put(
		root,
		"node_modules/playwright/index.js",
		`
		import {writeFileSync} from 'node:fs'; let cancel;
		export const chromium = {launch: async () => ({
			close: async () => {writeFileSync(${JSON.stringify(join(root, "browser-closed"))}, 'yes'); cancel?.(new Error('Browser closed'));},
			newPage: async () => ({on() {}, setDefaultTimeout() {}, close: async () => {}, goto: async () => ({status: () => 200}),
				screenshot: async () => {writeFileSync(${JSON.stringify(join(root, "capture-started"))}, 'yes'); return new Promise((resolve, reject) => {cancel = reject;});}
			})
		})};
	`,
	);
	const result = runVerification({
		root,
		signal: controller.signal,
		startDevServer: true,
		runScreenshots: true,
		baseUrl: `http://127.0.0.1:${port}`,
		timeoutMs: 10_000,
	});
	await waitForFile(join(root, "capture-started"));
	controller.abort(new Error("fixture cancelled"));
	await assert.rejects(result, /fixture cancelled/);
	assert.ok(existsSync(join(root, "browser-closed")));
	await assertStopped(Number(readFileSync(join(root, "server.pid"), "utf8")));
});

test("package roots with the same slug retain distinct stable logs in each run", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "qa-verify-log-collision-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	put(root, "package.json", JSON.stringify({ private: true, workspaces: ["apps/*", "apps/a/*"] }));
	mkdirSync(join(root, "node_modules"));
	const packages = [
		{ path: "apps/a-b", output: "FIRST" },
		{ path: "apps/a/b", output: "SECOND" },
	];
	for (const pkg of packages) {
		put(root, `${pkg.path}/package.json`, JSON.stringify({ scripts: { test: "node check.cjs" } }));
		put(root, `${pkg.path}/check.cjs`, `console.log('${pkg.output}');`);
	}
	let previousIds: string[] | undefined;
	for (const runName of ["first", "second"]) {
		const artifactPrefix = `runs/${runName}`;
		const result = await runVerification({ root, artifactPrefix, runTests: true, timeoutMs: 5000 });
		const checks = result.checks.filter((check) => check.title.startsWith("Tests"));
		assert.equal(checks.length, 2);
		assert.equal(new Set(checks.map((check) => check.id)).size, 2);
		assert.equal(new Set(checks.map((check) => check.evidencePath)).size, 2);
		const ids = checks.map((check) => check.id).sort();
		if (previousIds)
			assert.deepEqual(ids, previousIds, "check identities must remain stable across runs");
		previousIds = ids;
		for (const pkg of packages) {
			const check = checks.find((candidate) => candidate.cwd === join(root, pkg.path));
			assert.equal(check?.status, "passed");
			assert.ok(check?.evidencePath?.startsWith(`${artifactPrefix}/findings/`));
			assert.ok(check?.evidencePath);
			const log = readFileSync(join(root, ".qa", check.evidencePath), "utf8");
			assert.ok(log.includes(pkg.output));
			assert.ok(
				!log.includes(pkg.output === "FIRST" ? "SECOND" : "FIRST"),
				"another package must never overwrite this log",
			);
		}
	}
});
