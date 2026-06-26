#!/usr/bin/env -S npx tsx
/**
 * /qa-plan [scope] — turn the registry into a risk-scaled test plan.
 *
 * Usage: tsx scripts/plan.ts [targetDir] [--scope <entity|type|risk|admin>]
 */
import { runPlan } from "../src/core.js";
import { parseArgs, printResult } from "./lib.js";

const args = parseArgs(process.argv.slice(2));
// Scope can be given as --scope or as a second positional after the dir.
const scope = args.values.get("scope") ?? args.positionals[1];
const result = runPlan(args.root, { scope });
printResult(`qa-plan ${args.root}${scope ? ` (scope: ${scope})` : ""}`, result);
