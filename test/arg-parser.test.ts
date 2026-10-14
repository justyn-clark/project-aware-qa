import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { parseVerifyArgs } from "../extensions/qa.js";
import { parseArgs } from "../scripts/lib.js";
import { ArgumentError, parseQaArgs, tokenizeArgs, wantsJson } from "../src/cli-args.js";

test("Pi parses scope, booleans, and all value flags without swallowing arguments", () => {
	const flags = parseVerifyArgs(
		'--install --tests --screenshots --start-dev-server "admin users" --base-url http://localhost:5173 --max-routes 5 --timeout 2000',
	);
	assert.deepEqual(flags, {
		scope: "admin users",
		runInstall: true,
		runTests: true,
		runScreenshots: true,
		startDevServer: true,
		baseUrl: "http://localhost:5173",
		maxRoutes: 5,
		timeoutMs: 2000,
		changedSince: undefined,
		requiredChecks: [],
		failOnIncomplete: false,
		exportFormats: [],
	});
});

test("timeout does not leak into scope", () => {
	const flags = parseVerifyArgs("--timeout 1000");
	assert.equal(flags.timeoutMs, 1000);
	assert.equal(flags.scope, undefined);
});

test("empty Pi args preserve safe defaults", () => {
	const flags = parseVerifyArgs("");
	assert.equal(flags.scope, undefined);
	assert.equal(flags.runInstall, false);
	assert.equal(flags.runTests, false);
	assert.equal(flags.runScreenshots, false);
	assert.equal(flags.startDevServer, false);
	assert.equal(flags.timeoutMs, undefined);
});

test("boolean flags before the CLI target never consume the target", () => {
	const args = parseArgs(["--tests", "a repo", "--screenshots", "admin users"], "verify");
	assert.equal(args.root, resolve("a repo"));
	assert.equal(args.scope, "admin users");
	assert.ok(args.flags.has("tests"));
	assert.ok(args.flags.has("screenshots"));
});

test("explicit root and equals values work consistently", () => {
	const args = parseArgs(["--root=a repo", "--scope=admin users", "--timeout=1000"], "verify");
	assert.equal(args.root, resolve("a repo"));
	assert.equal(args.scope, "admin users");
	assert.equal(parseVerifyArgs('--scope="admin users" --timeout=1000').timeoutMs, 1000);
	assert.equal(parseArgs(["--root", "a repo", "admin users"], "plan").scope, "admin users");
});

test("Pi quotes and escapes preserve multiword scopes without shell evaluation", () => {
	assert.deepEqual(tokenizeArgs("\"admin users\" 'billing users' path\\ with\\ spaces"), [
		"admin users",
		"billing users",
		"path with spaces",
	]);
	assert.deepEqual(tokenizeArgs('"$HOME" "$(touch nope)"'), ["$HOME", "$(touch nope)"]);
	assert.equal(parseVerifyArgs("admin\\ users").scope, "admin users");
	assert.throws(() => parseVerifyArgs('"admin users'), /Unclosed quote/);
	assert.throws(() => parseVerifyArgs("admin\\"), /Unfinished escape/);
});

test("unknown options, missing values, duplicates, and conflicting positionals fail closed", () => {
	for (const raw of [
		"--bogus high",
		"--timeout",
		"--timeout --tests",
		"--scope=",
		"--scope -x",
		"--tests=yes",
		"--tests --tests",
		"admin users",
		"admin --scope users",
		"-x",
		'""',
	]) {
		assert.throws(() => parseVerifyArgs(raw), ArgumentError, raw);
	}
	assert.throws(() => parseArgs(["--tests", "repo"], "scan"), /Unknown option/);
	assert.throws(() => parseArgs(["repo", "extra"], "report"), /Too many positional/);
	assert.throws(() => parseQaArgs(["--root", "repo"], "verify", { mode: "pi" }), /Unknown option/);
});

test("numeric options require finite positive safe integers before any workflow runs", () => {
	for (const value of ["abc", "NaN", "Infinity", "0", "-1", "1.5", "9007199254740992"]) {
		for (const option of ["timeout", "max-routes"]) {
			assert.throws(
				() => parseVerifyArgs(`--${option} ${value}`),
				/positive integer/,
				`${option} ${value}`,
			);
		}
		assert.throws(() => parseArgs(["--max-files", value], "scan"), /positive integer/);
	}
	assert.equal(parseArgs(["--max-files", "10"], "scan").maxFiles, 10);
});

test("option terminator allows a target or scope beginning with dashes", () => {
	assert.equal(parseArgs(["--", "--repo"], "scan").root, resolve("--repo"));
	assert.equal(parseVerifyArgs("-- --admin").scope, "--admin");
});

test("JSON is a CLI-only boolean and does not consume its target", () => {
	for (const command of ["scan", "plan", "verify", "report"] as const) {
		const parsed = parseQaArgs(["--json", "some repo"], command);
		assert.ok(parsed.flags.has("json"));
		assert.equal(parsed.root, resolve("some repo"));
		assert.throws(() => parseQaArgs(["--json"], command, { mode: "pi" }), /Unknown option/);
	}
	assert.ok(wantsJson(["--typo", "--json"]));
	assert.equal(wantsJson(["--", "--json"]), false);
});
