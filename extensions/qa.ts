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
import { runPlan, runReport, runScan, runVerify, type StepResult } from "../src/core.js";

const QA_MESSAGE_TYPE = "qa-result";

function surface(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	title: string,
	result: StepResult,
): void {
	const icon = result.ok ? "✅" : "❌";
	const files = result.writtenFiles.map((f) => `- \`${f}\``).join("\n");
	const content =
		`${icon} **${title}**\n\n${result.summary}\n` +
		(files ? `\n**Wrote:**\n${files}\n` : "") +
		(result.error ? `\n**Error:**\n\`\`\`\n${result.error}\n\`\`\`\n` : "");
	pi.sendMessage({ customType: QA_MESSAGE_TYPE, content, display: true });
	ctx.ui.notify(`${title}: ${result.summary}`.slice(0, 200), result.ok ? "info" : "error");
	ctx.ui.setStatus("qa", `${icon} ${title}`);
}

export interface VerifyFlags {
	scope?: string;
	runInstall: boolean;
	runTests: boolean;
	runScreenshots: boolean;
	startDevServer: boolean;
	baseUrl?: string;
	maxRoutes?: number;
	timeoutMs?: number;
}

export function parseVerifyArgs(raw: string): VerifyFlags {
	const tokens = raw.trim().split(/\s+/).filter(Boolean);
	const flags: VerifyFlags = {
		runInstall: false,
		runTests: false,
		runScreenshots: false,
		startDevServer: false,
	};
	// Consume the next token as a value only when it exists and isn't another flag.
	const takeValue = (i: number): string | undefined => {
		const next = tokens[i + 1];
		return next !== undefined && !next.startsWith("--") ? next : undefined;
	};
	const takeNumber = (i: number): number | undefined => {
		const v = takeValue(i);
		if (v === undefined) return undefined;
		const n = Number(v);
		return Number.isFinite(n) ? n : undefined;
	};
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i] as string;
		switch (t) {
			case "--install":
				flags.runInstall = true;
				break;
			case "--tests":
				flags.runTests = true;
				break;
			case "--screenshots":
				flags.runScreenshots = true;
				break;
			case "--start-dev-server":
				flags.startDevServer = true;
				break;
			case "--base-url": {
				const v = takeValue(i);
				if (v !== undefined) {
					flags.baseUrl = v;
					i++;
				}
				break;
			}
			case "--max-routes": {
				const n = takeNumber(i);
				if (n !== undefined) {
					flags.maxRoutes = n;
					i++;
				}
				break;
			}
			case "--timeout": {
				const n = takeNumber(i);
				if (n !== undefined) {
					flags.timeoutMs = n;
					i++;
				}
				break;
			}
			default:
				// Unknown --flags are ignored; the first bare token is the scope.
				if (!t.startsWith("--") && !flags.scope) flags.scope = t;
		}
	}
	return flags;
}

export default function projectAwareQaExtension(pi: ExtensionAPI): void {
	pi.registerCommand("qa-scan", {
		description:
			"Scan the repo, infer test surfaces, and write .qa/surface-registry.json + reports",
		handler: async (_args, ctx) => {
			ctx.ui.setStatus("qa", "⏳ scanning…");
			ctx.ui.setWorkingMessage("project-aware-qa: scanning repository…");
			const result = runScan(ctx.cwd);
			ctx.ui.setWorkingMessage();
			surface(pi, ctx, "qa-scan", result);
		},
	});

	pi.registerCommand("qa-plan", {
		description: "Turn the surface registry into a risk-scaled test plan (optional [scope])",
		handler: async (args, ctx) => {
			const scope = args.trim() || undefined;
			ctx.ui.setStatus("qa", "⏳ planning…");
			const result = runPlan(ctx.cwd, { scope });
			surface(pi, ctx, `qa-plan${scope ? ` ${scope}` : ""}`, result);
		},
	});

	pi.registerCommand("qa-verify", {
		description:
			"Run safe checks (typecheck/lint/tests/route-probe/screenshots) with evidence. Flags: --install --tests --screenshots --start-dev-server --base-url <url> --max-routes <n> --timeout <ms>",
		handler: async (args, ctx) => {
			const flags = parseVerifyArgs(args);
			ctx.ui.setStatus("qa", "⏳ verifying…");
			ctx.ui.setWorkingMessage("project-aware-qa: running checks…");
			const result = await runVerify({ root: ctx.cwd, ...flags });
			ctx.ui.setWorkingMessage();
			surface(pi, ctx, "qa-verify", result);
		},
	});

	pi.registerCommand("qa-report", {
		description: "Aggregate the registry + verification status into .qa/qa-report.md",
		handler: async (_args, ctx) => {
			ctx.ui.setStatus("qa", "⏳ reporting…");
			const result = runReport(ctx.cwd);
			surface(pi, ctx, "qa-report", result);
		},
	});
}
