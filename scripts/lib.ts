/**
 * Tiny argv helpers shared by the CLI scripts. No dependency on a flag library.
 *
 * Conventions:
 *   <command> [targetDir] [--flag] [--key value]
 * The first non-flag positional is the target repo root (defaults to cwd).
 */
import { resolve } from "node:path";
import type { StepResult } from "../src/core.js";

export interface ParsedArgs {
	root: string;
	flags: Set<string>;
	values: Map<string, string>;
	positionals: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
	const flags = new Set<string>();
	const values = new Map<string, string>();
	const positionals: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		if (arg.startsWith("--")) {
			const key = arg.slice(2);
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				values.set(key, next);
				i++;
			} else {
				flags.add(key);
			}
		} else {
			positionals.push(arg);
		}
	}
	const root = resolve(values.get("root") ?? positionals[0] ?? process.cwd());
	return { root, flags, values, positionals };
}

export function printResult(title: string, result: StepResult): void {
	const icon = result.ok ? "✅" : "❌";
	process.stdout.write(`\n${icon} ${title}\n${result.summary}\n`);
	if (result.writtenFiles.length) {
		process.stdout.write("\nWrote:\n");
		for (const f of result.writtenFiles) process.stdout.write(`  - ${f}\n`);
	}
	if (result.error) process.stderr.write(`\nError: ${result.error}\n`);
	process.exitCode = result.ok ? 0 : 1;
}
