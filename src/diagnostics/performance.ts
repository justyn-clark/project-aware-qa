import { type DiagnosticCheck, number, object, text } from "./config.js";

/** Catalog entries identify collection families, not hardware certification. Custom IDs are accepted. */
export const CTV_PLATFORMS = {
	tizen: "Samsung Web Inspector / configured collector",
	webos: "LG Web Inspector / ares / configured collector",
	"android-tv": "Android Studio / Perfetto / ADB collector",
	"google-tv": "Android Studio / Perfetto / ADB collector",
	"fire-tv": "Fire TV Android-based devices / platform tooling collector",
	"fire-tv-vega": "Vega platform tooling / configured collector",
	"samsung-orsay": "Legacy Samsung tooling / configured collector",
	"lg-netcast": "Legacy LG tooling / configured collector",
	vewd: "Vendor web tooling / configured collector",
	roku: "BrightScript Profiler / Roku Resource Monitor export",
	tvos: "Apple Instruments export / configured collector",
	vidaa: "Vendor web tooling / configured collector",
	vizio: "Vendor tooling / configured collector",
	cast: "Receiver tooling / configured collector",
	xumo: "Provider tooling / configured collector",
	rdk: "Provider tooling / configured collector",
	"titan-os": "Vendor web tooling / configured collector",
	"tivo-os": "Vendor tooling / configured collector",
	hbbtv: "Device web inspector / configured collector",
	playstation: "Platform-authorized tooling / configured collector",
	xbox: "Platform-authorized tooling / configured collector",
} as const;
export const METRICS: Record<string, string> = {
	startupMs: "ms",
	timeToFirstFrameMs: "ms",
	inputLatencyP95Ms: "ms",
	frameTimeP95Ms: "ms",
	rebufferRatioPct: "percent",
	droppedFramesPct: "percent",
	cpuPercent: "percent",
	rssMb: "MiB",
	pssMb: "MiB",
	jsHeapMb: "MiB",
	nativeMemoryMb: "MiB",
	gpuMemoryMb: "MiB",
	decoderMemoryMb: "MiB",
	gcPauseP95Ms: "ms",
	longTaskCount: "count",
	rebufferCount: "count",
	memoryGrowthMbPerMinute: "MiB/min",
};
export interface PerformanceCapture {
	version: 1;
	runId: string;
	sourceHash: string;
	collectedAt: string;
	buildId: string;
	device: Record<string, string>;
	scenario: Record<string, string | number>;
	samples: { iteration: number; metrics: Record<string, number> }[];
}
export function parsePerformance(value: unknown): PerformanceCapture {
	const data = object(value, "performance", [
		"version",
		"runId",
		"sourceHash",
		"collectedAt",
		"buildId",
		"device",
		"scenario",
		"samples",
	]);
	if (data.version !== 1) throw Error("performance version must be 1");
	for (const key of ["runId", "sourceHash", "collectedAt", "buildId"]) text(data[key], key);
	if (
		!/^[a-f0-9]{64}$/.test(data.sourceHash as string) ||
		!Number.isFinite(Date.parse(data.collectedAt as string))
	)
		throw Error("Invalid source hash or collection timestamp");
	const device = object(data.device, "device", [
		"platform",
		"model",
		"osVersion",
		"runtime",
		"runtimeVersion",
		"kind",
		"memoryMb",
		"deviceId",
		"soc",
	]);
	for (const key of ["platform", "model", "osVersion", "runtime", "runtimeVersion", "kind"])
		text(device[key], `device.${key}`);
	if (!["physical", "emulator", "desktop"].includes(device.kind as string))
		throw Error("Unknown device kind");
	for (const key of ["memoryMb", "deviceId", "soc"])
		if (device[key] !== undefined) text(device[key], `device.${key}`);
	const scenario = object(data.scenario, "scenario", [
		"name",
		"phase",
		"contentId",
		"codec",
		"resolution",
		"drm",
		"network",
		"durationMs",
		"warmupMs",
		"instrumentation",
		"sampleIntervalMs",
		"cpuNormalization",
	]);
	for (const key of [
		"name",
		"phase",
		"contentId",
		"codec",
		"resolution",
		"drm",
		"network",
		"instrumentation",
		"cpuNormalization",
	])
		text(scenario[key], `scenario.${key}`);
	number(scenario.durationMs, "durationMs", 1);
	number(scenario.warmupMs, "warmupMs");
	number(scenario.sampleIntervalMs, "sampleIntervalMs", 0.001);
	if (!Array.isArray(data.samples) || !data.samples.length || data.samples.length > 10000)
		throw Error("samples must contain 1 to 10000 independent scenario repetitions");
	const iterations = new Set<number>();
	for (const sample of data.samples) {
		const row = object(sample, "sample", ["iteration", "metrics"]);
		const i = number(row.iteration, "iteration");
		if (!Number.isInteger(i) || iterations.has(i)) throw Error("Duplicate or invalid iteration");
		iterations.add(i);
		const metrics = object(row.metrics, "metrics");
		if (!Object.keys(metrics).length) throw Error("Empty metrics");
		for (const [key, value] of Object.entries(metrics)) {
			if (!Object.hasOwn(METRICS, key)) throw Error(`Unknown metric or unit: ${key}`);
			number(value, key, key === "memoryGrowthMbPerMinute" ? -Number.MAX_VALUE : 0);
			if ((key === "rebufferRatioPct" || key === "droppedFramesPct") && (value as number) > 100)
				throw Error(`Invalid percentage: ${key}`);
		}
	}
	return data as unknown as PerformanceCapture;
}
function canonical(value: Record<string, unknown>): string {
	return JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}
function median(values: number[]): number {
	const v = [...values].sort((a, b) => a - b);
	return (
		((v[Math.floor(v.length / 2)] as number) + (v[Math.floor((v.length - 1) / 2)] as number)) / 2
	);
}
export function evaluatePerformance(
	capture: PerformanceCapture,
	check: DiagnosticCheck,
	baseline?: PerformanceCapture,
) {
	const reasons: string[] = [];
	const violations: string[] = [];
	if (check.requirePhysicalDevice && capture.device.kind !== "physical")
		reasons.push(
			"A physical device is required; desktop/emulator measurements cannot satisfy this check.",
		);
	if (capture.samples.length < check.minRuns)
		reasons.push(`Need ${check.minRuns} independent repetitions; found ${capture.samples.length}.`);
	const metrics: Record<
		string,
		{
			unit: string;
			count: number;
			median: number;
			max: number;
			baselineMedian?: number;
			regressionPercent?: number;
		}
	> = {};
	const names = new Set([
		...capture.samples.flatMap((s) => Object.keys(s.metrics)),
		...Object.keys(check.budgets),
		...(baseline?.samples.flatMap((s) => Object.keys(s.metrics)) ?? []),
	]);
	for (const name of names) {
		if (!Object.hasOwn(METRICS, name)) throw Error(`Unknown budget metric: ${name}`);
		const values = capture.samples
			.map((s) => s.metrics[name])
			.filter((v): v is number => v !== undefined);
		if (values.length !== capture.samples.length)
			reasons.push(`Metric ${name} is missing from one or more repetitions.`);
		if (!values.length) continue;
		metrics[name] = {
			unit: METRICS[name] as string,
			count: values.length,
			median: median(values),
			max: Math.max(...values),
		};
		const limit = check.budgets[name];
		if (limit !== undefined && Math.max(...values) > limit)
			violations.push(
				`${name}: max ${Math.max(...values)} exceeds budget ${limit} ${METRICS[name]}.`,
			);
	}
	if (baseline) {
		const comparable =
			canonical(capture.device) === canonical(baseline.device) &&
			canonical(capture.scenario) === canonical(baseline.scenario);
		if (!comparable)
			reasons.push(
				"Baseline device, runtime, workload or instrumentation differs; comparison is inconclusive.",
			);
		else if (baseline.samples.length < check.minRuns)
			reasons.push("Baseline has too few independent repetitions.");
		else
			for (const [name, metric] of Object.entries(metrics)) {
				const values = baseline.samples.map((s) => s.metrics[name]);
				if (values.some((v) => v === undefined)) {
					reasons.push(`Baseline metric ${name} is incomplete.`);
					continue;
				}
				metric.baselineMedian = median(values as number[]);
				if (metric.baselineMedian === 0) {
					if (metric.median !== 0)
						reasons.push(
							`Cannot calculate percentage regression from a zero baseline for ${name}.`,
						);
					else metric.regressionPercent = 0;
				} else
					metric.regressionPercent =
						(100 * (metric.median - metric.baselineMedian)) / Math.abs(metric.baselineMedian);
				if (
					check.maxRegressionPercent !== undefined &&
					metric.regressionPercent !== undefined &&
					metric.regressionPercent > check.maxRegressionPercent
				)
					violations.push(
						`${name}: median regression ${metric.regressionPercent.toFixed(2)}% exceeds ${check.maxRegressionPercent}%.`,
					);
			}
	}
	if (!Object.keys(check.budgets).length && check.maxRegressionPercent === undefined)
		reasons.push("Measurements recorded without a performance acceptance budget.");
	return {
		status: violations.length
			? ("failed" as const)
			: reasons.length
				? ("inconclusive" as const)
				: ("passed" as const),
		metrics,
		reasons,
		violations,
		note: "Budget evaluation, not statistical proof of improvement. Missing telemetry is not zero. JS heap excludes native, GPU and decoder allocations.",
	};
}
