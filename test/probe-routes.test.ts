/**
 * Route-probe correctness (audit Finding 1): a 404/5xx must NOT count as a passing route,
 * and the aggregate verdict must be "partial = failed".
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import {
	classifyProbe,
	probeRoutes,
	type RouteProbe,
	summarizeRouteProbes,
} from "../src/verify/playwright.js";

function startServer(
	statusByPath: Record<string, number>,
): Promise<{ server: Server; baseUrl: string }> {
	return new Promise((resolve) => {
		const server = createServer((req, res) => {
			const code = statusByPath[req.url ?? ""] ?? 200;
			res.statusCode = code;
			if (code >= 300 && code < 400) res.setHeader("location", "/login");
			res.end("x");
		});
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
		});
	});
}

function mk(route: string, status: number | null): RouteProbe {
	return {
		route,
		url: `http://x${route}`,
		status,
		ok: status !== null && status >= 200 && status < 400,
		reachable: status !== null,
		durationMs: 1,
	};
}

test("probeRoutes: 200 ok, 302 ok, 404/500 reachable-but-not-ok, 401 auth", async () => {
	const { server, baseUrl } = await startServer({
		"/ok": 200,
		"/redir": 302,
		"/missing": 404,
		"/boom": 500,
		"/secret": 401,
	});
	try {
		const probes = await probeRoutes(baseUrl, ["/ok", "/redir", "/missing", "/boom", "/secret"]);
		const by = Object.fromEntries(probes.map((p) => [p.route, p]));
		assert.equal(by["/ok"]?.ok, true);
		assert.equal(by["/ok"]?.reachable, true);
		assert.equal(by["/redir"]?.ok, true, "3xx redirect counts as ok");
		// The core of the bug: a 404 used to report ok=true.
		assert.equal(by["/missing"]?.ok, false, "404 must NOT be ok");
		assert.equal(by["/missing"]?.reachable, true);
		assert.equal(classifyProbe(by["/missing"] as RouteProbe), "broken");
		assert.equal(by["/boom"]?.ok, false);
		assert.equal(classifyProbe(by["/boom"] as RouteProbe), "broken");
		assert.equal(classifyProbe(by["/secret"] as RouteProbe), "auth");
	} finally {
		server.close();
	}
});

test("probeRoutes: connection refused -> unreachable, not ok", async () => {
	const probes = await probeRoutes("http://127.0.0.1:1", ["/x"], 1500);
	assert.equal(probes[0]?.reachable, false);
	assert.equal(probes[0]?.ok, false);
	assert.equal(classifyProbe(probes[0] as RouteProbe), "unreachable");
});

test("summarizeRouteProbes: all 200 -> passed", () => {
	const v = summarizeRouteProbes([mk("/a", 200), mk("/b", 200)], "http://x");
	assert.equal(v.status, "passed");
	assert.equal(v.counts.ok, 2);
});

test("summarizeRouteProbes: any 404 -> failed (partial = failed)", () => {
	const v = summarizeRouteProbes([mk("/a", 200), mk("/b", 404)], "http://x");
	assert.equal(v.status, "failed");
	assert.match(v.summary ?? "", /broken/);
});

test("summarizeRouteProbes: 500 -> failed", () => {
	const v = summarizeRouteProbes([mk("/a", 500)], "http://x");
	assert.equal(v.status, "failed");
});

test("summarizeRouteProbes: none reachable -> skipped (server down)", () => {
	const v = summarizeRouteProbes([mk("/a", null), mk("/b", null)], "http://x");
	assert.equal(v.status, "skipped");
});

test("summarizeRouteProbes: auth-gated is a soft pass with a note", () => {
	const v = summarizeRouteProbes([mk("/a", 200), mk("/admin", 401)], "http://x");
	assert.equal(v.status, "passed");
	assert.match(v.summary ?? "", /auth-gated/);
});

test("summarizeRouteProbes: some reachable + some unreachable -> failed", () => {
	const v = summarizeRouteProbes([mk("/a", 200), mk("/b", null)], "http://x");
	assert.equal(v.status, "failed");
	assert.match(v.summary ?? "", /unreachable/);
});
