# Runtime, infrastructure and CTV diagnostics

These capabilities are unreleased source changes, not part of npm 0.3.0.

Diagnostics add inspectable evidence to the existing scan/verify/report workflow.
They do not turn a discovered configuration, captured profile or emulator run into
proof of production or physical-device performance.

## Run diagnostics

Add `diagnostics` to `.project-aware-qa.json`, alongside existing team settings:

```json
{
  "version": 1,
  "diagnostics": [
    {"id": "bun-tests", "kind": "bun-test", "cwd": "apps/web"},
    {"id": "go-tests", "kind": "go-test", "cwd": "services/api", "race": true},
    {"id": "go-bench", "kind": "go-benchmark", "cwd": "services/api", "minRuns": 5},
    {"id": "bun-profile", "kind": "runtime-profile", "runtime": "bun", "cwd": "apps/web", "target": "./scripts/profile-workload.ts"},
    {"id": "node-profile", "kind": "runtime-profile", "runtime": "node", "cwd": "apps/web", "target": "./scripts/profile-workload.js"},
    {"id": "go-profile", "kind": "go-profile", "cwd": "services/api", "target": "./internal/player"}
  ]
}
```

Use only the entries that apply to your repository. Paths are repository-relative;
`target` is relative to `cwd`. Profiling workloads must terminate on their own.
The single-package Go profile preset preserves the generated test binary for external
symbol inspection; it is not a multi-package profiling command.

```bash
project-aware-qa scan .
project-aware-qa verify . --diagnostics --timeout 120000 --json
project-aware-qa report .
```

Pi uses the same flags through `/qa-verify --diagnostics`. Diagnostics are not selected
by `--tests`, and currently require an unscoped run (no scope, service or changed-since).
All configured checks run sequentially. `minRuns` defaults to 3. Go benchmarks use it
as `-count`; performance collectors must produce that many independent repetitions.

| Preset | Evidence | Acceptance boundary |
| --- | --- | --- |
| bun-test | Runtime version, JUnit cases, LCOV per-file lines | Nonempty, passing cases; skipped cases are inconclusive. Unlisted source coverage is unknown |
| go-test | Go version, JSON events, statement coverage, optional race detector | Passing completed tests/packages; cached results disabled |
| go-benchmark | Repeated ns/op, B/op and allocs/op where emitted | Measurements only; no automatic speedup claim or benchmark threshold |
| runtime-profile | Bun/Node CPU samples; Bun heap snapshot or Node sampled heap allocations | Profile capture only; no performance verdict |
| go-profile | Go test events, CPU/memory pprof files, execution trace | Raw native artifacts; open with Go tools, not automatically decoded |
| collector | Explicit command and declared artifact files | Depends on artifact format and configured performance budgets |
| cloudflare | Active deployment/version and traffic allocation | Expected version serving 100% of traffic; not health, permissions or bindings |

Unavailable runtimes, missing flags and malformed artifacts do not pass. Runtime
versions are recorded from the invoked executable; Bun as package manager is reported
separately from an explicit runtime declaration. Deno can supply a collector runtime
identity but has no native test/profile preset yet. Running the QA CLI itself on Bun
or Deno is not certified by these integrations.

Receipts, command logs and copied artifacts live in each `.qa/runs/<id>/diagnostics/`
directory and participate in verification evidence hashing. Receipts include source
fingerprints, run identity, capture times, runtime/host metadata and parsed observations.
A profile has its own capture overhead. Its CPU samples are not total CPU utilization;
Node allocation profiles are not complete heap snapshots; JS heap is not process,
native, GPU, media buffer or decoder memory.

Raw artifact files are limited to 64 MiB and command output to 8 MiB per stream.
Use bounded capture windows. Larger captures need an external inspection workflow;
this implementation refuses them rather than silently truncating and passing them.

## Infrastructure discovery and Cloudflare inspection

Scanning writes `platform-report.md` and records declarations in the registry:

- Cloudflare Wrangler JSON/JSONC: explicit binding names and environment sections for
  KV, R2, D1, services, Durable Objects, queues, workflows, cron and related bindings.
- Wrangler TOML: partial literal binding-name extraction; section names retain scope.
  Complex TOML and environment inheritance are not resolved.
- AWS CDK/SAM/Serverless/CloudFormation, Azure Bicep/Functions/azure.yaml, Google Cloud
  app/cloudbuild files, Terraform/OpenTofu and Pulumi: configuration markers only.
  No provider expressions are evaluated and no resources are deployed.

Variables, secret values and resource IDs are not copied into the configuration report.
Marker recognition can be ambiguous and is explicitly labeled; it is not a cloud audit.

For a read-only Cloudflare deployment identity check:

```json
{
  "id": "preview-deployment",
  "kind": "cloudflare",
  "accountId": "YOUR_ACCOUNT_ID",
  "worker": "YOUR_EXACT_PREVIEW_WORKER_NAME",
  "expectedVersion": "YOUR_EXPECTED_VERSION_ID",
  "tokenEnv": "CLOUDFLARE_API_TOKEN"
}
```

```bash
project-aware-qa verify . --diagnostics --cloud --require diagnostic-preview-deployment
```

The token comes from the named environment variable. The implementation makes one
fixed-origin GET to Cloudflare's deployments API, refuses redirects, and records only
allowlisted deployment metadata. A split rollout does not satisfy the 100% check.
Missing access is inconclusive. No deployment mutations, account-wide discovery,
AWS/Azure/GCP API inspection, or telemetry export configuration are performed.

## CTV platforms and collection levels

The shared schema accepts every platform identifier, including custom legacy devices.
The catalog includes these families:

| Platform IDs | Intended source tooling |
| --- | --- |
| tizen | Samsung Web Inspector or a configured device collector |
| webos | LG Web Inspector / ares tooling |
| android-tv, google-tv, fire-tv | Platform-supported Android profiling, Perfetto or ADB workflows |
| fire-tv-vega | Vega platform tooling / configured collector |
| samsung-orsay, lg-netcast, vewd | Legacy/vendor tooling / configured collector |
| roku | BrightScript Profiler and Roku Resource Monitor exports |
| tvos | Apple Instruments exports |
| vidaa, vizio, cast, titan-os, tivo-os, hbbtv | Vendor-supported web/device tooling |
| xumo, rdk | Provider/set-top-box tooling |
| playstation, xbox | Authorized platform tooling |
| Any custom ID | Your collector implementing the same contract |

**Current support level for all CTV entries: configured external collector and artifact
integration.** The pack does not ship native control/capture drivers for every platform,
install SDKs, attach to devices, decode proprietary `.bsprof`/Instruments/Perfetto files,
or certify any TV model. Attach those files as `opaque-profile`; use a collector to
export normalized measurements. Physical TV validation remains a device-lab task.

## Collector contract

Configure a real scenario runner in your repository:

```json
{
  "id": "living-room-playback",
  "kind": "collector",
  "command": ["node", "tools/collect-tv-performance.mjs"],
  "cwd": "",
  "requiredEnv": ["TV_TEST_CREDENTIAL"],
  "artifacts": [
    {"path": "performance.json", "format": "performance"}
  ],
  "minRuns": 5,
  "requirePhysicalDevice": true,
  "budgets": {"timeToFirstFrameMs": 2500, "rssMb": 180, "droppedFramesPct": 1},
  "baseline": "performance-baselines/tv-playback.json",
  "maxRegressionPercent": 10
}
```

The example command must be implemented using your device lab's tooling. The budget
numbers are examples, not recommended limits for every device. Remove `baseline` and
`maxRegressionPercent` for a first run. Do not add placeholder credentials to source.

The command receives:

- `QA_OUTPUT_DIR`: fresh absolute directory for this invocation's outputs.
- `QA_RUN_ID`: identity to embed in the capture.
- `QA_SOURCE_HASH`: current source fingerprint to embed in the capture.

Commands run as argument arrays without shell expansion. Write fresh files under the
output directory; artifact paths are relative to it. Absolute paths, traversal and
symlinks to external files are refused. The collector must capture new measurements,
identify the deployed build honestly, and never relabel an old capture with a new run ID.
The pack validates the contract, not the truthfulness of an external collector.

Use `performance-capture.example.json` as the format reference. Replace all example
metadata, capture timestamps and measurements with real results. Each `samples` entry
represents one independent scenario repetition after the stated warmup. Do not turn
successive time samples from one playback session into independent repetitions.
Record inaccessible metrics as absent, never zero. Optional `deviceId` (a lab alias)
and `soc` fields pin a physical unit and chipset for comparisons. Capture timestamps
must use the collector host clock and fall within the verification run.

Supported metric names and units are exported as `METRICS` from the package. They cover
startup/first frame, input and frame latency, rebuffering, dropped frames, CPU, RSS/PSS,
JS/native/GPU/decoder memory, GC pauses, long tasks and memory growth. `Mb` fields use
MiB. CPU normalization must say whether 100% represents one core or the whole device.
Counts and per-run p95 values must use the same measurement window across comparisons.

Budget evaluation uses the maximum across repetitions for absolute limits. Relative
regression uses medians. A changed device/model, OS/firmware, runtime, memory capacity,
content, codec, DRM, resolution, network, warmup, duration, sampling interval or
instrumentation makes the baseline incomparable. A zero baseline cannot establish a
percentage regression to a nonzero value. These are engineering budgets, not significance
tests or proof that a particular function caused a bottleneck.

For CTV investigation, keep separate scenarios for cold start, home-screen navigation,
first frame, steady playback, seek/channel changes, ads, suspend/resume and long soak
runs. CPU/heap traces can explain a regression; they do not measure the video decoder
or GPU unless the device collector supplies that evidence. A missing memory layer
remains unknown. Legacy hardware should have its own baseline and budget.

Use `--require diagnostic-living-room-playback` to gate that scenario in CI. A captured
profile alone remains inconclusive, so do not require every profile-only check to pass.
Declared credential values are redacted from logs and refused in copied artifacts;
collectors must keep secrets out of their original output and raw device traces.

## Primary references

- [Bun tests and JUnit](https://bun.sh/docs/test), [coverage](https://bun.sh/docs/test/code-coverage), [profiling](https://bun.sh/docs/project/benchmarking)
- [Node CPU/heap profiling flags](https://nodejs.org/api/cli.html)
- [Go diagnostics](https://go.dev/doc/diagnostics)
- [Cloudflare deployments API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/)
- [Samsung Web Inspector](https://developer.samsung.com/smarttv/develop/getting-started/using-sdk/web-inspector.html)
- [LG CLI tooling](https://webostv.developer.lge.com/develop/tools/cli-dev-guide)
- [Android TV memory](https://developer.android.com/training/tv/playback/memory)
- [Roku profiling](https://developer.roku.com/dev/docs/brightscript-profiler)
- [Apple Instruments](https://developer.apple.com/tutorials/instruments)
