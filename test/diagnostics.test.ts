import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { parseQaArgs, verifyFlags } from "../src/cli-args.js";
import { runScan, runVerify } from "../src/core.js";
import { inspectCloudflare } from "../src/diagnostics/cloudflare.js";
import { parseDiagnostics } from "../src/diagnostics/config.js";
import {
	parseCoverage,
	parseGoTests,
	parseJUnit,
	parseProfile,
} from "../src/diagnostics/parsers.js";
import {
	CTV_PLATFORMS,
	evaluatePerformance,
	parsePerformance,
} from "../src/diagnostics/performance.js";
import { runDiagnostics } from "../src/diagnostics/run.js";
import { walkRepo } from "../src/scanner/files.js";
import { discoverPlatforms, parseJsonConfig } from "../src/scanner/platforms.js";
import { readTeamConfig } from "../src/team-config.js";
import { captureEvidenceManifest } from "../src/verification-record.js";

function must<T>(value: T | undefined): T {
	assert.ok(value !== undefined);
	return value;
}

function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "qa-diagnostics-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", private: true }));
	return root;
}
function checks(extra: Record<string, unknown> = {}) {
	return parseDiagnostics([
		{
			id: "device",
			kind: "collector",
			command: [process.execPath, "collect.cjs"],
			artifacts: [{ path: "performance.json", format: "performance" }],
			budgets: { rssMb: 100 },
			...extra,
		},
	]);
}
function capture() {
	return {
		version: 1,
		runId: "run-a",
		sourceHash: "a".repeat(64),
		collectedAt: new Date().toISOString(),
		buildId: "build-a",
		device: {
			platform: "tizen",
			model: "legacy-2017",
			osVersion: "3.0",
			runtime: "webkit",
			runtimeVersion: "device-engine",
			kind: "physical",
			memoryMb: "1024",
		},
		scenario: {
			name: "playback",
			phase: "steady-state",
			contentId: "asset-v1",
			codec: "h264",
			resolution: "1920x1080",
			drm: "test-clear",
			network: "fixed-20mbps",
			durationMs: 60000,
			warmupMs: 10000,
			instrumentation: "collector-v1",
			sampleIntervalMs: 1000,
			cpuNormalization: "100=all-logical-cpus",
		},
		samples: [0, 1, 2].map((iteration) => ({
			iteration,
			metrics: { rssMb: 60 + iteration, jsHeapMb: 20 },
		})),
	};
}
const collector = (body: string) =>
	`const fs=require('node:fs');const path=require('node:path');const output=process.env.QA_OUTPUT_DIR;${body}`;
function writeCollector(root: string, modified = "") {
	writeFileSync(
		join(root, "collect.cjs"),
		collector(
			`const data=${JSON.stringify(capture())};data.runId=process.env.QA_RUN_ID;data.sourceHash=process.env.QA_SOURCE_HASH;data.collectedAt=new Date().toISOString();${modified}fs.writeFileSync(path.join(output,'performance.json'),JSON.stringify(data));`,
		),
	);
}

test("diagnostics configuration and CLI keep expensive work explicit", (t) => {
	const root = fixture(t);
	assert.deepEqual(readTeamConfig(root).diagnostics, []);
	const flags = verifyFlags(parseQaArgs(["--diagnostics", "--cloud"], "verify"));
	assert.equal(flags.runDiagnostics, true);
	assert.equal(flags.runCloud, true);
	for (const extra of [
		{ artifacts: [] },
		{ minRuns: 1 },
		{ budgets: { rssMb: -1 } },
		{ kind: "cloudflare" },
		{ target: "../outside" },
		{ command: [] },
		{ requiredEnv: ["a=b"] },
		{ typo: true },
	])
		assert.throws(() => checks(extra));
	assert.throws(() => parseDiagnostics([{ id: "x", kind: "go-test", command: ["sh", "-c", "x"] }]));
});

test("JUnit parser refuses empty, skipped, failed and malformed evidence", () => {
	assert.equal(
		parseJUnit('<testsuites><testsuite><testcase name="a"/></testsuite></testsuites>').status,
		"passed",
	);
	assert.equal(
		parseJUnit('<testsuite><testcase><failure message="bad">oops</failure></testcase></testsuite>')
			.status,
		"failed",
	);
	assert.equal(
		parseJUnit("<testsuite><testcase><skipped/></testcase></testsuite>").status,
		"inconclusive",
	);
	assert.throws(() => parseJUnit('<testsuite tests="10"/>'));
	assert.equal(parseJUnit("<testsuite/>").status, "inconclusive");
	assert.throws(() => parseJUnit("garbage<testsuite><testcase/></testsuite>"));
	assert.throws(() => parseJUnit("<testsuite><testcase></testsuite>"));
	assert.throws(() => parseJUnit('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///secret">]><testsuite/>'));
});

test("coverage parsers retain file measurements and reject truncated input", () => {
	const lcov = parseCoverage("SF:src/a.ts\nDA:1,1\nDA:2,0\nend_of_record\n", "lcov");
	assert.deepEqual(lcov.details, {
		unit: "lines",
		files: { "src/a.ts": { total: 2, covered: 1 } },
	});
	assert.throws(() => parseCoverage("SF:a\nDA:1,1", "lcov"));
	assert.throws(() => parseCoverage("", "lcov"));
	assert.deepEqual(
		parseCoverage("mode: atomic\nx/a.go:1.1,2.3 2 1\nx/a.go:3.1,4.4 1 0", "go-cover").details,
		{ unit: "statements", files: { "x/a.go": { total: 3, covered: 2 } } },
	);
});

test("Go event evidence detects package failures and unfinished execution", () => {
	const line = (Action: string, Test?: string) => JSON.stringify({ Action, Package: "app", Test });
	const good = [line("start"), line("run", "TestA"), line("pass", "TestA"), line("pass")].join(
		"\n",
	);
	assert.equal(parseGoTests(good).status, "passed");
	assert.equal(parseGoTests(`${good}\n${line("fail")}`).status, "failed");
	assert.equal(parseGoTests(line("start")).status, "inconclusive");
	assert.equal(parseGoTests(good, true).status, "inconclusive");
});

test("CPU and heap summaries preserve their measurement boundaries", () => {
	const profile = {
		startTime: 0,
		endTime: 50,
		nodes: [{ id: 1, callFrame: { functionName: "render" } }],
		samples: [1, 1],
		timeDeltas: [20, 30],
	};
	const parsed = parseProfile(Buffer.from(JSON.stringify(profile)), "cpu-profile");
	assert.equal(parsed.status, "inconclusive");
	assert.match(JSON.stringify(parsed.details), /sampledUs":50/);
	assert.throws(() =>
		parseProfile(Buffer.from(JSON.stringify({ ...profile, samples: [2] })), "cpu-profile"),
	);
	assert.match(
		JSON.stringify(
			parseProfile(
				Buffer.from(
					JSON.stringify({
						snapshot: { meta: { node_fields: ["type", "self_size"] } },
						nodes: [1, 20, 1, 30],
					}),
				),
				"heap-snapshot",
			).details,
		),
		/selfBytes":50/,
	);
	assert.throws(() => parseProfile(Buffer.from("{}"), "trace"));
});

test("CTV budgets distinguish measured failure, missing samples and incomparable baselines", () => {
	const current = parsePerformance(capture());
	const check = must(checks()[0]);
	assert.equal(evaluatePerformance(current, check).status, "passed");
	const bad = structuredClone(current);
	must(bad.samples[0]).metrics.rssMb = 200;
	assert.equal(evaluatePerformance(bad, check).status, "failed");
	const missing = structuredClone(current);
	delete must(missing.samples[0]).metrics.rssMb;
	assert.equal(evaluatePerformance(missing, check).status, "inconclusive");
	const emulated = structuredClone(current);
	emulated.device.kind = "emulator";
	assert.equal(evaluatePerformance(emulated, check).status, "inconclusive");
	const baseline = structuredClone(current);
	baseline.device.osVersion = "other";
	assert.equal(evaluatePerformance(current, check, baseline).status, "inconclusive");
	const short = structuredClone(current);
	short.samples.pop();
	assert.equal(evaluatePerformance(short, check).status, "inconclusive");
	assert.ok(Object.keys(CTV_PLATFORMS).length >= 15);
	const custom = structuredClone(current);
	custom.device.platform = "legacy-provider-box";
	assert.equal(parsePerformance(custom).device.platform, "legacy-provider-box");
});

test("performance comparisons require complete matching metrics and reject invalid measurements", () => {
	const current = parsePerformance(capture());
	const baseline = structuredClone(current);
	for (const row of baseline.samples) row.metrics.rssMb = 20;
	const check = must(checks({ baseline: ".qa/baseline.json", maxRegressionPercent: 5 })[0]);
	assert.equal(evaluatePerformance(current, check, baseline).status, "failed");
	baseline.scenario.sampleIntervalMs = 50;
	assert.equal(evaluatePerformance(current, check, baseline).status, "inconclusive");
	for (const mutate of [
		(x: ReturnType<typeof capture>) => x.samples.push(must(x.samples[0])),
		(x: ReturnType<typeof capture>) => (must(x.samples[0]).metrics.rssMb = NaN),
	]) {
		const input = capture();
		mutate(input);
		assert.throws(() => parsePerformance(input));
	}
});

test("fresh collector artifacts are bound to source and run and contribute to policy", async (t) => {
	const root = fixture(t);
	writeCollector(root);
	writeFileSync(
		join(root, ".project-aware-qa.json"),
		JSON.stringify({
			version: 1,
			diagnostics: checks(),
			policy: { requiredChecks: ["diagnostic-device"] },
		}),
	);
	const scanned = runScan(root);
	assert.equal(scanned.ok, true, scanned.error);
	const result = await runVerify({ root, runDiagnostics: true });
	assert.equal(
		result.verify?.checks.find((c) => c.id === "diagnostic-device")?.status,
		"passed",
		JSON.stringify(result),
	);
	const check = must(must(result.verify).checks.find((c) => c.id === "diagnostic-device"));
	assert.ok(check.evidencePath);
	assert.ok(check.attachments?.length);
	const receipt = JSON.parse(readFileSync(join(root, ".qa", check.evidencePath), "utf8"));
	assert.equal(receipt.status, "passed");
	assert.ok(receipt.source.inputHash);
	assert.ok(receipt.artifacts.every((a: { sha256: string }) => a.sha256.length === 64));
	assert.deepEqual(captureEvidenceManifest(root, must(result.verify)).issues, []);
});

test("diagnostic brakes and source/run mismatches cannot pass", async (t) => {
	const root = fixture(t);
	writeCollector(root, "data.runId='old-run';");
	assert.equal((await runDiagnostics(checks(), { root }))[0]?.status, "skipped");
	const result = must((await runDiagnostics(checks(), { root, runDiagnostics: true }))[0]);
	assert.equal(result.status, "inconclusive");
	assert.match(result.reason ?? "", /another run/);
	assert.equal(
		(await runDiagnostics(checks(), { root, runDiagnostics: true, scope: "admin" }))[0]?.status,
		"inconclusive",
	);
});

test("missing, escaping, credential-bearing artifacts and changed source are rejected", async (t) => {
	const root = fixture(t);
	writeCollector(root);
	const key = "QA_TEST_DIAGNOSTIC_SECRET";
	process.env[key] = "secret-for-diagnostics-fixture";
	t.after(() => delete process.env[key]);
	writeFileSync(
		join(root, "collect.cjs"),
		collector("fs.writeFileSync(path.join(output,'x'),process.env.QA_TEST_DIAGNOSTIC_SECRET);"),
	);
	let result = must(
		(
			await runDiagnostics(
				checks({
					requiredEnv: [key],
					budgets: {},
					artifacts: [{ path: "x", format: "opaque-profile" }],
				}),
				{ root, runDiagnostics: true },
			)
		)[0],
	);
	assert.equal(result.status, "inconclusive");
	assert.match(result.reason ?? "", /credential/);
	assert.ok(!JSON.stringify(result).includes(must(process.env[key])));
	writeFileSync(
		join(root, "collect.cjs"),
		collector("fs.symlinkSync(path.join(process.cwd(),'package.json'),path.join(output,'x'));"),
	);
	result = must(
		(
			await runDiagnostics(
				checks({ budgets: {}, artifacts: [{ path: "x", format: "opaque-profile" }] }),
				{ root, runDiagnostics: true },
			)
		)[0],
	);
	assert.match(result.reason ?? "", /leaves project root/);
	writeCollector(root, "fs.writeFileSync('new-source.ts','changed');");
	result = must((await runDiagnostics(checks(), { root, runDiagnostics: true }))[0]);
	assert.match(result.reason ?? "", /Source changed/);
});

test("collector cwd and QA symlink escapes are rejected", async (t) => {
	const root = fixture(t);
	const outside = fixture(t);
	symlinkSync(outside, join(root, "external"));
	assert.match(
		(await runDiagnostics(checks({ cwd: "external" }), { root, runDiagnostics: true }))[0]
			?.reason ?? "",
		/cwd leaves/,
	);
	symlinkSync(outside, join(root, ".qa"));
	assert.match(
		(await runDiagnostics(checks(), { root, runDiagnostics: true }))[0]?.reason ?? "",
		/QA directory leaves/,
	);
});

test("collector cancellation stops execution and is not a pass", async (t) => {
	const root = fixture(t);
	writeFileSync(join(root, "collect.cjs"), "setInterval(()=>{},1000)");
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 100);
	await assert.rejects(
		() => runDiagnostics(checks(), { root, runDiagnostics: true, signal: controller.signal }),
		/abort/i,
	);
});

test("Cloudflare inspection uses fixed-origin GET and verifies all traffic", async (t) => {
	process.env.QA_CF_TEST_TOKEN = "cf-fixture-token";
	t.after(() => delete process.env.QA_CF_TEST_TOKEN);
	const check = must(
		parseDiagnostics([
			{
				id: "cf",
				kind: "cloudflare",
				accountId: "account",
				worker: "worker",
				expectedVersion: "v2",
				tokenEnv: "QA_CF_TEST_TOKEN",
			},
		])[0],
	);
	let method = "";
	const fake = async (url: unknown, init?: RequestInit) => {
		assert.match(String(url), /^https:\/\/api.cloudflare.com\/client\/v4\/accounts\/account/);
		method = init?.method ?? "";
		return new Response(
			JSON.stringify({
				success: true,
				result: {
					deployments: [{ id: "deploy", versions: [{ version_id: "v2", percentage: 100 }] }],
				},
			}),
		);
	};
	const result = await inspectCloudflare(check, new AbortController().signal, fake as typeof fetch);
	assert.equal(method, "GET");
	assert.equal(result.status, "passed");
	assert.ok(!JSON.stringify(result).includes("cf-fixture-token"));
	const split = async () =>
		new Response(
			JSON.stringify({
				success: true,
				result: {
					deployments: [
						{
							id: "deploy",
							versions: [
								{ version_id: "v2", percentage: 50 },
								{ version_id: "v1", percentage: 50 },
							],
						},
					],
				},
			}),
		);
	assert.equal(
		(await inspectCloudflare(check, new AbortController().signal, split as typeof fetch)).status,
		"failed",
	);
	const root = fixture(t);
	assert.equal(
		(await runDiagnostics([check], { root, runDiagnostics: true }))[0]?.status,
		"skipped",
	);
});

test("platform scan distinguishes Bun package manager and runtime and excludes secret values", (t) => {
	const root = fixture(t);
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({ packageManager: "bun@1.3.0", scripts: { start: "node app.js" } }),
	);
	writeFileSync(
		join(root, "wrangler.jsonc"),
		`{// example\n"vars":{"SECRET":"never-print-this"},"d1_databases":[{"binding":"DB","database_id":"secret-id"}],"env":{"staging":{"r2_buckets":[{"binding":"ASSETS","bucket_name":"private-bucket"}]}},}`,
	);
	writeFileSync(join(root, "main.tf"), 'provider "aws" {}');
	writeFileSync(join(root, "main.bicep"), "");
	writeFileSync(join(root, "cloudbuild.yaml"), "steps: []");
	const data = discoverPlatforms(walkRepo(root));
	assert.ok(data.runtimes.some((r) => r.runtime === "bun" && r.role === "package-manager"));
	assert.ok(data.runtimes.some((r) => r.runtime === "node" && r.role === "script"));
	assert.deepEqual(
		data.infrastructure
			.filter((i) => i.provider === "cloudflare")
			.flatMap((i) => i.resources.map((r) => r.name)),
		["DB", "ASSETS"],
	);
	assert.ok(!JSON.stringify(data).includes("never-print-this"));
	assert.ok(!JSON.stringify(data).includes("secret-id"));
	assert.ok(data.infrastructure.some((i) => i.provider === "azure"));
	assert.deepEqual(parseJsonConfig('{"url":"https://example.test/x,}", /* comment */ "a":1,}'), {
		url: "https://example.test/x,}",
		a: 1,
	});
});

test("profile presets require explicit bounded targets and identify Node allocation profiles", () => {
	assert.throws(() =>
		parseDiagnostics([
			{ id: "profile", kind: "runtime-profile", runtime: "deno", target: "./app.ts" },
		]),
	);
	assert.throws(() => parseDiagnostics([{ id: "profile", kind: "go-profile", target: "./..." }]));
	assert.equal(
		parseDiagnostics([
			{ id: "profile", kind: "runtime-profile", runtime: "node", target: "./app.js" },
		])[0]?.runtime,
		"node",
	);
	const p = parseProfile(
		Buffer.from(
			JSON.stringify({ head: { selfSize: 10, children: [{ selfSize: 20, children: [] }] } }),
		),
		"heap-profile",
	);
	assert.equal(p.status, "inconclusive");
	assert.match(JSON.stringify(p.details), /sampledSelfBytes":30/);
});

test("baseline-only metrics cannot silently disappear in a newer capture", () => {
	const old = parsePerformance(capture());
	const current = structuredClone(old);
	for (const row of current.samples) delete row.metrics.jsHeapMb;
	assert.equal(evaluatePerformance(current, must(checks()[0]), old).status, "inconclusive");
});

test("failed or timed-out collectors cannot be rescued by a passing artifact", async (t) => {
	const root = fixture(t);
	writeCollector(root, "process.exitCode=1;");
	assert.equal(
		(await runDiagnostics(checks(), { root, runDiagnostics: true }))[0]?.status,
		"failed",
	);
	writeFileSync(join(root, "collect.cjs"), "setInterval(()=>{},1000);");
	const result = must(
		(await runDiagnostics(checks(), { root, runDiagnostics: true, timeoutMs: 50 }))[0],
	);
	assert.equal(result.status, "failed");
	assert.ok(result.evidencePath);
});

test("Cloudflare API errors and missing deployments cannot pass", async (t) => {
	process.env.QA_CF_ERROR_TEST = "fixture";
	t.after(() => delete process.env.QA_CF_ERROR_TEST);
	const check = must(
		parseDiagnostics([
			{
				id: "cf",
				kind: "cloudflare",
				accountId: "a",
				worker: "w",
				expectedVersion: "v",
				tokenEnv: "QA_CF_ERROR_TEST",
			},
		])[0],
	);
	for (const body of [
		{ success: false, result: {} },
		{ success: true, result: { deployments: [] } },
		{
			success: true,
			result: { deployments: [{ id: "d", versions: [{ version_id: "v", percentage: 101 }] }] },
		},
	]) {
		await assert.rejects(() =>
			inspectCloudflare(
				check,
				new AbortController().signal,
				(async () => new Response(JSON.stringify(body))) as typeof fetch,
			),
		);
	}
	await assert.rejects(
		() =>
			inspectCloudflare(
				check,
				new AbortController().signal,
				(async () => new Response("credential-secret", { status: 403 })) as typeof fetch,
			),
		/HTTP 403/,
	);
});
