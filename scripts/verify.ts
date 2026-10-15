#!/usr/bin/env -S npx tsx
/**
 * /qa-verify [scope] - run the safe-check ladder and write the evidence report.
 *
 * Usage:
 *   tsx scripts/verify.ts [targetDir] [--scope <s>] [--install] [--tests]
 *                         [--screenshots] [--start-dev-server] [--base-url <url>]
 *                         [--max-routes N] [--timeout MS]
 *                         [--changed-since REF] [--require id,id]
 *                         [--fail-on-incomplete] [--junit] [--sarif]
 *
 * Brakes: --install, --tests and --screenshots are off by default. Without them the
 * verifier records those checks as skipped with a reason rather than executing them.
 */
import { verifyFlags, wantsJson } from "../src/cli-args.js";
import { runVerify } from "../src/core.js";
import { parseArgs, printResult, runCli } from "./lib.js";

await runCli(
	async (signal) => {
		const args = parseArgs(process.argv.slice(2), "verify");
		const result = await runVerify({ root: args.root, ...verifyFlags(args), signal });
		printResult(`qa-verify ${args.root}`, result, args.flags.has("json"));
	},
	wantsJson(process.argv.slice(2)),
);
