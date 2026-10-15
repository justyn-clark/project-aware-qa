import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { parseDiagnostics } from "../src/diagnostics/config.js";
import { parseProfile } from "../src/diagnostics/parsers.js";
import { runDiagnostics } from "../src/diagnostics/run.js";

const profile = (value: unknown) => parseProfile(Buffer.from(JSON.stringify(value)), "speedscope");
function must<T>(value: T | undefined): T {
	assert.ok(value !== undefined);
	return value;
}
const frame = { name: "render" };
function sampled() {
	return {
		shared: { frames: [frame] },
		profiles: [
			{
				type: "sampled",
				name: "main",
				unit: "seconds",
				startValue: 0,
				endValue: 3,
				samples: [[0], [], [0]],
				weights: [1, 1, 1],
			},
		],
	};
}
test("Speedscope validates sampled stacks and keeps native profiles inconclusive", () => {
	const result = profile(sampled());
	assert.equal(result.status, "inconclusive");
	assert.match(JSON.stringify(result.details), /selfWeight":2/);
	for (const mutate of [
		(p: ReturnType<typeof sampled>) => {
			must(p.profiles[0]).samples[0] = [2];
		},
		(p: ReturnType<typeof sampled>) => {
			must(p.profiles[0]).weights = [1];
		},
		(p: ReturnType<typeof sampled>) => {
			must(p.profiles[0]).weights[0] = -1;
		},
		(p: ReturnType<typeof sampled>) => {
			must(p.profiles[0]).unit = "cpu-percent";
		},
	]) {
		const p = sampled();
		mutate(p);
		assert.throws(() => profile(p));
	}
});
test("Speedscope event stacks must close in order within the interval", () => {
	const p = {
		shared: { frames: [frame] },
		profiles: [
			{
				type: "evented",
				name: "native",
				unit: "milliseconds",
				startValue: 0,
				endValue: 5,
				events: [
					{ type: "O", at: 1, frame: 0 },
					{ type: "C", at: 4, frame: 0 },
				],
			},
		],
	};
	assert.match(JSON.stringify(profile(p).details), /selfWeight":3/);
	must(must(p.profiles[0]).events[1]).at = 6;
	assert.throws(() => profile(p), /outside/);
	must(p.profiles[0]).events.pop();
	assert.throws(() => profile(p), /Unclosed/);
	must(must(p.profiles[0]).events[0]).type = "C";
	assert.throws(() => profile(p), /Unbalanced/);
});
test("Python profile parser rejects malformed memory and counters", () => {
	const p = {
		version: 1,
		tracedCurrentBytes: 10,
		tracedPeakBytes: 20,
		functions: [
			{
				file: "app.py",
				line: 1,
				name: "render",
				calls: 1,
				primitiveCalls: 1,
				selfSeconds: 0.1,
				cumulativeSeconds: 0.2,
			},
		],
	};
	const parse = () => parseProfile(Buffer.from(JSON.stringify(p)), "python-profile");
	assert.equal(parse().status, "inconclusive");
	p.tracedPeakBytes = 5;
	assert.throws(parse, /peak/);
	p.tracedPeakBytes = 20;
	must(p.functions[0]).calls = -1;
	assert.throws(parse);
});
test("Python presets and native runtime identities are explicit", () => {
	assert.equal(
		parseDiagnostics([{ id: "py", kind: "python-profile", target: "./app.py" }])[0]?.kind,
		"python-profile",
	);
	assert.throws(() => parseDiagnostics([{ id: "py", kind: "python-profile" }]));
	assert.throws(() =>
		parseDiagnostics([{ id: "py", kind: "python-profile", target: "../app.py" }]),
	);
	for (const runtime of ["python3", "rustc", "zig", "clang"]) {
		assert.equal(
			parseDiagnostics([
				{
					id: "native",
					kind: "collector",
					runtime,
					command: ["tool"],
					artifacts: [{ path: "profile.json", format: "speedscope" }],
				},
			])[0]?.runtime,
			runtime,
		);
	}
});
test("Python preset captures actual functions and preserves workload failures", async (t) => {
	if (spawnSync("python3", ["--version"]).status !== 0)
		return t.skip("Optional Python interpreter unavailable");
	const root = mkdtempSync(join(tmpdir(), "qa-python-profile-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(
		join(root, "app.py"),
		"def workload():\n    return sum(range(10000))\nworkload()\n",
	);
	const checks = parseDiagnostics([{ id: "py", kind: "python-profile", target: "./app.py" }]);
	const options = { root, runDiagnostics: true, timeoutMs: 10000 };
	const result = (await runDiagnostics(checks, options))[0];
	assert.equal(result?.status, "inconclusive", result?.reason);
	const receipt = JSON.parse(
		readFileSync(join(root, ".qa", result?.evidencePath ?? "missing"), "utf8"),
	);
	const captured = receipt.artifacts.find((a: { path: string }) =>
		a.path.endsWith("python-profile.json"),
	);
	assert.ok(captured);
	assert.match(readFileSync(join(root, ".qa", captured.path), "utf8"), /workload/);
	writeFileSync(join(root, "app.py"), "raise RuntimeError('broken workload')\n");
	assert.equal((await runDiagnostics(checks, options))[0]?.status, "failed");
});
test("CTV collector validates explicit desktop scenario configuration", async () => {
	const moduleUrl = pathToFileURL(resolve("templates/ctv-browser-collector.mjs")).href;
	const { validateConfig } = await import(moduleUrl);
	const c = {
		url: "http://localhost:3000",
		name: "home",
		buildId: "build",
		readySelector: "#home",
		contentId: "clear-fixture",
		codec: "none",
		drm: "none",
		network: "loopback",
		hostId: "lab-desktop",
		steps: [{ key: "ArrowRight", focus: "#play" }],
	};
	assert.equal(validateConfig(c).viewport.width, 1920);
	assert.throws(() => validateConfig({ ...c, runs: 1 }));
	assert.throws(() => validateConfig({ ...c, steps: [] }));
	assert.throws(() => validateConfig({ ...c, cpuThrottle: -1 }));
	assert.throws(() => validateConfig({ ...c, physicalDevice: true }));
	assert.throws(() => validateConfig({ ...c, url: "file:///etc/passwd" }));
	assert.throws(() => validateConfig({ ...c, steps: [{ key: "Tab", focus: "#play" }] }));
});

test("CTest preset requires real cases and preserves failures", async (t) => {
	if (spawnSync("ctest", ["--version"]).status !== 0) return t.skip("Optional CTest unavailable");
	const root = mkdtempSync(join(tmpdir(), "qa-ctest-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "build"));
	writeFileSync(join(root, "CMakeLists.txt"), "# Configured test fixture\n");
	// CTest reads this configured-build format; no compiler or network is needed.
	writeFileSync(
		join(root, "build", "CTestTestfile.cmake"),
		`add_test(pass "${process.execPath}" "-e" "process.exit(0)")\n`,
	);
	writeFileSync(join(root, ".gitignore"), "Testing/\n");
	const checks = parseDiagnostics([{ id: "ctest", kind: "cmake-test", cwd: "build" }]);
	const options = { root, runDiagnostics: true, timeoutMs: 10000 };
	const passed = (await runDiagnostics(checks, options))[0];
	assert.equal(passed?.status, "passed", passed?.reason);
	writeFileSync(
		join(root, "build", "CTestTestfile.cmake"),
		`add_test(fail "${process.execPath}" "-e" "process.exit(1)")\n`,
	);
	assert.equal((await runDiagnostics(checks, options))[0]?.status, "failed");
	writeFileSync(join(root, "build", "CTestTestfile.cmake"), "");
	assert.equal((await runDiagnostics(checks, options))[0]?.status, "failed");
});

test("Rust coverage and pytest adapters route fresh reports and preserve failed exits (tool fixtures)", async (t) => {
	if (process.platform === "win32") return t.skip("POSIX executable fixtures");
	const root = mkdtempSync(join(tmpdir(), "qa-language-tools-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const bin = join(root, "tools");
	mkdirSync(bin);
	const executable = (name: string, body: string) => {
		const path = join(bin, name);
		writeFileSync(path, `#!${process.execPath}\n${body}`);
		chmodSync(path, 0o755);
	};
	executable("rustc", "console.log('rustc fixture-version');");
	executable(
		"cargo",
		`
const fs=require('node:fs'),assert=require('node:assert/strict'),args=process.argv.slice(2);
assert.deepEqual(args.slice(0,5),['llvm-cov','--offline','--locked','--lcov','--output-path']);
assert.equal(args.length,6);
assert.equal(process.env.CARGO_LLVM_COV_SETUP,'no');
assert.ok(process.env.CARGO_LLVM_COV_TARGET_DIR.startsWith(process.env.QA_OUTPUT_DIR));
assert.equal(process.env.CARGO_LLVM_COV_BUILD_DIR,process.env.CARGO_LLVM_COV_TARGET_DIR);
fs.writeFileSync(args[5],'SF:src/lib.rs\\nDA:1,1\\nend_of_record\\n');
process.exit(fs.existsSync('fail')?1:0);
`,
	);
	executable(
		"python3",
		`
if(process.argv.includes('--version')) { console.log('Python fixture-version'); process.exit(0); }
const fs=require('node:fs'),args=process.argv.slice(2),assert=require('node:assert/strict');
assert.deepEqual(args.slice(0,5),['-B','-m','pytest','-p','no:cacheprovider']);
const path=args.find(a=>a.startsWith('--junitxml=')).slice(11);
assert.ok(path.startsWith(process.env.QA_OUTPUT_DIR));
fs.writeFileSync(path,'<testsuite tests="1"><testcase name="fixture"/></testsuite>');
process.exit(fs.existsSync('fail')?1:0);
`,
	);
	const oldPath = process.env.PATH;
	process.env.PATH = `${bin}:${oldPath}`;
	try {
		const checks = parseDiagnostics([
			{ id: "rust", kind: "rust-coverage" },
			{ id: "python", kind: "python-test" },
		]);
		const options = { root, runDiagnostics: true, timeoutMs: 10000 };
		for (const result of await runDiagnostics(checks, options))
			assert.equal(result.status, "passed", result.reason);
		writeFileSync(join(root, "fail"), "fail");
		for (const result of await runDiagnostics(checks, options))
			assert.equal(result.status, "failed", result.reason);
	} finally {
		process.env.PATH = oldPath;
	}
});

test("Zig collectors record the real compiler identity using zig version", async (t) => {
	if (spawnSync("zig", ["version"]).status !== 0) return t.skip("Optional Zig unavailable");
	const root = mkdtempSync(join(tmpdir(), "qa-zig-identity-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(
		join(root, "collect.cjs"),
		`require('node:fs').writeFileSync(require('node:path').join(process.env.QA_OUTPUT_DIR,'profile.json'),JSON.stringify(${JSON.stringify(sampled())}));`,
	);
	const checks = parseDiagnostics([
		{
			id: "zig",
			kind: "collector",
			runtime: "zig",
			command: [process.execPath, "collect.cjs"],
			artifacts: [{ path: "profile.json", format: "speedscope" }],
		},
	]);
	const result = (
		await runDiagnostics(checks, { root, runDiagnostics: true, timeoutMs: 10000 })
	)[0];
	assert.equal(result?.status, "inconclusive");
	assert.equal(result?.reason, undefined);
	const receipt = JSON.parse(
		readFileSync(join(root, ".qa", result?.evidencePath ?? "missing"), "utf8"),
	);
	const runtimePath = receipt.artifacts.find((a: { path: string }) =>
		a.path.endsWith("runtime.json"),
	).path;
	const runtime = JSON.parse(readFileSync(join(root, ".qa", runtimePath), "utf8"));
	assert.equal(runtime.name, "zig");
	assert.match(runtime.version, /^\d+\./);
});
