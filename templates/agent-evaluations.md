# Agent readiness and evaluations

Use readiness evidence to improve onboarding. Use task evaluations to measure whether
an agent can make verified changes in a particular repository. These are separate
claims: discovering AGENTS.md does not establish that its instructions are useful.

## Commands

```sh
project-aware-qa agent-readiness . --json
project-aware-qa agent-eval . --suite .qa-evals --execute --json
project-aware-qa agent-compare . --before .qa/agent-evals/BEFORE/report.json --after .qa/agent-evals/AFTER/report.json --json
```

Pi exposes /qa-agent-readiness, /qa-agent-eval and /qa-agent-compare with the same
options, using the current project. Evaluation is a separate workflow from verify.
Readiness executes no project commands. Its conventional-path checks cover
instructions, onboarding, architecture, lockfiles, automation, test entrypoints and
evaluation tasks. Missing evidence can mean an unsupported custom layout.
There is no universal numerical readiness score.

## Define a suite

Copy templates/agent-evals to .qa-evals in a small, disposable Git fixture first.
Add a root math.cjs containing `exports.add = (a, b) => a - b;`.
Add `.qa/` to .gitignore. Commit the fixture and suite; evaluations require a clean
Git root, including no untracked files. Do not use the production project for this
example task.

Prepare a local container image containing Node and /opt/fixture-agent.cjs, copied
from the example fixture-agent.cjs. The included Dockerfile accepts a local pinned
Node base image through BASE_IMAGE:

```sh
docker build --pull=false --build-arg BASE_IMAGE=sha256:YOUR_LOCAL_NODE_IMAGE_ID -t qa-eval-fixture templates/agent-evals
docker image inspect qa-eval-fixture --format '{{.Id}}'
```

Record that full image ID in suite.json. The placeholder is deliberately invalid. The harness never builds or
pulls images, installs dependencies, or runs agents without --execute. Image preparation
is a separate operator action. Use preinstalled dependencies and explicit interpreters.
The deterministic example validates harness mechanics; it does not measure an AI model.

Replace the example command with your team's noninteractive agent adapter. Commands
are argument arrays, never shell-expanded. The adapter reads the task from
QA_TASK_FILE (/task.txt), works in /workspace, then exits. Pin agent/model configuration
in the image and suite. Agent id/model are declared identities, not independently
verified provider attestations. Do not place secrets in command arguments or prompts.

The suite has version 1, an immutable image ID/digest, agent identity/command/env,
1-10 trials per task, time budgets, and 1-20 tasks. Each task has a unique ID, prompt,
allowedPaths (exact paths or directory prefixes; no globs), grader command and
reference overlay directory relative to the suite. Unknown fields fail validation.
Reference overlays can add or replace files, but cannot delete files in version 1.

Only grader/ is copied to /grader in grading containers. Reference fixes and suite
configuration remain outside agent and grading containers. Graders must emit exactly
one JSON object to stdout:

```json
{"version":1,"assertions":[{"id":"expected-behavior","passed":true}]}
```

Use stderr for diagnostics. Exit zero for valid assertion results, even when an
assertion fails. Nonzero exit, timeout, missing/empty/malformed output or different
assertion IDs are inconclusive. Before any agent trials, the unchanged source must
fail an assertion and the reference overlay must pass every assertion with identical
IDs. This first version targets repair/implementation tasks; tasks where unchanged
code already passes need a different evaluation protocol and are not supported.

Use trusted held-out behavioral assertions, including regressions, rather than
trusting the agent's self-report or editable repository tests. Candidate code runs
inside grading containers and may be adversarial: the grader must prevent candidate
output from spoofing its result protocol. For high-assurance grading, run candidate
programs as subprocesses and independently validate their outputs. Controls detect
broken/trivial graders, but are not a proof that every grader resists gaming.

## Isolation and budgets

The runner snapshots tracked blobs from the current Git commit, excluding the entire
suite directory. No Git history, untracked or ignored files are copied. Symlinks,
submodules, special files, unsafe paths, files above 8 MiB and trees above 64 MiB or
10000 files are unsupported. Snapshot files have normalized non-executable permissions;
invoke scripts through their interpreter. Keep secrets out of tracked repository files.
No source changes are made in the original checkout.

Each agent trial receives a fresh writable snapshot. After execution, changed file
paths must stay within allowedPaths. A fresh copy of that candidate is graded in a
separate container; grading cannot rewrite the candidate under evaluation. Bounded patches,
configuration, execution logs and reports stay under .qa/agent-evals/<run-id>. Treat this directory
as private source evidence and exclude it from version control.

Containers have a read-only image filesystem, writable /tmp, no added capabilities,
no privilege escalation, one CPU, 512 MiB memory, no additional swap and 128 process slots.
The /tmp filesystem is capped at 64 MiB and container logs at one 1 MiB file. Host credentials
and Docker sockets are never mounted. Network defaults to none. For API-backed
agents, explicitly pass --allow-network and list required host variable names in
agent.env; only agent containers receive them. This enables ordinary container network
access, not a domain allowlist. Graders always have no network or injected credentials.
Use a trusted Docker daemon and images. Containers are an isolation layer, not a VM
security guarantee for hostile images or shared production infrastructure.

Per-agent, per-grader and total wall-time limits are enforced. Cleanup is bounded and
can extend elapsed time beyond the task limit. The runner removes only containers
named for its own execution. CLI cancellation and Pi /qa-cancel invoke cleanup.
Pi /qa-status shows progress and recent activity for background evaluations.
Token and monetary usage are unavailable, not zero. There is no provider-level spend
cap in this version; enforce billing limits through the chosen provider/adapter.
Large generated artifacts and dependency installs can exceed the snapshot limits.
Snapshot size checks happen after execution; bind mounts have no disk quota. Run
untrusted workloads on a dedicated daemon with externally enforced disk limits.

## Reports and comparisons

Primary measure: verified completions / attempted scheduled trials. Failed assertions,
prohibited edits, unsuccessful agent exits and agent timeouts fail a trial.
Infrastructure/grader errors are inconclusive. Inconclusive trials never count as
success, and prevent baseline comparison. Reports contain controls, outcomes, changed
paths, candidate hashes, duration, source commit/hash, image identity and compatibility
hash. Bounded changes.json patches and per-stage execution evidence are retained locally;
completed scratch workspaces are removed. Patch content is limited to 16 MiB across
a run, with omissions labeled. Docker output is capped at 64 KiB per stream.

A report checksum detects accidental report edits; it is not a signature or proof of
an authentic run. Review the saved patches and grader evidence for audit decisions.
Do not compare edited or manually fabricated receipts.

Comparison requires identical task/grader/reference bytes, agent configuration,
image identity, network setting, limits, trial identities and harness version.
Repository source commits may differ. Reports show completion rates, paired gains
and regressions. Results are preliminary descriptive evidence, without statistical
significance or causal claims. Keep hardware, provider model revision, dependency
state and service load controlled externally; these cannot all be verified by the
harness. Run multiple repetitions and representative tasks before team decisions.

Useful task suites cover regression repair, feature implementation, configuration
changes, API compatibility, performance budgets and boundary compliance. Keep tasks
representative of actual work and rotate held-out assertions to reduce overfitting.

## Validation

Unit tests exercise suite validation, snapshots, controls, grading outcomes, boundaries,
cancellation, checksums and comparisons with deterministic executors. Set
QA_AGENT_EVAL_IMAGE to a locally installed immutable Node image ID to opt into the
Docker integration test. No model calls are made by these tests.

See [acceptance workflows](acceptance-workflows.md) for requirement traceability,
explicit targets, behavior reports and optional agent-interface checks without Docker.
