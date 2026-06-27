/**
 * Node stack anchoring: a real project signal (framework or runnable script) is required,
 * so an assets/tooling-only package.json next to another stack doesn't create noise.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { scanRepo } from "../src/scanner/index.js";

function tmp(): string {
	return mkdtempSync(join(tmpdir(), "qa-node-"));
}

test("assets-only package.json (no frameworks, no scripts) → no Node stack", () => {
	const dir = tmp();
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({ name: "assets", devDependencies: { tailwindcss: "^3", esbuild: "^0.20" } }),
	);
	mkdirSync(join(dir, "js"));
	writeFileSync(join(dir, "js/app.js"), "localStorage.getItem('x')");
	const s = scanRepo(dir);
	assert.ok(!s.project.stacks.some((st) => st.adapter === "node"), "no Node stack for assets-only");
});

test("package.json with a real script → Node stack present", () => {
	const dir = tmp();
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({ scripts: { build: "tsc", test: "vitest" } }),
	);
	writeFileSync(join(dir, "index.ts"), "export const x = 1;");
	const s = scanRepo(dir);
	const node = s.project.stacks.find((st) => st.adapter === "node");
	assert.ok(node, "Node stack present");
	assert.equal(node?.checks.build?.command, "npm run --silent build");
});

test("package.json with a framework dep → Node stack present", () => {
	const dir = tmp();
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({ dependencies: { "react-router-dom": "^6" } }),
	);
	const s = scanRepo(dir);
	assert.ok(
		s.project.stacks.some((st) => st.adapter === "node"),
		"framework → Node stack",
	);
});
