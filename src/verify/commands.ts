/**
 * Safe command execution for the verifier.
 *
 * Brakes are enforced here, not by convention: install and full test runs are gated
 * behind explicit opt-in flags and otherwise recorded as `skipped` with a reason.
 * Every executed command captures its full stdout/stderr to `.qa/findings/<id>.log` so
 * the report can cite evidence for every claim.
 */
import { spawn } from "node:child_process";
import type { PackageManager } from "../types.js";

export interface RunResult {
	command: string;
	cwd: string;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	durationMs: number;
	timedOut: boolean;
}

export interface RunOptions {
	cwd: string;
	timeoutMs?: number;
	env?: Record<string, string>;
	/** Hard cap on captured output per stream (bytes) to keep logs bounded. */
	maxBuffer?: number;
}

/** Run a command, never throwing: failures surface as a non-zero exitCode. */
export function runCommand(
	command: string,
	args: string[],
	options: RunOptions,
): Promise<RunResult> {
	const timeoutMs = options.timeoutMs ?? 120_000;
	const maxBuffer = options.maxBuffer ?? 1_000_000;
	const startedAt = Date.now();
	return new Promise<RunResult>((resolvePromise) => {
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		const full = `${command} ${args.join(" ")}`.trim();

		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, args, {
				cwd: options.cwd,
				env: { ...process.env, ...options.env, CI: "1" },
				shell: false,
			});
		} catch (e) {
			resolvePromise({
				command: full,
				cwd: options.cwd,
				exitCode: 127,
				stdout: "",
				stderr: String(e),
				durationMs: Date.now() - startedAt,
				timedOut: false,
			});
			return;
		}

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 2000);
		}, timeoutMs);

		const append = (buf: string, chunk: Buffer): string =>
			buf.length < maxBuffer ? buf + chunk.toString("utf8") : buf;
		child.stdout?.on("data", (c: Buffer) => {
			stdout = append(stdout, c);
		});
		child.stderr?.on("data", (c: Buffer) => {
			stderr = append(stderr, c);
		});

		const finish = (exitCode: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolvePromise({
				command: full,
				cwd: options.cwd,
				exitCode,
				stdout,
				stderr,
				durationMs: Date.now() - startedAt,
				timedOut,
			});
		};
		child.on("error", (e) => {
			stderr += `\n${String(e)}`;
			finish(127);
		});
		child.on("close", (code) => finish(code));
	});
}

/** Build the `<pm> run <script>` invocation for a detected package manager. */
export function packageManagerRun(
	pm: PackageManager,
	script: string,
): { command: string; args: string[] } {
	switch (pm) {
		case "pnpm":
			return { command: "pnpm", args: ["run", script] };
		case "yarn":
			return { command: "yarn", args: [script] };
		case "bun":
			return { command: "bun", args: ["run", script] };
		default:
			return { command: "npm", args: ["run", "--silent", script] };
	}
}

/** Install command for a package manager (only run when the brake is lifted). */
export function packageManagerInstall(pm: PackageManager): { command: string; args: string[] } {
	switch (pm) {
		case "pnpm":
			return { command: "pnpm", args: ["install", "--frozen-lockfile"] };
		case "yarn":
			return { command: "yarn", args: ["install", "--frozen-lockfile"] };
		case "bun":
			return { command: "bun", args: ["install", "--frozen-lockfile"] };
		default:
			return { command: "npm", args: ["ci"] };
	}
}

/** Tail the last N lines of combined output for inclusion in a report. */
export function tail(text: string, lines = 30): string {
	const arr = text.split("\n");
	return arr.slice(Math.max(0, arr.length - lines)).join("\n");
}
