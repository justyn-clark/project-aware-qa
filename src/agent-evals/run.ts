import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { StepResult } from "../core.js";
import { notifyProgress, type ProgressListener } from "../progress.js";
import { type RunResult, runCommand } from "../verify/commands.js";
import { digest, type EvalSuite, parseAssertions, parseEvalSuite, safePath } from "./config.js";
import {
	allowedChange,
	changes,
	gitSnapshot,
	readTree,
	type Tree,
	treeHash,
	writeTree,
} from "./files.js";

export interface Trial {
	task: string;
	trial: number;
	status: "passed" | "failed" | "inconclusive";
	reason: string;
	durationMs: number;
	changedFiles: string[];
	candidateHash?: string;
}
export interface EvalReport {
	version: 1;
	kind: "agent-eval";
	commit: string;
	sourceHash: string;
	compatibilityHash: string;
	suiteHash: string;
	image: string;
	runner: EvalSuite["agent"];
	network: boolean;
	trials: Trial[];
	controls: Array<{ task: string; valid: boolean; reason: string }>;
	usage: null;
	startedAt: string;
	completedAt?: string;
}
export class ContainerCleanupError extends Error {}

export type ContainerExecutor = (
	command: string[],
	workspace: string,
	bundle: string | undefined,
	prompt: string | undefined,
	timeoutMs: number,
	agent: boolean,
) => Promise<RunResult>;

/** Only this run's UUID-named containers are removed. Never relies on killing the Docker client. */
export function dockerExecutor(
	image: string,
	root: string,
	env: string[],
	network: boolean,
	signal?: AbortSignal,
	commandRunner: typeof runCommand = runCommand,
): ContainerExecutor {
	return async (command, workspace, bundle, prompt, timeoutMs, agent) => {
		const name = `qa-eval-${randomUUID()}`;
		for (const path of [workspace, bundle, prompt].filter(Boolean))
			if (path?.includes(",")) throw new Error("Docker mount paths cannot contain commas");
		const args = [
			"run",
			"--name",
			name,
			"--pull=never",
			"--network",
			agent && network ? "bridge" : "none",
			"--read-only",
			"--cap-drop=ALL",
			"--security-opt=no-new-privileges",
			"--pids-limit=128",
			"--memory=512m",
			"--memory-swap=512m",
			"--log-driver=local",
			"--log-opt=max-size=1m",
			"--log-opt=max-file=1",
			"--log-opt=compress=false",
			"--cpus=1",
			"--user",
			`${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
			"--tmpfs",
			"/tmp:rw,nosuid,nodev,size=64m",
			"--env",
			"HOME=/tmp",
			"--workdir",
			"/workspace",
			"--mount",
			`type=bind,src=${workspace},dst=/workspace`,
		];
		if (bundle) args.push("--mount", `type=bind,src=${bundle},dst=/grader,readonly`);
		if (prompt)
			args.push(
				"--mount",
				`type=bind,src=${prompt},dst=/task.txt,readonly`,
				"--env",
				"QA_TASK_FILE=/task.txt",
			);
		if (agent)
			for (const key of env) {
				if (!process.env[key])
					throw new Error(`Missing declared agent environment variable: ${key}`);
				args.push("--env", key);
			}
		args.push("--entrypoint", command[0] as string, image, ...command.slice(1));
		try {
			return await commandRunner("docker", args, {
				cwd: root,
				timeoutMs,
				signal,
				maxBuffer: 64 * 1024,
			});
		} finally {
			const cleanup = await commandRunner("docker", ["rm", "-f", name], {
				cwd: root,
				timeoutMs: 10000,
			});
			if (cleanup.exitCode !== 0 && !cleanup.stderr.includes("No such container"))
				// biome-ignore lint/correctness/noUnsafeFinally: Failed cleanup must override a successful process result.
				throw new ContainerCleanupError(
					`Container cleanup failed for ${name}; inspect Docker before retrying`,
				);
		}
	};
}
function grade(result: RunResult): ReturnType<typeof parseAssertions> | undefined {
	if (result.timedOut || result.aborted || result.exitCode !== 0) return undefined;
	try {
		return parseAssertions(result.stdout);
	} catch {
		return undefined;
	}
}
function assertionIds(value: ReturnType<typeof parseAssertions>): string {
	return JSON.stringify(value.assertions.map((a) => a.id).sort());
}
export function outputDirectory(root: string, category: string): string {
	const base = realpathSync(root);
	let dir = base;
	for (const part of [".qa", category]) {
		dir = join(dir, part);
		if (existsSync(dir)) {
			if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory())
				throw new Error(`Unsafe output directory: ${dir}`);
		} else mkdirSync(dir, { mode: 0o700 });
	}
	const output = join(dir, randomUUID());
	mkdirSync(output, { mode: 0o700 });
	return output;
}
export async function executeEvaluation(
	suite: EvalSuite,
	source: Tree,
	heldOut: Tree,
	output: string,
	execute: ContainerExecutor,
	signal?: AbortSignal,
	onProgress?: ProgressListener,
	onSnapshot?: (data: Pick<EvalReport, "trials" | "controls">) => void,
): Promise<Pick<EvalReport, "trials" | "controls">> {
	const trials: Trial[] = [];
	const controls: EvalReport["controls"] = [];
	const started = Date.now();
	const deadline = started + suite.totalTimeoutMs;
	let retainedBytes = 0;
	let halted: string | undefined;
	const budget = (limit: number) => {
		if (halted) throw new Error(halted);
		signal?.throwIfAborted();
		const left = deadline - Date.now();
		if (left <= 0) throw new Error("Evaluation total time budget exhausted");
		return Math.min(limit, left);
	};
	const bundle = join(output, "grader");
	// Reference fixes and configuration never appear in the grader bundle either.
	const graderFiles = new Map(
		[...heldOut].filter(([p]) => p.startsWith("grader/")).map(([p, b]) => [p.slice(7), b]),
	);
	if (!graderFiles.size) throw new Error("Suite directory requires a grader/ bundle");
	writeTree(bundle, graderFiles);
	const redact = (text: string) =>
		suite.agent.env.reduce(
			(s, name) =>
				process.env[name] ? s.split(process.env[name] as string).join("[REDACTED]") : s,
			text,
		);
	const evidence = async (
		name: string,
		command: string[],
		tree: Tree,
		agent: boolean,
		prompt?: string,
	) => {
		budget(agent ? suite.timeoutMs : suite.graderTimeoutMs);
		const workspace = join(output, name, "workspace");
		writeTree(workspace, tree);
		const event = () => ({
			stage: agent ? "agent" : "grading",
			task: name,
			command: command[0],
			elapsedMs: Date.now() - started,
			remainingMs: Math.max(0, deadline - Date.now()),
		});
		notifyProgress(onProgress, event());
		const heartbeat = setInterval(() => notifyProgress(onProgress, event()), 1000);
		heartbeat.unref();
		let result: RunResult;
		let cleanupFailed = false;
		try {
			result = await execute(
				command,
				workspace,
				agent ? undefined : bundle,
				prompt,
				budget(agent ? suite.timeoutMs : suite.graderTimeoutMs),
				agent,
			);
		} catch (error) {
			cleanupFailed = error instanceof ContainerCleanupError;
			throw error;
		} finally {
			clearInterval(heartbeat);
			if (!agent && !cleanupFailed) rmSync(workspace, { recursive: true, force: true });
		}
		writeFileSync(
			join(output, name, "execution.json"),
			JSON.stringify(
				{
					exitCode: result.exitCode,
					timedOut: result.timedOut,
					aborted: result.aborted ?? false,
					durationMs: result.durationMs,
					stdout: redact(result.stdout),
					stderr: redact(result.stderr),
				},
				null,
				2,
			),
			{ mode: 0o600 },
		);
		return { result, workspace };
	};
	for (const task of suite.tasks) {
		let ids: string | undefined;
		try {
			const reference = new Map(source);
			const prefix = `${task.reference}/`;
			const fixes = [...heldOut].filter(([p]) => p.startsWith(prefix));
			if (!fixes.length) throw new Error("Reference overlay is empty");
			for (const [p, bytes] of fixes) {
				const target = safePath(p.slice(prefix.length));
				if (!allowedChange(target, task.allowedPaths))
					throw new Error(`Reference exceeds edit boundary: ${target}`);
				reference.set(target, bytes);
			}
			const noop = grade(
				(await evidence(`${task.id}-control-unchanged`, task.grader, source, false)).result,
			);
			const oracle = grade(
				(await evidence(`${task.id}-control-reference`, task.grader, reference, false)).result,
			);
			if (
				!noop ||
				!oracle ||
				noop.assertions.every((a) => a.passed) ||
				!oracle.assertions.every((a) => a.passed) ||
				assertionIds(noop) !== assertionIds(oracle)
			)
				throw new Error(
					"Controls require identical assertions, an unchanged failure, and a passing reference",
				);
			ids = assertionIds(oracle);
			controls.push({ task: task.id, valid: true, reason: "Unchanged fails; reference passes" });
		} catch (error) {
			if (error instanceof ContainerCleanupError) halted = error.message;
			controls.push({ task: task.id, valid: false, reason: String(error) });
		}
		onSnapshot?.({ trials, controls });
		for (let i = 1; i <= suite.trials; i++) {
			const trial: Trial = {
				task: task.id,
				trial: i,
				status: "inconclusive",
				reason: "Invalid grader controls",
				durationMs: 0,
				changedFiles: [],
			};
			trials.push(trial);
			if (!ids) {
				onSnapshot?.({ trials, controls });
				continue;
			}
			const start = Date.now();
			try {
				const prompt = join(output, `${task.id}-${i}-prompt.txt`);
				writeFileSync(prompt, task.prompt, { mode: 0o600 });
				const agent = await evidence(
					`${task.id}-${i}-agent`,
					suite.agent.command,
					source,
					true,
					prompt,
				);
				if (agent.result.aborted) throw new Error("Agent cancelled");
				if (agent.result.timedOut) {
					trial.status = "failed";
					trial.reason = "Agent exceeded time budget";
					continue;
				}
				if ([125, 126, 127].includes(agent.result.exitCode ?? 125))
					throw new Error("Agent container could not execute");
				if (agent.result.exitCode !== 0) {
					trial.status = "failed";
					trial.reason = "Agent exited unsuccessfully";
					continue;
				}
				let candidate: Tree;
				try {
					candidate = readTree(agent.workspace);
				} catch (error) {
					trial.status = "failed";
					trial.reason = `Candidate violates snapshot constraints: ${String(error)}`;
					continue;
				}
				trial.changedFiles = changes(source, candidate);
				trial.candidateHash = treeHash(candidate);
				const patch = trial.changedFiles.map((path) => {
					const bytes = candidate.get(path);
					const keep = bytes && retainedBytes + bytes.length <= 16 * 1024 * 1024;
					if (keep) retainedBytes += bytes.length;
					return {
						path,
						deleted: !bytes,
						hash: bytes ? digest(bytes) : undefined,
						contentBase64: keep ? bytes.toString("base64") : undefined,
						omitted: !!bytes && !keep,
					};
				});
				writeFileSync(join(output, `${task.id}-${i}-agent`, "changes.json"), JSON.stringify(patch));
				if (trial.changedFiles.some((p) => !allowedChange(p, task.allowedPaths))) {
					trial.status = "failed";
					trial.reason = "Changes outside allowed paths";
					continue;
				}
				const judged = grade(
					(await evidence(`${task.id}-${i}-grade`, task.grader, candidate, false)).result,
				);
				if (!judged || assertionIds(judged) !== ids)
					throw new Error("Missing, invalid, or inconsistent grader assertions");
				trial.status = judged.assertions.every((a) => a.passed) ? "passed" : "failed";
				trial.reason =
					trial.status === "passed"
						? "Independent assertions passed within edit boundaries"
						: "Independent assertions failed";
			} catch (error) {
				if (error instanceof ContainerCleanupError) halted = error.message;
				trial.reason = String(error);
			} finally {
				trial.durationMs = Date.now() - start;
				if (!halted)
					rmSync(join(output, `${task.id}-${i}-agent`, "workspace"), {
						recursive: true,
						force: true,
					});
				onSnapshot?.({ trials, controls });
			}
		}
	}
	return { trials, controls };
}
export async function runAgentEval(
	root: string,
	options: {
		suite?: string;
		execute?: boolean;
		allowNetwork?: boolean;
		signal?: AbortSignal;
		onProgress?: ProgressListener;
	} = {},
): Promise<StepResult> {
	if (!options.execute)
		throw new Error("Agent execution requires --execute; review the suite and image first");
	root = realpathSync(root);
	const relative = safePath(options.suite ?? ".qa-evals");
	const suiteDir = resolve(root, relative);
	if (
		!realpathSync(suiteDir).startsWith(`${realpathSync(root)}${sep}`) ||
		realpathSync(suiteDir) !== suiteDir
	)
		throw new Error("Suite directory must be contained and cannot use symlinks");
	const heldOut = readTree(suiteDir);
	const raw = heldOut.get("suite.json");
	if (!raw) throw new Error("Missing suite.json");
	const suite = parseEvalSuite(JSON.parse(raw.toString()));
	const snapshot = gitSnapshot(root, relative);
	const inspect = await runCommand(
		"docker",
		["image", "inspect", suite.image, "--format", "{{.Id}}"],
		{ cwd: root, timeoutMs: 10000, signal: options.signal },
	);
	if (inspect.exitCode !== 0 || !/^sha256:[a-f0-9]{64}$/.test(inspect.stdout.trim()))
		throw new Error("Pinned Docker image unavailable locally; no image was pulled");
	const output = outputDirectory(root, "agent-evals");
	writeFileSync(join(output, "configuration.json"), JSON.stringify(suite, null, 2), {
		mode: 0o600,
	});
	const report: EvalReport = {
		version: 1,
		kind: "agent-eval",
		commit: snapshot.commit,
		sourceHash: treeHash(snapshot.tree),
		compatibilityHash: digest(
			JSON.stringify({
				suite,
				heldOut: treeHash(heldOut),
				image: inspect.stdout.trim(),
				network: !!options.allowNetwork,
				platform: process.platform,
				arch: process.arch,
				harness: 1,
			}),
		),
		suiteHash: treeHash(heldOut),
		image: inspect.stdout.trim(),
		runner: { ...suite.agent, command: suite.agent.command.map(() => "[CONFIGURED]") },
		network: !!options.allowNetwork,
		trials: [],
		controls: [],
		usage: null,
		startedAt: new Date().toISOString(),
	};
	writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2));
	Object.assign(
		report,
		await executeEvaluation(
			suite,
			snapshot.tree,
			heldOut,
			output,
			dockerExecutor(report.image, root, suite.agent.env, report.network, options.signal),
			options.signal,
			options.onProgress,
			(snapshot) => {
				Object.assign(report, snapshot);
				writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2));
			},
		),
	);
	report.completedAt = new Date().toISOString();
	const content = JSON.stringify(report, null, 2);
	const path = join(output, "report.json");
	writeFileSync(path, content);
	writeFileSync(`${path}.sha256`, digest(content));
	const passed = report.trials.filter((t) => t.status === "passed").length;
	const incomplete = report.trials.some((t) => t.status === "inconclusive");
	return {
		ok: passed === report.trials.length && !incomplete,
		outcome: incomplete ? "incomplete" : passed === report.trials.length ? "passed" : "failed",
		summary: `${passed}/${report.trials.length} verified completions. Token and cost usage unavailable.`,
		writtenFiles: [path, `${path}.sha256`],
	};
}
