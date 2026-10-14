# Changelog

All notable changes to `@justynclark/project-aware-qa` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/), and this project adheres
to [Semantic Versioning](https://semver.org/).

## [0.3.0] — unreleased

### Added
- A compiled `project-aware-qa` CLI with scan/plan/verify/report commands and structured
  `--json` output. The published CLI runs with Node 22+ and no TypeScript loader.
- Source/registry fingerprints, structured verification records, evidence digests, and
  separate `.qa/runs/<id>/` artifacts for every verification run.
- CI configuration for Node 22/24/26 on Linux and Node 24 on macOS, including a packed CLI smoke test.

### Fixed
- Node monorepo checks retain their package directories and package managers. Parent
  adapters exclude nested projects; services sharing routes keep separate surface IDs.
- Related test files now mean unknown coverage, and no longer lower risk or claim
  successful happy-path/validation coverage. Cache links remain unproven until verified.
- A successful desktop screenshot cannot hide a failed mobile capture.
- Owned dev servers start before probes and are stopped after completion or cancellation.
  Timeouts and cancellation clean up descendant processes.
- Reports preserve inconclusive results and reject stale, missing, or changed evidence.
- CLI/Pi flags share strict parsing, including quoted scopes, boolean flags before target
  paths, positive numeric options, and errors before any work on invalid arguments.
- Plan and verification scopes consistently select risk, surface type, entity, and route.
- HTML templates reach Python form detection; runtime tool metadata uses the package version.

## [0.2.2] — 2026-10-14

### Fixed
- **Skill frontmatter** — `0.2.1` shipped a broken `SKILL.md`: a colon in the `description`
  (`Multi-stack: …`) made YAML read the value as a nested mapping, so Pi failed to load the
  skill (the `/qa-*` commands, which come from the extension, were unaffected). Replaced with
  an em dash. **Use `0.2.2`+ if you installed `0.2.1`.**

### Added
- A test that parses every `SKILL.md` frontmatter (runs in `prepublishOnly`) so a malformed
  skill can never be published again.
- A packed-release regression test that validates the shipped skill manifest and loads
  the shipped extension to check registration of all four QA commands.

## [0.2.1] — 2026-06-27

> ⚠️ The published `0.2.1` skill fails to load due to malformed YAML frontmatter — fixed in `0.2.2`.

### Changed
- A Node stack is now anchored only by a real project signal (a framework or a runnable
  script), so an assets/tooling-only `package.json` next to a Phoenix/Django/… app no longer
  produces a noisy "Node (unknown)" stack.
- Empty stacks (no frameworks, no checks, nothing detected) are dropped from the registry.

### Fixed
- Removed two non-null assertions so `biome check` is warning-free.
- Migrated the Biome config (`linter.rules.recommended` → `preset`) to clear a deprecation.

### Docs
- `SKILL.md` and the README now describe the full multi-language stack support.
- Added this changelog.

## [0.2.0] — 2026-06-26

First published release.

### Added
- **Pi pack**: `/qa-scan`, `/qa-plan`, `/qa-verify`, `/qa-report` commands (plus CLI scripts),
  loaded via the `pi` manifest; a `project-aware-qa` skill.
- **Surface registry**: entity-correlated inference of CRUD flows, forms↔endpoint/DTO mapping,
  mutation↔cache-invalidation pairing, additive risk scoring, and `.qa/*` reports.
- **Multi-stack adapter architecture** — deep adapters for **node** (React Router/Remix +
  NestJS), **phoenix** (Elixir), **python** (FastAPI/Flask/Django), **go** (chi/gin/echo/
  fiber/net-http), **rust** (axum/actix/Rocket), **java** (Spring/JAX-RS), and **csharp**
  (ASP.NET Core); a **generic** any-language adapter (Zig, Odin, Godot, C/C++, Swift, Ruby,
  PHP, …) with build/test/lint detection and a test-gap baseline.
- **Evidence-based verify**: a gated safe-check ladder (install/typecheck/lint/test per stack),
  calibrated route probing (down/distinguishes/catch-all → first-class `inconclusive` status,
  trailing-slash variant rescue), and rendered-DOM screenshot validation — every claim backed
  by a command log or a skip reason.

[0.3.0]: https://github.com/justyn-clark/project-aware-qa/compare/b7507f6...HEAD
[0.2.2]: https://github.com/justyn-clark/project-aware-qa/compare/v0.2.1...b7507f6
[0.2.1]: https://github.com/justyn-clark/project-aware-qa/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/justyn-clark/project-aware-qa/releases/tag/v0.2.0
