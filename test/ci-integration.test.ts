import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { parseQaArgs, verifyFlags } from "../src/cli-args.js";
import { runScan, runVerify } from "../src/core.js";
import { renderJUnit, renderSarif } from "../src/report/machine.js";
import { evaluatePolicy } from "../src/verification-policy.js";
import type { VerifyResult } from "../src/verify/index.js";

function put(root: string, path: string, content: string): void {
	mkdirSync(join(root, path, ".."), { recursive: true });
	writeFileSync(join(root, path), content);
}

function fixture(t: TestContext): string {
	const root = mkdtempSync(join(tmpdir(), "qa-ci-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	put(
		root,
		"package.json",
		JSON.stringify({ name: "team-repo", private: true, workspaces: ["apps/*", "services/*"] }),
	);
	for (const path of ["apps/web", "services/api"]) {
		put(
			root,
			`${path}/package.json`,
			JSON.stringify({
				name: path.replace("/", "-"),
				dependencies: { "@remix-run/react": "*" },
				scripts: { typecheck: 'node -e "process.exit(0)"' },
			}),
		);
		put(
			root,
			`${path}/app/routes/index.tsx`,
			`export default function ${path.includes("web") ? "Web" : "Api"}() { return <main/>; }\n`,
		);
	}
	mkdirSync(join(root, "node_modules"));
	execFileSync("git", ["init", "-q"], { cwd: root });
	execFileSync("git", ["config", "user.email", "qa@example.invalid"], { cwd: root });
	execFileSync("git", ["config", "user.name", "QA Fixture"], { cwd: root });
	execFileSync("git", ["add", "."], { cwd: root });
	execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
	return root;
}

test("change-aware verification runs only affected stacks and writes CI exports", async (t) => {
	const root = fixture(t);
	put(
		root,
		"apps/web/app/routes/index.tsx",
		"export default function Web() { return <main>changed</main>; }\n",
	);
	const scan = runScan(root);
	assert.equal(scan.ok, true, scan.error);
	const verified = await runVerify({
		root,
		changedSince: "HEAD",
		requiredChecks: ["typecheck"],
		exportFormats: ["junit", "sarif"],
	});
	assert.equal(verified.ok, true, verified.error);
	assert.deepEqual(verified.verify?.selection?.changedFiles, ["apps/web/app/routes/index.tsx"]);
	assert.deepEqual(verified.verify?.selection?.stackRoots, ["apps/web"]);
	assert.ok(verified.verify?.selection?.surfaceIds.length);
	assert.equal(verified.verify?.policy?.passed, true);
	const typechecks =
		verified.verify?.checks.filter((check) => check.id.startsWith("typecheck")) ?? [];
	assert.equal(typechecks.length, 1);
	assert.match(typechecks[0]?.title ?? "", /apps\/web/);
	assert.doesNotMatch(typechecks[0]?.title ?? "", /services\/api/);
	const junit = readFileSync(join(root, ".qa", "verification.junit.xml"), "utf8");
	assert.match(junit, /<testsuites/);
	assert.match(junit, /name="policy"/);
	const sarif = JSON.parse(readFileSync(join(root, ".qa", "verification.sarif.json"), "utf8"));
	assert.equal(sarif.version, "2.1.0");
	assert.ok(
		existsSync(
			join(
				root,
				".qa",
				"runs",
				verified.verify?.selection ? readRunId(root) : "",
				"verification.junit.xml",
			),
		),
	);
	const strict = await runVerify({
		root,
		changedSince: "HEAD",
		requiredChecks: ["test"],
	});
	assert.equal(strict.ok, false);
	assert.equal(strict.outcome, "failed");
	assert.equal(strict.verify?.policy?.passed, false);
	assert.ok(strict.verify?.policy?.violations.some((violation) => /test.*skipped/.test(violation)));
});

test("change selection rejects unsafe or missing refs before repository checks", async (t) => {
	const root = fixture(t);
	const scan = runScan(root);
	assert.equal(scan.ok, true, scan.error);
	for (const changedSince of ["--upload-pack=bad", "refs/heads/does-not-exist"]) {
		const result = await runVerify({ root, changedSince });
		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /change-selection base ref/i);
		assert.deepEqual(result.writtenFiles, []);
	}
});

test("root and unmapped shared changes conservatively select every stack", async (t) => {
	const root = fixture(t);
	put(root, "shared/contracts.ts", "export interface Contract { id: string }\n");
	const scan = runScan(root);
	assert.equal(scan.ok, true, scan.error);
	const result = await runVerify({ root, changedSince: "HEAD" });
	assert.equal(result.ok, true, result.error);
	assert.equal(result.verify?.selection?.globalImpact, true);
	assert.deepEqual(result.verify?.selection?.stackRoots, ["apps/web", "services/api"]);
	assert.equal(result.verify?.selection?.surfaceIds.length, 2);
	assert.equal(result.verify?.checks.filter((check) => check.id.startsWith("typecheck")).length, 2);
});

function readRunId(root: string): string {
	return JSON.parse(readFileSync(join(root, ".qa", "verification.json"), "utf8")).runId;
}

test("required and completeness policies turn advisory gaps into failures", () => {
	const checks = [
		{ id: "typecheck-node-root", title: "Type check", status: "passed" as const },
		{ id: "screenshots", title: "Screenshots", status: "skipped" as const },
	];
	assert.deepEqual(
		evaluatePolicy(checks, { requiredChecks: ["typecheck"], failOnIncomplete: false }),
		{
			requiredChecks: ["typecheck"],
			failOnIncomplete: false,
			passed: true,
			violations: [],
		},
	);
	const strict = evaluatePolicy(checks, {
		requiredChecks: ["typecheck", "test"],
		failOnIncomplete: true,
	});
	assert.equal(strict.passed, false);
	assert.ok(strict.violations.some((violation) => /test did not run/.test(violation)));
	assert.ok(strict.violations.some((violation) => /screenshots was skipped/.test(violation)));
});

test("JUnit and SARIF exports escape content and preserve failed/inconclusive findings", () => {
	const result = {
		root: "/repo",
		generatedAt: "2026-10-14T00:00:00.000Z",
		project: {
			root: "/repo",
			packageManager: "npm",
			frameworks: [],
			scripts: {},
			testRunners: [],
			packageJsonPaths: [],
			dependencies: {},
			stacks: [],
		},
		registry: null,
		checks: [
			{ id: "lint", title: "Lint", status: "failed", reason: "a < b & c" },
			{ id: "probe", title: "Probe", status: "inconclusive", reason: 'route "unknown"' },
		],
		probes: [],
		screenshots: [],
		baseUrl: "http://127.0.0.1:3000",
	} satisfies VerifyResult;
	const junit = renderJUnit(result);
	assert.match(junit, /a &lt; b &amp; c/);
	assert.match(junit, /<skipped message="route &quot;unknown&quot;"\/>/);
	const sarif = JSON.parse(renderSarif(result));
	assert.deepEqual(
		sarif.runs[0].results.map((finding: { level: string }) => finding.level),
		["error", "warning"],
	);
});

test("CLI parses CI controls strictly", () => {
	const flags = verifyFlags(
		parseQaArgs(
			[
				"--changed-since",
				"origin/main",
				"--require",
				"typecheck,lint,test",
				"--fail-on-incomplete",
				"--junit",
				"--sarif",
			],
			"verify",
		),
	);
	assert.equal(flags.changedSince, "origin/main");
	assert.deepEqual(flags.requiredChecks, ["typecheck", "lint", "test"]);
	assert.equal(flags.failOnIncomplete, true);
	assert.deepEqual(flags.exportFormats, ["junit", "sarif"]);
	assert.throws(
		() => verifyFlags(parseQaArgs(["--require", "typecheck,$bad"], "verify")),
		/Invalid required check/,
	);
});
