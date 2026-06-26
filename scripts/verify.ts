#!/usr/bin/env -S npx tsx
/**
 * /qa-verify [scope] — run the safe-check ladder and write the evidence report.
 *
 * Usage:
 *   tsx scripts/verify.ts [targetDir] [--scope <s>] [--install] [--tests]
 *                         [--screenshots] [--start-dev-server] [--base-url <url>]
 *                         [--max-routes N] [--timeout MS]
 *
 * Brakes: --install, --tests and --screenshots are off by default. Without them the
 * verifier records those checks as skipped with a reason rather than executing them.
 */
import { runVerify } from "../src/core.js";
import { parseArgs, printResult } from "./lib.js";

const args = parseArgs(process.argv.slice(2));
const scope = args.values.get("scope") ?? args.positionals[1];

const result = await runVerify({
	root: args.root,
	scope,
	runInstall: args.flags.has("install"),
	runTests: args.flags.has("tests"),
	runScreenshots: args.flags.has("screenshots"),
	startDevServer: args.flags.has("start-dev-server"),
	baseUrl: args.values.get("base-url"),
	maxRoutes: args.values.has("max-routes") ? Number(args.values.get("max-routes")) : undefined,
	timeoutMs: args.values.has("timeout") ? Number(args.values.get("timeout")) : undefined,
});
printResult(`qa-verify ${args.root}`, result);
