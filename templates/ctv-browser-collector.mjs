// Copy into your project and run through a diagnostic collector. Requires local Playwright.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { arch, cpus, platform, release } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const keys = [
	"ArrowUp",
	"ArrowDown",
	"ArrowLeft",
	"ArrowRight",
	"Enter",
	"Escape",
	"Backspace",
	"MediaPlayPause",
];
function object(value, allowed, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw Error(`Invalid ${label}`);
	for (const key of Object.keys(value))
		if (!allowed.includes(key)) throw Error(`Unknown ${label}.${key}`);
	return value;
}
function text(value, label) {
	if (typeof value !== "string" || !value.trim() || /[\0\r\n]/.test(value))
		throw Error(`Invalid ${label}`);
	return value;
}
function integer(value, min, max, label) {
	if (!Number.isInteger(value) || value < min || value > max) throw Error(`Invalid ${label}`);
	return value;
}
export function validateConfig(raw) {
	const c = object(
		raw,
		[
			"url",
			"name",
			"buildId",
			"readySelector",
			"steps",
			"videoSelector",
			"runs",
			"viewport",
			"cpuThrottle",
			"durationMs",
			"warmupMs",
			"timeoutMs",
			"debug",
			"contentId",
			"codec",
			"drm",
			"network",
			"hostId",
		],
		"config",
	);
	const url = new URL(text(c.url, "url"));
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
		throw Error("Use an HTTP(S) URL without credentials");
	for (const key of [
		"name",
		"buildId",
		"readySelector",
		"contentId",
		"codec",
		"drm",
		"network",
		"hostId",
	])
		text(c[key], key);
	if (!Array.isArray(c.steps) || !c.steps.length || c.steps.length > 100)
		throw Error("Provide 1 to 100 remote-key steps");
	const steps = c.steps.map((step) => {
		object(step, ["key", "focus", "timeoutMs"], "step");
		if (step.timeoutMs !== undefined) integer(step.timeoutMs, 100, 120000, "step.timeoutMs");
		if (!keys.includes(step.key)) throw Error("Unsupported remote key");
		text(step.focus, "step.focus");
		return step;
	});
	const viewport = c.viewport ?? { width: 1920, height: 1080 };
	object(viewport, ["width", "height"], "viewport");
	integer(viewport.width, 640, 3840, "width");
	integer(viewport.height, 360, 2160, "height");
	if (c.debug !== undefined && typeof c.debug !== "boolean") throw Error("debug must be boolean");
	if (c.videoSelector !== undefined) text(c.videoSelector, "videoSelector");
	return {
		...c,
		steps,
		viewport,
		runs: integer(c.runs ?? 3, 3, 30, "runs"),
		cpuThrottle: integer(c.cpuThrottle ?? 1, 1, 20, "cpuThrottle"),
		durationMs: integer(c.durationMs ?? 5000, 250, 120000, "durationMs"),
		warmupMs: integer(c.warmupMs ?? 1000, 0, 120000, "warmupMs"),
		timeoutMs: integer(c.timeoutMs ?? 10000, 100, 120000, "timeoutMs"),
		debug: c.debug ?? false,
	};
}
const xml = (value) =>
	String(value).replace(
		/[&<>"']/g,
		(ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[ch],
	);

export async function collect(config, chromium, env = process.env) {
	const c = validateConfig(config);
	const output = env.QA_OUTPUT_DIR;
	if (!output || !env.QA_RUN_ID || !/^[a-f0-9]{64}$/.test(env.QA_SOURCE_HASH ?? ""))
		throw Error("Run through QA diagnostics to supply fresh output and source identity");
	const write = (file, value) =>
		writeFileSync(
			resolve(output, file),
			typeof value === "string" ? value : JSON.stringify(value, null, 2),
			{ flag: "wx" },
		);
	const samples = [],
		cases = [],
		errors = [];
	let browser;
	try {
		browser = await chromium.launch({ headless: true, timeout: c.timeoutMs });
		for (let iteration = 0; iteration < c.runs; iteration++) {
			const context = await browser.newContext({ viewport: c.viewport, deviceScaleFactor: 1 });
			let page,
				session,
				tracing = false,
				profiling = false;
			try {
				if (c.debug) {
					await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
					tracing = true;
				}
				page = await context.newPage();
				page.setDefaultTimeout(c.timeoutMs);
				const pageErrors = [];
				page.on("pageerror", (err) => pageErrors.push(String(err)));
				page.on("console", (msg) => {
					if (msg.type() === "error") pageErrors.push(msg.text());
				});
				session = await context.newCDPSession(page);
				await session.send("Emulation.setCPUThrottlingRate", { rate: c.cpuThrottle });
				await session.send("Performance.enable");
				if (c.debug) {
					await session.send("Profiler.enable");
					await session.send("Profiler.start");
					profiling = true;
				}
				const start = performance.now();
				const response = await page.goto(c.url, {
					waitUntil: "domcontentloaded",
					timeout: c.timeoutMs,
				});
				if (!response || response.status() >= 400)
					throw Error(`Navigation failed: ${response?.status() ?? "no response"}`);
				await page.locator(c.readySelector).waitFor({ state: "visible" });
				const startupMs = performance.now() - start;
				for (const step of c.steps) {
					await page.keyboard.press(step.key);
					await page.waitForFunction(
						(selector) => {
							const elements = document.querySelectorAll(selector);
							if (elements.length !== 1) return false;
							const el = elements[0],
								rect = el.getBoundingClientRect(),
								style = getComputedStyle(el);
							return (
								document.activeElement === el &&
								rect.width > 0 &&
								rect.height > 0 &&
								rect.left >= 0 &&
								rect.top >= 0 &&
								rect.right <= innerWidth &&
								rect.bottom <= innerHeight &&
								style.visibility === "visible" &&
								style.display !== "none" &&
								Number(style.opacity) > 0
							);
						},
						step.focus,
						{ timeout: step.timeoutMs ?? c.timeoutMs },
					);
				}
				await page.waitForTimeout(c.warmupMs);
				const observed = await page.evaluate(
					async ({ durationMs, videoSelector }) => {
						const video = videoSelector ? document.querySelector(videoSelector) : null;
						if (videoSelector && !(video instanceof HTMLVideoElement))
							throw Error("Expected a video element");
						const mediaStart = video?.currentTime;
						if (video && (video.paused || video.ended || video.error || video.readyState < 2))
							throw Error("Video is not playing after remote navigation");
						const qualityBefore = video?.getVideoPlaybackQuality?.();
						const frames = [];
						let frame,
							previous,
							longTaskCount = 0;
						const observer = new PerformanceObserver((list) => {
							longTaskCount += list.getEntries().length;
						});
						observer.observe({ type: "longtask", buffered: false });
						const tick = (now) => {
							if (previous !== undefined) frames.push(now - previous);
							previous = now;
							frame = requestAnimationFrame(tick);
						};
						frame = requestAnimationFrame(tick);
						await new Promise((done) => setTimeout(done, durationMs));
						cancelAnimationFrame(frame);
						longTaskCount += observer.takeRecords().length;
						observer.disconnect();
						if (frames.length < 2) throw Error("Insufficient animation frame samples");
						if (video && (video.error || video.paused || video.currentTime <= mediaStart))
							throw Error("Video failed to advance during measurement");
						frames.sort((a, b) => a - b);
						const metrics = {
							frameTimeP95Ms: frames[Math.ceil(frames.length * 0.95) - 1],
							longTaskCount,
						};
						const quality = video?.getVideoPlaybackQuality?.();
						const total =
							quality && qualityBefore
								? quality.totalVideoFrames - qualityBefore.totalVideoFrames
								: 0;
						if (total > 0)
							metrics.droppedFramesPct =
								(100 * (quality.droppedVideoFrames - qualityBefore.droppedVideoFrames)) / total;
						return metrics;
					},
					{ durationMs: c.durationMs, videoSelector: c.videoSelector },
				);
				if (pageErrors.length) throw Error(`Browser errors: ${pageErrors.slice(0, 5).join("; ")}`);
				const metrics = await session.send("Performance.getMetrics");
				const heap = metrics.metrics.find((m) => m.name === "JSHeapUsedSize");
				samples.push({
					iteration,
					metrics: { startupMs, ...observed, ...(heap ? { jsHeapMb: heap.value / 1048576 } : {}) },
				});
				cases.push(`<testcase name="remote-and-playback-${iteration}"/>`);
				await page.screenshot({ path: resolve(output, `screen-${iteration}.png`) });
			} catch (error) {
				errors.push(String(error));
				cases.push(
					`<testcase name="remote-and-playback-${iteration}"><failure>${xml(String(error))}</failure></testcase>`,
				);
				if (page)
					await page
						.screenshot({ path: resolve(output, `failure-${iteration}.png`), timeout: c.timeoutMs })
						.catch(() => {});
			} finally {
				try {
					if (profiling) {
						const result = await session.send("Profiler.stop");
						write(`cpu-${iteration}.cpuprofile`, result.profile);
					}
					if (tracing)
						await context.tracing.stop({ path: resolve(output, `trace-${iteration}.zip`) });
				} finally {
					await context.close();
				}
			}
		}
		if (samples.length === c.runs) {
			// Hash scenario configuration so changed steps, URL, throttling and instrumentation cannot compare silently.
			const { buildId: _build, runs: _runs, hostId: _host, ...scenarioConfig } = c;
			const stable = (value) =>
				Array.isArray(value)
					? value.map(stable)
					: value && typeof value === "object"
						? Object.fromEntries(
								Object.entries(value)
									.sort(([a], [b]) => a.localeCompare(b))
									.map(([key, item]) => [key, stable(item)]),
							)
						: value;
			const scenarioId = createHash("sha256")
				.update(JSON.stringify(stable(scenarioConfig)))
				.digest("hex");
			write("performance.json", {
				version: 1,
				runId: env.QA_RUN_ID,
				sourceHash: env.QA_SOURCE_HASH,
				collectedAt: new Date().toISOString(),
				buildId: c.buildId,
				device: {
					platform: "ctv-web",
					model: `${platform()}/${arch()}/${cpus()[0]?.model ?? "unknown"}`,
					osVersion: release(),
					runtime: "chromium",
					runtimeVersion: browser.version(),
					kind: "desktop",
					deviceId: c.hostId,
				},
				scenario: {
					name: c.name,
					phase: "post-navigation",
					contentId: c.contentId,
					codec: c.codec,
					resolution: `${c.viewport.width}x${c.viewport.height}`,
					drm: c.drm,
					network: c.network,
					durationMs: c.durationMs,
					warmupMs: c.warmupMs,
					instrumentation: `ctv-web-v1:${scenarioId}`,
					sampleIntervalMs: 16.667,
					cpuNormalization: `not-collected; chromium-throttle=${c.cpuThrottle}`,
				},
				samples,
			});
		}
	} catch (error) {
		errors.push(String(error));
		cases.push(`<testcase name="collector"><error>${xml(String(error))}</error></testcase>`);
	} finally {
		try {
			await browser?.close();
		} catch (error) {
			errors.push(String(error));
			cases.push(`<testcase name="browser-close"><error>${xml(String(error))}</error></testcase>`);
		}
		write(
			"junit.xml",
			`<testsuite name="ctv-web" tests="${cases.length}">${cases.join("")}</testsuite>\n`,
		);
		write("browser-run.json", {
			version: 1,
			config: c,
			samples,
			errors,
			note: "Desktop Chromium proxy; not a physical CTV device measurement.",
		});
	}
	return errors.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try {
		const config = validateConfig(JSON.parse(readFileSync(process.argv[2], "utf8")));
		const require = createRequire(resolve("package.json"));
		let chromium;
		for (const name of ["playwright", "@playwright/test", "playwright-core"]) {
			try {
				chromium = require(name).chromium;
				if (chromium) break;
			} catch {
				/* Try installed alternatives. */
			}
		}
		if (!chromium)
			throw Error(
				"Install Playwright and Chromium in the target project before running this collector",
			);
		process.exitCode = await collect(config, chromium);
	} catch (error) {
		console.error(String(error));
		process.exitCode = 1;
	}
}
