import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { runPlan } from "../src/core.js";
import { writeJsonArtifact } from "../src/io.js";
import { renderTestPlan } from "../src/report/markdown.js";
import { scanRepo } from "../src/scanner/index.js";
import { selectVisualRoutes } from "../src/verify/playwright.js";

function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "qa-scope-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({ dependencies: { "@remix-run/react": "*" } }),
	);
	mkdirSync(join(root, "app/routes"), { recursive: true });
	for (const entity of ["users", "teams"]) {
		writeFileSync(
			join(root, "app/routes", `${entity}.tsx`),
			"export default function Page() { return <div/>; }",
		);
	}
	const { registry } = scanRepo(root);
	const users = registry.surfaces.find((surface) => surface.frontendRoute === "/users");
	assert.ok(users);
	users.risk = "high";
	users.riskScore = 75;
	users.riskReasons.push("admin permission required");
	return { root, registry };
}

test("plan and route verification share risk, type, entity, and text scopes", (t) => {
	const { registry } = fixture(t);
	const cases: Array<[string, string[]]> = [
		["high", ["/users"]],
		["visual-page", ["/teams", "/users"]],
		[" UsEr ", ["/users"]],
		["/teams", ["/teams"]],
		["admin", ["/users"]],
		[" ", ["/teams", "/users"]],
		["nonexistent", []],
	];
	for (const [scope, expected] of cases) {
		const selected = selectVisualRoutes(registry, { scope });
		assert.deepEqual(selected.map((surface) => surface.frontendRoute).sort(), expected, scope);
		const plan = renderTestPlan(registry, { scope });
		if (expected.length) {
			assert.match(plan, new RegExp(`Surfaces in scope: \\*\\*${expected.length}\\*\\*`), scope);
		} else {
			assert.match(plan, /No surfaces matched scope/, scope);
		}
	}
});

test("runPlan summary counts agree with scoped plan contents", (t) => {
	const { root, registry } = fixture(t);
	writeJsonArtifact(root, "surface-registry.json", registry);
	for (const [scope, count] of [
		["high", 1],
		["visual-page", 2],
		["user", 1],
	] as const) {
		const result = runPlan(root, { scope });
		assert.equal(result.ok, true);
		assert.ok(result.summary.includes(`(~${count} surfaces)`), result.summary);
		assert.match(
			readFileSync(join(root, ".qa", "test-plan.md"), "utf8"),
			new RegExp(`Surfaces in scope: \\*\\*${count}\\*\\*`),
		);
	}
});
