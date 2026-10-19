/**
 * project-aware-qa - Pi extension entrypoint.
 *
 * Registers the QA commands. Each runs the corresponding workflow step against the
 * current working directory, writes `.qa/*` artifacts, and surfaces a markdown summary
 * in the transcript (plus a footer status and a toast). The heavy lifting lives in
 * `../src/*`; this file is only command wiring so the CLI scripts and the extension stay
 * in lockstep.
 */

import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { runAcceptance } from "../src/acceptance/run.js";
import { runAgentComparison } from "../src/agent-evals/compare.js";
import { runAgentReadiness } from "../src/agent-evals/readiness.js";
import { runAgentEval } from "../src/agent-evals/run.js";
import {
	ArgumentError,
	type ParsedArgs,
	parseQaArgs,
	type QaCommand,
	tokenizeArgs,
	verifyFlags,
} from "../src/cli-args.js";
import { runPlan, runReport, runScan, runVerify, type StepResult } from "../src/core.js";
import { progressLabel, type RunProgress } from "../src/progress.js";

export { parseVerifyArgs, type VerifyFlags } from "../src/cli-args.js";

const QA_MESSAGE_TYPE = "qa-result";

function surface(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	title: string,
	result: StepResult,
): void {
	const incomplete = result.outcome === "incomplete";
	const icon = incomplete ? "[WARN]" : result.ok ? "[PASS]" : "[FAIL]";
	const label = incomplete ? `${title} (incomplete)` : title;
	const files = result.writtenFiles.map((f) => `- \`${f}\``).join("\n");
	const content =
		`${icon} **${label}**\n\n${result.summary}\n` +
		(files ? `\n**Wrote:**\n${files}\n` : "") +
		(result.error ? `\n**Error:**\n\`\`\`\n${result.error}\n\`\`\`\n` : "");
	pi.sendMessage({ customType: QA_MESSAGE_TYPE, content, display: true });
	ctx.ui.notify(
		`${label}: ${result.summary}`.slice(0, 200),
		incomplete ? "warning" : result.ok ? "info" : "error",
	);
	ctx.ui.setStatus("qa", `${icon} ${label}`);
}

function parseCommandArgs(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	command: QaCommand,
	raw: string,
): ParsedArgs | undefined {
	try {
		return parseQaArgs(tokenizeArgs(raw), command, { mode: "pi", cwd: ctx.cwd });
	} catch (error) {
		if (!(error instanceof ArgumentError)) throw error;
		surface(pi, ctx, `qa-${command}`, {
			ok: false,
			summary: error.message,
			writtenFiles: [],
		});
		return undefined;
	}
}

export default function projectAwareQaExtension(pi: ExtensionAPI): void {
	const runs = new Map<
		string,
		{ controller: AbortController; active: boolean; recent: string[]; result?: StepResult }
	>();
	for (const action of ["status", "cancel"] as const)
		pi.registerCommand(`qa-${action}`, {
			description:
				action === "cancel"
					? "Cancel this project's active acceptance/evaluation run and preserve evidence"
					: "Show current or last acceptance/evaluation run",
			handler: async (raw, ctx) => {
				if (raw.trim()) {
					ctx.ui.notify(`qa-${action} takes no arguments`, "error");
					return;
				}
				const run = runs.get(ctx.cwd);
				if (!run) {
					ctx.ui.notify("No acceptance/evaluation run in this session", "info");
					return;
				}
				if (action === "cancel" && run.active) {
					run.controller.abort(new Error("Cancelled by user"));
					ctx.ui.notify("Cancellation requested; cleanup is in progress", "info");
					return;
				}
				surface(
					pi,
					ctx,
					`qa-${action}`,
					run.result ?? { ok: true, summary: run.recent.join("\n"), writtenFiles: [] },
				);
			},
		});
	for (const command of ["acceptance", "agent-readiness", "agent-eval", "agent-compare"] as const) {
		pi.registerCommand(`qa-${command}`, {
			description:
				command === "acceptance"
					? "Verify explicit criteria and targets (--plan <file> [--allow-network] [--allow-tool-calls])"
					: command === "agent-readiness"
						? "Discover static readiness evidence"
						: command === "agent-eval"
							? "Run bounded container evaluations (--suite <directory> --execute [--allow-network])"
							: "Compare reports (--before <path> --after <path>)",
			handler: async (raw, ctx) => {
				const args = parseCommandArgs(pi, ctx, command, raw);
				if (!args) return;
				if (command === "acceptance" || command === "agent-eval") {
					if (runs.get(ctx.cwd)?.active) {
						ctx.ui.notify("A run is active; use /qa-status or /qa-cancel", "warning");
						return;
					}
					const run: {
						controller: AbortController;
						active: boolean;
						recent: string[];
						result?: StepResult;
					} = { controller: new AbortController(), active: true, recent: ["Starting"] };
					runs.set(ctx.cwd, run);
					const onProgress = (event: RunProgress) => {
						const label = progressLabel(event);
						run.recent = [...run.recent.slice(-7), label];
						ctx.ui.setStatus("qa", label);
					};
					void (async () => {
						try {
							run.result =
								command === "acceptance"
									? await runAcceptance(ctx.cwd, {
											plan: args.values.get("plan"),
											allowNetwork: args.flags.has("allow-network"),
											allowToolCalls: args.flags.has("allow-tool-calls"),
											browserModule: args.values.get("browser-module"),
											authEnv: args.values.get("auth-env"),
											signal: run.controller.signal,
											onProgress,
										})
									: await runAgentEval(ctx.cwd, {
											suite: args.values.get("suite"),
											execute: args.flags.has("execute"),
											allowNetwork: args.flags.has("allow-network"),
											signal: run.controller.signal,
											onProgress,
										});
						} catch (error) {
							run.result = { ok: false, summary: String(error), writtenFiles: [] };
						} finally {
							run.active = false;
						}
						surface(pi, ctx, `qa-${command}`, run.result);
					})();
					return;
				}
				try {
					if (
						command === "agent-compare" &&
						(!args.values.has("before") || !args.values.has("after"))
					)
						throw new Error("Comparison requires --before and --after");
					const result =
						command === "agent-readiness"
							? runAgentReadiness(ctx.cwd)
							: runAgentComparison(
									resolve(ctx.cwd, args.values.get("before") as string),
									resolve(ctx.cwd, args.values.get("after") as string),
								);
					surface(pi, ctx, `qa-${command}`, result);
				} catch (error) {
					surface(pi, ctx, `qa-${command}`, {
						ok: false,
						summary: String(error),
						writtenFiles: [],
					});
				}
			},
		});
	}

	pi.registerCommand("qa-scan", {
		description:
			"Scan the repo, infer test surfaces, and write .qa/surface-registry.json + reports",
		handler: async (raw, ctx) => {
			const args = parseCommandArgs(pi, ctx, "scan", raw);
			if (!args) return;
			ctx.ui.setStatus("qa", "[WAIT] scanning...");
			ctx.ui.setWorkingMessage("project-aware-qa: scanning repository...");
			const result = runScan(ctx.cwd, {
				maxFiles: args.maxFiles,
				baseline: args.baseline,
				saveBaseline: args.saveBaseline,
			});
			ctx.ui.setWorkingMessage();
			surface(pi, ctx, "qa-scan", result);
		},
	});

	pi.registerCommand("qa-plan", {
		description: "Turn the surface registry into a risk-scaled test plan (optional [scope])",
		handler: async (raw, ctx) => {
			const args = parseCommandArgs(pi, ctx, "plan", raw);
			if (!args) return;
			const scope = args.scope;
			ctx.ui.setStatus("qa", "[WAIT] planning...");
			const result = runPlan(ctx.cwd, { scope });
			surface(pi, ctx, `qa-plan${scope ? ` ${scope}` : ""}`, result);
		},
	});

	pi.registerCommand("qa-verify", {
		description:
			"Run safe checks with evidence. CI flags: --changed-since <ref> --require <id,id> --fail-on-incomplete --junit --sarif. Runtime flags: --install --tests --screenshots --start-dev-server --base-url <url> --max-routes <n> --timeout <ms>",
		handler: async (raw, ctx) => {
			const args = parseCommandArgs(pi, ctx, "verify", raw);
			if (!args) return;
			const flags = verifyFlags(args);
			ctx.ui.setStatus("qa", "[WAIT] verifying...");
			ctx.ui.setWorkingMessage("project-aware-qa: running checks...");
			const result = await runVerify({ root: ctx.cwd, ...flags, signal: ctx.signal });
			ctx.ui.setWorkingMessage();
			surface(pi, ctx, "qa-verify", result);
		},
	});

	pi.registerCommand("qa-report", {
		description: "Aggregate the registry + verification status into .qa/qa-report.md",
		handler: async (raw, ctx) => {
			if (!parseCommandArgs(pi, ctx, "report", raw)) return;
			ctx.ui.setStatus("qa", "[WAIT] reporting...");
			const result = runReport(ctx.cwd);
			surface(pi, ctx, "qa-report", result);
		},
	});
}
