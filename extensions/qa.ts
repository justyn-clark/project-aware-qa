/**
 * project-aware-qa — Pi extension entrypoint.
 *
 * Registers the four QA commands. Each runs the corresponding workflow step against the
 * current working directory, writes `.qa/*` artifacts, and surfaces a markdown summary
 * in the transcript (plus a footer status and a toast). The heavy lifting lives in
 * `../src/*`; this file is only command wiring so the CLI scripts and the extension stay
 * in lockstep.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	ArgumentError,
	type ParsedArgs,
	parseQaArgs,
	type QaCommand,
	tokenizeArgs,
	verifyFlags,
} from "../src/cli-args.js";
import { runPlan, runReport, runScan, runVerify, type StepResult } from "../src/core.js";

export { parseVerifyArgs, type VerifyFlags } from "../src/cli-args.js";

const QA_MESSAGE_TYPE = "qa-result";

function surface(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	title: string,
	result: StepResult,
): void {
	const incomplete = result.outcome === "incomplete";
	const icon = incomplete ? "⚠️" : result.ok ? "✅" : "❌";
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
	pi.registerCommand("qa-scan", {
		description:
			"Scan the repo, infer test surfaces, and write .qa/surface-registry.json + reports",
		handler: async (raw, ctx) => {
			const args = parseCommandArgs(pi, ctx, "scan", raw);
			if (!args) return;
			ctx.ui.setStatus("qa", "⏳ scanning…");
			ctx.ui.setWorkingMessage("project-aware-qa: scanning repository…");
			const result = runScan(ctx.cwd, { maxFiles: args.maxFiles });
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
			ctx.ui.setStatus("qa", "⏳ planning…");
			const result = runPlan(ctx.cwd, { scope });
			surface(pi, ctx, `qa-plan${scope ? ` ${scope}` : ""}`, result);
		},
	});

	pi.registerCommand("qa-verify", {
		description:
			"Run safe checks (typecheck/lint/tests/route-probe/screenshots) with evidence. Flags: --install --tests --screenshots --start-dev-server --base-url <url> --max-routes <n> --timeout <ms>",
		handler: async (raw, ctx) => {
			const args = parseCommandArgs(pi, ctx, "verify", raw);
			if (!args) return;
			const flags = verifyFlags(args);
			ctx.ui.setStatus("qa", "⏳ verifying…");
			ctx.ui.setWorkingMessage("project-aware-qa: running checks…");
			const result = await runVerify({ root: ctx.cwd, ...flags, signal: ctx.signal });
			ctx.ui.setWorkingMessage();
			surface(pi, ctx, "qa-verify", result);
		},
	});

	pi.registerCommand("qa-report", {
		description: "Aggregate the registry + verification status into .qa/qa-report.md",
		handler: async (raw, ctx) => {
			if (!parseCommandArgs(pi, ctx, "report", raw)) return;
			ctx.ui.setStatus("qa", "⏳ reporting…");
			const result = runReport(ctx.cwd);
			surface(pi, ctx, "qa-report", result);
		},
	});
}
