import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compareEvaluations, readEvalReport } from "../src/agent-evals/compare.js";
import { digest, parseAssertions, parseEvalSuite } from "../src/agent-evals/config.js";
import { changes, gitSnapshot, readTree, treeHash } from "../src/agent-evals/files.js";
import { inspectReadiness, runAgentReadiness } from "../src/agent-evals/readiness.js";
import {
	type ContainerExecutor,
	type EvalReport,
	executeEvaluation,
	outputDirectory,
	runAgentEval,
} from "../src/agent-evals/run.js";
import { parseQaArgs } from "../src/cli-args.js";
import type { RunResult } from "../src/verify/commands.js";

const config = {
	version: 1,
	image: `sha256:${"a".repeat(64)}`,
	agent: {
		id: "fixture-v1",
		model: "deterministic-fixture",
		command: ["node", "/agent.cjs"],
		env: [],
	},
	trials: 2,
	timeoutMs: 1000,
	graderTimeoutMs: 1000,
	totalTimeoutMs: 10000,
	tasks: [
		{
			id: "fix-add",
			prompt: "Fix add in math.cjs",
			allowedPaths: ["math.cjs"],
			grader: ["node", "/grader/check.cjs"],
			reference: "reference/fix-add",
		},
	],
};
const source = new Map([
	["math.cjs", Buffer.from("broken")],
	["README.md", Buffer.from("keep")],
]);
const heldOut = new Map([
	["grader/check.cjs", Buffer.from("trusted")],
	["reference/fix-add/math.cjs", Buffer.from("fixed")],
]);
function result(passed = true): RunResult {
	return {
		command: "fixture",
		cwd: "/workspace",
		exitCode: 0,
		stdout: JSON.stringify({ version: 1, assertions: [{ id: "adds", passed }] }),
		stderr: "",
		durationMs: 1,
		timedOut: false,
	};
}
function fixture(t: { after: (fn: () => void) => void }): string {
	const path = mkdtempSync(join(tmpdir(), "qa-agent-eval-"));
	t.after(() => rmSync(path, { recursive: true, force: true }));
	return path;
}
function executor(
	mode: "fix" | "noop" | "boundary" | "timeout" | "malformed" = "fix",
): ContainerExecutor {
	return async (_cmd, workspace, bundle, prompt, timeout, agent) => {
		assert.ok(timeout > 0);
		if (agent) {
			assert.equal(bundle, undefined);
			assert.ok(prompt);
			assert.equal(readFileSync(prompt, "utf8"), "Fix add in math.cjs");
			if (mode === "timeout") return { ...result(), timedOut: true };
			if (mode !== "noop") writeFileSync(join(workspace, "math.cjs"), "fixed");
			if (mode === "boundary") writeFileSync(join(workspace, "README.md"), "changed");
			return result();
		}
		assert.ok(bundle);
		assert.equal(prompt, undefined);
		if (mode === "malformed") return { ...result(), stdout: "{}" };
		return result(readFileSync(join(workspace, "math.cjs"), "utf8") === "fixed");
	};
}
test("suite validates strict fields, identity pins and edit boundaries", () => {
	assert.equal(parseEvalSuite(config).tasks.length, 1);
	for (const bad of [
		{ ...config, unknown: true },
		{ ...config, image: "node:22" },
		{ ...config, trials: 0 },
		{ ...config, trials: 11 },
		{ ...config, tasks: [...config.tasks, ...config.tasks] },
		{ ...config, tasks: [{ ...config.tasks[0], allowedPaths: ["../secret"] }] },
	])
		assert.throws(() => parseEvalSuite(bad));
	assert.throws(() => parseAssertions('{"version":1,"assertions":[]}'));
	assert.throws(() => parseAssertions('{"version":1,"assertions":[{"id":"x","passed":"yes"}]}'));
});
test("readiness is static, exposes evidence and does not execute scripts", (t) => {
	const root = fixture(t);
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({ scripts: { test: "touch SHOULD_NOT_EXIST" } }),
	);
	writeFileSync(join(root, "AGENTS.md"), "Instructions");
	const findings = inspectReadiness(root);
	assert.equal(findings.find((f) => f.id === "instructions")?.status, "discovered");
	assert.deepEqual(findings.find((f) => f.id === "test-entrypoints")?.evidence, [
		"package.json#scripts.test",
	]);
	const report = runAgentReadiness(root);
	assert.equal(report.ok, true);
	assert.match(readFileSync(report.writtenFiles[1] as string, "utf8"), /Static discovery only/);
	assert.throws(() => readFileSync(join(root, "SHOULD_NOT_EXIST")));
});
test("execution requires explicit opt-in before filesystem or Docker access", async () => {
	await assert.rejects(runAgentEval("/does-not-exist"), /--execute/);
	assert.equal(
		parseQaArgs(["--execute", "--suite", ".qa-evals"], "agent-eval").flags.has("execute"),
		true,
	);
	assert.throws(() => parseQaArgs(["--execute"], "agent-readiness"));
});
for (const [mode, expected] of [
	["fix", "passed"],
	["noop", "failed"],
	["boundary", "failed"],
	["timeout", "failed"],
	["malformed", "inconclusive"],
] as const) {
	test(`evaluation ${mode}: independent controls and trial outcomes`, async (t) => {
		const root = fixture(t);
		const report = await executeEvaluation(
			parseEvalSuite(config),
			source,
			heldOut,
			root,
			executor(mode),
		);
		assert.equal(report.trials.length, 2);
		assert.ok(report.trials.every((v) => v.status === expected));
		assert.equal(report.controls[0]?.valid, mode !== "malformed");
		if (mode === "fix") assert.deepEqual(report.trials[0]?.changedFiles, ["math.cjs"]);
		assert.equal(source.get("math.cjs")?.toString(), "broken");
	});
}
test("invalid passing no-op control prevents any agent execution", async (t) => {
	let agents = 0;
	const report = await executeEvaluation(
		parseEvalSuite(config),
		source,
		heldOut,
		fixture(t),
		async (_c, _w, _b, _p, _t, agent) => {
			if (agent) agents++;
			return result();
		},
	);
	assert.equal(agents, 0);
	assert.ok(report.trials.every((v) => v.status === "inconclusive"));
});
test("cancelled evaluation does not start containers", async (t) => {
	const controller = new AbortController();
	controller.abort();
	let calls = 0;
	const report = await executeEvaluation(
		parseEvalSuite(config),
		source,
		heldOut,
		fixture(t),
		async () => {
			calls++;
			return result();
		},
		controller.signal,
	);
	assert.equal(calls, 0);
	assert.equal(report.controls[0]?.valid, false);
});
test("file boundaries reject symlinks and output escapes; hashes detect edits", (t) => {
	const root = fixture(t);
	const outside = fixture(t);
	symlinkSync(outside, join(root, ".qa"));
	assert.throws(() => outputDirectory(root, "agent-evals"), /Unsafe/);
	const files = fixture(t);
	symlinkSync(join(outside, "secret"), join(files, "escape"));
	assert.throws(() => readTree(files), /Unsupported/);
	assert.notEqual(treeHash(source), treeHash(new Map([["math.cjs", Buffer.from("fixed")]])));
	assert.deepEqual(changes(new Map([["empty", Buffer.alloc(0)]]), new Map()), ["empty"]);
});
test("Git snapshot excludes held-out material and refuses dirty trees", (t) => {
	const root = fixture(t);
	const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args]);
	git("init", "-q");
	git("config", "core.hooksPath", "/dev/null");
	writeFileSync(join(root, "math.cjs"), "broken");
	mkdirSync(join(root, ".qa-evals"));
	writeFileSync(join(root, ".qa-evals", "secret"), "reference");
	git("add", ".");
	git(
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"commit",
		"-qm",
		"fixture",
	);
	const snapshot = gitSnapshot(root, ".qa-evals");
	assert.deepEqual([...snapshot.tree.keys()], ["math.cjs"]);
	writeFileSync(join(root, "math.cjs"), "changed");
	assert.throws(() => gitSnapshot(root, ".qa-evals"), /clean Git/);
});
function report(): EvalReport {
	return {
		version: 1,
		kind: "agent-eval",
		commit: "a".repeat(40),
		sourceHash: "a".repeat(64),
		compatibilityHash: "b".repeat(64),
		suiteHash: "c".repeat(64),
		image: config.image,
		runner: config.agent,
		network: false,
		trials: [
			{
				task: "fix-add",
				trial: 1,
				status: "passed",
				reason: "passed",
				durationMs: 5,
				changedFiles: [],
			},
		],
		controls: [{ task: "fix-add", valid: true, reason: "valid" }],
		usage: null,
		startedAt: "2026-01-01",
		completedAt: "2026-01-01",
	};
}
test("comparison checks integrity, compatibility and complete paired trials", (t) => {
	const before = report();
	const first = before.trials[0];
	assert.ok(first);
	first.status = "failed";
	const after = report();
	assert.equal(compareEvaluations(before, after).delta, 1);
	assert.deepEqual(compareEvaluations(before, after).improvements, ["fix-add:1"]);
	assert.throws(
		() => compareEvaluations(before, { ...after, compatibilityHash: "d".repeat(64) }),
		/Incompatible/,
	);
	const root = fixture(t);
	const path = join(root, "report.json");
	const raw = JSON.stringify(after);
	writeFileSync(path, raw);
	writeFileSync(`${path}.sha256`, digest(raw));
	assert.equal(readEvalReport(path).kind, "agent-eval");
	writeFileSync(path, `${raw} `);
	assert.throws(() => readEvalReport(path), /checksum/);
});

test("direct comparisons reject missing, duplicate and unrelated controls", () => {
	const valid = report();
	for (const controls of [
		[],
		[...valid.controls, ...valid.controls],
		[{ task: "other", valid: true, reason: "unrelated" }],
		[...valid.controls, { task: "other", valid: true, reason: "unrelated" }],
	]) {
		const invalid = { ...valid, controls };
		assert.throws(() => compareEvaluations(valid, invalid));
		assert.throws(() => compareEvaluations(invalid, valid));
	}
});

test("Docker adapter enforces isolation and cleans up after cancellation without forwarding secrets to graders", async (t) => {
	const root = fixture(t);
	const calls: Array<{ args: string[]; signal?: AbortSignal }> = [];
	const controller = new AbortController();
	const { dockerExecutor } = await import("../src/agent-evals/run.js");
	const run = dockerExecutor(
		config.image,
		root,
		[],
		true,
		controller.signal,
		async (_cmd, args, options) => {
			calls.push({ args, signal: options?.signal });
			return { ...result(), aborted: args[0] === "run" };
		},
	);
	await run(["node", "/grader/check.cjs"], root, root, undefined, 500, false);
	const args = calls[0]?.args ?? [];
	assert.equal(args[args.indexOf("--network") + 1], "none");
	for (const flag of [
		"--read-only",
		"--cap-drop=ALL",
		"--security-opt=no-new-privileges",
		"--pull=never",
		"--memory=512m",
		"--memory-swap=512m",
		"--log-opt=max-size=1m",
		"--log-opt=max-file=1",
		"--log-opt=compress=false",
	])
		assert.ok(args.includes(flag));
	assert.equal(calls[1]?.args[0], "rm");
	assert.equal(calls[1]?.args[2], args[args.indexOf("--name") + 1]);
	assert.equal(calls[1]?.signal, undefined);
	assert.ok(args.some((a) => a.endsWith("dst=/grader,readonly")));
});
test("cleanup failure halts all further container execution", async (t) => {
	const { ContainerCleanupError } = await import("../src/agent-evals/run.js");
	let calls = 0;
	const report = await executeEvaluation(
		parseEvalSuite(config),
		source,
		heldOut,
		fixture(t),
		async () => {
			calls++;
			throw new ContainerCleanupError("cleanup failed");
		},
	);
	assert.equal(calls, 1);
	assert.ok(report.trials.every((t) => t.status === "inconclusive"));
});

test("Docker integration: held-out controls, candidate grading and owned-container cleanup", {
	skip: !process.env.QA_AGENT_EVAL_IMAGE,
	timeout: 120000,
}, async (t) => {
	const { writeTree } = await import("../src/agent-evals/files.js");
	const image = process.env.QA_AGENT_EVAL_IMAGE as string;
	const root = fixture(t);
	const suite = parseEvalSuite({
		...config,
		image,
		trials: 1,
		timeoutMs: 15000,
		graderTimeoutMs: 15000,
		totalTimeoutMs: 90000,
		agent: {
			...config.agent,
			command: [
				"node",
				"-e",
				"require('fs').writeFileSync('/workspace/math.cjs', 'exports.add = (a,b) => a+b;')",
			],
		},
	});
	const files = new Map([["math.cjs", Buffer.from("exports.add = (a,b) => a-b;")]]);
	const grader = new Map([
		[
			"grader/check.cjs",
			Buffer.from(
				"const {add}=require('/workspace/math.cjs'); process.stdout.write(JSON.stringify({version:1,assertions:[{id:'adds',passed:add(2,3)===5}]}));",
			),
		],
		["reference/fix-add/math.cjs", Buffer.from("exports.add = (a,b) => a+b;")],
	]);
	writeTree(root, files);
	writeFileSync(join(root, ".gitignore"), ".qa/\n");
	writeTree(join(root, ".qa-evals"), grader);
	writeFileSync(join(root, ".qa-evals", "suite.json"), JSON.stringify(suite));
	const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args]);
	git("init", "-q");
	git("config", "core.hooksPath", "/dev/null");
	git("add", ".");
	git(
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"commit",
		"-qm",
		"fixture",
	);
	const executed = await runAgentEval(root, { execute: true });
	if (!executed.ok) {
		for (const [path, bytes] of readTree(join(executed.writtenFiles[0] as string, "..")))
			if (path.endsWith("execution.json")) t.diagnostic(`${path}: ${bytes.toString()}`);
	}
	assert.equal(executed.ok, true, readFileSync(executed.writtenFiles[0] as string, "utf8"));
	const receipt = readEvalReport(executed.writtenFiles[0] as string);
	assert.equal(receipt.controls[0]?.valid, true);
	assert.equal(receipt.trials[0]?.status, "passed");
	assert.equal(compareEvaluations(receipt, receipt).delta, 0);
	assert.equal(readFileSync(join(root, "math.cjs"), "utf8"), "exports.add = (a,b) => a-b;");
});

test("inconsistent assertion IDs cannot produce successful completion", async (t) => {
	let calls = 0;
	const fake = executor();
	const report = await executeEvaluation(
		parseEvalSuite(config),
		source,
		heldOut,
		fixture(t),
		async (...args) => {
			calls++;
			const output = await fake(...args);
			if (calls > 3 && !args[5])
				output.stdout = '{"version":1,"assertions":[{"id":"different","passed":true}]}';
			return output;
		},
	);
	assert.ok(report.trials.every((t) => t.status === "inconclusive"));
});
test("total budget exhaustion prevents additional executions", async (t) => {
	let calls = 0;
	const suite = parseEvalSuite({ ...config, totalTimeoutMs: 1 });
	const report = await executeEvaluation(suite, source, heldOut, fixture(t), async () => {
		calls++;
		await new Promise((resolve) => setTimeout(resolve, 5));
		return result(false);
	});
	assert.ok(calls <= 1);
	assert.ok(report.trials.every((t) => t.status === "inconclusive"));
});

test("evaluation releases scratch trees, retains patches and persists progress snapshots", async (t) => {
	const { existsSync } = await import("node:fs");
	const root = fixture(t);
	const stages: string[] = [];
	let snapshots = 0;
	const evaluated = await executeEvaluation(
		parseEvalSuite(config),
		source,
		heldOut,
		root,
		executor(),
		undefined,
		(e) => stages.push(e.stage),
		() => snapshots++,
	);
	assert.ok(evaluated.trials.every((t) => t.status === "passed"));
	assert.ok(stages.includes("agent") && stages.includes("grading"));
	assert.ok(snapshots >= 3);
	assert.equal(existsSync(join(root, "fix-add-control-reference", "workspace")), false);
	assert.equal(existsSync(join(root, "fix-add-1-agent", "workspace")), false);
	const patch = JSON.parse(readFileSync(join(root, "fix-add-1-agent", "changes.json"), "utf8"));
	assert.equal(Buffer.from(patch[0].contentBase64, "base64").toString(), "fixed");
});
