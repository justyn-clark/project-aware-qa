import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseAcceptancePlan } from "../src/acceptance/config.js";
import { schemaIssues } from "../src/acceptance/network.js";
import { type AcceptanceReport, runAcceptance } from "../src/acceptance/run.js";
import { captureTarget } from "../src/acceptance/targets.js";

function fixture(t: { after: (fn: () => void) => void }): string {
	const root = mkdtempSync(join(tmpdir(), "qa-acceptance-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}
const plan = {
	version: 1,
	target: { kind: "file", value: "app.txt" },
	criteria: [
		{
			id: "welcome",
			expected: "Application includes welcome text",
			source: { kind: "ticket", path: "ticket.md", quote: "Show Welcome" },
		},
	],
	checks: [{ id: "welcome-text", criterion: "welcome", kind: "file", contains: "Welcome" }],
	timeoutMs: 5000,
};
function prepare(root: string, value: unknown = plan): void {
	writeFileSync(join(root, "app.txt"), "Welcome");
	writeFileSync(join(root, "ticket.md"), "Acceptance: Show Welcome");
	writeFileSync(join(root, ".qa-acceptance.json"), JSON.stringify(value));
}
function report(files: string[]): AcceptanceReport {
	return JSON.parse(readFileSync(files[0] as string, "utf8"));
}
async function server(
	t: { after: (fn: () => void) => void },
	handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<string> {
	const instance = createServer(handler);
	t.after(() => {
		instance.closeAllConnections();
		instance.close();
	});
	await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
	const address = instance.address();
	assert.ok(address && typeof address !== "string");
	return `http://127.0.0.1:${address.port}`;
}
test("acceptance strict schemas reject missing provenance and ignored fields", () => {
	assert.equal(parseAcceptancePlan(plan).criteria.length, 1);
	for (const value of [
		{ ...plan, extra: true },
		{
			...plan,
			criteria: [{ ...plan.criteria[0], source: { kind: "ticket", quote: "missing path" } }],
		},
		{ ...plan, checks: [{ ...plan.checks[0], criterion: "missing" }] },
		{ ...plan, checks: [{ ...plan.checks[0], input: {} }] },
		{ ...plan, target: { kind: "url", value: "https://user:pass@example.com" } },
	])
		assert.throws(() => parseAcceptancePlan(value));
});
test("acceptance links evidence to source and captures a non-Git artifact", async (t) => {
	const root = fixture(t);
	prepare(root);
	const stages: string[] = [];
	const result = await runAcceptance(root, { onProgress: (e) => stages.push(e.stage) });
	assert.equal(result.ok, true);
	const r = report(result.writtenFiles);
	assert.equal(r.criteria[0]?.status, "passed");
	assert.ok(r.criteria[0]?.sourceHash);
	assert.ok(r.target.hash);
	assert.equal(r.checks[0]?.status, "passed");
	assert.ok(stages.includes("checking"));
	assert.match(readFileSync(result.writtenFiles[1] as string, "utf8"), /Expected: Application/);
});
test("missing quotes, uncovered criteria and inferred expectations never pass acceptance", async (t) => {
	const root = fixture(t);
	for (const changed of [
		{
			...plan,
			criteria: [
				{
					...plan.criteria[0],
					source: { kind: "ticket", path: "ticket.md", quote: "not present" },
				},
			],
		},
		{ ...plan, checks: [] },
		{
			...plan,
			criteria: [{ ...plan.criteria[0], source: { kind: "inferred", quote: "inferred from app" } }],
		},
	]) {
		prepare(root, changed);
		assert.equal((await runAcceptance(root)).ok, false);
	}
});
test("changed sources invalidate passing results; cancellation preserves a report", async (t) => {
	const root = fixture(t);
	prepare(root);
	const result = await runAcceptance(root, {
		onProgress: (e) => {
			if (e.stage === "checked") writeFileSync(join(root, "ticket.md"), "changed");
		},
	});
	assert.equal(result.ok, false);
	assert.equal(report(result.writtenFiles).stale, true);
	prepare(root);
	const controller = new AbortController();
	controller.abort();
	const cancelled = await runAcceptance(root, { signal: controller.signal });
	assert.equal(report(cancelled.writtenFiles).cancelled, true);
	assert.equal(cancelled.ok, false);
});
test("target capture excludes credentials/dependencies and rejects symlinks", (t) => {
	const root = fixture(t);
	mkdirSync(join(root, "app"));
	writeFileSync(join(root, "app", "index.txt"), "ok");
	writeFileSync(join(root, "app", ".env"), "secret");
	const target = captureTarget(root, { kind: "directory", value: "app" });
	assert.deepEqual(target.excluded, [".env"]);
	assert.equal(target.files?.length, 1);
	symlinkSync(join(root, "app", "index.txt"), join(root, "app", "link"));
	assert.throws(() => captureTarget(root, { kind: "directory", value: "app" }), /symlink/);
});
test("URL targets require opt-in, fingerprint responses and do not follow redirects", async (t) => {
	let calls = 0;
	const url = await server(t, (_req, res) => {
		calls++;
		res.setHeader("X-Build-Id", "build-1");
		res.end("Welcome");
	});
	const root = fixture(t);
	prepare(root, {
		...plan,
		target: { kind: "url", value: url },
		checks: [
			{ id: "welcome-text", criterion: "welcome", kind: "http", status: 200, contains: "Welcome" },
		],
	});
	await assert.rejects(runAcceptance(root), /allow-network/);
	assert.equal(calls, 0);
	const r = await runAcceptance(root, { allowNetwork: true });
	assert.equal(r.ok, true);
	assert.match(JSON.stringify(report(r.writtenFiles).checks), /bodyHash/);
	const redirect = await server(t, (_req, res) => {
		res.writeHead(302, { Location: url });
		res.end();
	});
	prepare(root, {
		...plan,
		target: { kind: "url", value: redirect },
		checks: [{ id: "welcome-text", criterion: "welcome", kind: "http", status: 200 }],
	});
	assert.equal((await runAcceptance(root, { allowNetwork: true })).ok, false);
	assert.equal(calls, 1);
});
test("MCP discovers schemas and checks positive, negative and read-only effects", async (t) => {
	let state = "before",
		calls = 0;
	const schema = {
		type: "object",
		properties: { value: { type: "string" } },
		required: ["value"],
		additionalProperties: false,
	};
	const url = await server(t, (req, res) => {
		if (req.url === "/state") {
			res.end(state);
			return;
		}
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			const rpc = JSON.parse(body);
			if (rpc.method === "notifications/initialized") {
				res.writeHead(202);
				res.end();
				return;
			}
			let result: unknown = {};
			if (rpc.method === "initialize") result = { protocolVersion: "2025-11-25" };
			else if (rpc.method === "tools/list")
				result = { tools: [{ name: "set", description: "Set value", inputSchema: schema }] };
			else if (rpc.method === "tools/call") {
				calls++;
				if (typeof rpc.params.arguments.value !== "string") result = { isError: true };
				else {
					state = rpc.params.arguments.value;
					result = { content: [] };
				}
			}
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
		});
	});
	const root = fixture(t);
	const base = { id: "tool", criterion: "welcome", kind: "mcp", tool: "set", schema };
	prepare(root, { ...plan, target: { kind: "url", value: url }, checks: [base] });
	assert.equal((await runAcceptance(root, { allowNetwork: true })).ok, true);
	assert.equal(calls, 0);
	prepare(root, {
		...plan,
		target: { kind: "url", value: url },
		checks: [
			{ ...base, input: { value: "after" }, observePath: "/state", observeContains: "after" },
		],
	});
	assert.equal((await runAcceptance(root, { allowNetwork: true })).ok, false);
	assert.equal(calls, 0);
	assert.equal((await runAcceptance(root, { allowNetwork: true, allowToolCalls: true })).ok, true);
	prepare(root, {
		...plan,
		target: { kind: "url", value: url },
		checks: [{ ...base, input: {}, expectError: true, readOnly: true, observePath: "/state" }],
	});
	assert.equal((await runAcceptance(root, { allowNetwork: true, allowToolCalls: true })).ok, true);
	prepare(root, {
		...plan,
		target: { kind: "url", value: url },
		checks: [{ ...base, input: { value: "changed" }, readOnly: true, observePath: "/state" }],
	});
	assert.equal((await runAcceptance(root, { allowNetwork: true, allowToolCalls: true })).ok, false);
});
test("unsupported schema dialects fail closed; negative input assertions are checked", () => {
	assert.deepEqual(schemaIssues({ type: "object", required: ["x"] }, {}), ["Missing x"]);
	assert.throws(() => schemaIssues({ type: "string", pattern: ".*" }, "value"), /Unknown field/);
});
test("browser capability unavailable remains unverified", async (t) => {
	const root = fixture(t);
	prepare(root, {
		...plan,
		target: { kind: "url", value: "http://127.0.0.1:1" },
		checks: [{ id: "tool", criterion: "welcome", kind: "browser", tool: "search" }],
	});
	const result = await runAcceptance(root, { allowNetwork: true });
	assert.equal(result.ok, false);
	assert.equal(report(result.writtenFiles).checks[0]?.status, "unverified");
});

test("Pi runs acceptance in background, exposes status and cancels active requests", async (t) => {
	const { default: extension } = await import("../extensions/qa.js");
	type API = import("@earendil-works/pi-coding-agent").ExtensionAPI;
	type Context = import("@earendil-works/pi-coding-agent").ExtensionCommandContext;
	type Command = Parameters<API["registerCommand"]>[1];
	const url = await server(t, () => {}),
		root = fixture(t);
	prepare(root, {
		...plan,
		target: { kind: "url", value: url },
		checks: [{ id: "slow", criterion: "welcome", kind: "http", status: 200 }],
	});
	const commands = new Map<string, Command>();
	const messages: Array<{ content: string }> = [],
		notifications: string[] = [];
	extension({
		registerCommand: (name: string, command: Command) => commands.set(name, command),
		sendMessage: (message: { content: string }) => messages.push(message),
	} as unknown as API);
	const ctx = {
		cwd: root,
		ui: { notify: (s: string) => notifications.push(s), setStatus: () => {} },
	} as unknown as Context;
	await commands.get("qa-acceptance")?.handler("--allow-network", ctx);
	await commands.get("qa-status")?.handler("", ctx);
	assert.match(messages.at(-1)?.content ?? "", /starting|checking/);
	await commands.get("qa-acceptance")?.handler("--allow-network", ctx);
	assert.match(notifications.at(-1) ?? "", /active/);
	await commands.get("qa-cancel")?.handler("", ctx);
	const until = Date.now() + 3000;
	while (!messages.some((m) => m.content.includes("cancelled or timed out")) && Date.now() < until)
		await new Promise((r) => setTimeout(r, 10));
	assert.ok(messages.some((m) => m.content.includes("cancelled or timed out")));
});
test("network timeouts preserve unverified partial evidence", async (t) => {
	const root = fixture(t),
		url = await server(t, () => {});
	prepare(root, {
		...plan,
		timeoutMs: 30,
		target: { kind: "url", value: url },
		checks: [{ id: "slow", criterion: "welcome", kind: "http", status: 200 }],
	});
	const result = await runAcceptance(root, { allowNetwork: true });
	assert.equal(report(result.writtenFiles).cancelled, true);
	assert.equal(result.ok, false);
});
test("HTTP observations fail for wrong expectations and cross-origin checks remain unverified", async (t) => {
	const root = fixture(t),
		url = await server(t, (_req, res) => res.end("different"));
	prepare(root, {
		...plan,
		target: { kind: "url", value: url },
		checks: [{ id: "wrong", criterion: "welcome", kind: "http", contains: "Welcome" }],
	});
	const failed = await runAcceptance(root, { allowNetwork: true });
	assert.equal(report(failed.writtenFiles).criteria[0]?.status, "failed");
	prepare(root, {
		...plan,
		target: { kind: "url", value: url },
		checks: [
			{
				id: "escape",
				criterion: "welcome",
				kind: "http",
				path: "https://example.invalid",
				status: 200,
			},
		],
	});
	const blocked = await runAcceptance(root, { allowNetwork: true });
	assert.equal(report(blocked.writtenFiles).checks[0]?.status, "unverified");
	assert.match(report(blocked.writtenFiles).checks[0]?.observation ?? "", /origin/);
});

test("browser adapter executes real DOM observations with a simulated WebMCP API", {
	skip: !process.env.QA_PLAYWRIGHT_MODULE,
	timeout: 30000,
}, async (t) => {
	const root = fixture(t);
	const url = await server(t, (_req, res) => {
		res.setHeader("Content-Type", "text/html");
		res.end(`<div id="state">before</div><script>
  Object.defineProperty(document,"modelContext",{value:{
    async getTools(){return [{name:"set",description:"Update visible state",inputSchema:{type:"object",properties:{value:{type:"string"}},required:["value"]}}]},
    async executeTool(tool,input){if(typeof input.value!=="string")throw Error("Invalid input");document.querySelector("#state").textContent=input.value;return {content:[]}}
  }});
  </script>`);
	});
	const base = {
		id: "tool",
		criterion: "welcome",
		kind: "browser",
		tool: "set",
		observePath: "#state",
	};
	for (const [check, expected] of [
		[{ ...base, input: { value: "after" }, observeContains: "after" }, true],
		[{ ...base, input: {}, expectError: true, readOnly: true }, true],
		[{ ...base, input: { value: "changed" }, readOnly: true }, false],
	] as const) {
		prepare(root, { ...plan, target: { kind: "url", value: url }, checks: [check] });
		const result = await runAcceptance(root, {
			allowNetwork: true,
			allowToolCalls: true,
			browserModule: process.env.QA_PLAYWRIGHT_MODULE,
		});
		assert.equal(result.ok, expected, JSON.stringify(report(result.writtenFiles).checks));
	}
});

test("explicit bearer credentials are redacted from persisted observations", async (t) => {
	const root = fixture(t),
		token = "fixture-bearer-value-123";
	const old = process.env.QA_ACCEPTANCE_TEST_TOKEN;
	process.env.QA_ACCEPTANCE_TEST_TOKEN = token;
	t.after(() => {
		if (old === undefined) delete process.env.QA_ACCEPTANCE_TEST_TOKEN;
		else process.env.QA_ACCEPTANCE_TEST_TOKEN = old;
	});
	const url = await server(t, (req, res) => res.end(req.headers.authorization));
	prepare(root, {
		...plan,
		target: { kind: "url", value: url },
		checks: [{ id: "auth", criterion: "welcome", kind: "http", contains: token }],
	});
	const result = await runAcceptance(root, {
		allowNetwork: true,
		authEnv: "QA_ACCEPTANCE_TEST_TOKEN",
	});
	assert.equal(result.ok, true);
	assert.ok(!readFileSync(result.writtenFiles[0] as string, "utf8").includes(token));
	assert.match(readFileSync(result.writtenFiles[0] as string, "utf8"), /REDACTED/);
});
