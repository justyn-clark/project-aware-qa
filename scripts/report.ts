#!/usr/bin/env -S npx tsx
/**
 * /qa-report — aggregate the registry + verification status into qa-report.md.
 *
 * Usage: tsx scripts/report.ts [targetDir]
 */
import { wantsJson } from "../src/cli-args.js";
import { runReport } from "../src/core.js";
import { parseArgs, printResult, runCli } from "./lib.js";

await runCli(
	async () => {
		const args = parseArgs(process.argv.slice(2), "report");
		const result = runReport(args.root);
		printResult(`qa-report ${args.root}`, result, args.flags.has("json"));
	},
	wantsJson(process.argv.slice(2)),
);
