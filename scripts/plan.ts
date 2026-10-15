#!/usr/bin/env -S npx tsx
/**
 * /qa-plan [scope] - turn the registry into a risk-scaled test plan.
 *
 * Usage: tsx scripts/plan.ts [targetDir] [--scope <entity|type|risk|admin>]
 */
import { wantsJson } from "../src/cli-args.js";
import { runPlan } from "../src/core.js";
import { parseArgs, printResult, runCli } from "./lib.js";

await runCli(
	async () => {
		const args = parseArgs(process.argv.slice(2), "plan");
		const result = runPlan(args.root, { scope: args.scope });
		printResult(
			`qa-plan ${args.root}${args.scope ? ` (scope: ${args.scope})` : ""}`,
			result,
			args.flags.has("json"),
		);
	},
	wantsJson(process.argv.slice(2)),
);
