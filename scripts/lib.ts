/**
 * Tiny argv helpers shared by the CLI scripts. No dependency on a flag library.
 *
 * Conventions:
 *   <command> [targetDir] [--flag] [--key value]
 * The first non-flag positional is the target repo root (defaults to cwd).
 */
import { type ParsedArgs, parseQaArgs, type QaCommand } from "../src/cli-args.js";
import type { StepResult } from "../src/core.js";

export type { ParsedArgs } from "../src/cli-args.js";

export function parseArgs(argv: string[], command: QaCommand = "verify"): ParsedArgs {
	return parseQaArgs(argv, command);
}

/** All entrypoints fail before executing a workflow when parsing fails. */
export async function runCli(
	run: (signal: AbortSignal) => void | Promise<void>,
	json = false,
): Promise<void> {
	const cancellation = new AbortController();
	const abort = () => cancellation.abort(new Error("QA command cancelled"));
	process.once("SIGINT", abort);
	process.once("SIGTERM", abort);
	try {
		await run(cancellation.signal);
		if (cancellation.signal.aborted) process.exitCode = 130;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (json) {
			printResult("qa", { ok: false, summary: message, writtenFiles: [], error: message }, true);
		} else {
			process.stderr.write(`Error: ${message}\n`);
			process.exitCode = 1;
		}
		if (cancellation.signal.aborted) process.exitCode = 130;
	} finally {
		process.removeListener("SIGINT", abort);
		process.removeListener("SIGTERM", abort);
	}
}

export function printResult(title: string, result: StepResult, json = false): void {
	if (json) {
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		process.exitCode = result.ok ? 0 : 1;
		return;
	}
	const icon = result.outcome === "incomplete" ? "[WARN]" : result.ok ? "[PASS]" : "[FAIL]";
	const label = result.outcome === "incomplete" ? `${title} (incomplete)` : title;
	process.stdout.write(`\n${icon} ${label}\n${result.summary}\n`);
	if (result.writtenFiles.length) {
		process.stdout.write("\nWrote:\n");
		for (const f of result.writtenFiles) process.stdout.write(`  - ${f}\n`);
	}
	if (result.error) process.stderr.write(`\nError: ${result.error}\n`);
	process.exitCode = result.ok ? 0 : 1;
}
