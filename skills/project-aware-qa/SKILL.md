---
name: project-aware-qa
description: Project-aware QA for real codebases. Scan a repo to infer test surfaces (routes, endpoints, forms, CRUD/admin flows, cache risks), rank risk, generate a risk-scaled test plan, run evidence-based checks with screenshots, and drive a scan→plan→verify→fix→verify→report repair loop. Use when asked to QA, test, audit coverage, find stale-data/cache bugs, or check an admin app (React Router/Remix + NestJS).
---

# Project-aware QA

You QA a real codebase by **inferring its surface area first**, then testing the riskiest
surfaces with evidence. Never claim something works without a command, log, screenshot, or
probe to back it.

## Commands

| Command | What it does | Writes |
| --- | --- | --- |
| `/qa-scan` | Static scan → infer surfaces, rank risk | `.qa/surface-registry.json`, `.qa/scan-report.md`, `.qa/crud-matrix.md`, `.qa/risk-report.md` |
| `/qa-plan [scope]` | Risk-scaled test plan from the registry | `.qa/test-plan.md` |
| `/qa-verify [scope] [flags]` | Run safe checks + route probes + screenshots | `.qa/verification-report.md`, `.qa/findings/*`, `.qa/screenshots/*` |
| `/qa-report` | Aggregate everything + outstanding gaps | `.qa/qa-report.md` |

`scope` is an entity (`track`), a surface type (`crud-flow`, `cache-risk`, …), a risk level
(`high`), or `admin`. `/qa-verify` flags: `--install`, `--tests`, `--screenshots`,
`--start-dev-server`, `--base-url <url>`, `--max-routes <n>`.

You can also run the steps as scripts when outside Pi:
`tsx scripts/scan.ts <dir>`, `plan.ts`, `verify.ts`, `report.ts`.

## The repair loop

Always work in this order, and surface evidence at every step:

```
scan → plan → verify → fix → verify → report
```

1. **scan** — run `/qa-scan`. Read `risk-report.md` and `crud-matrix.md`. The high-risk
   surfaces are where bugs hide: admin CRUD, mutations without cache invalidation,
   forms whose fields don't match their DTO, untested mutating areas.
2. **plan** — run `/qa-plan` (optionally scoped to the area you're working on). The plan
   states what to test even when no test exists yet.
3. **verify** — run `/qa-verify`. By default it runs typecheck/lint and probes routes; it
   records install, full tests, and screenshots as **skipped with a reason** unless you
   opt in. Every executed check links a log under `.qa/findings/`.
4. **fix** — make a change. Keep it surgical and tied to one finding.
5. **verify again** — re-run `/qa-verify` and link the new log as **rerun evidence**.
6. **report** — run `/qa-report` once the area is in good shape.

## Evidence rule (non-negotiable)

A finding is only "done" when the verification report records all of:
**issue · evidence · suspected cause · fix status · rerun evidence · remaining gap.**
A skipped check is **not** a pass — it carries its reason. If you cannot verify something
(auth-gated route, missing seed data, server not running), say so explicitly and record it
as a remaining gap rather than asserting it works.

## Brakes — ask before

- modifying the target app's code (fixes are fine when that's the task, but confirm scope)
- installing dependencies (`--install`), running the full test suite (`--tests`), or
  starting dev servers (`--start-dev-server`) — these are gated for a reason
- any destructive DB command, seeding/deleting production-like data, or paid/networked APIs

## Capturing screenshots

`/qa-verify --screenshots` drives Playwright if it can resolve `playwright`/`@playwright/test`
from the target repo or globally. When it can't, it writes `.qa/screenshots/plan.json`
(base URL + routes + viewports) and skips with a reason — in that case capture the listed
routes with the **Playwright MCP** (`browser_navigate` → `browser_take_screenshot`) at
desktop (1280×800) and mobile (390×844), saving into `.qa/screenshots/`.

## What the scanner understands

- **Routes**: React Router (RR6 JSX, RR7 config) and Remix/flat-routes file conventions
  (`app/routes/**`, `$param`, `_index`, pathless `_` layouts, `.route.tsx`).
- **Backend**: NestJS controllers (`@Controller`/`@Get`/`@Post`/…), endpoints, and DTOs
  with class-validator decorators.
- **Forms**: Remix `<Form>`, raw `<form>`, react-hook-form, Formik — with field names.
- **Cache/invalidation**: TanStack Query, SWR, React Router revalidation, cachified +
  `clearCacheKey`, NestJS cache-manager, and browser storage.
- **Tests**: Vitest / Jest / Playwright, mapped back to the entities they cover.

Inference correlates these by **entity** (track ↔ tracks ↔ `@Controller('track')` ↔
`CreateTrackDto`) to build CRUD flows, map forms to endpoints, diff form fields against
DTOs, and pair mutations with their (missing) cache invalidations.
