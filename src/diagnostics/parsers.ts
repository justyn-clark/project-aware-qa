import type { ArtifactFormat } from "./config.js";
import { number, object } from "./config.js";
import { parsePythonProfile } from "./python.js";
import { parseSpeedscope } from "./speedscope.js";

export interface ParsedEvidence {
	status: "passed" | "failed" | "inconclusive";
	summary: string;
	details: unknown;
}
/** Restricted JUnit reader: no DTD/entities, no aggregate-only success, count actual cases. */
export function parseJUnit(source: string): ParsedEvidence {
	if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw Error("JUnit DTD/entities are unsupported");
	const xml = source
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")
		.replace(/<\?xml[^?]*\?>/g, "");
	const stack: { name: string; start: number; declared?: number }[] = [];
	let tests = 0,
		failed = 0,
		skipped = 0,
		roots = 0;
	let inCase = false,
		caseFailed = false,
		caseSkipped = false;
	const finish = () => {
		if (caseFailed) failed++;
		else if (caseSkipped) skipped++;
		inCase = false;
	};
	const tags = [...xml.matchAll(/<[^>]*>/g)];
	let cursor = 0;
	const complete = (frame: { start: number; declared?: number }) => {
		if (frame.declared !== undefined && tests - frame.start !== frame.declared)
			throw Error("JUnit declared count does not match testcase evidence");
	};
	for (const token of tags) {
		const tag = token[0];
		if (!stack.length && xml.slice(cursor, token.index).trim())
			throw Error("Text outside JUnit document");
		cursor = (token.index ?? 0) + tag.length;
		const m = /^<(\/)?([\w:-]+)(?:\s[^<>]*)?(\/?)>$/.exec(tag);
		if (!m) throw Error("Unsupported or malformed JUnit XML");
		const name = m[2] as string;
		if (m[1]) {
			const frame = stack.pop();
			if (frame?.name !== name) throw Error("Unbalanced JUnit XML");
			complete(frame);
			if (name === "testcase") finish();
			continue;
		}
		if (!stack.length) {
			roots++;
			if (!["testsuites", "testsuite"].includes(name)) throw Error("Invalid JUnit root");
		}
		if (name === "testcase") {
			if (inCase || stack.at(-1)?.name !== "testsuite") throw Error("Invalid JUnit testcase");
			tests++;
			inCase = true;
			caseFailed = false;
			caseSkipped = false;
		}
		if (["failure", "error"].includes(name)) {
			if (!inCase) throw Error("JUnit suite error without testcase");
			caseFailed = true;
		}
		if (name === "skipped") {
			if (!inCase) throw Error("Invalid skipped case");
			caseSkipped = true;
		}
		const count = ["testsuite", "testsuites"].includes(name)
			? /\btests\s*=\s*["'](\d+)["']/.exec(tag)
			: null;
		const frame = { name, start: tests, declared: count ? Number(count[1]) : undefined };
		if (tag.endsWith("/>")) {
			if (name === "testcase") finish();
			complete(frame);
		} else stack.push(frame);
	}
	if (stack.length || roots !== 1 || xml.slice(cursor).trim()) throw Error("Incomplete JUnit XML");
	return {
		status: failed ? "failed" : !tests || skipped ? "inconclusive" : "passed",
		summary: `JUnit: ${tests} cases, ${failed} failed, ${skipped} skipped`,
		details: { tests, failed, skipped },
	};
}
export function parseGoTests(source: string, benchmark = false): ParsedEvidence {
	let passed = 0,
		failed = 0,
		skipped = 0,
		packages = 0;
	const active = new Set<string>();
	const benchmarks: Record<string, unknown>[] = [];
	for (const line of source.trim().split(/\r?\n/)) {
		if (!line.trim()) continue;
		const event = object(JSON.parse(line), "Go event");
		if (typeof event.Action !== "string" || typeof event.Package !== "string")
			throw Error("Invalid Go test event");
		const key = `${event.Package}:${event.Test ?? ""}`;
		if (event.Action === "start" || event.Action === "run") active.add(key);
		if (["pass", "fail", "skip"].includes(event.Action)) {
			active.delete(key);
			if (event.Action === "fail") failed++;
			else if (event.Action === "skip") skipped++;
			else if (event.Test) passed++;
			else packages++;
		}
		if (benchmark && typeof event.Output === "string") {
			const match =
				/^(Benchmark\S+)\s+(\d+)\s+([\d.]+) ns\/op(?:\s+([\d.]+) B\/op\s+([\d.]+) allocs\/op)?/.exec(
					event.Output,
				);
			if (match)
				benchmarks.push({
					package: event.Package,
					name: match[1],
					iterations: Number(match[2]),
					nsPerOp: Number(match[3]),
					bytesPerOp: match[4] ? Number(match[4]) : undefined,
					allocsPerOp: match[5] ? Number(match[5]) : undefined,
				});
		}
	}
	return {
		status: failed
			? "failed"
			: benchmark || !passed || !packages || skipped || active.size
				? "inconclusive"
				: "passed",
		summary: benchmark
			? `Go benchmark: ${benchmarks.length} measurements; no performance budget applied`
			: `Go: ${passed} passed tests, ${failed} failures, ${skipped} skipped, ${active.size} unfinished`,
		details: { passed, failed, skipped, packages, unfinished: [...active], benchmarks },
	};
}
export function parseCoverage(source: string, format: "lcov" | "go-cover"): ParsedEvidence {
	const files = new Map<string, { total: number; covered: number }>();
	if (format === "lcov") {
		let file: string | undefined;
		const lines = new Map<number, number>();
		for (const line of source.split(/\r?\n/)) {
			if (line.startsWith("SF:")) {
				if (file) throw Error("Unterminated LCOV record");
				file = line.slice(3);
				if (!file) throw Error("Empty LCOV file");
			} else if (line.startsWith("DA:")) {
				const m = /^DA:(\d+),(\d+)(?:,[^,]+)?$/.exec(line);
				if (!m || !file) throw Error("Invalid LCOV line");
				lines.set(Number(m[1]), Math.max(lines.get(Number(m[1])) ?? 0, Number(m[2])));
			} else if (line === "end_of_record") {
				if (!file || !lines.size || files.has(file))
					throw Error("Invalid or duplicate LCOV record");
				files.set(file, {
					total: lines.size,
					covered: [...lines.values()].filter((n) => n > 0).length,
				});
				file = undefined;
				lines.clear();
			}
		}
		if (file) throw Error("Unterminated LCOV file");
	} else {
		const lines = source.trim().split(/\r?\n/);
		if (!/^mode: (set|count|atomic)$/.test(lines.shift() ?? ""))
			throw Error("Invalid Go cover mode");
		for (const line of lines) {
			const m = /^(.*):\d+\.\d+,\d+\.\d+ (\d+) (\d+)$/.exec(line);
			if (!m) throw Error("Invalid Go cover record");
			const key = m[1] as string;
			const entry = files.get(key) ?? { total: 0, covered: 0 };
			entry.total += Number(m[2]);
			if (Number(m[3]) > 0) entry.covered += Number(m[2]);
			files.set(key, entry);
		}
	}
	if (!files.size) throw Error("Empty coverage report");
	return {
		status: "passed",
		summary: `${format}: ${files.size} measured files; unlisted source files remain unknown`,
		details: { unit: format === "lcov" ? "lines" : "statements", files: Object.fromEntries(files) },
	};
}
export function parseProfile(source: Buffer, format: ArtifactFormat): ParsedEvidence {
	if (!source.length) throw Error("Empty diagnostic artifact");
	let details: unknown = { bytes: source.length, format };
	if (format === "cpu-profile") {
		const p = object(JSON.parse(source.toString()), "CPU profile");
		number(p.startTime, "startTime");
		number(p.endTime, "endTime", p.startTime as number);
		if (
			!Array.isArray(p.nodes) ||
			!Array.isArray(p.samples) ||
			!p.samples.length ||
			!Array.isArray(p.timeDeltas) ||
			p.timeDeltas.length !== p.samples.length
		)
			throw Error("Invalid or empty sampled CPU profile");
		const nodes = new Map(
			p.nodes.map((n) => {
				const node = object(n, "CPU node");
				number(node.id, "node id");
				return [node.id, object(node.callFrame, "callFrame")];
			}),
		);
		const totals = new Map<number, number>();
		p.samples.forEach((id, i) => {
			if (!nodes.has(id)) throw Error("Unknown CPU sample node");
			const duration = number((p.timeDeltas as unknown[])[i], "timeDelta");
			totals.set(id, (totals.get(id) ?? 0) + duration);
		});
		details = {
			format,
			samples: p.samples.length,
			durationUs: (p.endTime as number) - (p.startTime as number),
			hotspots: [...totals]
				.sort((a, b) => b[1] - a[1])
				.slice(0, 20)
				.map(([id, sampledUs]) => ({ sampledUs, callFrame: nodes.get(id) })),
			note: "Sampled self time; not wall-clock latency or total CPU utilization.",
		};
	} else if (format === "heap-profile") {
		const profile = object(JSON.parse(source.toString()), "allocation profile");
		const pending = [object(profile.head, "head")];
		let nodes = 0,
			selfBytes = 0;
		while (pending.length) {
			const node = pending.pop();
			if (!node) break;
			if (++nodes > 1000000) throw Error("Allocation profile exceeds node limit");
			selfBytes += number(node.selfSize, "selfSize");
			if (!Array.isArray(node.children)) throw Error("Invalid allocation profile children");
			for (const child of node.children) pending.push(object(child, "allocation node"));
		}
		details = {
			format,
			nodes,
			sampledSelfBytes: selfBytes,
			note: "Sampled allocation profile; not a complete heap snapshot or process memory.",
		};
	} else if (format === "heap-snapshot") {
		const p = object(JSON.parse(source.toString()), "heap snapshot");
		const snapshot = object(p.snapshot, "snapshot");
		const meta = object(snapshot.meta, "meta");
		if (!Array.isArray(meta.node_fields) || !Array.isArray(p.nodes) || !p.nodes.length)
			throw Error("Invalid V8-format heap snapshot");
		const width = meta.node_fields.length;
		const idx = meta.node_fields.indexOf("self_size");
		if (!width || idx < 0 || p.nodes.length % width) throw Error("Invalid heap layout");
		let selfBytes = 0;
		for (let i = idx; i < p.nodes.length; i += width) selfBytes += number(p.nodes[i], "self_size");
		details = {
			format,
			nodeCount: p.nodes.length / width,
			selfBytes,
			note: "Shallow self size; not retained size or total process/native/decoder memory.",
		};
	} else if (format === "trace") {
		const p = object(JSON.parse(source.toString()), "trace");
		const events = Array.isArray(p.traceEvents) ? p.traceEvents : undefined;
		const spans = Array.isArray(p.resourceSpans) ? p.resourceSpans : undefined;
		if (!events?.length && !spans?.length)
			throw Error("Expected nonempty Chrome traceEvents or OTLP JSON resourceSpans");
		details = {
			format: events ? "chrome-trace" : "otlp-json",
			records: events?.length ?? spans?.length,
			note: "Raw trace attached. Sampling completeness and causality require collector metadata.",
		};
	} else if (format === "python-profile")
		details = parsePythonProfile(JSON.parse(source.toString()));
	else if (format === "speedscope") details = parseSpeedscope(JSON.parse(source.toString()));
	else if (format !== "opaque-profile") throw Error(`Unsupported profile format ${format}`);
	return {
		status: "inconclusive",
		summary: `${format} captured for inspection; no performance budget evaluated`,
		details,
	};
}
