/**
 * Visual QA + targeted route checks (Phase 7 + Phase 6 step 7).
 *
 * Two independent capabilities that each degrade gracefully:
 *  - HTTP route probe: a dependency-free fetch against each selected route, recording
 *    status codes as evidence. Runs whenever a server is reachable.
 *  - Pixel screenshots: drives Playwright's chromium IF it can be resolved from the
 *    target repo or globally; otherwise records a skip with the exact reason and writes
 *    a screenshot plan the agent can fulfil via the Pi Playwright MCP.
 *
 * No baseline diffing in v1 — we capture, we don't compare.
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { qaPath } from "../io.js";
import type { Surface, SurfaceRegistry } from "../types.js";

export interface RouteProbe {
	route: string;
	url: string;
	status: number | null;
	/** The route loaded successfully (2xx/3xx). A 404/5xx is NOT ok. */
	ok: boolean;
	/** The server returned any HTTP response (even an error status) — i.e. it is up. */
	reachable: boolean;
	error?: string;
	durationMs: number;
	/** Set when a 404 was reclassified ok via a normalized variant (e.g. trailing slash). */
	note?: string;
}

/** Classification of a single probe for reporting/aggregation. */
export type ProbeCategory = "ok" | "auth" | "broken" | "unreachable";

export function classifyProbe(p: RouteProbe): ProbeCategory {
	if (!p.reachable || p.status === null) return "unreachable";
	if (p.status === 401 || p.status === 403) return "auth";
	if (p.status >= 200 && p.status < 400) return "ok";
	return "broken"; // 404, 4xx, 5xx
}

export interface ScreenshotResult {
	route: string;
	viewport: string;
	file?: string;
	ok: boolean;
	error?: string;
	/** HTTP status of the navigation response (Playwright), when available. */
	httpStatus?: number | null;
	title?: string;
	consoleErrors?: number;
	/** DOM heuristic: the rendered page looks like a not-found / error-boundary page. */
	looksLikeNotFound?: boolean;
}

export interface Viewport {
	name: string;
	width: number;
	height: number;
}

export const DEFAULT_VIEWPORTS: Viewport[] = [
	{ name: "desktop", width: 1280, height: 800 },
	{ name: "mobile", width: 390, height: 844 },
];

function slug(s: string): string {
	return (
		s
			.replace(/[^a-z0-9]+/gi, "-")
			.replace(/^-+|-+$/g, "")
			.toLowerCase() || "root"
	);
}

/** Resolve the base URL to probe from explicit option / playwright config / dev port. */
export function resolveBaseUrl(opts: {
	explicit?: string;
	playwrightBaseUrl?: string;
	playwrightUrl?: string;
	port?: number;
}): string {
	const raw = opts.explicit || opts.playwrightBaseUrl || opts.playwrightUrl;
	if (raw) return raw.replace(/\/$/, "");
	if (opts.port) return `http://localhost:${opts.port}`;
	return "http://localhost:3000";
}

/** Select renderable, screenshot-worthy routes (skip dynamic-param routes by default). */
export function selectVisualRoutes(
	registry: SurfaceRegistry,
	options: { includeDynamic?: boolean; max?: number; scope?: string } = {},
): Surface[] {
	const max = options.max ?? 20;
	let pages = registry.surfaces.filter((s) => s.type === "visual-page" && s.frontendRoute);
	if (!options.includeDynamic) {
		pages = pages.filter(
			(s) => !/:[A-Za-z0-9_]/.test(s.frontendRoute ?? "") && !(s.frontendRoute ?? "").includes("*"),
		);
	}
	if (options.scope) {
		const q = options.scope.toLowerCase();
		pages = pages.filter(
			(s) =>
				(s.frontendRoute ?? "").toLowerCase().includes(q) ||
				(s.entity ?? "").toLowerCase().includes(q),
		);
	}
	// Highest risk first; dedupe by route.
	const seen = new Set<string>();
	const out: Surface[] = [];
	for (const s of pages.sort((a, b) => b.riskScore - a.riskScore)) {
		const r = s.frontendRoute as string;
		if (seen.has(r)) continue;
		seen.add(r);
		out.push(s);
		if (out.length >= max) break;
	}
	return out;
}

export async function waitForServer(
	url: string,
	timeoutMs = 60_000,
	intervalMs = 1000,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(5000) });
			if (res.status > 0) return true;
		} catch {
			// not up yet
		}
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	return false;
}

export async function probeRoutes(
	baseUrl: string,
	routes: string[],
	timeoutMs = 10_000,
): Promise<RouteProbe[]> {
	const probes: RouteProbe[] = [];
	for (const route of routes) {
		const url = `${baseUrl}${route.startsWith("/") ? route : `/${route}`}`;
		const started = Date.now();
		try {
			const res = await fetch(url, {
				method: "GET",
				redirect: "manual",
				signal: AbortSignal.timeout(timeoutMs),
			});
			probes.push({
				route,
				url,
				status: res.status,
				// A route "works" only on 2xx/3xx. 404/5xx are reachable but broken.
				ok: res.status >= 200 && res.status < 400,
				reachable: true,
				durationMs: Date.now() - started,
			});
		} catch (e) {
			probes.push({
				route,
				url,
				status: null,
				ok: false,
				reachable: false,
				error: e instanceof Error ? e.message : String(e),
				durationMs: Date.now() - started,
			});
		}
	}
	return probes;
}

// ---------------------------------------------------------------------------
// Server calibration — learn what the server's responses actually MEAN before
// interpreting per-route probes. An HTTP status is only a trustworthy route signal
// when the server distinguishes real routes from unknown ones.
// ---------------------------------------------------------------------------

export type ServerMode =
	/** Root unreachable — server isn't running. */
	| "down"
	/** Unknown paths return a clear 404/410 — status IS a valid route signal. */
	| "distinguishes"
	/** Unknown paths return 2xx/3xx (SPA catch-all/soft-404) — status can't validate routes. */
	| "catch-all";

export interface ServerCalibration {
	mode: ServerMode;
	baseUrl: string;
	rootStatus: number | null;
	bogusStatus: number | null;
	/** The deliberately-nonexistent path probed. */
	bogusPath: string;
}

/** A path no real app should serve, used to observe the server's true not-found behavior. */
export const BOGUS_PATH = "/__qa-probe-nonexistent-7f3a__/__definitely-not-a-route__";

export async function calibrateServer(
	baseUrl: string,
	timeoutMs = 10_000,
): Promise<ServerCalibration> {
	const get = async (path: string): Promise<number | null> => {
		try {
			const res = await fetch(`${baseUrl}${path}`, {
				method: "GET",
				redirect: "manual",
				signal: AbortSignal.timeout(timeoutMs),
			});
			return res.status;
		} catch {
			return null;
		}
	};
	const rootStatus = await get("/");
	if (rootStatus === null) {
		// Some servers 404 the bare root but serve sub-routes; confirm with the bogus path.
		const bogusStatus = await get(BOGUS_PATH);
		if (bogusStatus === null) {
			return { mode: "down", baseUrl, rootStatus, bogusStatus, bogusPath: BOGUS_PATH };
		}
		// Root errored but server responds elsewhere; treat the bogus result as the signal.
		const distinguishes = bogusStatus === 404 || bogusStatus === 410;
		return {
			mode: distinguishes ? "distinguishes" : "catch-all",
			baseUrl,
			rootStatus,
			bogusStatus,
			bogusPath: BOGUS_PATH,
		};
	}
	const bogusStatus = await get(BOGUS_PATH);
	// A clear not-found on a bogus path → the server distinguishes routes; status is meaningful.
	const distinguishes = bogusStatus === 404 || bogusStatus === 410;
	return {
		mode: distinguishes ? "distinguishes" : "catch-all",
		baseUrl,
		rootStatus,
		bogusStatus,
		bogusPath: BOGUS_PATH,
	};
}

/**
 * Re-probe broken routes with cheap normalized variants (trailing slash, optional
 * basename prefix) before declaring them broken — most "404s" are normalization artifacts
 * of heuristic path derivation, not real app bugs. Only runs when the server distinguishes
 * routes (otherwise a 200 is meaningless). Mutates and returns the probe list.
 */
export async function reprobeBrokenVariants(
	baseUrl: string,
	probes: RouteProbe[],
	options: { basename?: string; timeoutMs?: number } = {},
): Promise<RouteProbe[]> {
	const timeoutMs = options.timeoutMs ?? 10_000;
	const tryGet = async (path: string): Promise<number | null> => {
		try {
			const res = await fetch(`${baseUrl}${path.startsWith("/") ? path : `/${path}`}`, {
				method: "GET",
				redirect: "manual",
				signal: AbortSignal.timeout(timeoutMs),
			});
			return res.status;
		} catch {
			return null;
		}
	};
	for (const p of probes) {
		if (classifyProbe(p) !== "broken") continue;
		const variants: Array<{ path: string; label: string }> = [];
		variants.push(
			p.route.endsWith("/")
				? { path: p.route.replace(/\/+$/, ""), label: "no trailing slash" }
				: { path: `${p.route}/`, label: "trailing slash" },
		);
		if (options.basename) {
			const bn = `/${options.basename.replace(/^\/+|\/+$/g, "")}`;
			variants.push({ path: `${bn}${p.route}`, label: `basename ${bn}` });
		}
		for (const v of variants) {
			const status = await tryGet(v.path);
			if (status !== null && status >= 200 && status < 400) {
				p.status = status;
				p.ok = true;
				p.note = `resolved via ${v.label}`;
				break;
			}
		}
	}
	return probes;
}

export interface RouteProbeSummary {
	status: "passed" | "failed" | "skipped" | "inconclusive";
	summary?: string;
	reason?: string;
	counts: { ok: number; auth: number; broken: number; unreachable: number; total: number };
}

/**
 * Aggregate route probes into a single check verdict, interpreted through server
 * calibration:
 *  - mode "down"          → skipped (server isn't running).
 *  - mode "catch-all"     → inconclusive (status can't validate routes; defer to the
 *                           rendered-DOM/screenshot check).
 *  - mode "distinguishes" → status is meaningful: all ok/auth → passed; any broken or
 *                           some-unreachable → failed (partial = failed). Auth-gated is a
 *                           soft note (can't verify without credentials).
 * When no calibration is supplied, falls back to reachability-only (legacy behaviour).
 */
export function summarizeRouteProbes(
	probes: RouteProbe[],
	baseUrl: string,
	calibration?: ServerCalibration,
): RouteProbeSummary {
	const counts = { ok: 0, auth: 0, broken: 0, unreachable: 0, total: probes.length };
	for (const p of probes) counts[classifyProbe(p)]++;
	const anyReachable = counts.ok + counts.auth + counts.broken > 0;

	if (calibration?.mode === "down" || !anyReachable) {
		return {
			status: "skipped",
			reason: `No server reachable at ${baseUrl} (${probes.length} routes probed, 0 responded). Start the app or pass a base URL.`,
			counts,
		};
	}

	if (calibration?.mode === "catch-all") {
		return {
			status: "inconclusive",
			reason:
				`Server returns ${calibration.bogusStatus ?? "non-404"} for a known-nonexistent path (SPA catch-all/soft-404) at ${baseUrl}, ` +
				`so HTTP status can't validate routes (${counts.ok}/${counts.total} returned 2xx/3xx, but so would any path). ` +
				`Enable --screenshots for rendered-DOM validation.`,
			counts,
		};
	}

	const authNote = counts.auth ? `, ${counts.auth} auth-gated` : "";
	if (counts.broken === 0 && counts.unreachable === 0) {
		return {
			status: "passed",
			summary: `${counts.ok}/${counts.total} routes OK${authNote} at ${baseUrl}`,
			counts,
		};
	}
	const broken = probes.filter((p) => classifyProbe(p) === "broken");
	const detail = broken
		.slice(0, 3)
		.map((p) => `${p.route}→${p.status}`)
		.join(", ");
	const bits: string[] = [];
	if (counts.broken)
		bits.push(`${counts.broken} broken (${detail}${broken.length > 3 ? ", …" : ""})`);
	if (counts.unreachable) bits.push(`${counts.unreachable} unreachable`);
	return {
		status: "failed",
		summary: `${counts.ok}/${counts.total} OK${authNote}; ${bits.join("; ")} at ${baseUrl}`,
		counts,
	};
}

/** Try to resolve Playwright's chromium from the target repo, then globally. */
async function resolveChromium(targetRoot: string): Promise<unknown | null> {
	const candidates = ["playwright", "playwright-core", "@playwright/test"];
	for (const base of [targetRoot, process.cwd()]) {
		const require = createRequire(`${base.replace(/\/$/, "")}/package.json`);
		for (const mod of candidates) {
			try {
				const resolved = require.resolve(mod);
				const imported = (await import(pathToFileURL(resolved).href)) as Record<string, unknown>;
				if (imported.chromium) return imported.chromium;
			} catch {
				// try next
			}
		}
	}
	return null;
}

export interface ScreenshotRunInput {
	root: string;
	baseUrl: string;
	routes: string[];
	viewports?: Viewport[];
	timeoutMs?: number;
}

export interface ScreenshotRunOutput {
	available: boolean;
	reason?: string;
	results: ScreenshotResult[];
}

export async function captureScreenshots(input: ScreenshotRunInput): Promise<ScreenshotRunOutput> {
	const viewports = input.viewports ?? DEFAULT_VIEWPORTS;
	const chromium = (await resolveChromium(input.root)) as {
		launch: (o?: unknown) => Promise<unknown>;
	} | null;
	if (!chromium) {
		return {
			available: false,
			reason:
				"Playwright not resolvable from target repo or globally (npm i -D playwright && npx playwright install chromium)",
			results: [],
		};
	}
	const results: ScreenshotResult[] = [];
	// biome-ignore lint/suspicious/noExplicitAny: Playwright is resolved dynamically at runtime without its types.
	const browser = (await chromium.launch({ headless: true })) as any;
	try {
		for (const route of input.routes) {
			for (const vp of viewports) {
				const file = qaPath(input.root, "screenshots", `${slug(route)}-${vp.name}.png`);
				try {
					const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
					let consoleErrors = 0;
					// biome-ignore lint/suspicious/noExplicitAny: Playwright page event payloads are untyped here.
					page.on("console", (msg: any) => {
						if (msg.type?.() === "error") consoleErrors++;
					});
					page.on("pageerror", () => {
						consoleErrors++;
					});
					const url = `${input.baseUrl}${route.startsWith("/") ? route : `/${route}`}`;
					const resp = await page.goto(url, {
						waitUntil: "networkidle",
						timeout: input.timeoutMs ?? 20_000,
					});
					const httpStatus: number | null =
						typeof resp?.status === "function" ? resp.status() : null;
					await page.screenshot({ path: file, fullPage: true });
					// Rendered-DOM validation: does the page look like a not-found / error boundary?
					const title: string = await page.title().catch(() => "");
					// Pass the snippet as a string so tsc doesn't need the DOM lib; it runs in-page.
					const bodyText: string = await page
						.evaluate("((document.body && document.body.innerText) || '').slice(0, 4000)")
						.catch(() => "");
					const looksLikeNotFound = NOT_FOUND_RE.test(`${title}\n${bodyText}`);
					await page.close();
					results.push({
						route,
						viewport: vp.name,
						file,
						ok: !looksLikeNotFound && (httpStatus === null || httpStatus < 400),
						httpStatus,
						title: title.slice(0, 120),
						consoleErrors,
						looksLikeNotFound,
					});
				} catch (e) {
					results.push({
						route,
						viewport: vp.name,
						ok: false,
						error: e instanceof Error ? e.message : String(e),
					});
				}
			}
		}
	} finally {
		await browser.close();
	}
	return { available: true, results };
}

/** Heuristic markers of a not-found / error-boundary page in title or body text. */
const NOT_FOUND_RE =
	/\b(404|not found|page (?:does ?n.?t|could ?n.?t be|cannot be) (?:exist|found)|page not found|nothing here|this page (?:does ?n.?t|could ?n.?t)|application error|something went wrong|unexpected (?:application )?error)\b/i;

export interface ScreenshotSummary {
	status: "passed" | "failed" | "skipped";
	summary?: string;
	reason?: string;
}

/**
 * Verdict over screenshot results using the rendered DOM — the authoritative route check
 * for SPA/catch-all servers where HTTP status is meaningless. One verdict per route
 * (collapsing viewports): a route is broken if any viewport rendered a not-found/error
 * page or returned a 4xx/5xx navigation status.
 */
export function summarizeScreenshots(results: ScreenshotResult[]): ScreenshotSummary {
	if (results.length === 0) {
		return { status: "skipped", reason: "No routes selected for screenshots" };
	}
	const byRoute = new Map<string, ScreenshotResult[]>();
	for (const r of results) {
		const arr = byRoute.get(r.route) ?? [];
		arr.push(r);
		byRoute.set(r.route, arr);
	}
	let okRoutes = 0;
	let notFoundRoutes = 0;
	let erroredRoutes = 0;
	const consoleErrRoutes: string[] = [];
	const brokenRoutes: string[] = [];
	for (const [route, shots] of byRoute) {
		const captured = shots.some((s) => s.file);
		const notFound = shots.some(
			(s) => s.looksLikeNotFound || (typeof s.httpStatus === "number" && s.httpStatus >= 400),
		);
		const errored = shots.every((s) => !s.file);
		if (notFound) {
			notFoundRoutes++;
			brokenRoutes.push(route);
		} else if (errored) {
			erroredRoutes++;
			brokenRoutes.push(route);
		} else if (captured) {
			okRoutes++;
		}
		if (shots.some((s) => (s.consoleErrors ?? 0) > 0)) consoleErrRoutes.push(route);
	}
	const total = byRoute.size;
	const savedShots = results.filter((s) => s.file).length;
	const consoleNote = consoleErrRoutes.length
		? ` · ${consoleErrRoutes.length} route(s) with console errors`
		: "";
	if (notFoundRoutes > 0 || erroredRoutes > 0) {
		const detail = brokenRoutes.slice(0, 4).join(", ");
		return {
			status: "failed",
			summary: `${okRoutes}/${total} rendered OK · ${notFoundRoutes} not-found/error page(s) · ${erroredRoutes} failed to load (${detail}${brokenRoutes.length > 4 ? ", …" : ""})${consoleNote}. ${savedShots} screenshots in .qa/screenshots/`,
		};
	}
	return {
		status: "passed",
		summary: `${okRoutes}/${total} routes rendered OK${consoleNote}. ${savedShots} screenshots in .qa/screenshots/`,
	};
}
