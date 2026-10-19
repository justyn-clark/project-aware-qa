import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { digest } from "../agent-evals/config.js";
import { outputDirectory } from "../agent-evals/run.js";
import type { StepResult } from "../core.js";
import { notifyProgress, type ProgressListener } from "../progress.js";
import { checkBrowser } from "./browser.js";
import { type AcceptancePlan, parseAcceptancePlan } from "./config.js";
import { checkHttp, checkMcp, type Observation, sameOrigin } from "./network.js";
import { captureTarget, localPath, readBounded } from "./targets.js";

export interface BehaviorResult {
	id: string;
	criterion: string;
	expected: string;
	status: "passed" | "failed" | "unverified";
	observation: string;
	evidence?: unknown;
}
export interface AcceptanceReport {
	version: 1;
	kind: "acceptance";
	planHash: string;
	target: ReturnType<typeof captureTarget>;
	startedAt: string;
	completedAt?: string;
	stale: boolean;
	cancelled: boolean;
	criteria: Array<{
		id: string;
		expected: string;
		source: AcceptancePlan["criteria"][number]["source"];
		sourceHash?: string;
		status: "passed" | "failed" | "unverified" | "inferred";
		reason?: string;
	}>;
	checks: BehaviorResult[];
}
export interface AcceptanceOptions {
	plan?: string;
	allowNetwork?: boolean;
	allowToolCalls?: boolean;
	browserModule?: string;
	authEnv?: string;
	signal?: AbortSignal;
	onProgress?: ProgressListener;
}
function markdown(report: AcceptanceReport): string {
	const literal = (s: string) => s.replace(/[\r\n]/g, " ").replace(/`/g, "'");
	return `# Acceptance evidence\n\nTarget: ${literal(report.target.value)}\nDeclared build: ${literal(report.target.buildId ?? "not asserted")}\nState: ${report.stale ? "stale" : report.cancelled ? "cancelled" : report.completedAt ? "completed" : "running"}\n\n${report.criteria
		.map(
			(c) =>
				`## ${c.id}: ${c.status}\n\nExpected: ${c.expected}\n\nSource: ${c.source.kind}${c.source.path ? ` (${c.source.path})` : ""}\n\n> ${c.source.quote.replace(/\n/g, "\n> ")}\n\n${c.reason ?? ""}\n\n${report.checks
					.filter((t) => t.criterion === c.id)
					.map(
						(t) =>
							`- ${t.id}: ${t.status}. Observed: ${literal(t.observation)}. Evidence: report.json checks/${t.id}.`,
					)
					.join("\n")}`,
		)
		.join("\n\n")}\n`;
}
export async function runAcceptance(
	root: string,
	options: AcceptanceOptions = {},
): Promise<StepResult> {
	const planPath = localPath(root, options.plan ?? ".qa-acceptance.json");
	const raw = readBounded(planPath),
		plan = parseAcceptancePlan(JSON.parse(raw.toString()));
	if (plan.target.kind === "url" && !options.allowNetwork)
		throw new Error("URL targets require --allow-network; no request was sent");
	const headers: Record<string, string> = {};
	if (options.authEnv) {
		if (!/^[A-Z][A-Z0-9_]*$/.test(options.authEnv) || !process.env[options.authEnv])
			throw new Error("Missing or invalid auth environment variable");
		headers.Authorization = `Bearer ${process.env[options.authEnv]}`;
	}
	const secret = options.authEnv ? process.env[options.authEnv] : undefined;
	const redact = (s: string) => (secret ? s.split(secret).join("[REDACTED]") : s);
	const output = outputDirectory(root, "acceptance");
	const started = Date.now();
	const signal = AbortSignal.any([
		...(options.signal ? [options.signal] : []),
		AbortSignal.timeout(plan.timeoutMs),
	]);
	const report: AcceptanceReport = {
		version: 1,
		kind: "acceptance",
		planHash: digest(raw),
		target: captureTarget(root, plan.target),
		startedAt: new Date().toISOString(),
		stale: false,
		cancelled: false,
		criteria: [],
		checks: [],
	};
	const reportPath = join(output, "report.json"),
		markdownPath = join(output, "report.md");
	const persist = () => {
		const text = redact(JSON.stringify(report, null, 2));
		writeFileSync(reportPath, text);
		writeFileSync(`${reportPath}.sha256`, digest(text));
		writeFileSync(markdownPath, redact(markdown(report)));
	};
	const progress = (stage: string, task?: string) => {
		const event = {
			stage,
			task,
			elapsedMs: Date.now() - started,
			remainingMs: Math.max(0, plan.timeoutMs - (Date.now() - started)),
		};
		appendFileSync(join(output, "progress.jsonl"), `${JSON.stringify(event)}\n`);
		notifyProgress(options.onProgress, event);
	};
	for (const criterion of plan.criteria) {
		const row: AcceptanceReport["criteria"][number] = { ...criterion, status: "unverified" };
		if (criterion.source.path) {
			try {
				const text = readBounded(localPath(root, criterion.source.path));
				row.sourceHash = digest(text);
				if (!text.toString().includes(criterion.source.quote))
					row.reason = "Source quote not found verbatim";
			} catch (error) {
				row.reason = String(error);
			}
		}
		if (criterion.source.kind === "inferred")
			row.reason = "Inferred expectations do not establish requested acceptance";
		report.criteria.push(row);
	}
	persist();
	progress("starting");
	let active: string | undefined;
	const heartbeat = setInterval(
		() =>
			notifyProgress(options.onProgress, {
				stage: "running",
				task: active,
				elapsedMs: Date.now() - started,
				remainingMs: Math.max(0, plan.timeoutMs - (Date.now() - started)),
			}),
		1000,
	);
	heartbeat.unref();
	try {
		for (const check of plan.checks) {
			active = check.id;
			progress("checking", check.id);
			const criterion = report.criteria.find((c) => c.id === check.criterion);
			const row: BehaviorResult = {
				id: check.id,
				criterion: check.criterion,
				expected: criterion?.expected ?? "",
				status: "unverified",
				observation: "Not executed",
			};
			report.checks.push(row);
			try {
				signal.throwIfAborted();
				if (criterion?.reason && criterion.source.kind !== "inferred")
					throw new Error(criterion.reason);
				let observed: Observation;
				if (check.kind === "file") {
					const path =
						plan.target.kind === "directory"
							? `${plan.target.value}/${check.path ?? ""}`
							: plan.target.value;
					const captured = report.target.files?.some(
						(f) => f.path === (plan.target.kind === "directory" ? check.path : plan.target.value),
					);
					if (!captured) throw new Error("File excluded from target capture or absent");
					const bytes = readBounded(localPath(root, path));
					observed = {
						passed: bytes.toString().includes(check.contains as string),
						observation: `File content ${bytes.toString().includes(check.contains as string) ? "matches" : "does not match"} expected text`,
						evidence: { path, hash: digest(bytes) },
					};
				} else if (check.kind === "http")
					observed = await checkHttp(plan.target.value, check, signal, headers);
				else if (check.kind === "mcp")
					observed = await checkMcp(
						sameOrigin(plan.target.value, check.path),
						check,
						signal,
						headers,
						!!options.allowToolCalls,
					);
				else
					observed = await checkBrowser(
						plan.target.value,
						check,
						signal,
						options.browserModule,
						!!options.allowToolCalls,
					);
				signal.throwIfAborted();
				row.status = observed.passed ? "passed" : "failed";
				row.observation = observed.observation;
				row.evidence = observed.evidence;
			} catch (error) {
				row.observation = String(error);
			}
			persist();
			progress("checked", check.id);
		}
	} finally {
		clearInterval(heartbeat);
	}
	report.cancelled = signal.aborted;
	try {
		report.stale =
			digest(readBounded(planPath)) !== report.planHash ||
			(plan.target.kind !== "url" && captureTarget(root, plan.target).hash !== report.target.hash);
		for (const criterion of report.criteria)
			if (
				criterion.sourceHash &&
				criterion.source.path &&
				digest(readBounded(localPath(root, criterion.source.path))) !== criterion.sourceHash
			)
				report.stale = true;
	} catch {
		report.stale = true;
	}
	for (const criterion of report.criteria) {
		const checks = report.checks.filter((c) => c.criterion === criterion.id);
		criterion.status =
			criterion.source.kind === "inferred"
				? "inferred"
				: report.stale ||
						criterion.reason ||
						!checks.length ||
						checks.some((c) => c.status === "unverified")
					? "unverified"
					: checks.some((c) => c.status === "failed")
						? "failed"
						: "passed";
		if (!checks.length) criterion.reason = "No checks cover this criterion";
	}
	report.completedAt = new Date().toISOString();
	persist();
	progress(report.cancelled ? "cancelled" : "complete");
	const ok =
		!report.stale && !report.cancelled && report.criteria.every((c) => c.status === "passed");
	return {
		ok,
		outcome: ok
			? "passed"
			: report.criteria.some((c) => c.status === "failed")
				? "failed"
				: "incomplete",
		summary: `${report.criteria.filter((c) => c.status === "passed").length}/${report.criteria.length} acceptance criteria verified${report.stale ? "; source or target changed" : ""}${report.cancelled ? "; cancelled or timed out" : ""}.`,
		writtenFiles: [reportPath, markdownPath, `${reportPath}.sha256`],
	};
}
