import { createHash } from "node:crypto";

export interface EvalTask {
	id: string;
	prompt: string;
	allowedPaths: string[];
	grader: string[];
	reference: string;
}
export interface EvalSuite {
	version: 1;
	image: string;
	agent: { id: string; model: string; command: string[]; env: string[] };
	trials: number;
	timeoutMs: number;
	graderTimeoutMs: number;
	totalTimeoutMs: number;
	tasks: EvalTask[];
}
export function digest(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Expected object");
	const result = value as Record<string, unknown>;
	for (const key of Object.keys(result))
		if (!keys.includes(key)) throw new Error(`Unknown field: ${key}`);
	return result;
}
function text(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || [...value].some((c) => c.charCodeAt(0) < 32))
		throw new Error("Expected nonempty single-line text");
	return value;
}
function integer(value: unknown, max: number): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max)
		throw new Error(`Expected integer from 1 to ${max}`);
	return value;
}
function strings(value: unknown, empty = false): string[] {
	if (!Array.isArray(value) || (!empty && !value.length) || value.length > 100)
		throw new Error("Expected bounded string array");
	return value.map(text);
}
export function safePath(value: unknown): string {
	const path = text(value);
	if (
		path.startsWith("/") ||
		/[\\:*?,]/.test(path) ||
		path.split("/").some((p) => !p || p === "." || p === ".." || p === ".git" || p === ".qa")
	)
		throw new Error(`Unsafe relative path: ${path}`);
	return path;
}
export function parseEvalSuite(value: unknown): EvalSuite {
	const v = object(value, [
		"version",
		"image",
		"agent",
		"trials",
		"timeoutMs",
		"graderTimeoutMs",
		"totalTimeoutMs",
		"tasks",
	]);
	if (v.version !== 1) throw new Error("Unsupported evaluation suite version");
	const image = text(v.image);
	if (!/^(sha256:[a-f0-9]{64}|[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64})$/.test(image))
		throw new Error("Image must use a full sha256 ID or digest");
	const a = object(v.agent, ["id", "model", "command", "env"]);
	const env = strings(a.env ?? [], true);
	if (env.some((e) => !/^[A-Z][A-Z0-9_]*$/.test(e)))
		throw new Error("Invalid agent environment name");
	if (!Array.isArray(v.tasks) || !v.tasks.length || v.tasks.length > 20)
		throw new Error("Expected 1 to 20 tasks");
	const tasks = v.tasks.map((raw) => {
		const t = object(raw, ["id", "prompt", "allowedPaths", "grader", "reference"]);
		const id = text(t.id);
		if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error("Invalid task ID");
		if (typeof t.prompt !== "string" || !t.prompt.trim() || t.prompt.length > 64000)
			throw new Error("Invalid task prompt");
		return {
			id,
			prompt: t.prompt,
			allowedPaths: strings(t.allowedPaths).map(safePath),
			grader: strings(t.grader),
			reference: safePath(t.reference),
		};
	});
	if (new Set(tasks.map((t) => t.id)).size !== tasks.length) throw new Error("Duplicate task ID");
	return {
		version: 1,
		image,
		agent: { id: text(a.id), model: text(a.model), command: strings(a.command), env },
		trials: integer(v.trials, 10),
		timeoutMs: integer(v.timeoutMs, 3600000),
		graderTimeoutMs: integer(v.graderTimeoutMs, 600000),
		totalTimeoutMs: integer(v.totalTimeoutMs, 14400000),
		tasks,
	};
}
export interface Assertions {
	version: 1;
	assertions: Array<{ id: string; passed: boolean }>;
}
export function parseAssertions(source: string): Assertions {
	const v = object(JSON.parse(source), ["version", "assertions"]);
	if (
		v.version !== 1 ||
		!Array.isArray(v.assertions) ||
		!v.assertions.length ||
		v.assertions.length > 10000
	)
		throw new Error("Grader must return nonempty version 1 assertions");
	const assertions = v.assertions.map((raw) => {
		const a = object(raw, ["id", "passed"]);
		if (typeof a.passed !== "boolean") throw new Error("Invalid assertion result");
		return { id: text(a.id), passed: a.passed };
	});
	if (new Set(assertions.map((a) => a.id)).size !== assertions.length)
		throw new Error("Duplicate assertion ID");
	return { version: 1, assertions };
}
