# Team integration

These features are in the 0.3 development build. Install the tested tarball as a pinned
development dependency before using the CLI or workflow template. Published 0.2.2 fixes
the Pi skill packaging issue and does not include this CLI.

Start with advisory runs against a representative pull request. Check the selected services,
surface IDs, gaps and owners with the people who maintain them. Enable required checks once
the mappings and test setup match your repository. A local pilot is not a production rollout.

Run `node templates/demo-team-workflow.mjs` after building to exercise the compiled CLI in an
isolated Git fixture. It checks transitive dependencies, authenticated/unauthenticated HTTP,
credential redaction, missing required suites and stale-result handling. Evidence stays under
`.qa/demos/`. Set `QA_DEMO_PLAYWRIGHT` to an installed Playwright module's absolute `index.mjs`
path to add a real Chromium assertion, screenshot and trace using already-installed browsers.

## Configuration and dependencies

Copy `project-aware-qa.example.json` to `.project-aware-qa.json` at the project root. Replace
its service paths, suite command and surface IDs. Unknown keys or invalid paths fail before
repository commands run. Paths use `/`, are relative to the project root, and cannot leave it.
Use `.` for the root service. No configuration is required for the existing advisory workflow.

`dependencies` maps **consumer -> dependencies**. If web depends on API and API depends on
contracts, a contracts change selects all three transitively. Cycles are handled. Local Node
package references in dependencies/devDependencies/peerDependencies/optionalDependencies are
inferred by package name or local file/link reference. Explicit edges add to these relationships.
Consumers must be discovered stack/package roots; dependencies may be shared directories.
Changed manifests select all stacks because the previous graph may have different edges.

`--changed-since` requires an available Git commit and merge base; CI needs full history or an
explicit fetch. It includes committed PR changes, the index, working-tree edits and untracked
files. Changes to helpers select the service's routes, not only files that contain routes.

`--service apps/web --base-url http://localhost:5173` selects one visual application. It does
not narrow package checks. Run a separate verification for each visual target, or use behavior
suites that own each service's URL and lifecycle. Route probes and screenshots are public-page
smoke checks; authenticated behavior belongs in the configured test runner.

## Ownership and baselines

Ownership comes from `.github/CODEOWNERS`, `CODEOWNERS`, then `docs/CODEOWNERS`, using the first
existing file. Patterns are case sensitive; the last matching line wins, including empty owners.
`*`, `**`, `?`, anchored paths and directory patterns are supported. Unsupported negation,
character ranges and escaped patterns are reported. Account existence/permissions are not checked.
These are checkout hints; GitHub's actual review requests use the PR base branch's CODEOWNERS.

```sh
project-aware-qa scan . --save-baseline
cp .qa/baseline.json qa-baseline.json
```

Review and commit `qa-baseline.json`; add `"baseline": "qa-baseline.json"` to configuration,
then scan again. Do not update the baseline automatically on every pull request. Comparisons
list new, resolved, worsened, improved and unchanged surfaces. Worsening means an increased
risk score or a new gap. IDs follow scanner identity, so route/entity renames may appear as
resolved/new. Baselines require the same tool version to avoid treating changed heuristics as
application regressions. `policy.failOnNewHighRisk: true` requires a baseline and fails on
new/worsened high-risk surfaces that have not been explicitly accepted.

An exact gap can be accepted temporarily:

```json
{
  "surfaceId": "COPY_EXACT_ID_FROM_REGISTRY",
  "gap": "COPY_EXACT_GAP_FROM_REGISTRY",
  "owner": "@company/team",
  "reason": "QA-123: permission-denial coverage scheduled",
  "expires": "2026-12-01"
}
```

Place entries in `suppressions`. Expiry is inclusive through that UTC day. Active entries
stay visible with their reason. Expired or unmatched entries are inconclusive and never apply;
an expired acceptance also invalidates an earlier verification summary. Suppressions never
change risk scores, delete findings or pardon failed commands. A high-risk surface is accepted
by baseline policy only when every current gap has an active exact suppression.

## Authenticated behavior and Playwright

Each `behaviorChecks` entry has an `id`, a command argument array and explicit `surfaceIds`.
Commands execute without an extra shell. Use a repository script to configure authentication,
data setup, assertions and teardown. Test commands may mutate test data, so they run only with
`--tests`. The suite is selected when its declared surfaces intersect change/scope selection.
Unknown IDs fail before any checks run. A requirement such as `behavior-admin` fails if the
suite is skipped, absent, inconclusive or failed; requirements never enable execution themselves.

`requiredEnv` contains names, never values. Missing values make a suite inconclusive. Values
are inherited by the test runner and exact matches are redacted from its saved stdout/stderr.
Use your existing secret store/CI environment. Keep Playwright storage state ignored and out
of configured attachments. Encoded secrets and application data inside compressed traces
cannot be reliably sanitized by this tool; treat trace sharing as a separate reviewed action.

For Playwright, configure its JSON reporter to write a stable path relative to the repo root:

```ts
reporter: [['list'], ['json', { outputFile: '../../.qa/admin-results.json' }]],
use: { storageState: process.env.QA_STORAGE_STATE, trace: 'retain-on-failure' },
```

Set `playwrightReport: ".qa/admin-results.json"` on the behavior entry. This fresh report is
archived automatically. Unexpected tests/global errors fail the check; zero expected tests,
flaky or skipped tests make an otherwise successful command inconclusive. A passing command
without a report is only evidence that the declared suite exited successfully. Neither mode
claims that every possible behavior of a mapped surface has been tested.

`artifacts` lists exact repo-relative outputs to attach, such as a known trace ZIP path.
They must be created or changed during that command, stay inside the repo, and be at most
64 MiB each. Missing or stale required artifacts make a successful suite inconclusive.
For failure-only traces, attach them only in suites that promise those files, or leave the
list empty. Trace paths are not globbed. Archived copies are bound to the run by SHA-256;
changes to them invalidate the verification summary. No trace is executed or uploaded.

## CI policy and artifacts

`policy.requiredChecks` and CLI `--require` combine. CLI defaults cannot weaken repository
requirements. `failOnIncomplete` rejects every skipped/inconclusive check, including optional
install/screenshot steps; use specific required IDs when that is too strict. Missing required
checks fail even for a diff with no selected services, so decide explicitly whether your CI
should skip a no-op verification job.

The workflow example uses `pull_request` with read-only permissions and no secret injection.
Do not use privileged `pull_request_target` to execute untrusted branch commands. Add auth
only to a trusted test environment. The example uploads summary exports, not raw logs,
attachments or storage state. Keep `.qa/` ignored. JUnit/SARIF contain QA diagnostics;
source locations exist only when a check has an explicit surface mapping.

References: [GitHub CODEOWNERS](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners),
[Playwright authentication](https://playwright.dev/docs/auth),
[Playwright reporters](https://playwright.dev/docs/test-reporters#json-reporter),
[GitHub SARIF support](https://docs.github.com/en/code-security/reference/code-scanning/sarif-files/sarif-support).
