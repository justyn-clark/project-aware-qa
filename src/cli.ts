#!/usr/bin/env node
import { printResult, runCli } from "../scripts/lib.js";
import { ArgumentError, parseQaArgs, type QaCommand, verifyFlags, wantsJson } from "./cli-args.js";
import { runPlan, runReport, runScan, runVerify } from "./core.js";
import { TOOL } from "./version.js";

const argv = process.argv.slice(2);
const command = argv[0];
if (command === "--version") {
	process.stdout.write(`${TOOL.version}\n`);
} else if (!command || command === "--help" || argv[1] === "--help") {
	process.stdout.write(`project-aware-qa ${TOOL.version}

Usage: project-aware-qa <scan|plan|verify|report> [directory] [options]

  scan      Infer test surfaces and write the source registry
  plan      Write a test plan (--scope <entity|type|risk>)
  verify    Run checks against the current source snapshot
  report    Summarize current evidence and outstanding gaps

All commands: --root <directory>, --json
Scan: --max-files <positive integer>, --baseline <repo-relative-path>, --save-baseline
Verify: --scope <value>, --tests, --install, --screenshots,
        --start-dev-server, --base-url <url>, --max-routes <n>, --timeout <ms>
        --changed-since <git-ref>, --require <id,id>, --fail-on-incomplete,
        --junit, --sarif, --service <repo-relative-root>

Team configuration: .project-aware-qa.json (dependencies, policy, baseline, suppressions, behaviorChecks).
Verification is advisory unless a repository or CLI policy is supplied.
Exit 0 means the operation completed without failed checks; exit 1 means failure.
`);
} else {
	await runCli(async (signal) => {
		if (!["scan", "plan", "verify", "report"].includes(command)) {
			throw new ArgumentError(`Unknown command ${JSON.stringify(command)}. Use --help.`);
		}
		const args = parseQaArgs(argv.slice(1), command as QaCommand);
		const result =
			command === "scan"
				? runScan(args.root, {
						maxFiles: args.maxFiles,
						baseline: args.baseline,
						saveBaseline: args.saveBaseline,
					})
				: command === "plan"
					? runPlan(args.root, { scope: args.scope })
					: command === "verify"
						? await runVerify({ root: args.root, ...verifyFlags(args), signal })
						: runReport(args.root);
		printResult(`qa-${command} ${args.root}`, result, args.flags.has("json"));
	}, wantsJson(argv));
}
