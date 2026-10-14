import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import { selectChanges } from "../src/change-selection.js";
import { parseQaArgs } from "../src/cli-args.js";
import { runScan, runVerify } from "../src/core.js";
import { affectedRoots, dependencyGraph } from "../src/dependency-graph.js";
import { renderJUnit, renderSarif } from "../src/report/machine.js";
import { readTeamConfig } from "../src/team-config.js";
import { analyzeTeam, createBaseline, readOwnership } from "../src/team-insights.js";
import type { SurfaceRegistry } from "../src/types.js";
import { readVerificationSummary } from "../src/verification-record.js";

function put(root: string, path: string, value: string | object) {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value));
}
function git(root: string, ...args: string[]): string {
	return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}
function fixture(t: TestContext): string {
	const root = mkdtempSync(join(tmpdir(), "qa-team-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	put(root, "package.json", { name: "team", private: true, workspaces: ["apps/*", "packages/*"] });
	for (const app of ["web", "admin"]) {
		put(root, `apps/${app}/package.json`, {
			name: app,
			dependencies: {
				"@remix-run/react": "*",
				...(app === "web" ? { contract: "workspace:*" } : {}),
			},
		});
		put(
			root,
			`apps/${app}/app/routes/index.tsx`,
			"export default function Page() { return <main>Hello</main>; }",
		);
		put(root, `apps/${app}/helper.ts`, "export const label = 'first';");
	}
	put(root, "packages/contract/package.json", { name: "contract" });
	put(root, "packages/contract/index.ts", "export interface User { id: string }");
	put(root, ".gitignore", ".qa/\nnode_modules/\n");
	mkdirSync(join(root, "node_modules"));
	git(root, "init", "-q");
	git(root, "config", "user.email", "fixture@example.invalid");
	git(root, "config", "user.name", "Fixture");
	git(root, "add", ".");
	git(root, "commit", "-qm", "base");
	return root;
}
function scan(root: string): SurfaceRegistry {
	const result = runScan(root);
	assert.equal(result.ok, true, result.error);
	assert.ok(result.scan);
	return result.scan.registry;
}

test("shared packages select transitive consumers and helpers select service routes", (t) => {
	const root = fixture(t);
	put(root, "packages/contract/index.ts", "export interface User { id: string; name: string }");
	let registry = scan(root);
	const selection = selectChanges(root, registry, registry.project, "HEAD");
	assert.equal(selection.globalImpact, false);
	assert.deepEqual(selection.affectedRoots, ["apps/web", "packages/contract"]);
	assert.ok(
		selection.surfaceIds.some((id) =>
			registry.surfaces.find((s) => s.id === id)?.files.some((f) => f.startsWith("apps/web/")),
		),
	);
	assert.ok(
		!selection.surfaceIds.some((id) =>
			registry.surfaces.find((s) => s.id === id)?.files.some((f) => f.startsWith("apps/admin/")),
		),
	);
	put(root, "apps/web/helper.ts", "export const label = 'changed';");
	registry = scan(root);
	assert.ok(selectChanges(root, registry, registry.project, "HEAD").surfaceIds.length);
	const graph = dependencyGraph(root, registry.project);
	graph.edges.push(
		{ consumer: "apps/admin", dependency: "apps/web", source: "config" },
		{ consumer: "apps/web", dependency: "apps/admin", source: "config" },
	);
	assert.deepEqual(affectedRoots(graph, ["packages/contract"]), [
		"apps/admin",
		"apps/web",
		"packages/contract",
	]);
});

test("explicit cross-language edges and renamed/deleted inputs never under-select", (t) => {
	const root = fixture(t);
	put(root, "contracts/user.proto", "message User {}\n");
	put(root, ".project-aware-qa.json", {
		version: 1,
		dependencies: { "apps/admin": ["contracts"] },
	});
	git(root, "add", ".");
	git(root, "commit", "-qm", "explicit relationships");
	put(root, "contracts/user.proto", "message User { string id = 1; }\n");
	let registry = scan(root);
	let selection = selectChanges(root, registry, registry.project, "HEAD");
	assert.deepEqual(selection.stackRoots, ["apps/admin"]);
	renameSync(join(root, "apps/web/helper.ts"), join(root, "apps/admin/moved.ts"));
	git(root, "add", ".");
	registry = scan(root);
	selection = selectChanges(root, registry, registry.project, "HEAD");
	assert.ok(selection.changedFiles.includes("apps/web/helper.ts"));
	assert.ok(selection.changedFiles.includes("apps/admin/moved.ts"));
	rmSync(join(root, "packages/contract/package.json"));
	registry = scan(root);
	assert.equal(selectChanges(root, registry, registry.project, "HEAD").globalImpact, true);
});

test("CODEOWNERS uses precedence, overrides, directory boundaries and empty owners", (t) => {
	const root = fixture(t);
	put(root, "CODEOWNERS", "* @ignored\n");
	put(
		root,
		".github/CODEOWNERS",
		"* @default\n/apps/ @team/all\n/apps/web/ @team/web\n/apps/admin/\n!invalid @ignored\n",
	);
	const registry = scan(root);
	const ownership = readOwnership(root, registry);
	assert.equal(ownership.file, ".github/CODEOWNERS");
	assert.equal(ownership.warnings.length, 1);
	for (const surface of registry.surfaces) {
		if (surface.files.some((file) => file.startsWith("apps/web/")))
			assert.deepEqual(ownership.bySurface[surface.id], ["@team/web"]);
		if (surface.files.some((file) => file.startsWith("apps/admin/")))
			assert.deepEqual(ownership.bySurface[surface.id], []);
	}
	put(root, ".github/CODEOWNERS", "* @default\napps/* @one-level\n**/routes/*.tsx @routes\n");
	assert.ok(
		Object.values(readOwnership(root, registry).bySurface).some((owners) =>
			owners.includes("@routes"),
		),
	);
});

test("baseline comparisons preserve risk and suppressions expire without hiding findings", (t) => {
	const root = fixture(t);
	const registry = scan(root);
	const surface = registry.surfaces[0];
	assert.ok(surface);
	put(root, "qa-baseline.json", createBaseline(registry));
	surface.riskScore = 95;
	surface.risk = "high";
	surface.gaps = ["Missing permission denial assertion"];
	put(root, ".project-aware-qa.json", {
		version: 1,
		baseline: "qa-baseline.json",
		suppressions: [
			{
				surfaceId: surface.id,
				gap: surface.gaps[0],
				owner: "@team/web",
				reason: "Tracked in QA-123",
				expires: "2026-11-01",
			},
		],
	});
	const config = readTeamConfig(root);
	const active = analyzeTeam(root, registry, config, new Date("2026-11-01T23:59:59Z"));
	assert.ok(active.baseline?.worsened.includes(surface.id));
	assert.deepEqual(active.baseline?.newHighRisk, []);
	assert.equal(surface.riskScore, 95);
	const expired = analyzeTeam(root, registry, config, new Date("2026-11-02T00:00:00Z"));
	assert.equal(expired.suppressions[0]?.status, "expired");
	assert.ok(expired.baseline?.newHighRisk.includes(surface.id));
	registry.surfaces = registry.surfaces.filter((item) => item.id !== surface.id);
	assert.ok(analyzeTeam(root, registry, config).baseline?.resolved.includes(surface.id));
});

test("team config rejects typos, unsafe paths, duplicate IDs and empty requirements", (t) => {
	const root = fixture(t);
	for (const config of [
		{ version: 2 },
		{ version: 1, policy: { requiredCheck: ["test"] } },
		{ version: 1, dependencies: { "../outside": ["apps/web"] } },
		{ version: 1, policy: { requiredChecks: [""] } },
		{
			version: 1,
			suppressions: [{ surfaceId: "x", gap: "g", owner: "o", reason: "r", expires: "2026-02-30" }],
		},
		{
			version: 1,
			behaviorChecks: [
				{ id: "x", command: ["node"], surfaceIds: ["a"] },
				{ id: "x", command: ["node"], surfaceIds: ["a"] },
			],
		},
	]) {
		put(root, ".project-aware-qa.json", config);
		assert.throws(() => readTeamConfig(root));
	}
	assert.throws(() => parseQaArgs(["--require", ","], "verify"), /Invalid required check/);
});

test("configured policy cannot be weakened by default CLI values and failures refresh exports", async (t) => {
	const root = fixture(t);
	put(root, ".project-aware-qa.json", { version: 1, policy: { requiredChecks: ["test"] } });
	scan(root);
	const result = await runVerify({
		root,
		requiredChecks: [],
		failOnIncomplete: false,
		exportFormats: ["junit", "sarif"],
	});
	assert.equal(result.ok, false);
	assert.deepEqual(result.verify?.policy?.requiredChecks, ["test"]);
	put(root, "apps/web/helper.ts", "changed snapshot");
	const stale = await runVerify({ root });
	assert.equal(stale.outcome, "incomplete");
	assert.match(readFileSync(join(root, ".qa/verification.junit.xml"), "utf8"), /name="preflight"/);
	assert.ok(
		JSON.parse(
			readFileSync(join(root, ".qa/verification.sarif.json"), "utf8"),
		).runs[0].results.some((result: { ruleId: string }) => result.ruleId === "preflight"),
	);
});

test("behavior checks require opt-in and auth, redact logs, archive fresh evidence and bind mappings", async (t) => {
	const root = fixture(t);
	const surfaceId = scan(root).surfaces[0]?.id as string;
	put(
		root,
		"assert.cjs",
		"const fs = require('node:fs'); if (!process.env.QA_FIXTURE_TOKEN) process.exit(1); console.log(process.env.QA_FIXTURE_TOKEN); fs.writeFileSync('.qa/behavior-result.json', JSON.stringify({ assertions: ['authenticated response matches schema'], passed: true }));",
	);
	put(root, ".project-aware-qa.json", {
		version: 1,
		behaviorChecks: [
			{
				id: "authenticated",
				command: [process.execPath, "assert.cjs"],
				surfaceIds: [surfaceId],
				requiredEnv: ["QA_FIXTURE_TOKEN"],
				artifacts: [".qa/behavior-result.json"],
			},
		],
		policy: { requiredChecks: ["behavior-authenticated"] },
	});
	scan(root);
	const gated = await runVerify({ root });
	assert.equal(
		gated.verify?.checks.find((c) => c.id === "behavior-authenticated")?.status,
		"skipped",
	);
	assert.equal(gated.ok, false);
	const old = process.env.QA_FIXTURE_TOKEN;
	delete process.env.QA_FIXTURE_TOKEN;
	t.after(() => {
		if (old === undefined) delete process.env.QA_FIXTURE_TOKEN;
		else process.env.QA_FIXTURE_TOKEN = old;
	});
	assert.equal(
		(await runVerify({ root, runTests: true })).verify?.checks.find(
			(c) => c.id === "behavior-authenticated",
		)?.status,
		"inconclusive",
	);
	process.env.QA_FIXTURE_TOKEN = "fixture-secret-never-persist";
	const verified = await runVerify({ root, runTests: true });
	assert.equal(verified.ok, true, verified.error);
	const check = verified.verify?.checks.find((c) => c.id === "behavior-authenticated");
	assert.equal(check?.status, "passed");
	assert.deepEqual(check?.surfaceIds, [surfaceId]);
	const log = readFileSync(join(root, ".qa", check?.evidencePath as string), "utf8");
	assert.match(log, /REDACTED/);
	assert.doesNotMatch(log, /fixture-secret-never-persist/);
	assert.equal(check?.attachments?.length, 1);
	const record = JSON.parse(readFileSync(join(root, ".qa/verification.json"), "utf8"));
	assert.ok(
		record.evidence.files.some((file: { path: string }) => file.path === check?.attachments?.[0]),
	);
	assert.equal(
		readVerificationSummary(root, verified.verify?.registry as SurfaceRegistry)?.state,
		"current",
	);
	writeFileSync(join(root, ".qa", check?.attachments?.[0] as string), "changed evidence");
	assert.equal(
		readVerificationSummary(root, verified.verify?.registry as SurfaceRegistry)?.state,
		"stale",
	);
});

test("unchanged behavior output cannot count as new trace evidence", async (t) => {
	const root = fixture(t);
	const surfaceId = scan(root).surfaces[0]?.id as string;
	put(root, ".qa/trace.zip", "stale trace");
	put(root, ".project-aware-qa.json", {
		version: 1,
		behaviorChecks: [
			{
				id: "trace",
				command: [process.execPath, "-e", "process.exit(0)"],
				surfaceIds: [surfaceId],
				artifacts: [".qa/trace.zip"],
			},
		],
	});
	scan(root);
	const result = await runVerify({ root, runTests: true });
	assert.equal(
		result.verify?.checks.find((c) => c.id === "behavior-trace")?.status,
		"inconclusive",
	);
	assert.match(
		result.verify?.checks.find((c) => c.id === "behavior-trace")?.reason ?? "",
		/unchanged/,
	);
});

test("ambiguous visual services fail closed and scan can save portable baselines", async (t) => {
	const root = fixture(t);
	const scanned = runScan(root, { saveBaseline: true });
	assert.equal(scanned.ok, true, scanned.error);
	assert.ok(existsSync(join(root, ".qa/baseline.json")));
	copyFileSync(join(root, ".qa/baseline.json"), join(root, "qa-baseline.json"));
	const comparison = runScan(root, { baseline: "qa-baseline.json" });
	assert.equal(comparison.scan?.registry.team?.baseline?.new.length, 0);
	const result = await runVerify({ root });
	assert.equal(result.verify?.checks.find((c) => c.id === "route-service")?.status, "inconclusive");
	assert.equal(result.verify?.probes.length, 0);
	assert.ok(result.verify);
	const firstSurface = comparison.scan?.registry.surfaces[0];
	assert.ok(firstSurface);
	const junit = renderJUnit({
		...result.verify,
		checks: [{ id: "bad", title: "Control chars", status: "failed", reason: "a\u0000b\u001b[31m" }],
	});
	assert.ok(!junit.includes("\u0000") && !junit.includes("\u001b"));
	const sarif = JSON.parse(
		renderSarif({
			...result.verify,
			checks: [
				{
					id: "behavior-fail",
					title: "Behavior",
					status: "failed",
					surfaceIds: [firstSurface.id],
				},
			],
		}),
	);
	assert.ok(sarif.runs[0].results[0].locations.length);
});

test("affected routes are filtered before the global route limit and invalid mappings execute nothing", async (t) => {
	const root = fixture(t);
	put(root, "apps/web/helper.ts", "export const label = 'changed';");
	const registry = scan(root);
	const web = registry.surfaces.find((s) => s.files.some((file) => file.startsWith("apps/web/")));
	assert.ok(web);
	const admin = registry.surfaces.find((s) =>
		s.files.some((file) => file.startsWith("apps/admin/")),
	);
	assert.ok(admin);
	registry.surfaces = [
		...Array.from({ length: 20 }, (_, i) => ({
			...admin,
			id: `admin-${i}`,
			frontendRoute: `/admin/${i}`,
			riskScore: 100,
		})),
		{ ...web, riskScore: 0 },
	];
	put(root, ".qa/surface-registry.json", registry);
	const result = await runVerify({
		root,
		changedSince: "HEAD",
		maxRoutes: 1,
		baseUrl: "http://127.0.0.1:9",
		timeoutMs: 10,
	});
	assert.equal(result.verify?.probes.length, 1);
	assert.equal(
		result.verify?.checks.some((check) => check.id === "route-service"),
		false,
	);
	put(root, ".project-aware-qa.json", {
		version: 1,
		behaviorChecks: [
			{
				id: "bad-map",
				command: [
					process.execPath,
					"-e",
					"require('node:fs').writeFileSync('should-not-run', 'bad')",
				],
				surfaceIds: ["nonexistent"],
			},
		],
	});
	scan(root);
	const invalid = await runVerify({ root, runTests: true });
	assert.equal(invalid.ok, false);
	assert.match(invalid.error ?? "", /unknown surface/);
	assert.equal(existsSync(join(root, "should-not-run")), false);
});

test("Playwright report rejects empty, skipped, flaky and unexpected tests even with exit zero", async (t) => {
	const root = fixture(t);
	const id = scan(root).surfaces[0]?.id as string;
	for (const [stats, status] of [
		[{ expected: 1, unexpected: 0, flaky: 0, skipped: 0 }, "passed"],
		[{ expected: 0, unexpected: 0, flaky: 0, skipped: 0 }, "inconclusive"],
		[{ expected: 1, unexpected: 0, flaky: 1, skipped: 0 }, "inconclusive"],
		[{ expected: 1, unexpected: 0, flaky: 0, skipped: 1 }, "inconclusive"],
		[{ expected: 1, unexpected: 1, flaky: 0, skipped: 0 }, "failed"],
	] as const) {
		put(
			root,
			"suite.cjs",
			`require('node:fs').writeFileSync('.qa/pw.json', ${JSON.stringify(JSON.stringify({ stats, errors: [] }))});`,
		);
		put(root, ".project-aware-qa.json", {
			version: 1,
			behaviorChecks: [
				{
					id: "pw",
					command: [process.execPath, "suite.cjs"],
					surfaceIds: [id],
					playwrightReport: ".qa/pw.json",
				},
			],
		});
		scan(root);
		const result = await runVerify({ root, runTests: true });
		const check = result.verify?.checks.find((c) => c.id === "behavior-pw");
		assert.equal(check?.status, status, result.error);
		assert.deepEqual(check?.behaviorTests, stats);
		assert.equal(check?.attachments?.length, 1);
	}
});

test("suppression expiry invalidates earlier verification without source edits", async (t) => {
	const root = fixture(t);
	const registry = scan(root);
	const surface = registry.surfaces.find((s) => s.gaps.length);
	assert.ok(surface);
	const now = new Date();
	const expires = now.toISOString().slice(0, 10);
	put(root, ".project-aware-qa.json", {
		version: 1,
		suppressions: [
			{ surfaceId: surface.id, gap: surface.gaps[0], owner: "@team", reason: "temporary", expires },
		],
	});
	const current = scan(root);
	assert.equal((await runVerify({ root })).ok, true);
	assert.equal(readVerificationSummary(root, current, now)?.state, "current");
	const nextDay = new Date(now.getTime() + 86400_000);
	assert.match(
		readVerificationSummary(root, current, nextDay)?.reason ?? "",
		/suppression expired/,
	);
});
