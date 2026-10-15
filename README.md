# project-aware-qa

[![npm](https://img.shields.io/npm/v/@justynclark/project-aware-qa)](https://www.npmjs.com/package/@justynclark/project-aware-qa)
[![license](https://img.shields.io/npm/l/@justynclark/project-aware-qa)](./LICENSE)

A **Pi-first QA pack** that scans a real codebase, infers its test surfaces, ranks risk,
runs evidence-based checks, captures screenshots, and writes `.qa/*` reports.

It is *project-aware*: instead of running generic checks, it first builds a **surface
registry** by correlating frontend routes, backend endpoints, forms, DTOs, cache usage and
existing tests by **entity**, then plans and verifies the riskiest surfaces — admin/CRUD
flows, mutations without cache invalidation, forms whose fields don't match their DTO, and
untested mutating areas.

It is **multi-stack** via a plugin architecture: deep adapters parse real web surfaces for
specific ecosystems, and a generic adapter gives every other language a useful baseline.
A monorepo (e.g. a Remix frontend + a Phoenix backend) is detected as multiple stacks and
verified per-stack.

**Version 0.3.0** adds a standalone CLI, evidence validation, change-aware verification,
and team policies. See the [team integration guide](templates/team-workflows.md) for
configuration, ownership, baselines, authenticated checks, and CI exports.

### Stacks

| Adapter | Coverage |
| --- | --- |
| **node** (deep) | React Router / Remix routes, NestJS controllers/DTOs, forms, cache, Vitest/Jest/Playwright |
| **phoenix** (deep) | Phoenix router (scopes/pipelines, `resources`, LiveView), controllers, Ecto schemas, HEEx forms, Cachex, ExUnit |
| **python** (deep) | FastAPI/Flask decorator routes (APIRouter/Blueprint prefixes, Pydantic bodies), Django `urls.py` + DRF `router.register` + `@admin.register` CRUD, Pydantic/DRF/Django-model/form DTOs, templates, cache, pytest |
| **go** (deep) | chi / gin / echo / fiber / gorilla / net-http routes (chi `Route` closures + `Group` prefixes, gorilla `.Methods`, Go 1.22 `"GET /path"`), request/response structs as DTOs, `go test`, `go build/vet`/golangci-lint |
| **rust** (deep) | axum `.route(...)` chains, actix/Rocket `#[get]` macros, serde `Deserialize` structs as DTOs, `cargo build/test/clippy` |
| **java** (deep) | Spring `@RestController`/`@*Mapping` (class prefix + `@RequestBody`), JAX-RS `@Path`/`@GET`, records + `*Request`/`*Dto` classes, maven/gradle |
| **csharp** (deep) | ASP.NET Core minimal APIs (`MapGet`/`MapGroup`) + MVC controllers (`[HttpGet]`, `[controller]`, `[FromBody]`), record/`*Request` DTOs, `dotnet build/test` |
| **generic** (any language) | Detects the project type — **Zig, Odin, Godot (GUT), C/C++, Swift, Ruby, PHP, …** (and any language above when no web framework is present) — maps build/test/lint commands, and emits a test-gap baseline, so even systems/game stacks get something useful instead of "0 files" |

Adding a deep adapter for a new ecosystem is incremental — implement one `StackAdapter`
(file extensions, toolchain, detectors) and the shared inference/risk/report/verify core
works unchanged.

## Install into Pi

This is a Pi package: its `package.json` `pi` manifest points at the extension and the
skill, so Pi discovers both.

```bash
# Install the published package:
pi install npm:@justynclark/project-aware-qa

# …or from this repo (git source or a local clone):
pi install git:github.com/justyn-clark/project-aware-qa
pi install .
```

After installing, `/reload` in Pi and the four commands appear.

### Developing on the pack

Use Node 22 or newer.

```bash
npm ci
npm run check   # strict typecheck
npm run lint    # biome
npm test        # node:test suite
pi -e extensions/qa.ts   # load the local extension for a session
```

## Commands

| Command | Writes |
| --- | --- |
| `/qa-scan` | `.qa/surface-registry.json`, `scan-report.md`, `crud-matrix.md`, `risk-report.md` |
| `/qa-plan [scope]` | `.qa/test-plan.md` |
| `/qa-verify [scope] [flags]` | `.qa/verification.json`, `verification-report.md`, `.qa/runs/<id>/*` |
| `/qa-report` | `.qa/qa-report.md` |

`/qa-verify` flags (all **off by default** — they're brakes):
`--install`, `--tests`, `--screenshots`, `--start-dev-server`, `--base-url <url>`,
`--max-routes <n>`, `--timeout <ms>`.

### Standalone CLI and CI

The package includes a compiled CLI. Install a pinned version in your project:

```bash
npm install --save-dev --save-exact @justynclark/project-aware-qa@0.3.0
npx project-aware-qa --help
```

To build it from this checkout:

```bash
npm run build
node dist/src/cli.js scan /path/to/repo --json
node dist/src/cli.js plan /path/to/repo --scope admin
node dist/src/cli.js verify /path/to/repo --tests --json
node dist/src/cli.js report /path/to/repo
```

For a pull request or CI job, scan the exact checkout and restrict verification to the
changed stacks, their consumers, and affected service routes:

```bash
project-aware-qa scan . --json
project-aware-qa verify . --changed-since origin/main --tests \
  --require registry,typecheck,lint,test --junit --sarif --json
```

`--changed-since` combines the Git three-dot diff with staged, unstaged, and untracked files.
Local Node dependencies propagate transitively, including packages without runnable scripts.
Explicit cross-service dependencies live in `.project-aware-qa.json`. Root/shared inputs,
changed manifests and unmapped files conservatively select every stack, including when an
old dependency edge was removed. Renames include both paths. Helpers select all routes in
their service before the route limit is applied. The graph, reasons and resolved base commit
are recorded in each run as `change-selection.json`.

`npm pack` builds the executable before packing. Installing that tarball exposes
`project-aware-qa` with the same commands, without requiring Pi or `tsx`.
The TypeScript wrapper scripts remain available during development:

```bash
tsx scripts/scan.ts   /path/to/repo
tsx scripts/plan.ts   /path/to/repo --scope admin
tsx scripts/verify.ts /path/to/repo --screenshots --base-url http://localhost:5173
tsx scripts/report.ts /path/to/repo
```

Arguments are shared between Pi and the CLI. Unknown options, missing values, conflicting
arguments, and nonpositive numeric limits fail before running a workflow. Quote paths and
scopes containing spaces. `--json` is available on CLI commands only.

Verification remains advisory by default. `--require <id,id>` promotes missing, failed,
skipped, or inconclusive matching checks to a policy failure; a requirement such as `typecheck`
matches every package-specific typecheck ID. `--fail-on-incomplete` additionally rejects any
skipped or inconclusive check. Exit 1 indicates a check or policy failure; cancellation exits 130.

`--junit` writes `.qa/verification.junit.xml`; `--sarif` writes
`.qa/verification.sarif.json`. Immutable copies live in `.qa/runs/<id>/` beside the JSON and
Markdown reports. Once enabled in a workspace, exports are refreshed on subsequent verification
attempts, including failed prerequisites, so CI cannot upload an earlier passing result.
The [CI template](templates/github-actions-qa.yml) checks the PR checkout with full Git history
and uploads summary artifacts even when verification fails.

### Engineering team workflows

Use [the team guide](templates/team-workflows.md) and
[configuration example](templates/project-aware-qa.example.json) to configure:

- Dependencies between services and shared directories, plus mandatory checks that CLI defaults cannot weaken.
- CODEOWNERS routing in `.qa/team-report.md`, using local file precedence and last matching rules.
- Portable risk/gap baselines and a policy for new or worsened high-risk surfaces.
- Exact gap suppressions with an owner, reason and UTC expiry. Original findings and failed checks remain visible.
- Existing authenticated behavior suites, explicit surface mappings, fresh Playwright JSON results and trace attachments.

Create a baseline with `project-aware-qa scan . --save-baseline`, then copy
`.qa/baseline.json` to a version-controlled path and reference it in team configuration.
`scan --baseline qa-baseline.json` also supports a one-off comparison. Baselines compare
inferred risk and gaps, not screenshot pixels. They must use the same tool version.

When several applications expose the same route, use `verify --service apps/web
--base-url http://localhost:5173` for that visual target. Otherwise visual verification is
inconclusive and no cross-service route probes run. Package checks still run for all affected
stacks. Authenticated assertions run through your configured test command with `--tests`;
pass credentials through environment variable names, never command arguments or config values.

### Evidence freshness

Scanning records a Git commit (when available) and content fingerprint. Verification
requires that snapshot to match current inputs. Edits require another scan; changes during
verification make the run inconclusive. Legacy registries need a new scan.

Each run stores logs, probes, screenshots, a report, and `verification.json` under
`.qa/runs/<id>/`. The top-level `.qa/verification.json` points to the latest run through its
run ID and contains the full structured results. Aggregated reports check source and registry
fingerprints and evidence digests before displaying current counts. Deleted/changed artifacts
are unverified; old source evidence is stale. All four check statuses remain visible.

Package boundaries isolate inference and check execution. A matching test filename is
evidence of a related test, with coverage **unknown** until established. Static cache signals
likewise do not establish that a particular mutation executes an invalidation. Cross-package
relationships require explicit verification.

## The repair loop

```
scan → plan → verify → fix → scan → verify → report
```

Nothing is "done" without evidence. Executed checks link their logs under
`.qa/runs/<id>/findings/`, and every failing check becomes a repair-loop finding carrying:
**issue · evidence · suspected cause · fix status · rerun evidence · remaining gap.**
Skipped checks are never counted as passing — they record *why* they were skipped.

### Route checks are calibrated, not naïve

An HTTP status is only a trustworthy route signal when the server distinguishes real
routes from unknown ones. So `/qa-verify` first **calibrates** the server (probes the root
and a deliberately-nonexistent path):

- **SSR / framework apps** (unknown path → 404): status is meaningful. Routes that 2xx/3xx
  pass; **any 404/5xx fails the check** (partial = failed), with the broken routes named by
  source file. 404s that are mere normalization artifacts (trailing slash) are **rescued**
  by a variant re-probe before being reported. 401/403 are treated as auth-gated (a soft
  note, not a failure).
- **SPA / catch-all apps** (unknown path → 200): HTTP status can't validate routes, so the
  route check is reported **inconclusive** (never a false pass), and the authoritative
  verdict comes from the **rendered-DOM check** in `--screenshots` mode — which flags pages
  that render a not-found/error boundary and counts console errors.

`inconclusive` is a first-class status: not a pass, not a fail, with the reason recorded.

## What it detects

- **Routes** — React Router (RR6 `<Route>`, RR7 `route()`/`index()` config) and
  Remix/flat-routes file conventions (`app/routes/**`, `$param`, `_index`, pathless `_`
  layouts, `.route.tsx`, hybrid folders), plus light Next.js app-router support.
- **Backend** — NestJS controllers/endpoints (`@Controller`, `@Get/@Post/@Put/@Patch/@Delete`,
  `@Body() Dto`) and DTOs with class-validator decorators.
- **Forms** — Remix `<Form>`, raw `<form>`, react-hook-form, Formik, with field names.
- **Cache/invalidation** — TanStack Query (`useQuery`/`useMutation`/`invalidateQueries`),
  SWR (`useSWR`/`mutate`), React Router revalidation, `cachified` + `clearCacheKey`,
  NestJS `cache-manager`, and `localStorage`/`sessionStorage`.
- **Tests** — Vitest / Jest / Playwright, mapped to the entities they cover.

## Architecture

```
extensions/qa.ts          Pi extension — registers /qa-scan /qa-plan /qa-verify /qa-report
scripts/*.ts              CLI wrappers around the same core
src/
  types.ts                Surface + registry model (Phase 3 core object)
  scanner/                files walker, package/toolchain detection, scan orchestration
  detectors/              react-router, nestjs, forms, cache, playwright, tests, entities
  inference/              crud (entity correlation), risk (scoring)
  registry/               build (assembly), schema (validation)
  verify/                 commands (safe runner + brakes), playwright (probes+screenshots)
  report/                 markdown (scan/crud/risk/plan), verification, summary
  core.ts                 runScan / runPlan / runVerify / runReport
templates/                surface-registry.schema.json + report templates
skills/project-aware-qa/  SKILL.md (agent guidance)
```

Runtime dependencies: **none** — the scanner uses only Node built-ins. Playwright is used
opportunistically (resolved from the target repo or globally) and is never required.

## Surface registry

The central artifact (`.qa/surface-registry.json`) is an array of `Surface` objects:

```ts
{ id, type, entity?, frontendRoute?, backendEndpoint?, files,
  risk, riskScore, riskReasons, inferredTests, evidence, gaps }
```

`type ∈ { crud-flow, form, api-endpoint, route, cache-risk, visual-page, test-gap }`.
Validated against `templates/surface-registry.schema.json`.

## Limitations (v1)

- Route detection is heuristic across React Router versions; flat-routes edge cases may
  mis-derive a path.
- NestJS decorator parsing is regex-based (computed paths / unusual decorators may be missed).
- Form detection requires real fields to avoid over-detecting search/layout forms.
- Auth-gated admin routes need credentials/config to verify at runtime.
- Visual QA captures, it does **not** diff against baselines.
- Cache-invalidation inference is best-effort and can produce false positives/negatives.
- Fingerprints exclude installed dependencies and operational/generated output directories;
  they establish a source snapshot, not reproducibility of external services or databases.
- Process-tree cleanup has local POSIX regression coverage; Windows behavior and real browser
  integration require separate validation. The CI matrix is configuration until run on GitHub.
- Dependency inference covers local Node manifests; declare cross-language and network service
  relationships explicitly. It is not a complete runtime call graph.
- Ownership hints reflect the current checkout; GitHub evaluates review routing from the PR base
  and checks account permissions. This tool does not request reviews or notify owners.
- Behavior mappings state which suite the team assigns to a surface. Passing a suite does not
  prove every assertion or user journey is covered. Traces may contain application data;
  the CI template excludes attachments and raw logs from uploads.
