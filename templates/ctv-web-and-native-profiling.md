# CTV web testing and cross-language profiling

Use browser QA as an accessible development and CI layer before device testing.
It can catch broken D-pad navigation, lost or off-screen focus, failed playback,
JavaScript errors, and desktop performance regressions. Physical TV certification
still needs the target engine, decoder, DRM, firmware and memory constraints.

## Run the browser collector

Copy `ctv-browser-collector.mjs` and `ctv-browser.example.json` from this directory
into your project's `qa/` directory. Adapt the URL, selectors, key sequence, content
metadata and host alias. Start the application yourself, and use an installed local
Playwright package with its Chromium browser. The collector does not install tools,
start application servers, or connect to your personal browser session.

Add this entry to the `diagnostics` array in `.project-aware-qa.json`:

```json
{
  "id": "ctv-web",
  "kind": "collector",
  "runtime": "node",
  "command": ["node", "qa/ctv-browser-collector.mjs", "qa/ctv-browser.example.json"],
  "artifacts": [
    { "path": "junit.xml", "format": "junit" },
    { "path": "performance.json", "format": "performance" }
  ],
  "requirePhysicalDevice": false,
  "minRuns": 3,
  "budgets": { "startupMs": 2000, "frameTimeP95Ms": 50, "jsHeapMb": 128 }
}
```

Those budgets are examples, not recommended device limits. Establish a baseline on
your own runner and workload. Run with enough time for all repetitions and failures:

```sh
project-aware-qa verify . --diagnostics --timeout 180000 --require diagnostic-ctv-web
```

Every repetition gets a fresh browser context. Steps send only remote keys and assert
that exactly one expected element has focus, is visible, and fits in the viewport.
There are no pointer clicks or programmatic focus repairs. The app must establish its
initial focus and implement navigation. Each step may set `timeoutMs` for its focus
assertion; otherwise the scenario timeout applies. Supported keys: ArrowUp, ArrowDown, ArrowLeft,
ArrowRight, Enter, Escape, Backspace and MediaPlayPause. Key mapping remains app-specific.
DOM selectors do not cover closed shadow roots or native TV controls. These assertions
do not certify focus-ring contrast, occlusion, readability or ten-foot usability;
review the screenshots and test with people and remotes.

If `videoSelector` is set, video must be playing after navigation and its currentTime
must advance during the measurement window. Missing video, pause, media error or stalled
time fails the scenario. If omitted, this is a navigation-only scenario. This check
is not an end-to-end DRM, CDN, decoder or audiovisual synchronization test.

### What is measured

| Output | Definition and boundary |
| --- | --- |
| startupMs | Host elapsed time from navigation to visible readySelector; not time to first video frame |
| frameTimeP95Ms | P95 requestAnimationFrame interval during the observation window; not decoded video frame time |
| longTaskCount | Browser long tasks during that window, after warmup |
| jsHeapMb | End-of-window CDP JSHeapUsedSize divided by 1048576; not RSS or native/decoder memory |
| droppedFramesPct | Delta dropped/total frames from video playback quality, only if frames were reported |

Desktop captures always say `device.kind: desktop`, with Chromium version, OS, CPU,
architecture and your stable host alias. CPU throttling is synthetic, not a named TV
emulation. Network is a declared environment label; this collector does not impose
network shaping. Configure shaping outside the collector and label it accurately.
The recorded 16.667 ms sample interval is a nominal 60 Hz reference; actual rAF
intervals are measured, not forced. The scenario fingerprint includes the URL, selectors, remote steps, viewport, throttle,
measurement durations, and debug setting. Build IDs may change across comparisons;
scenario and host changes cannot silently compare as the same experiment. Warmup
covers the post-navigation session, not a prewarmed browser process. Repeated contexts
still share one browser process and host; use stable CI runners and investigate noise.

A failed repetition produces failed JUnit evidence and a nonzero exit. No complete
performance capture is emitted unless every repetition succeeds. Missing metrics
cannot satisfy a configured budget. By default the performance evaluator requires
physical hardware; the explicit `requirePhysicalDevice: false` above authorizes a
desktop-only gate. Never use that gate to satisfy a physical-device release requirement.

### Inspect failures and profiles

The output directory contains `browser-run.json`, per-run PNG screenshots and JUnit.
Set `debug: true` for Playwright trace ZIPs and CDP CPU profiles. Debug collection adds
overhead and changes the scenario fingerprint; use separate debug and benchmark runs.
Open trace ZIPs with Playwright Trace Viewer and `.cpuprofile` files with DevTools.
The template currently does not capture heap snapshots, native memory or GPU counters.

Only declared artifacts are copied into the QA evidence manifest. Declare a debug
CPU file as `cpu-profile` or a Playwright ZIP as `opaque-profile` when it must be part
of the digest-bound receipt. Raw profiles produce an inconclusive diagnostic because
capture alone is not a performance pass. Keep that inspection check separate from your
required budget gate. Files larger than 64 MiB are rejected; shorten debug captures.
Traces and screenshots can contain application data; use fixture accounts and content.

## Chrome DevTools for agents and MCP

Chrome's official DevTools MCP supports browser interaction, performance traces and
heap inspection. The October 2026 release notes also describe retained-size/property
queries, lazy source maps and JavaScript execution controls. See the official
[agent guide](https://developer.chrome.com/docs/devtools/agents) and
[October release notes](https://developer.chrome.com/blog/new-in-devtools-october-2026/).

Use MCP for exploratory investigation: reproduce the exact key flow, inspect focus,
record a bounded trace, and inspect heap retainers around repeated playback sessions.
Turn a useful reproduction into a committed collector scenario for repeatable CI.
The pack does not register an MCP server, configure your agent, or claim that an agent's
textual explanation is measured evidence.

For ingestion, an external collector must export artifacts into its fresh
`QA_OUTPUT_DIR` during that invocation. Supported imports include V8 CPU profiles,
V8 heap snapshots, sampled allocation profiles, Chrome `traceEvents` JSON, OTLP JSON,
and raw opaque profiles. A Playwright ZIP is not Chrome trace JSON. Bind normalized
performance data to `QA_RUN_ID` and `QA_SOURCE_HASH`; do not relabel an old manually
captured profile as a fresh benchmark. Keep recorder/tool version, capture settings,
source maps and symbol information with the experiment. Raw file import supports
inspection; it does not establish capture provenance or causal conclusions by itself.

## Language support and presets

Python is not normally categorized as a low-level language, but its native extensions,
allocations and runtime overhead make it equally relevant to this diagnostics layer.

| Language | Existing QA | Added diagnostic evidence | Remaining boundary |
| --- | --- | --- | --- |
| Python | FastAPI/Flask/Django discovery, pytest and lint candidates | python-test JUnit; python-profile cProfile function timing and tracemalloc allocation totals | Native allocations and all-thread CPU need external profilers |
| Rust | Axum/Actix/Rocket discovery, build/test/clippy | rust-coverage LCOV; collector runtime identity and native profile attachments | OS sampling, allocator profiling and sanitizers remain external tools |
| Zig | Manifest detection, build/test candidates | Zig identity on collectors, common trace/profile/coverage imports | No universal bundled Zig test-report or profiler driver |
| C/C++ | Manifest detection, CMake/CTest candidates | cmake-test JUnit; clang identity and common profile imports | Compiler/platform-specific instrumentation remains external |
| Go | Route/type discovery and tests | JSON tests/race/coverage, repeated benchmarks, pprof and execution trace | Binary profiles require Go tools for deeper inspection |
| Bun/Node | JS/TS framework discovery | CPU and heap profiles; Bun JUnit/LCOV | V8/JSC memory is not all process memory |

Available native presets:

```json
[
  { "id": "python-tests", "kind": "python-test", "cwd": "services/api" },
  { "id": "python-cpu-memory", "kind": "python-profile", "target": "./bench/workload.py" },
  { "id": "rust-lines", "kind": "rust-coverage", "cwd": "native/player" },
  { "id": "cpp-tests", "kind": "cmake-test", "cwd": "build" }
]
```

`python-test` uses the active `python3 -m pytest` environment and writes fresh JUnit;
activate your project's virtual environment first. The preset disables the pytest
cache provider to avoid adding cache files to the source snapshot. `python-profile` uses only Python
stdlib cProfile, pstats and tracemalloc, with bytecode writes disabled. It executes a
finite script with its own directory on sys.path and no extra arguments. The JSON
contains call counts, self/cumulative seconds and current/peak traced Python bytes.
The instrumented main thread and traced allocator are not the whole process. A workload
exception remains a failed diagnostic even when a profile was captured in `finally`.
Profiles without performance budgets remain inconclusive.

`rust-coverage` requires preinstalled cargo-llvm-cov and compatible LLVM tools. It runs
locked/offline, disables automatic LLVM installation, and uses a fresh coverage target
and intermediate-build directory under the run output. Provision the lockfile and
cached dependencies first. It records line coverage, not test-case counts or speed.
Doctests and branch coverage are not enabled. Native C/C++ dependencies in Rust need
project-specific LLVM configuration; use a collector for those settings.
`cmake-test` runs CTest in an already-configured build directory, fails if no tests
exist, and consumes actual JUnit cases. It does not configure or build your project.

### Cross-language profiler collectors

The `collector` runtime field accepts `python3`, `rustc`, `zig` and `clang` as well as
Bun, Node, Deno and Go. It records the executable version; that identity does not prove
which compiler built an arbitrary attached binary. Keep build flags, symbols, target
triple and binary hash in your collector's metadata.

Speedscope `sampled` and `evented` JSON now receive structural validation: frame IDs,
weights, units, event ordering and balanced stacks. Hotspots retain the declared unit;
bytes and sample weights are not silently converted into CPU percentages. Python
[py-spy](https://github.com/benfred/py-spy) can export this format. For Rust, Zig and
C/C++, tools such as [samply](https://github.com/mstange/samply), perf and Instruments
can inspect native binaries with symbols. Use `opaque-profile` for their native files
unless the exporter explicitly produces one of the supported structured formats;
Firefox Profiler JSON is not Speedscope JSON. Profiler permissions are OS-dependent.

A project-owned collector can run the appropriate tool with an argument array and
write `profile.json` under `QA_OUTPUT_DIR`. Declare its actual format in configuration:

```json
{
  "id": "zig-native-profile",
  "kind": "collector",
  "runtime": "zig",
  "command": ["node", "qa/profile-native.mjs"],
  "artifacts": [{ "path": "profile.json", "format": "opaque-profile" }]
}
```

`qa/profile-native.mjs` is your platform-specific runner, not a bundled script. The
same contract works for Rust, C/C++, Swift and other native runtimes. Only use
`speedscope` when the output actually conforms to that format. Coverage collectors
can export LCOV; Rust test collectors can export
[nextest JUnit](https://nexte.st/docs/machine-readable/junit/). Always create reports
in the fresh output directory and propagate the child process exit code. Do not copy
stale reports or treat Cargo compiler JSON messages as individual test results.

References: [Python profiling](https://docs.python.org/3/library/profile.html),
[cargo-llvm-cov](https://github.com/taiki-e/cargo-llvm-cov),
[CTest](https://cmake.org/cmake/help/latest/manual/ctest.1.html),
[Speedscope schema](https://www.speedscope.app/file-format-schema.json).

## Regression tests

The main test suite covers parsers, configuration and language adapters. Browser
regressions run in the dedicated `ctv-browser` CI job using isolated Playwright 1.62.1.
To run them locally with an existing installation:

```sh
QA_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node --import tsx --test test/ctv-browser.test.ts
```

Without that variable the browser integration test explicitly skips; no browser is
silently installed. The fixture streams generated canvas frames locally, so these
tests exercise browser playback and failure handling without an external video CDN.
