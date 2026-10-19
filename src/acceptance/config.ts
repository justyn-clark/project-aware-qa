import { safePath } from "../agent-evals/config.js";

export type SourceKind = "request" | "ticket" | "specification" | "inferred";
export interface Criterion {
	id: string;
	expected: string;
	source: { kind: SourceKind; path?: string; quote: string };
}
export interface AcceptanceCheck {
	id: string;
	criterion: string;
	kind: "file" | "http" | "mcp" | "browser";
	path?: string;
	contains?: string;
	status?: number;
	tool?: string;
	input?: Record<string, unknown>;
	expectError?: boolean;
	schema?: Record<string, unknown>;
	readOnly?: boolean;
	observePath?: string;
	observeContains?: string;
}
export interface AcceptancePlan {
	version: 1;
	target: { kind: "file" | "directory" | "url"; value: string; buildId?: string };
	timeoutMs: number;
	criteria: Criterion[];
	checks: AcceptanceCheck[];
}
export function record(value: unknown, keys?: string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Expected object");
	const data = value as Record<string, unknown>;
	if (keys)
		for (const key of Object.keys(data))
			if (!keys.includes(key)) throw new Error(`Unknown field: ${key}`);
	return data;
}
function text(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || value.length > 64000 || value.includes("\0"))
		throw new Error("Expected bounded nonempty text");
	return value;
}
function id(value: unknown): string {
	const s = text(value);
	if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(s)) throw new Error("Invalid ID");
	return s;
}
export function httpUrl(value: string): string {
	const url = new URL(value);
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash)
		throw new Error("Use an HTTP(S) URL without credentials or fragment");
	return url.href;
}
export function parseAcceptancePlan(value: unknown): AcceptancePlan {
	const v = record(value, ["version", "target", "timeoutMs", "criteria", "checks"]);
	if (v.version !== 1) throw new Error("Unsupported acceptance plan version");
	const target = record(v.target, ["kind", "value", "buildId"]);
	if (!["file", "directory", "url"].includes(String(target.kind)))
		throw new Error("Unsupported target kind");
	const targetValue = text(target.value);
	if (target.kind === "url") httpUrl(targetValue);
	else safePath(targetValue);
	const timeoutMs = v.timeoutMs ?? 30000;
	if (
		typeof timeoutMs !== "number" ||
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs < 1 ||
		timeoutMs > 300000
	)
		throw new Error("timeoutMs must be 1 to 300000");
	if (!Array.isArray(v.criteria) || !v.criteria.length || v.criteria.length > 100)
		throw new Error("Expected 1 to 100 criteria");
	const criteria = v.criteria.map((raw) => {
		const c = record(raw, ["id", "expected", "source"]);
		const source = record(c.source, ["kind", "path", "quote"]);
		if (!["request", "ticket", "specification", "inferred"].includes(String(source.kind)))
			throw new Error("Unknown criterion source");
		const path = source.path === undefined ? undefined : safePath(source.path);
		if (["ticket", "specification"].includes(String(source.kind)) && !path)
			throw new Error("Ticket and specification criteria require a source path");
		return {
			id: id(c.id),
			expected: text(c.expected),
			source: { kind: source.kind as SourceKind, path, quote: text(source.quote) },
		};
	});
	if (new Set(criteria.map((c) => c.id)).size !== criteria.length)
		throw new Error("Duplicate criterion IDs");
	if (!Array.isArray(v.checks) || v.checks.length > 200)
		throw new Error("Expected at most 200 checks");
	const checks = v.checks.map((raw) => {
		const c = record(raw, [
			"id",
			"criterion",
			"kind",
			"path",
			"contains",
			"status",
			"tool",
			"input",
			"expectError",
			"schema",
			"readOnly",
			"observePath",
			"observeContains",
		]);
		if (!["file", "http", "mcp", "browser"].includes(String(c.kind)))
			throw new Error("Unknown check kind");
		const common = ["id", "criterion", "kind"];
		const specific =
			c.kind === "file"
				? ["path", "contains"]
				: c.kind === "http"
					? ["path", "contains", "status"]
					: [
							"path",
							"tool",
							"input",
							"expectError",
							"schema",
							"readOnly",
							"observePath",
							"observeContains",
						];
		for (const key of Object.keys(c))
			if (![...common, ...specific].includes(key))
				throw new Error(`Field ${key} is not supported for ${String(c.kind)} checks`);
		const check: AcceptanceCheck = {
			id: id(c.id),
			criterion: id(c.criterion),
			kind: c.kind as AcceptanceCheck["kind"],
		};
		if (!criteria.some((v) => v.id === check.criterion))
			throw new Error("Check references unknown criterion");
		for (const key of ["path", "contains", "tool", "observePath", "observeContains"] as const)
			if (c[key] !== undefined) check[key] = text(c[key]);
		for (const key of ["expectError", "readOnly"] as const)
			if (c[key] !== undefined) {
				if (typeof c[key] !== "boolean") throw new Error(`${key} must be boolean`);
				check[key] = c[key];
			}
		if (c.input !== undefined) check.input = record(c.input);
		if (c.schema !== undefined) check.schema = record(c.schema);
		if (c.status !== undefined) {
			if (!Number.isInteger(c.status) || Number(c.status) < 100 || Number(c.status) > 599)
				throw new Error("Invalid HTTP status");
			check.status = Number(c.status);
		}
		if (check.kind === "file") {
			if (target.kind === "url" || !check.contains)
				throw new Error("File checks require a local target and contains");
			if (check.path) safePath(check.path);
			if (target.kind === "directory" && !check.path)
				throw new Error("Directory file checks require path");
			if (target.kind === "file" && check.path)
				throw new Error("File targets cannot override path");
		} else if (target.kind !== "url")
			throw new Error("Network/browser checks require a URL target");
		if (check.kind === "http" && check.status === undefined && !check.contains)
			throw new Error("HTTP check needs status or contains");
		if (["mcp", "browser"].includes(check.kind) && !check.tool)
			throw new Error("Interface check needs a tool name");
		if (check.readOnly && check.kind === "mcp" && check.input !== undefined && !check.observePath)
			throw new Error("Read-only MCP calls require an independent observePath");
		if (check.kind === "browser" && check.path)
			throw new Error("Browser uses the target URL; path override unsupported");
		if (check.expectError !== undefined && check.input === undefined)
			throw new Error("expectError requires explicit input");
		if (
			check.kind === "mcp" &&
			check.input !== undefined &&
			!check.expectError &&
			!check.observePath
		)
			throw new Error("Successful MCP calls need an independent observePath");
		if (check.observePath && check.kind === "mcp" && !check.readOnly && !check.observeContains)
			throw new Error("MCP effect checks need observeContains");
		if (
			check.kind === "browser" &&
			check.input !== undefined &&
			!check.expectError &&
			!check.readOnly &&
			!check.observeContains
		)
			throw new Error("Browser effect checks need observeContains");
		return check;
	});
	if (new Set(checks.map((c) => c.id)).size !== checks.length)
		throw new Error("Duplicate check IDs");
	return {
		version: 1,
		target: {
			kind: target.kind as AcceptancePlan["target"]["kind"],
			value: targetValue,
			buildId: target.buildId === undefined ? undefined : text(target.buildId),
		},
		timeoutMs,
		criteria,
		checks,
	};
}
