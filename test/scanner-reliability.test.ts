import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import { scanRepo } from "../src/scanner/index.js";

function fixture(t: TestContext, files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "qa-scanner-reliability-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const [path, contents] of Object.entries(files)) {
		const target = join(root, path);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, contents);
	}
	return root;
}

const NEST_PACKAGE = JSON.stringify({ dependencies: { "@nestjs/core": "*" } });
const USERS_CONTROLLER = `
@Controller('users')
export class UsersController {
  @Post()
  create() { return {}; }
}
`;

test("Node packages keep their scripts, working directories, and inherited toolchains", (t) => {
	const root = fixture(t, {
		"package.json": JSON.stringify({
			packageManager: "pnpm@10.0.0",
			scripts: { test: "root-test" },
		}),
		"apps/web/package.json": JSON.stringify({ scripts: { lint: "web-lint" } }),
		"services/api/package.json": JSON.stringify({
			packageManager: "bun@1.0.0",
			scripts: { test: "api-test" },
		}),
		"independent/package.json": JSON.stringify({ scripts: { build: "build" } }),
		"independent/package-lock.json": "{}",
	});
	const stacks = scanRepo(root).project.stacks.filter((s) => s.adapter === "node");
	assert.equal(stacks.length, 4);
	const byRoot = new Map(stacks.map((stack) => [stack.rootRel, stack]));
	assert.deepEqual(byRoot.get("")?.checks, { test: { command: "pnpm run test", cwd: "" } });
	assert.deepEqual(byRoot.get("apps/web")?.checks, {
		lint: { command: "pnpm run lint", cwd: "apps/web" },
	});
	assert.deepEqual(byRoot.get("services/api")?.checks, {
		test: { command: "bun run test", cwd: "services/api" },
	});
	assert.deepEqual(byRoot.get("independent")?.checks, {
		build: { command: "npm run --silent build", cwd: "independent" },
	});
});

test("a discovered nested Node check executes successfully in its package", (t) => {
	const root = fixture(t, {
		"package.json": JSON.stringify({ private: true }),
		"packages/app/package.json": JSON.stringify({
			scripts: { test: 'node -e "process.stdout.write(process.cwd())"' },
		}),
	});
	const check = scanRepo(root).project.stacks.find((s) => s.adapter === "node")?.checks.test;
	assert.ok(check);
	const [command, ...args] = check.command.split(/\s+/);
	assert.ok(command);
	const result = spawnSync(command, args, {
		cwd: join(root, check.cwd),
		encoding: "utf8",
		timeout: 10000,
	});
	assert.equal(result.status, 0, result.stderr || String(result.error ?? ""));
	assert.equal(result.stdout, realpathSync(join(root, "packages/app")));
});

test("services sharing API paths have distinct flows, IDs, and related-test evidence", (t) => {
	const root = fixture(t, {
		"package.json": JSON.stringify({ scripts: { test: "root-test" } }),
		"services/a/package.json": NEST_PACKAGE,
		"services/a/users.controller.ts": USERS_CONTROLLER,
		"services/a/users.test.ts": "test.skip('users', () => {});",
		"services/b/package.json": NEST_PACKAGE,
		"services/b/users.controller.ts": USERS_CONTROLLER,
	});
	const result = scanRepo(root);
	assert.equal(result.bundle.endpoints.length, 2, "root package must not re-scan child packages");
	const endpoints = result.registry.surfaces.filter((s) => s.type === "api-endpoint");
	assert.equal(endpoints.length, 2);
	assert.equal(
		new Set(result.registry.surfaces.map((s) => s.id)).size,
		result.registry.surfaces.length,
	);
	const first = endpoints.find((s) => s.files.includes("services/a/users.controller.ts"));
	const second = endpoints.find((s) => s.files.includes("services/b/users.controller.ts"));
	assert.ok(first);
	assert.ok(second);
	assert.ok(first.inferredTests.every((inferred) => inferred.status === "unknown"));
	assert.ok(second.inferredTests.every((inferred) => inferred.status === "missing"));
	assert.equal(first.riskScore, second.riskScore, "filename matches cannot discount risk");
	assert.deepEqual(
		first.evidence.filter((e) => e.kind === "test").map((e) => e.file),
		["services/a/users.test.ts"],
	);
	assert.equal(second.evidence.filter((e) => e.kind === "test").length, 0);
	assert.equal(result.flows.length, 2);
	assert.ok(result.flows.every((flow) => flow.files.length === 1));
	assert.equal(result.registry.surfaces.filter((s) => s.type === "test-gap").length, 2);
	assert.ok(
		result.registry.surfaces.every((s) => s.inferredTests.every((i) => i.status !== "present")),
	);
});

test("matching route paths in separate frontend packages remain separate surfaces", (t) => {
	const root = fixture(t, {
		"apps/a/package.json": JSON.stringify({ dependencies: { "@remix-run/react": "*" } }),
		"apps/a/app/routes/users.tsx": "export default function Users() { return <div/>; }",
		"apps/b/package.json": JSON.stringify({ dependencies: { "@remix-run/react": "*" } }),
		"apps/b/app/routes/users.tsx": "export default function Users() { return <div/>; }",
	});
	const pages = scanRepo(root).registry.surfaces.filter((s) => s.type === "visual-page");
	assert.equal(pages.length, 2);
	assert.ok(pages.every((page) => page.frontendRoute === "/users"));
	assert.equal(new Set(pages.map((page) => page.id)).size, 2);
});

test("Python HTML forms reach the registry through real file discovery", (t) => {
	const root = fixture(t, {
		"requirements.txt": "django>=5",
		"templates/users.html": '<form method="post"><input name="email" /></form>',
	});
	const result = scanRepo(root);
	assert.ok(result.repo.files.some((f) => f.path === "templates/users.html"));
	const form = result.registry.surfaces.find((s) => s.type === "form");
	assert.ok(form);
	assert.deepEqual(form.files, ["templates/users.html"]);
	assert.match(form.evidence.find((e) => e.kind === "form")?.detail ?? "", /email/);
});

test("unrelated cache invalidation cannot prove a mutation refreshes cached data", (t) => {
	const root = fixture(t, {
		"package.json": NEST_PACKAGE,
		"users.controller.ts": USERS_CONTROLLER,
		"users.ts": "const users = useQuery({ queryKey: ['users'] });",
		"users.helpers.ts":
			"export function onManualRefresh() { client.invalidateQueries(['users']); }",
	});
	const result = scanRepo(root);
	const mutation = result.flows[0]?.mutationLinks[0];
	assert.ok(mutation);
	assert.ok(mutation.invalidations.length > 0);
	assert.equal(mutation.invalidationStatus, "unknown");
	assert.equal(mutation.hasInvalidation, false);
	assert.equal(mutation.staleRisk, true);
	const cacheRisk = result.registry.surfaces.find((s) => s.type === "cache-risk");
	assert.ok(cacheRisk);
	assert.match(cacheRisk.gaps.join(" "), /execution.*unverified/);
});

test("mutations of entities with no cache reads do not create cache risk", (t) => {
	const root = fixture(t, {
		"package.json": NEST_PACKAGE,
		"users.controller.ts": USERS_CONTROLLER,
	});
	const result = scanRepo(root);
	assert.ok(result.flows[0]?.mutationLinks.length);
	assert.equal(result.registry.surfaces.filter((s) => s.type === "cache-risk").length, 0);
});

test("generic parents neither absorb child sources nor claim their framework", (t) => {
	const root = fixture(t, {
		"requirements.txt": "pytest",
		"utility.py": "def convert(value): return value",
		"test_utility.py": "def test_convert(): pass",
		"services/web/requirements.txt": "django",
		"services/web/views.py": "from django.http import HttpResponse",
		"services/web/templates/users.html": '<form method="post"><input name="email" /></form>',
		"services/web/test_users.py": "def test_users(): pass",
	});
	const result = scanRepo(root);
	assert.deepEqual(
		result.project.stacks.map((s) => [s.adapter, s.rootRel]).sort(),
		[
			["generic", ""],
			["python", "services/web"],
		].sort(),
	);
	assert.equal(result.bundle.tests.length, 2, "test files belong to exactly one stack");
	assert.equal(result.bundle.forms.length, 1);
	const baseline = result.registry.surfaces.find((s) => s.id === "gap:python:root");
	assert.ok(baseline);
	assert.match(baseline.evidence[0]?.detail ?? "", /^2 python source files, 1 test files$/);
	assert.ok(baseline.inferredTests.every((inferred) => inferred.status === "unknown"));
	assert.ok(!baseline.riskReasons.some((reason) => reason.includes("existing tests present")));
});

test("nested deep Python services do not duplicate endpoints and flows", (t) => {
	const root = fixture(t, {
		"requirements.txt": "fastapi",
		"users.py":
			'from fastapi import FastAPI\napp = FastAPI()\n@app.post("/users")\ndef create(): pass',
		"services/api/requirements.txt": "fastapi",
		"services/api/users.py":
			'from fastapi import FastAPI\napp = FastAPI()\n@app.post("/users")\ndef create(): pass',
	});
	const result = scanRepo(root);
	assert.equal(result.project.stacks.length, 2);
	assert.equal(result.bundle.endpoints.length, 2);
	assert.equal(result.flows.length, 2);
	const endpoints = result.registry.surfaces.filter((s) => s.type === "api-endpoint");
	assert.equal(new Set(endpoints.map((s) => s.id)).size, 2);
});
