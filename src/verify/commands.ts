/**
 * Safe command execution for the verifier.
 *
 * Brakes are enforced here, not by convention: install and full test runs are gated
 * behind explicit opt-in flags and otherwise recorded as `skipped` with a reason.
 * Every executed command captures its full stdout/stderr for the verification run so
 * the report can cite evidence for every claim.
 */
import { type ChildProcess, spawn } from "node:child_process";
import type { PackageManager } from "../types.js";

export interface RunResult {
	command: string;
	cwd: string;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	durationMs: number;
	timedOut: boolean;
	aborted?: boolean;
}

export interface RunOptions {
	cwd: string;
	timeoutMs?: number;
	env?: Record<string, string>;
	/** Hard cap on captured output per stream (bytes) to keep logs bounded. */
	maxBuffer?: number;
	/** Stop this command and its children when the caller cancels. */
	signal?: AbortSignal;
}

/** Stop an owned, detached process group. Never call this for an existing external server. */
export async function stopProcessTree(child: ChildProcess, graceMs = 1000): Promise<void> {
	if (!child.pid) return;
	if (process.platform === "win32") {
		await new Promise<void>((resolve) => {
			const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
				stdio: "ignore",
			});
			const timer = setTimeout(() => {
				killer.kill();
				child.kill("SIGKILL");
				resolve();
			}, graceMs + 250);
			const done = () => {
				clearTimeout(timer);
				resolve();
			};
			killer.once("error", done);
			killer.once("close", done);
		});
		return;
	}
	const group = -child.pid;
	const signal = (name: NodeJS.Signals): boolean => {
		try {
			process.kill(group, name);
			return true;
		} catch {
			return false;
		}
	};
	if (!signal("SIGTERM")) return;
	const deadline = Date.now() + graceMs;
	while (Date.now() < deadline) {
		try {
			process.kill(group, 0);
		} catch {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	signal("SIGKILL");
	// Give children time to close inherited descriptors and be reaped, with a fixed bound.
	const killedDeadline = Date.now() + 250;
	while (Date.now() < killedDeadline) {
		try {
			process.kill(group, 0);
		} catch {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
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
		let aborted = options.signal?.aborted ?? false;
		let settled = false;
		let stopping = false;
		const full = `${command} ${args.join(" ")}`.trim();
		if (aborted) {
			resolvePromise({
				command: full,
				cwd: options.cwd,
				exitCode: null,
				stdout,
				stderr,
				durationMs: 0,
				timedOut: false,
				aborted: true,
			});
			return;
		}

		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, args, {
				cwd: options.cwd,
				env: { ...process.env, ...options.env, CI: "1" },
				shell: false,
				// A private group lets cancellation stop test workers and npm's child processes.
				detached: process.platform !== "win32",
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

		const append = (buf: string, chunk: Buffer): string =>
			buf.length < maxBuffer ? buf + chunk.toString("utf8").slice(0, maxBuffer - buf.length) : buf;
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
			options.signal?.removeEventListener("abort", onAbort);
			resolvePromise({
				command: full,
				cwd: options.cwd,
				exitCode,
				stdout,
				stderr,
				durationMs: Date.now() - startedAt,
				timedOut,
				aborted,
			});
		};
		const stop = async () => {
			if (stopping || settled) return;
			stopping = true;
			await stopProcessTree(child);
			// Escaped grandchildren must not keep inherited output pipes open indefinitely.
			child.stdout?.destroy();
			child.stderr?.destroy();
			finish(child.exitCode);
		};
		const onAbort = () => {
			aborted = true;
			void stop();
		};
		const timer = setTimeout(() => {
			timedOut = true;
			void stop();
		}, timeoutMs);
		options.signal?.addEventListener("abort", onAbort, { once: true });
		child.on("error", (e) => {
			stderr += `\n${String(e)}`;
			finish(127);
		});
		child.on("close", (code) => {
			if (!stopping) finish(code);
		});
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
