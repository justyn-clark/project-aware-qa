/**
 * Server calibration + variant re-probe + screenshot DOM verdict.
 *
 * These cover the deeper route-validity problem: HTTP status is only a trustworthy route
 * signal when the server distinguishes real routes from unknown ones. A SPA catch-all
 * (200 for everything) must be reported inconclusive, not passed; a 404 that is just a
 * trailing-slash artifact must be rescued; and for catch-all servers the rendered DOM is
 * the authoritative validator.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import {
	calibrateServer,
	probeRoutes,
	type RouteProbe,
	reprobeBrokenVariants,
	type ScreenshotResult,
	type ServerCalibration,
	summarizeRouteProbes,
	summarizeScreenshots,
} from "../src/verify/playwright.js";

function startServer(
	statusFor: (url: string) => number,
): Promise<{ server: Server; baseUrl: string }> {
	return new Promise((resolve) => {
		const server = createServer((req, res) => {
			res.statusCode = statusFor(req.url ?? "/");
			res.end("x");
		});
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
		});
	});
}

function calib(mode: ServerCalibration["mode"], bogusStatus: number | null): ServerCalibration {
	return { mode, baseUrl: "http://x", rootStatus: 200, bogusStatus, bogusPath: "/__bogus__" };
}
function probe(route: string, status: number | null): RouteProbe {
	return {
		route,
		url: `http://x${route}`,
		status,
		ok: status !== null && status >= 200 && status < 400,
		reachable: status !== null,
		durationMs: 1,
	};
}

test("calibrateServer: server that 404s unknown paths -> distinguishes", async () => {
	const { server, baseUrl } = await startServer((url) => (url === "/" ? 200 : 404));
	try {
		const c = await calibrateServer(baseUrl);
		assert.equal(c.mode, "distinguishes");
		assert.equal(c.bogusStatus, 404);
	} finally {
		server.close();
	}
});

test("calibrateServer: SPA catch-all (200 for everything) -> catch-all", async () => {
	const { server, baseUrl } = await startServer(() => 200);
	try {
		const c = await calibrateServer(baseUrl);
		assert.equal(c.mode, "catch-all");
		assert.equal(c.bogusStatus, 200);
	} finally {
		server.close();
	}
});

test("calibrateServer: nothing listening -> down", async () => {
	const c = await calibrateServer("http://127.0.0.1:1", 1200);
	assert.equal(c.mode, "down");
});

test("summarizeRouteProbes: catch-all -> inconclusive (not passed), even if all 200", () => {
	const v = summarizeRouteProbes(
		[probe("/a", 200), probe("/b", 200)],
		"http://x",
		calib("catch-all", 200),
	);
	assert.equal(v.status, "inconclusive");
	assert.match(v.reason ?? "", /catch-all|unknown path|can't validate/i);
});

test("summarizeRouteProbes: distinguishes + a real 404 -> failed", () => {
	const v = summarizeRouteProbes(
		[probe("/a", 200), probe("/b", 404)],
		"http://x",
		calib("distinguishes", 404),
	);
	assert.equal(v.status, "failed");
});

test("summarizeRouteProbes: distinguishes + all ok -> passed", () => {
	const v = summarizeRouteProbes(
		[probe("/a", 200), probe("/b", 301)],
		"http://x",
		calib("distinguishes", 404),
	);
	assert.equal(v.status, "passed");
});

test("reprobeBrokenVariants: a 404 that resolves with a trailing slash is rescued", async () => {
	const { server, baseUrl } = await startServer((url) =>
		url === "/admin/tracks/" ? 200 : url === "/admin/tracks" ? 404 : 404,
	);
	try {
		const probes = await probeRoutes(baseUrl, ["/admin/tracks"]);
		assert.equal(probes[0]?.ok, false, "bare path 404s");
		await reprobeBrokenVariants(baseUrl, probes);
		assert.equal(probes[0]?.ok, true, "rescued via trailing slash");
		assert.match(probes[0]?.note ?? "", /trailing slash/);
	} finally {
		server.close();
	}
});

function shot(route: string, viewport: string, over: Partial<ScreenshotResult>): ScreenshotResult {
	return {
		route,
		viewport,
		ok: true,
		file: `/x/.qa/screenshots/${route}-${viewport}.png`,
		...over,
	};
}

test("summarizeScreenshots: a not-found DOM render -> failed (the SPA route validator)", () => {
	const v = summarizeScreenshots([
		shot("/admin/tracks", "desktop", { looksLikeNotFound: false, httpStatus: 200 }),
		shot("/bogus", "desktop", { looksLikeNotFound: true, httpStatus: 200 }),
	]);
	assert.equal(v.status, "failed");
	assert.match(v.summary ?? "", /not-found|error/i);
});

test("summarizeScreenshots: all rendered cleanly -> passed", () => {
	const v = summarizeScreenshots([
		shot("/a", "desktop", { httpStatus: 200 }),
		shot("/a", "mobile", { httpStatus: 200 }),
	]);
	assert.equal(v.status, "passed");
});

test("summarizeScreenshots: empty -> skipped", () => {
	assert.equal(summarizeScreenshots([]).status, "skipped");
});

test("summarizeScreenshots: desktop success cannot hide a mobile timeout", () => {
	const verdict = summarizeScreenshots([
		shot("/account", "desktop", { httpStatus: 200 }),
		shot("/account", "mobile", { file: undefined, ok: false, error: "navigation timed out" }),
	]);
	assert.equal(verdict.status, "failed");
	assert.match(verdict.summary ?? "", /failed viewport capture/);
});

test("summarizeScreenshots: a saved image with failed verification does not pass", () => {
	assert.equal(summarizeScreenshots([shot("/account", "desktop", { ok: false })]).status, "failed");
});
