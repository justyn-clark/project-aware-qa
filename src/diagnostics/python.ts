import { number, object, text } from "./config.js";

/** Stdlib only; run in the selected project's Python environment, without bytecode writes. */
export const PYTHON_PROFILE = `
import cProfile, json, os, pstats, runpy, sys, tracemalloc
entry, output = sys.argv[1:3]
sys.argv = [entry]
sys.path.insert(0, os.path.dirname(entry))
profiler = cProfile.Profile()
tracemalloc.start(1)
try:
    profiler.enable()
    runpy.run_path(entry, run_name="__main__")
finally:
    profiler.disable()
    current, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    stats = pstats.Stats(profiler)
    rows = []
    for (file, line, name), (primitive, calls, own, cumulative, callers) in stats.stats.items():
        rows.append(dict(file=file, line=line, name=name, primitiveCalls=primitive,
                         calls=calls, selfSeconds=own, cumulativeSeconds=cumulative))
    rows.sort(key=lambda row: row["selfSeconds"], reverse=True)
    with open(os.path.join(output, "python-profile.json"), "x") as dest:
        json.dump(dict(version=1, functions=rows, tracedCurrentBytes=current,
                       tracedPeakBytes=peak), dest, ensure_ascii=True)
`;

export function parsePythonProfile(value: unknown): unknown {
	const data = object(value, "Python profile");
	if (data.version !== 1 || !Array.isArray(data.functions) || !data.functions.length)
		throw Error("Invalid Python profile");
	const current = number(data.tracedCurrentBytes, "tracedCurrentBytes");
	const peak = number(data.tracedPeakBytes, "tracedPeakBytes");
	if (peak < current) throw Error("Python peak memory is below current memory");
	for (const raw of data.functions) {
		const row = object(raw, "Python function");
		text(row.file, "file");
		text(row.name, "name");
		for (const key of ["line", "primitiveCalls", "calls"])
			if (!Number.isInteger(number(row[key], key))) throw Error(`Invalid ${key}`);
		if ((row.primitiveCalls as number) > (row.calls as number)) throw Error("Invalid call count");
		number(row.selfSeconds, "selfSeconds");
		number(row.cumulativeSeconds, "cumulativeSeconds");
	}
	return {
		functions: data.functions.length,
		tracedCurrentBytes: current,
		tracedPeakBytes: peak,
		hotspots: [...data.functions].sort((a, b) => b.selfSeconds - a.selfSeconds).slice(0, 20),
		note: "Instrumented Python function timing and traced Python allocations; not process RSS, native allocations or all-thread CPU utilization.",
	};
}
