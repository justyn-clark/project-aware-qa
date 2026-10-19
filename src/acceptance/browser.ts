import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { digest } from "../agent-evals/config.js";
import type { AcceptanceCheck } from "./config.js";
import { canonical, type Observation, schemaIssues } from "./network.js";

interface Page {
	goto(url: string): Promise<unknown>;
	innerText(selector: string): Promise<string>;
	setDefaultTimeout(ms: number): void;
	evaluate<T, A>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T>;
}
interface Browser {
	newPage(): Promise<Page>;
	close(): Promise<void>;
}
interface Tool {
	name: string;
	description?: string;
	inputSchema?: unknown;
}
interface BrowserContext {
	document: {
		modelContext?: {
			getTools(): Promise<Tool[]>;
			executeTool(tool: Tool, input: Record<string, unknown>): Promise<unknown>;
		};
	};
}
export async function checkBrowser(
	url: string,
	check: AcceptanceCheck,
	signal: AbortSignal,
	modulePath: string | undefined,
	allowCalls: boolean,
): Promise<Observation> {
	if (!modulePath)
		throw new Error(
			"Browser checks require --browser-module pointing to an installed Playwright module",
		);
	signal.throwIfAborted();
	const module = await import(pathToFileURL(resolve(modulePath)).href);
	if (!module.chromium?.launch) throw new Error("Browser module does not export chromium.launch");
	const browser: Browser = await module.chromium.launch({
		headless: true,
		timeout: 10000,
		args: ["--enable-features=WebMCPTesting"],
	});
	const close = () => {
		void browser.close().catch(() => {});
	};
	signal.addEventListener("abort", close, { once: true });
	try {
		signal.throwIfAborted();
		const page = await browser.newPage();
		page.setDefaultTimeout(10000);
		await page.goto(url);
		const tools = await page.evaluate(async () => {
			const ctx = (globalThis as unknown as BrowserContext).document.modelContext;
			if (!ctx?.getTools) return null;
			return (await ctx.getTools()).map((t) => ({
				name: t.name,
				description: t.description,
				inputSchema: t.inputSchema,
			}));
		}, undefined);
		if (!tools)
			throw new Error(
				"Browser does not expose document.modelContext.getTools; native WebMCP unavailable",
			);
		if (tools.length > 1000 || JSON.stringify(tools).length > 1024 * 1024)
			throw new Error("Oversized browser tool manifest");
		if (
			tools.some((t) => typeof t.name !== "string") ||
			new Set(tools.map((t) => t.name)).size !== tools.length
		)
			throw new Error("Invalid or duplicate browser tool names");
		const tool = tools.find((t) => t.name === check.tool),
			manifestHash = digest(canonical(tools));
		if (!tool?.description?.trim() || !tool.inputSchema)
			return {
				passed: false,
				observation: "Required tool, description or schema missing",
				evidence: { manifestHash },
			};
		const schema =
			typeof tool.inputSchema === "string" ? JSON.parse(tool.inputSchema) : tool.inputSchema;
		if (check.schema && canonical(check.schema) !== canonical(schema))
			return {
				passed: false,
				observation: "Browser tool schema differs from expected schema",
				evidence: { manifestHash },
			};
		if (check.input === undefined)
			return {
				passed: true,
				observation: "Browser tool discovered",
				evidence: { manifestHash, tool },
			};
		if (!allowCalls) throw new Error("Tool invocation requires --allow-tool-calls");
		const issues = schemaIssues(schema, check.input);
		if (!!check.expectError !== issues.length > 0)
			throw new Error("Input validity does not match positive/negative case");
		const selector = check.observePath ?? "body";
		const before = await page.innerText(selector);
		if (before.length > 1024 * 1024) throw new Error("DOM observation exceeds 1 MiB");
		const called = await page.evaluate(
			async ({ name, input }) => {
				const ctx = (globalThis as unknown as BrowserContext).document.modelContext;
				if (!ctx) throw new Error("WebMCP disappeared");
				const selected = (await ctx.getTools()).find((t) => t.name === name);
				if (!selected) throw new Error("Tool disappeared");
				try {
					await ctx.executeTool(selected, input);
					return { error: false };
				} catch {
					return { error: true };
				}
			},
			{ name: check.tool, input: check.input },
		);
		const after = await page.innerText(selector);
		if (after.length > 1024 * 1024) throw new Error("DOM observation exceeds 1 MiB");
		const matched =
			(!check.observeContains || after.includes(check.observeContains)) &&
			(!check.readOnly || before === after);
		return {
			passed: called.error === !!check.expectError && matched,
			observation: `Browser tool ${called.error ? "threw" : "returned"}; DOM observation ${matched ? "matched" : "did not match"}`,
			evidence: {
				manifestHash,
				inputIssues: issues,
				tool,
				beforeExcerpt: before.slice(0, 4096),
				afterExcerpt: after.slice(0, 4096),
				beforeHash: digest(before),
				afterHash: digest(after),
				selector,
			},
		};
	} finally {
		signal.removeEventListener("abort", close);
		await browser.close();
	}
}
