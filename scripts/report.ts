#!/usr/bin/env -S npx tsx
/**
 * /qa-report — aggregate the registry + verification status into qa-report.md.
 *
 * Usage: tsx scripts/report.ts [targetDir]
 */
import { runReport } from "../src/core.js";
import { parseArgs, printResult } from "./lib.js";

const args = parseArgs(process.argv.slice(2));
const result = runReport(args.root);
printResult(`qa-report ${args.root}`, result);
