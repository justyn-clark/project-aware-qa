import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/qa.js";

const repo = fileURLToPath(new URL("..", import.meta.url));
const tsx = fileURLToPath(import.meta.resolve("tsx"));

function run(command: string, args: string[], cwd: string) {
	return spawnSync(
		process.execPath,
		["--import", tsx, join(repo, "scripts", `${command}.ts`), ...args],
		{
			cwd,
			encoding: "utf8",
			timeout: 20_000,
		},
	);
}

test("CLI accepts spaced target paths and booleans before the target", () => {
	const temp = mkdtempSync(join(tmpdir(), "qa-cli-"));
	try {
		const target = join(temp, "target repo");
		mkdirSync(target);
		writeFileSync(
			join(target, "package.json"),
			JSON.stringify({ name: "cli-fixture", private: true }),
		);
		const scan = run("scan", [target, "--max-files", "10"], temp);
		assert.equal(scan.status, 0, scan.stderr);
		assert.ok(existsSync(join(target, ".qa", "surface-registry.json")));
		const verify = run("verify", ["--tests", target, "--timeout", "1000"], temp);
		assert.equal(verify.status, 0, verify.stderr);
		assert.match(verify.stdout, /⚠️ qa-verify .*\(incomplete\)/);
		assert.ok(existsSync(join(target, ".qa", "verification-report.md")));
		assert.equal(existsSync(join(temp, ".qa")), false, "must not execute against the caller's cwd");
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});

test("every CLI rejects invalid arguments with a clear error and nonzero status before writes", () => {
	const temp = mkdtempSync(join(tmpdir(), "qa-cli-errors-"));
	try {
		for (const command of ["scan", "plan", "verify", "report"]) {
			const result = run(command, ["--typo", temp], temp);
			assert.equal(result.status, 1, `${command}: ${result.stderr}`);
			assert.match(result.stderr, /^Error: Unknown option "--typo"/);
			assert.doesNotMatch(result.stderr, /\n\s+at /, "argument errors need no stack trace");
		}
		const numeric = run("scan", [temp, "--max-files", "0"], temp);
		assert.equal(numeric.status, 1);
		assert.match(numeric.stderr, /positive integer/);
		assert.equal(existsSync(join(temp, ".qa")), false);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});

test("Pi fails closed on invalid arguments and labels incomplete verification", async () => {
	const temp = mkdtempSync(join(tmpdir(), "qa-pi-errors-"));
	try {
		type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
		const commands = new Map<string, Command>();
		const messages: Array<{ content: string }> = [];
		const notifications: string[] = [];
		extension({
			registerCommand: (name: string, command: Command) => commands.set(name, command),
			sendMessage: (message: { content: string }) => messages.push(message),
		} as unknown as ExtensionAPI);
		const ctx = {
			cwd: temp,
			ui: {
				notify: (_message: string, level: string) => notifications.push(level),
				setStatus: () => {},
				setWorkingMessage: () => {},
			},
		} as unknown as ExtensionCommandContext;
		for (const command of ["qa-scan", "qa-plan", "qa-verify", "qa-report"]) {
			await commands.get(command)?.handler("--typo", ctx);
			assert.match(messages.at(-1)?.content ?? "", /Unknown option "--typo"/);
			assert.equal(notifications.at(-1), "error");
		}
		assert.equal(existsSync(join(temp, ".qa")), false);
		writeFileSync(
			join(temp, "package.json"),
			JSON.stringify({ name: "pi-fixture", private: true }),
		);
		await commands.get("qa-scan")?.handler("", ctx);
		await commands.get("qa-verify")?.handler("", ctx);
		assert.match(messages.at(-1)?.content ?? "", /⚠️ \*\*qa-verify \(incomplete\)/);
		assert.equal(notifications.at(-1), "warning");
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});

test("CLI JSON mode emits one structured result for success and argument errors", () => {
	const temp = mkdtempSync(join(tmpdir(), "qa-cli-json-"));
	try {
		writeFileSync(
			join(temp, "package.json"),
			JSON.stringify({ name: "json-fixture", private: true }),
		);
		const scan = run("scan", ["--json", temp], temp);
		assert.equal(scan.status, 0, scan.stderr);
		assert.equal(scan.stderr, "");
		const result = JSON.parse(scan.stdout);
		assert.equal(result.ok, true);
		assert.ok(result.writtenFiles.length > 0);
		for (const command of ["scan", "plan", "verify", "report"]) {
			const invalid = run(command, ["--json", "--typo", temp], temp);
			assert.equal(invalid.status, 1);
			assert.equal(invalid.stderr, "");
			const error = JSON.parse(invalid.stdout);
			assert.equal(error.ok, false);
			assert.match(error.error, /Unknown option/);
			assert.deepEqual(error.writtenFiles, []);
		}
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

for (const entry of ["src/cli.ts", "scripts/verify.ts"]) {
	test(`CLI SIGINT cancellation cleans up detached descendants (${entry})`, {
		skip: process.platform === "win32",
		timeout: 15_000,
	}, async () => {
		const temp = mkdtempSync(join(tmpdir(), "qa-cli-cancel-"));
		const workerPidPath = join(temp, ".qa", "worker.pid");
		const descendantPidPath = join(temp, ".qa", "descendant.pid");
		writeFileSync(
			join(temp, "package.json"),
			JSON.stringify({
				name: "cli-cancellation-fixture",
				private: true,
				scripts: { typecheck: "node worker.cjs", lint: "node lint.cjs" },
			}),
		);
		mkdirSync(join(temp, "node_modules"));
		const descendant = `
			process.on('SIGTERM', () => {});
			require('node:fs').writeFileSync(${JSON.stringify(descendantPidPath)}, String(process.pid));
			setInterval(() => {}, 1000);
		`;
		writeFileSync(
			join(temp, "worker.cjs"),
			`
			require('node:fs').writeFileSync(${JSON.stringify(workerPidPath)}, String(process.pid));
			require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio: 'inherit'});
			setInterval(() => {}, 1000);
		`,
		);
		writeFileSync(
			join(temp, "lint.cjs"),
			"require('node:fs').writeFileSync('.qa/lint-ran', 'yes')",
		);
		let child: ReturnType<typeof spawn> | undefined;
		let watchdog: ReturnType<typeof setTimeout> | undefined;
		try {
			const scan = run("scan", ["--json", temp], temp);
			assert.equal(scan.status, 0, scan.stderr || scan.stdout);
			child = spawn(
				process.execPath,
				[
					"--import",
					tsx,
					join(repo, entry),
					...(entry === "src/cli.ts" ? ["verify"] : []),
					"--json",
					temp,
					"--timeout",
					"10000",
				],
				{
					cwd: temp,
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			let stdout = "";
			let stderr = "";
			child.stdout?.on("data", (chunk: Buffer) => {
				stdout += chunk.toString();
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			const completed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
				(resolve, reject) => {
					child?.once("error", reject);
					child?.once("close", (code, signal) => resolve({ code, signal }));
				},
			);
			// Keep cleanup bounded even if a future regression stops handling SIGINT.
			watchdog = setTimeout(() => child?.kill("SIGKILL"), 10_000);
			const deadline = Date.now() + 5000;
			while (!existsSync(descendantPidPath) && child.exitCode === null && Date.now() < deadline) {
				await delay(20);
			}
			assert.ok(existsSync(descendantPidPath), `descendant did not start: ${stdout}\n${stderr}`);
			const workerPid = Number(readFileSync(workerPidPath, "utf8"));
			const descendantPid = Number(readFileSync(descendantPidPath, "utf8"));
			assert.ok(processIsAlive(workerPid));
			assert.ok(processIsAlive(descendantPid));
			assert.equal(child.kill("SIGINT"), true);
			const result = await completed;
			assert.equal(result.code, 130, `${stdout}\n${stderr}`);
			assert.equal(result.signal, null, "CLI should handle cancellation and exit normally");
			assert.equal(stderr, "", "JSON mode must emit one machine-readable result");
			const output = JSON.parse(stdout);
			assert.equal(output.ok, false);
			assert.match(output.error, /cancelled/);
			assert.equal(processIsAlive(workerPid), false, "check worker leaked after CLI exit");
			assert.equal(
				processIsAlive(descendantPid),
				false,
				"TERM-resistant descendant leaked after CLI exit",
			);
			assert.equal(
				existsSync(join(temp, ".qa", "lint-ran")),
				false,
				"cancellation must prevent the next check",
			);
			const cancelledRecord = JSON.parse(
				readFileSync(join(temp, ".qa", "verification.json"), "utf8"),
			);
			assert.deepEqual(
				cancelledRecord.result.checks.map((check: { status: string }) => check.status),
				["failed"],
				"cancelled run must publish failure evidence, never successful verification",
			);
		} finally {
			if (watchdog) clearTimeout(watchdog);
			child?.kill("SIGINT");
			for (const path of [descendantPidPath, workerPidPath]) {
				if (!existsSync(path)) continue;
				try {
					process.kill(Number(readFileSync(path, "utf8")), "SIGKILL");
				} catch {}
			}
			child?.kill("SIGKILL");
			rmSync(temp, { recursive: true, force: true });
		}
	});
}
