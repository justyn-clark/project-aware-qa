#!/usr/bin/env -S npx tsx
/**
 * /qa-scan — scan a repo, infer surfaces, and write the registry + scan/crud/risk reports.
 *
 * Usage: tsx scripts/scan.ts [targetDir] [--max-files N]
 */
import { wantsJson } from "../src/cli-args.js";
import { runScan } from "../src/core.js";
import { parseArgs, printResult, runCli } from "./lib.js";

await runCli(
	async () => {
		const args = parseArgs(process.argv.slice(2), "scan");
		const result = runScan(args.root, {
			maxFiles: args.maxFiles,
			baseline: args.baseline,
			saveBaseline: args.saveBaseline,
		});
		printResult(`qa-scan ${args.root}`, result, args.flags.has("json"));
	},
	wantsJson(process.argv.slice(2)),
);
