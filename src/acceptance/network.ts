import { digest } from "../agent-evals/config.js";
import { type AcceptanceCheck, httpUrl, record } from "./config.js";

export interface Observation {
	passed: boolean;
	observation: string;
	evidence: unknown;
}
export function sameOrigin(base: string, path?: string): string {
	const url = httpUrl(new URL(path ?? base, base).href);
	if (new URL(url).origin !== new URL(base).origin)
		throw new Error("Check URL must have the target origin");
	return url;
}
export async function boundedFetch(
	url: string,
	signal: AbortSignal,
	options: { method?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; text: string; headers: Headers }> {
	const response = await fetch(url, { ...options, redirect: "manual", signal });
	const reader = response.body?.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		if (reader)
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.length;
				if (size > 1024 * 1024) throw new Error("Response exceeds 1 MiB");
				chunks.push(value);
			}
	} finally {
		await reader?.cancel();
	}
	if (response.status >= 300 && response.status < 400)
		throw new Error("Redirects are not followed; specify the final target URL");
	return {
		status: response.status,
		text: Buffer.concat(chunks).toString("utf8"),
		headers: response.headers,
	};
}
export function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.entries(value)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
			.join(",")}}`;
	return JSON.stringify(value);
}
function validateSchema(schema: unknown, depth = 0): void {
	if (depth > 12) throw new Error("Schema nesting exceeds limit");
	const s = record(schema, [
		"type",
		"properties",
		"required",
		"additionalProperties",
		"items",
		"enum",
		"description",
		"title",
		"$schema",
		"default",
	]);
	if (
		!["object", "array", "string", "number", "integer", "boolean", "null"].includes(String(s.type))
	)
		throw new Error("Unsupported schema type");
	if (
		s.required !== undefined &&
		(!Array.isArray(s.required) || s.required.some((v) => typeof v !== "string"))
	)
		throw new Error("Malformed required fields");
	if (s.additionalProperties !== undefined && typeof s.additionalProperties !== "boolean")
		throw new Error("Unsupported additionalProperties schema");
	if (s.enum !== undefined && (!Array.isArray(s.enum) || !s.enum.length))
		throw new Error("Malformed enum");
	if (s.properties !== undefined)
		for (const value of Object.values(record(s.properties))) validateSchema(value, depth + 1);
	if (s.items !== undefined) validateSchema(s.items, depth + 1);
}
/** Deliberately bounded schema dialect; unsupported validation keywords are not guessed. */
export function schemaIssues(schema: unknown, input: unknown, depth = 0): string[] {
	if (depth === 0) validateSchema(schema);
	if (depth > 12) throw new Error("Schema nesting exceeds limit");
	const s = record(schema, [
		"type",
		"properties",
		"required",
		"additionalProperties",
		"items",
		"enum",
		"description",
		"title",
		"$schema",
		"default",
	]);
	if (
		!["object", "array", "string", "number", "integer", "boolean", "null"].includes(String(s.type))
	)
		throw new Error("Unsupported schema type");
	const matches =
		s.type === "object"
			? !!input && typeof input === "object" && !Array.isArray(input)
			: s.type === "array"
				? Array.isArray(input)
				: s.type === "null"
					? input === null
					: s.type === "integer"
						? Number.isInteger(input)
						: s.type === "number"
							? typeof input === "number" && Number.isFinite(input)
							: typeof input === s.type;
	if (!matches) return ["Input type differs from schema"];
	const issues: string[] = [];
	if (s.enum !== undefined) {
		if (!Array.isArray(s.enum)) throw new Error("Malformed enum");
		if (!s.enum.some((v) => canonical(v) === canonical(input))) issues.push("Input not in enum");
	}
	if (s.type === "object") {
		const props = s.properties === undefined ? {} : record(s.properties);
		const value = record(input);
		if (
			s.required !== undefined &&
			(!Array.isArray(s.required) || s.required.some((v) => typeof v !== "string"))
		)
			throw new Error("Malformed required fields");
		for (const key of (s.required ?? []) as string[])
			if (!Object.hasOwn(value, key)) issues.push(`Missing ${key}`);
		if (s.additionalProperties !== undefined && typeof s.additionalProperties !== "boolean")
			throw new Error("Unsupported additionalProperties schema");
		for (const [key, v] of Object.entries(value)) {
			if (Object.hasOwn(props, key))
				issues.push(...schemaIssues(props[key], v, depth + 1).map((p) => `${key}: ${p}`));
			else if (s.additionalProperties === false) issues.push(`Unknown ${key}`);
		}
	}
	if (s.type === "array" && s.items)
		for (const item of input as unknown[]) issues.push(...schemaIssues(s.items, item, depth + 1));
	return issues;
}
export async function checkHttp(
	base: string,
	check: AcceptanceCheck,
	signal: AbortSignal,
	headers: Record<string, string>,
): Promise<Observation> {
	const url = sameOrigin(base, check.path);
	const response = await boundedFetch(url, signal, { headers });
	return {
		passed:
			(check.status === undefined || response.status === check.status) &&
			(check.contains === undefined || response.text.includes(check.contains)),
		observation: `HTTP ${response.status}; body SHA-256 ${digest(response.text)}`,
		evidence: {
			url,
			status: response.status,
			bodyHash: digest(response.text),
			bodyExcerpt: response.text.slice(0, 4096),
			excerptTruncated: response.text.length > 4096,
			etag: response.headers.get("etag"),
			buildId: response.headers.get("x-build-id"),
		},
	};
}
export async function checkMcp(
	base: string,
	check: AcceptanceCheck,
	signal: AbortSignal,
	headers: Record<string, string>,
	allowCalls: boolean,
): Promise<Observation> {
	let id = 0,
		session: string | undefined;
	const protocol = "2025-11-25";
	async function rpc(
		method: string,
		params: unknown,
		notification = false,
	): Promise<Record<string, unknown>> {
		const requestId = notification ? undefined : ++id;
		const response = await boundedFetch(base, signal, {
			method: "POST",
			headers: {
				...headers,
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				"MCP-Protocol-Version": protocol,
				...(session ? { "Mcp-Session-Id": session } : {}),
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
		});
		if (response.status < 200 || response.status >= 300)
			throw new Error(`MCP HTTP ${response.status}`);
		session = response.headers.get("mcp-session-id") ?? session;
		if (notification) return {};
		if (!response.headers.get("content-type")?.includes("application/json"))
			throw new Error("MCP SSE responses unsupported by this bounded JSON transport");
		const body = record(JSON.parse(response.text));
		if (body.jsonrpc !== "2.0" || body.id !== requestId)
			throw new Error("Mismatched MCP response identity");
		if (body.error) {
			const error = record(body.error);
			if (method === "tools/call" && error.code === -32602) return { isError: true };
			throw new Error(`MCP protocol error ${String(error.code)}`);
		}
		return record(body.result);
	}
	try {
		const initialized = await rpc("initialize", {
			protocolVersion: protocol,
			capabilities: {},
			clientInfo: { name: "project-aware-qa", version: "1" },
		});
		if (initialized.protocolVersion !== protocol)
			throw new Error("Server did not negotiate supported MCP 2025-11-25 protocol");
		await rpc("notifications/initialized", {}, true);
		const tools: Record<string, unknown>[] = [];
		let cursor: unknown;
		for (let page = 0; page < 10; page++) {
			const list = await rpc("tools/list", cursor ? { cursor } : {});
			if (!Array.isArray(list.tools) || tools.length + list.tools.length > 1000)
				throw new Error("Invalid or oversized MCP tool list");
			tools.push(...list.tools.map((t) => record(t)));
			cursor = list.nextCursor;
			if (!cursor) break;
			if (page === 9) throw new Error("MCP pagination exceeds limit");
		}
		if (
			tools.some((t) => typeof t.name !== "string") ||
			new Set(tools.map((t) => t.name)).size !== tools.length
		)
			throw new Error("Invalid or duplicate tool names");
		const tool = tools.find((t) => t.name === check.tool);
		const manifestHash = digest(canonical(tools));
		if (!tool)
			return {
				passed: false,
				observation: "Required tool not discovered",
				evidence: { manifestHash },
			};
		if (typeof tool.description !== "string" || !tool.description.trim())
			return { passed: false, observation: "Tool lacks description", evidence: { manifestHash } };
		if (record(tool.inputSchema).type !== "object")
			throw new Error("MCP tool input schema must describe an object");
		if (check.schema && canonical(check.schema) !== canonical(tool.inputSchema))
			return {
				passed: false,
				observation: "Tool schema differs from expected schema",
				evidence: { manifestHash },
			};
		if (check.input === undefined)
			return {
				passed: true,
				observation: "Tool discovered with description and schema",
				evidence: { manifestHash, tool },
			};
		if (!allowCalls) throw new Error("Tool invocation requires --allow-tool-calls");
		const issues = schemaIssues(tool.inputSchema, check.input);
		if (!!check.expectError !== issues.length > 0)
			throw new Error("Input validity does not match the declared positive/negative case");
		const observe = async () =>
			check.observePath
				? boundedFetch(sameOrigin(base, check.observePath), signal, { headers })
				: undefined;
		const before = await observe();
		const called = await rpc("tools/call", { name: check.tool, arguments: check.input });
		const after = await observe();
		const observed =
			!check.observePath ||
			(!!after &&
				after.status >= 200 &&
				after.status < 300 &&
				(!check.observeContains || after.text.includes(check.observeContains)));
		const unchanged =
			!check.readOnly ||
			(!!before && !!after && before.status === after.status && before.text === after.text);
		return {
			passed: !!called.isError === !!check.expectError && observed && unchanged,
			observation: `Tool ${called.isError ? "rejected input" : "returned"}; independent observation ${observed && unchanged ? "matched" : "did not match"}`,
			evidence: {
				manifestHash,
				inputIssues: issues,
				resultHash: digest(canonical(called)),
				resultExcerpt: canonical(called).slice(0, 4096),
				tool,
				beforeExcerpt: before?.text.slice(0, 4096),
				afterExcerpt: after?.text.slice(0, 4096),
				beforeHash: before ? digest(before.text) : undefined,
				afterHash: after ? digest(after.text) : undefined,
			},
		};
	} finally {
		if (session) {
			try {
				await boundedFetch(base, AbortSignal.timeout(2000), {
					method: "DELETE",
					headers: { ...headers, "Mcp-Session-Id": session, "MCP-Protocol-Version": protocol },
				});
			} catch {
				/* Session cleanup is best effort; request remains bounded. */
			}
		}
	}
}
