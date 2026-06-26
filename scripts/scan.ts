#!/usr/bin/env -S npx tsx
/**
 * /qa-scan — scan a repo, infer surfaces, and write the registry + scan/crud/risk reports.
 *
 * Usage: tsx scripts/scan.ts [targetDir] [--max-files N]
 */
import { runScan } from "../src/core.js";
import { parseArgs, printResult } from "./lib.js";

const args = parseArgs(process.argv.slice(2));
const maxFiles = args.values.has("max-files") ? Number(args.values.get("max-files")) : undefined;
const result = runScan(args.root, { maxFiles });
printResult(`qa-scan ${args.root}`, result);
