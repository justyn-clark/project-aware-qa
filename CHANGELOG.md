# Changelog

All notable changes to `@justynclark/project-aware-qa` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/), and this project adheres
to [Semantic Versioning](https://semver.org/).

## [0.2.2] — unreleased

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

[0.2.2]: https://github.com/justyn-clark/project-aware-qa/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/justyn-clark/project-aware-qa/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/justyn-clark/project-aware-qa/releases/tag/v0.2.0
