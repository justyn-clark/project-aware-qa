#!/usr/bin/env node
import { resolve } from "node:path";
import { printResult, runCli } from "../scripts/lib.js";
import { runAcceptance } from "./acceptance/run.js";
import { runAgentComparison } from "./agent-evals/compare.js";
import { runAgentReadiness } from "./agent-evals/readiness.js";
import { runAgentEval } from "./agent-evals/run.js";
import { ArgumentError, parseQaArgs, type QaCommand, verifyFlags, wantsJson } from "./cli-args.js";
import { runPlan, runReport, runScan, runVerify, type StepResult } from "./core.js";
import { progressLabel } from "./progress.js";
import { TOOL } from "./version.js";

const argv = process.argv.slice(2);
const command = argv[0];
if (command === "--version") {
	process.stdout.write(`${TOOL.version}\n`);
} else if (!command || command === "--help" || argv[1] === "--help") {
	process.stdout.write(`project-aware-qa ${TOOL.version}

Usage: project-aware-qa <scan|plan|verify|report|acceptance|agent-readiness|agent-eval|agent-compare> [directory] [options]

  scan      Infer test surfaces and write the source registry
  plan      Write a test plan (--scope <entity|type|risk>)
  verify    Run checks against the current source snapshot
  report    Summarize current evidence and outstanding gaps

  acceptance       Check explicit requirements and targets (--plan <file>)
                   Network: --allow-network; calls: --allow-tool-calls
                   Optional: --browser-module <installed-playwright-module>, --auth-env <NAME>
  agent-readiness  Discover static agent readiness evidence
  agent-eval       Run isolated tasks (--suite <directory> --execute [--allow-network])
  agent-compare    Compare compatible reports (--before <report.json> --after <report.json>)

All commands: --root <directory>, --json
Scan: --max-files <positive integer>, --baseline <repo-relative-path>, --save-baseline
Verify: --scope <value>, --tests, --install, --screenshots,
        --start-dev-server, --base-url <url>, --max-routes <n>, --timeout <ms>
        --changed-since <git-ref>, --require <id,id>, --fail-on-incomplete,
        --junit, --sarif, --service <repo-relative-root>, --diagnostics, --cloud

Team configuration: .project-aware-qa.json (dependencies, policy, baseline, suppressions, behaviorChecks, diagnostics).
Verification is advisory unless a repository or CLI policy is supplied.
Exit 0 means the operation completed without failed checks; exit 1 means failure.
`);
} else {
	await runCli(async (signal) => {
		if (
			![
				"scan",
				"plan",
				"verify",
				"report",
				"acceptance",
				"agent-readiness",
				"agent-eval",
				"agent-compare",
			].includes(command)
		) {
			throw new ArgumentError(`Unknown command ${JSON.stringify(command)}. Use --help.`);
		}
		const args = parseQaArgs(argv.slice(1), command as QaCommand);
		if (command === "agent-compare" && (!args.values.has("before") || !args.values.has("after")))
			throw new ArgumentError("agent-compare requires --before and --after");
		const onProgress = (event: Parameters<typeof progressLabel>[0]) =>
			process.stderr.write(`${progressLabel(event)}\n`);
		let result: StepResult;
		switch (command as QaCommand) {
			case "acceptance":
				result = await runAcceptance(args.root, {
					plan: args.values.get("plan"),
					allowNetwork: args.flags.has("allow-network"),
					allowToolCalls: args.flags.has("allow-tool-calls"),
					browserModule: args.values.get("browser-module"),
					authEnv: args.values.get("auth-env"),
					signal,
					onProgress,
				});
				break;
			case "agent-readiness":
				result = runAgentReadiness(args.root);
				break;
			case "agent-eval":
				result = await runAgentEval(args.root, {
					suite: args.values.get("suite"),
					execute: args.flags.has("execute"),
					allowNetwork: args.flags.has("allow-network"),
					onProgress,
					signal,
				});
				break;
			case "agent-compare":
				result = runAgentComparison(
					resolve(args.root, args.values.get("before") as string),
					resolve(args.root, args.values.get("after") as string),
				);
				break;
			case "scan":
				result = runScan(args.root, {
					maxFiles: args.maxFiles,
					baseline: args.baseline,
					saveBaseline: args.saveBaseline,
				});
				break;
			case "plan":
				result = runPlan(args.root, { scope: args.scope });
				break;
			case "verify":
				result = await runVerify({ root: args.root, ...verifyFlags(args), signal });
				break;
			case "report":
				result = runReport(args.root);
				break;
		}
		printResult(`qa-${command} ${args.root}`, result, args.flags.has("json"));
	}, wantsJson(argv));
}
