/**
 * Extension arg parser (audit Finding 3): /qa-verify --timeout was dropped, turning the
 * value into the scope. These lock in --timeout parsing and robust unknown/missing handling.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVerifyArgs } from "../extensions/qa.js";

test("--timeout is parsed and does not leak into scope (the bug)", () => {
	const f = parseVerifyArgs("--timeout 1000");
	assert.equal(f.timeoutMs, 1000);
	assert.equal(f.scope, undefined, "1000 must NOT become the scope");
});

test("scope + all value flags together", () => {
	const f = parseVerifyArgs(
		"admin --screenshots --base-url http://localhost:5173 --max-routes 5 --timeout 2000",
	);
	assert.equal(f.scope, "admin");
	assert.equal(f.runScreenshots, true);
	assert.equal(f.baseUrl, "http://localhost:5173");
	assert.equal(f.maxRoutes, 5);
	assert.equal(f.timeoutMs, 2000);
});

test("boolean flags", () => {
	const f = parseVerifyArgs("--install --tests --start-dev-server");
	assert.equal(f.runInstall, true);
	assert.equal(f.runTests, true);
	assert.equal(f.startDevServer, true);
});

test("unknown --flag is ignored; first bare token is the scope", () => {
	const f = parseVerifyArgs("--bogus high");
	assert.equal(f.scope, "high");
	assert.equal(f.timeoutMs, undefined);
});

test("a value flag with no value doesn't swallow the next flag", () => {
	const f = parseVerifyArgs("--timeout --tests");
	assert.equal(f.timeoutMs, undefined, "no value → not set");
	assert.equal(f.runTests, true, "--tests still parsed");
});

test("non-numeric value for a number flag is guarded (no NaN)", () => {
	const f = parseVerifyArgs("--max-routes abc");
	assert.equal(f.maxRoutes, undefined);
	assert.equal(f.scope, "abc", "the bare token still becomes scope");
});

test("empty args → all defaults", () => {
	const f = parseVerifyArgs("");
	assert.deepEqual(
		{
			scope: f.scope,
			install: f.runInstall,
			tests: f.runTests,
			ss: f.runScreenshots,
			timeout: f.timeoutMs,
		},
		{ scope: undefined, install: false, tests: false, ss: false, timeout: undefined },
	);
});
