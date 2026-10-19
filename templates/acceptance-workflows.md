# Acceptance criteria, targets and agent interfaces

This workflow connects explicit requirements to observed behavior. It runs without
Docker or an LLM. It complements scan/verify and the isolated agent-evaluation runner.

```sh
project-aware-qa acceptance . --plan .qa-acceptance.json --json
project-aware-qa acceptance . --plan deployed.json --allow-network --json
```

Copy acceptance.example.json and adapt the target, ticket and checks. JSON stdout
contains the result and report paths; live progress goes to stderr. Pi exposes
/qa-acceptance with the same options. /qa-status shows the current or last acceptance
or agent-evaluation run, and /qa-cancel aborts the active run in that project.
These Pi commands run in the background so cancellation remains accessible. Only
one acceptance/evaluation run per project can be active in an extension instance.
CLI SIGINT/SIGTERM also cancels. Cancellation preserves partial reports. Status is
session-local, not a cross-process job service, and does not manage scan/verify.

## Requirements and reports

Every criterion has a unique ID, expected behavior, and a source:

- request: an explicit statement supplied in the plan;
- ticket or specification: a repository-relative path and verbatim source quote;
- inferred: an expectation supplied by inference, always labeled inferred.

Source files are hashed, quotes must be found verbatim, and source/plan changes during
execution invalidate the result. The tool verifies the quote's presence, not the
semantic correctness of a human's interpretation or the authorship of an inline request.
Ticket IDs alone are not resolved from remote services; provide an exported/local
file. It never treats a tool response or scanner inference as user intent.

Each check references one criterion. Criteria with no checks, missing source quotes,
unsupported capabilities, or incomplete observations remain unverified. Inferred
criteria cannot establish overall acceptance. Every check assigned to a criterion
must pass for that criterion to pass. A failed criterion makes the run fail; gaps
make it incomplete. Neither outcome exits successfully.

Reports under .qa/acceptance/<run-id> include JSON, Markdown, a report checksum and
phase events. They present expected behavior, source quote, observation, status and
inspectable evidence. Network/DOM evidence has bounded excerpts plus full captured
content hashes; excerpts are not full captures. Checksums detect accidental edits,
not forgery. Keep these private artifacts out of version control. External source
quotes and captured text remain verbatim except configured credential redaction;
project-owned labels and documentation are ASCII.

## Explicit targets

Targets are {kind, value, buildId?}, where kind is file, directory or url.
Local paths are relative to the selected root and do not require Git. File/directory
identity is a content manifest and hash; it is checked again after execution.
The capture excludes .git, .qa, node_modules, vendor, .env* and common private-key
files. Excluded paths are listed and cannot be checked as captured evidence. This
is a bounded exclusion list, not a general secret scanner. Symlinks and special
files fail closed. Limits: 4 MiB per file, 32 MiB total and 10000 entries.

URL checks require --allow-network. Their receipts record the requested URL,
response status, body hash and available ETag/X-Build-Id headers. A declared buildId
is an operator label, not attested deployment identity. URL observations prove only
what was observed at that time; they do not establish an entire deployment's state.
HTTP redirects and cross-origin check paths are rejected. Private/local URLs are
allowed when explicitly selected. Browser navigation may load subresources; use
trusted test deployments and non-production accounts for any tool calls.

For bearer authentication, --auth-env NAME reads that host environment variable;
its value is redacted from persisted reports. This applies to HTTP/MCP requests,
not browser authentication. No credentials are copied into browser profiles.
Never embed secrets in URLs, plans or tool arguments. No network occurs without
--allow-network; file checks never execute application code.

## Checks

File: kind=file, contains, and path for directory targets. It checks bytes as UTF-8
text; matching content proves that assertion only, not interactive application behavior.

HTTP: kind=http with optional same-origin path and at least one of status or contains.
Requests use GET. Each response is capped at 1 MiB, with up to 4096 characters retained
as an excerpt. A whole-plan timeout (default 30 seconds, maximum 5 minutes) bounds work.

MCP: kind=mcp, tool, optional path and expected schema. Discovery requires the named
tool, a description and an object input schema. Invocations additionally supply input
and require --allow-tool-calls, including calls advertised as read-only. The client
supports MCP 2025-11-25 initialization and bounded JSON Streamable HTTP responses;
other negotiated revisions, SSE responses, stdio, OAuth and server-initiated requests
are unsupported and remain unverified. Sessions are deleted on a best-effort bounded
basis. Tool listing follows at most 10 pages and 1000 tools.

For a positive invocation, provide observePath (an independent same-origin HTTP GET)
and observeContains, or readOnly=true to compare before/after observations. Negative
cases use expectError=true and schema-invalid input. Pair negative cases with positive
cases to detect tools that simply reject everything. Tool return values alone do not
prove an observable effect. A read-only check establishes only that its selected
observable state stayed unchanged, not absence of every possible side effect.

```json
{
  "id": "set-volume",
  "criterion": "volume",
  "kind": "mcp",
  "tool": "set_volume",
  "input": { "level": 20 },
  "observePath": "/test/player-state",
  "observeContains": "\"volume\":20"
}
```

Input validation supports explicit JSON Schema types, properties, required,
additionalProperties booleans, items and enum; description/title/default/$schema
are annotations. Unsupported validation keywords fail closed for invocations.
Supplying schema requests exact structural equality with the published schema.
There is no claim of full JSON Schema conformance.

Browser: kind=browser, tool, optional schema/input/expectError/readOnly.
Set --browser-module to an already installed Playwright index.mjs. The workflow
never installs a browser or package. A fresh headless browser runs each check and
closes on completion/cancellation. It probes document.modelContext.getTools and
executeTool with object arguments. Unsupported browser API versions are unverified;
there is no silent compatibility guess. For invocations, observePath is a CSS selector
(default body), and observeContains asserts the DOM text afterward. readOnly compares
that text before and after. Browser checks require --allow-network and invocations
require --allow-tool-calls. Missing input means discovery only.

DOM comparisons are immediate after the tool promise settles. For eventual effects,
make the test tool's promise resolve when the effect is visible. Screenshots, full
browser journey scripting and MCP App hosting are outside this first interface-check
adapter; existing CTV collectors remain available for their respective workflows.
The browser integration test uses a real browser with a simulated WebMCP page API;
it validates adapter/DOM behavior, not native WebMCP availability across Chrome versions.

## Resource usage

No acceptance command starts Docker. Browser use is optional and can consume memory;
file/HTTP/MCP checks avoid launching a browser. There is no automatic Docker startup,
image pull, install or background polling service. Agent-evaluation Docker validation
runs separately on an ephemeral CI runner or an explicitly enabled local test.

Agent evaluations now remove completed scratch workspaces and retain changes.json
patches with a 16 MiB total content budget (base64 adds overhead), plus candidate
hashes and execution receipts. Omitted patch content is explicitly marked. Each
Docker stdout/stderr stream is capped at 64 KiB. Cleanup failures halt subsequent
execution and preserve the affected workspace for investigation. Existing historical
runs are untouched. Active Docker bind mounts still need an external disk quota for
untrusted workloads; post-run file limits are not a disk quota.

## Design references

The acceptance-source distinction, behavior-centered presentation and accessible run
status/cancellation were inspired by reviewing
[pi-qa](https://github.com/prjct-app/pi-qa). This implementation uses this project's
existing deterministic evidence and verification conventions.
Protocol references: [MCP 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
and [Chrome WebMCP](https://developer.chrome.com/docs/ai/webmcp/imperative-api).
