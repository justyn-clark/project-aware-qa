# project-aware-qa

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

### Stacks

| Adapter | Coverage |
| --- | --- |
| **node** (deep) | React Router / Remix routes, NestJS controllers/DTOs, forms, cache, Vitest/Jest/Playwright |
| **phoenix** (deep) | Phoenix router (scopes/pipelines, `resources`, LiveView), controllers, Ecto schemas, HEEx forms, Cachex, ExUnit |
| **python** (deep) | FastAPI/Flask decorator routes (APIRouter/Blueprint prefixes, Pydantic bodies), Django `urls.py` + DRF `router.register` + `@admin.register` CRUD, Pydantic/DRF/Django-model/form DTOs, templates, cache, pytest |
| **go** (deep) | chi / gin / echo / fiber / gorilla / net-http routes (chi `Route` closures + `Group` prefixes, gorilla `.Methods`, Go 1.22 `"GET /path"`), request/response structs as DTOs, `go test`, `go build/vet`/golangci-lint |
| **generic** (any language) | Detects the project type (Elixir, Go, Rust, Zig, Python, Ruby, Java, .NET, C/C++, Godot, …), maps build/test/lint commands, and emits a test-gap baseline — so even systems/game stacks get something useful instead of "0 files" |

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

```bash
npm install
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
| `/qa-verify [scope] [flags]` | `.qa/verification-report.md`, `.qa/findings/*`, `.qa/screenshots/*` |
| `/qa-report` | `.qa/qa-report.md` |

`/qa-verify` flags (all **off by default** — they're brakes):
`--install`, `--tests`, `--screenshots`, `--start-dev-server`, `--base-url <url>`,
`--max-routes <n>`, `--timeout <ms>`.

### As standalone scripts

```bash
tsx scripts/scan.ts   /path/to/repo
tsx scripts/plan.ts   /path/to/repo --scope admin
tsx scripts/verify.ts /path/to/repo --screenshots --base-url http://localhost:5173
tsx scripts/report.ts /path/to/repo
```

## The repair loop

```
scan → plan → verify → fix → verify → report
```

Nothing is "done" without evidence. Every verification check links its command log under
`.qa/findings/`, and every failing check becomes a repair-loop finding carrying:
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
