import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { parseDiagnostics } from "../src/diagnostics/config.js";
import { parseJUnit, parseProfile } from "../src/diagnostics/parsers.js";
import { evaluatePerformance, parsePerformance } from "../src/diagnostics/performance.js";

test("CTV collector exercises Chromium playback, focus failures and comparable captures", {
	timeout: 90000,
}, async (t) => {
	const browserModule = process.env.QA_PLAYWRIGHT_MODULE;
	if (!browserModule)
		return t.skip(
			"Set QA_PLAYWRIGHT_MODULE to an installed Playwright entry point (browser CI job)",
		);
	const { chromium } = await import(pathToFileURL(resolve(browserModule)).href);
	const { collect } = await import(
		pathToFileURL(resolve("templates/ctv-browser-collector.mjs")).href
	);
	const html = readFileSync("test/fixtures/ctv-web/index.html", "utf8");
	const server = createServer((req, res) => {
		res.writeHead(req.url === "/missing" ? 404 : 200, { "Content-Type": "text/html" });
		res.end(html);
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	t.after(() => new Promise<void>((done) => server.close(() => done())));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const config = {
		url: `http://127.0.0.1:${address.port}`,
		name: "remote-playback",
		buildId: "fixture-a",
		readySelector: "#home",
		contentId: "canvas-stream-v1",
		codec: "raw-canvas-stream",
		drm: "none",
		network: "loopback",
		hostId: "ci-host",
		steps: [
			{ key: "ArrowRight", focus: "#play" },
			{ key: "Enter", focus: "#play" },
		],
		videoSelector: "#video",
		durationMs: 300,
		warmupMs: 100,
		timeoutMs: 10000,
		debug: true,
	};
	const check = parseDiagnostics([
		{
			id: "browser",
			kind: "collector",
			command: ["node", "collector.mjs"],
			artifacts: [{ path: "performance.json", format: "performance" }],
			requirePhysicalDevice: false,
			budgets: { startupMs: 10000 },
		},
	])[0];
	assert.ok(check);
	let baseline: ReturnType<typeof parsePerformance> | undefined;
	const variants: [string, Record<string, unknown>, number][] = [
		["success", {}, 0],
		["focus-failure", { steps: [{ key: "ArrowRight", focus: "#home", timeoutMs: 1500 }] }, 1],
		["playback-failure", { steps: [...config.steps, { key: "Escape", focus: "#play" }] }, 1],
		["http-failure", { url: `${config.url}/missing` }, 1],
		["different-build", { buildId: "fixture-b" }, 0],
	];
	for (const [name, patch, expected] of variants)
		await t.test(name, async () => {
			const out = mkdtempSync(join(tmpdir(), "qa-ctv-browser-"));
			try {
				const exitCode = await collect({ ...config, ...patch }, chromium, {
					QA_OUTPUT_DIR: out,
					QA_RUN_ID: name,
					QA_SOURCE_HASH: "a".repeat(64),
				});
				assert.equal(exitCode, expected, readFileSync(join(out, "browser-run.json"), "utf8"));
				assert.equal(
					parseJUnit(readFileSync(join(out, "junit.xml"), "utf8")).status,
					expected ? "failed" : "passed",
				);
				if (expected) {
					const errors = JSON.parse(
						readFileSync(join(out, "browser-run.json"), "utf8"),
					).errors.join(" ");
					assert.match(
						errors,
						name === "focus-failure"
							? /waitForFunction/
							: name === "playback-failure"
								? /Video is not playing/
								: /Navigation failed/,
					);
					return;
				}
				const capture = parsePerformance(
					JSON.parse(readFileSync(join(out, "performance.json"), "utf8")),
				);
				assert.equal(capture.device.kind, "desktop");
				assert.equal(evaluatePerformance(capture, check).status, "passed");
				assert.equal(
					evaluatePerformance(capture, { ...check, requirePhysicalDevice: true }).status,
					"inconclusive",
				);
				assert.equal(
					parseProfile(readFileSync(join(out, "cpu-0.cpuprofile")), "cpu-profile").status,
					"inconclusive",
				);
				assert.ok(readFileSync(join(out, "trace-0.zip")).length > 0);
				assert.ok(readFileSync(join(out, "screen-0.png")).length > 0);
				if (baseline)
					assert.equal(capture.scenario.instrumentation, baseline.scenario.instrumentation);
				baseline = capture;
			} finally {
				rmSync(out, { recursive: true, force: true });
			}
		});
});
