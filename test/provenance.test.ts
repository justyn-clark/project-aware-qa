import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runReport, runScan, runVerify } from "../src/core.js";
import { fingerprintProject, validateProjectRoot } from "../src/provenance.js";
import {
	captureEvidenceManifest,
	readVerificationSummary,
	type VerificationRecord,
} from "../src/verification-record.js";
import { TOOL } from "../src/version.js";

function fixture(t: { after: (fn: () => void) => void }): string {
	const root = mkdtempSync(join(tmpdir(), "qa-provenance-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({ scripts: { lint: "node check.cjs" } }),
	);
	writeFileSync(join(root, "check.cjs"), "console.log('checked current source');");
	mkdirSync(join(root, "node_modules"));
	return root;
}

test("fingerprint detects same-size source edits but ignores QA artifacts", (t) => {
	const root = fixture(t);
	const before = fingerprintProject(root);
	writeFileSync(join(root, "check.cjs"), "console.log('changed current source');");
	assert.notEqual(fingerprintProject(root).inputHash, before.inputHash);
	const edited = fingerprintProject(root);
	mkdirSync(join(root, ".qa"));
	writeFileSync(join(root, ".qa", "result.ts"), "generated output");
	assert.deepEqual(fingerprintProject(root), edited);
});

test("verify refuses stale source before executing repository commands", async (t) => {
	const root = fixture(t);
	assert.equal(runScan(root).ok, true);
	writeFileSync(join(root, "check.cjs"), "throw new Error('must not execute stale checks');");
	const result = await runVerify({ root });
	assert.equal(result.ok, false);
	assert.equal(result.outcome, "incomplete");
	assert.match(result.summary, /stale/);
	assert.equal(existsSync(join(root, ".qa", "verification.json")), false);
});

test("verification records keep unique evidence and preserve every status", async (t) => {
	const root = fixture(t);
	const scan = runScan(root);
	assert.equal(scan.ok, true);
	assert.equal(scan.scan?.registry.tool.version, TOOL.version);
	const first = await runVerify({ root });
	assert.equal(first.ok, true, first.error);
	const recordPath = join(root, ".qa", "verification.json");
	const record = JSON.parse(readFileSync(recordPath, "utf8")) as VerificationRecord;
	const lint = record.result.checks.find((c) => c.command?.includes("lint"));
	assert.equal(lint?.status, "passed");
	assert.ok(lint?.evidencePath?.startsWith(`runs/${record.runId}/findings/`));
	const oldLog = join(root, ".qa", lint?.evidencePath ?? "missing");
	const evidence = readFileSync(oldLog, "utf8");
	assert.match(evidence, /checked current source/);
	assert.equal((await runVerify({ root })).ok, true);
	const rerun = JSON.parse(readFileSync(recordPath, "utf8")) as VerificationRecord;
	assert.notEqual(rerun.runId, record.runId);
	assert.equal(readFileSync(oldLog, "utf8"), evidence);
	assert.ok(existsSync(join(root, ".qa", "runs", record.runId, "verification.json")));
	// Reproduce the previous aggregate-report bug with an explicitly inconclusive check.
	rerun.result.checks.push({ id: "spa", title: "SPA route", status: "inconclusive" });
	writeFileSync(recordPath, JSON.stringify(rerun));
	assert.equal(runReport(root).ok, true);
	assert.match(readFileSync(join(root, ".qa", "qa-report.md"), "utf8"), /1 inconclusive/);
});

test("a new scan cannot inherit verification counts from an old registry", async (t) => {
	const root = fixture(t);
	runScan(root, { generatedAt: "2026-10-01T00:00:00Z" });
	assert.equal((await runVerify({ root })).ok, true);
	runScan(root, { generatedAt: "2026-10-13T00:00:00Z" });
	runReport(root);
	const report = readFileSync(join(root, ".qa", "qa-report.md"), "utf8");
	assert.match(report, /Verification: \*\*stale\*\*/);
	assert.doesNotMatch(report, /Verification: \*\*\d+ passed/);
});

test("legacy Markdown counts remain unverified rather than becoming current evidence", (t) => {
	const root = fixture(t);
	runScan(root);
	writeFileSync(join(root, ".qa", "verification-report.md"), "**3 passed · 0 failed · 2 skipped**");
	runReport(root);
	const report = readFileSync(join(root, ".qa", "qa-report.md"), "utf8");
	assert.match(report, /Verification: \*\*unverified\*\*/);
	assert.doesNotMatch(report, /3 passed/);
});

test("non-Git fingerprints include locks, config, fixture data, scripts, and assets", (t) => {
	const root = fixture(t);
	const inputs = [
		"package-lock.json",
		"pnpm-lock.yaml",
		"config.json",
		"fixture.csv",
		"check.sh",
		"styles.css",
		"image.png",
	];
	for (const name of inputs) writeFileSync(join(root, name), "before");
	for (const name of inputs) {
		const before = fingerprintProject(root);
		writeFileSync(join(root, name), "after!");
		const after = fingerprintProject(root);
		assert.equal(after.complete, true, after.issues?.join("; "));
		assert.notEqual(after.inputHash, before.inputHash, `${name} must affect source provenance`);
	}
	const beforeGenerated = fingerprintProject(root);
	for (const directory of ["node_modules", ".qa", "dist"]) {
		mkdirSync(join(root, directory), { recursive: true });
		writeFileSync(join(root, directory, "generated.js"), "changed generated output");
	}
	assert.deepEqual(fingerprintProject(root), beforeGenerated);
});

test("Git fingerprints include tracked and untracked inputs within the selected target only", (t) => {
	const root = fixture(t);
	execFileSync("git", ["init", "-q"], { cwd: root });
	const target = join(root, "apps", "web");
	mkdirSync(target, { recursive: true });
	writeFileSync(join(root, ".gitignore"), "ignored.txt\nnode_modules/\n.qa/\n");
	writeFileSync(join(target, "tracked.json"), "first");
	execFileSync("git", ["add", "apps/web/tracked.json", ".gitignore"], { cwd: root });
	const before = fingerprintProject(target);
	writeFileSync(join(root, "sibling.ts"), "outside selected target");
	writeFileSync(join(target, "ignored.txt"), "ignored");
	mkdirSync(join(target, "node_modules"));
	writeFileSync(join(target, "node_modules", "cached.js"), "ignored");
	assert.deepEqual(fingerprintProject(target), before);
	writeFileSync(join(target, "fixture.json"), "untracked data");
	const untracked = fingerprintProject(target);
	assert.notEqual(untracked.inputHash, before.inputHash);
	writeFileSync(join(target, "tracked.json"), "other");
	assert.notEqual(fingerprintProject(target).inputHash, untracked.inputHash);
	rmSync(join(target, "tracked.json"));
	assert.equal(
		fingerprintProject(target).complete,
		true,
		"tracked working-tree deletions are valid snapshot states",
	);
});

test("missing roots and unreadable inputs cannot claim a complete snapshot", (t) => {
	const root = fixture(t);
	const absent = join(root, "absent");
	assert.match(validateProjectRoot(absent) ?? "", /does not exist or cannot be read/);
	assert.equal(fingerprintProject(absent).complete, false);
	assert.match(fingerprintProject(absent).issues?.[0] ?? "", /does not exist/);
	assert.match(validateProjectRoot(join(root, "package.json")) ?? "", /not a directory/);
	const privateFile = join(root, "unreadable.json");
	writeFileSync(privateFile, "opaque test input");
	chmodSync(privateFile, 0);
	try {
		const inaccessible = fingerprintProject(root);
		assert.equal(inaccessible.complete, false);
		assert.match(inaccessible.issues?.join(" ") ?? "", /Cannot read input: unreadable.json/);
	} finally {
		chmodSync(privateFile, 0o600);
	}
});

test("external source symlinks are not read and leave the snapshot incomplete", (t) => {
	const root = fixture(t);
	const outside = mkdtempSync(join(tmpdir(), "qa-provenance-outside-"));
	t.after(() => rmSync(outside, { recursive: true, force: true }));
	const external = join(outside, "external.json");
	writeFileSync(external, "first private external input");
	symlinkSync(external, join(root, "linked.json"));
	const before = fingerprintProject(root);
	assert.equal(before.complete, false);
	assert.match(before.issues?.join(" ") ?? "", /symlink leaves the project root/);
	writeFileSync(external, "different private external input");
	assert.equal(
		fingerprintProject(root).inputHash,
		before.inputHash,
		"external content is never read",
	);
});

test("changing a lockfile makes previously current verification stale", async (t) => {
	const root = fixture(t);
	writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":3}');
	const scan = runScan(root);
	assert.ok(scan.scan);
	assert.equal((await runVerify({ root })).ok, true);
	assert.equal(readVerificationSummary(root, scan.scan.registry)?.state, "current");
	writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":2}');
	const summary = readVerificationSummary(root, scan.scan.registry);
	assert.equal(summary?.state, "stale");
	assert.equal(summary?.passed, 0);
});

test("missing or overwritten command evidence cannot retain current passed counts", async (t) => {
	const root = fixture(t);
	const scan = runScan(root);
	assert.ok(scan.scan);
	assert.equal((await runVerify({ root })).ok, true);
	const record = JSON.parse(
		readFileSync(join(root, ".qa", "verification.json"), "utf8"),
	) as VerificationRecord;
	assert.ok(record.evidence?.files.length);
	const file = join(root, ".qa", record.evidence.files[0]?.path ?? "missing");
	const original = readFileSync(file);
	assert.equal(readVerificationSummary(root, scan.scan.registry)?.state, "current");
	writeFileSync(file, Buffer.alloc(original.length, 120));
	const overwritten = readVerificationSummary(root, scan.scan.registry);
	assert.equal(overwritten?.state, "stale");
	assert.equal(overwritten?.passed, 0);
	writeFileSync(file, original);
	assert.equal(readVerificationSummary(root, scan.scan.registry)?.state, "current");
	rmSync(file);
	const missing = readVerificationSummary(root, scan.scan.registry);
	assert.equal(missing?.state, "unverified");
	assert.equal(missing?.passed, 0);
	assert.match(missing?.reason ?? "", /Evidence is missing or unreadable/);
});

test("evidence manifest covers probe records and screenshot bytes and rejects escaped paths", async (t) => {
	const root = fixture(t);
	runScan(root);
	const verified = await runVerify({ root });
	assert.ok(verified.verify);
	const probe = join(root, ".qa", "findings", "probe.json");
	const screenshot = join(root, ".qa", "screenshots", "route.png");
	writeFileSync(probe, "[]");
	writeFileSync(screenshot, Buffer.from([1, 2, 3]));
	verified.verify.checks.push({
		id: "probe",
		title: "probe",
		status: "passed",
		evidencePath: "findings/probe.json",
	});
	verified.verify.screenshots.push({ route: "/", viewport: "desktop", ok: true, file: screenshot });
	const evidence = captureEvidenceManifest(root, verified.verify);
	assert.deepEqual(evidence.issues, []);
	assert.ok(evidence.files.some((file) => file.path === "findings/probe.json"));
	const image = evidence.files.find((file) => file.path === "screenshots/route.png");
	assert.ok(image);
	writeFileSync(screenshot, Buffer.from([3, 2, 1]));
	assert.notEqual(
		captureEvidenceManifest(root, verified.verify).files.find((file) => file.path === image.path)
			?.sha256,
		image.sha256,
	);
	verified.verify.checks.push({
		id: "escape",
		title: "escape",
		status: "passed",
		evidencePath: "../package.json",
	});
	assert.match(
		captureEvidenceManifest(root, verified.verify).issues.join(" "),
		/leaves the QA artifact directory/,
	);
});

test("Git-ignored detector inputs are included so edited controllers cannot reuse verification", async (t) => {
	const root = fixture(t);
	execFileSync("git", ["init", "-q"], { cwd: root });
	writeFileSync(join(root, ".gitignore"), "local/\nnode_modules/\n.qa/\n");
	mkdirSync(join(root, "local"));
	const controller = join(root, "local", "users.controller.ts");
	writeFileSync(
		controller,
		"@Controller('users') export class UsersController { @Get() list() {} }",
	);
	const scan = runScan(root);
	assert.equal(scan.ok, true);
	assert.ok(
		scan.scan?.registry.surfaces.some((surface) => surface.backendEndpoint?.includes("users")),
	);
	assert.equal((await runVerify({ root })).ok, true);
	writeFileSync(
		controller,
		"@Controller('admins') export class UsersController { @Get() list() {} }",
	);
	const after = await runVerify({ root });
	assert.equal(after.ok, false);
	assert.match(after.summary, /stale/);
});

test("Git-tracked generated inputs affect provenance while operational artifacts stay excluded", (t) => {
	const root = fixture(t);
	execFileSync("git", ["init", "-q"], { cwd: root });
	mkdirSync(join(root, "dist"));
	writeFileSync(join(root, "dist", "contract.json"), "before");
	execFileSync("git", ["add", "dist/contract.json"], { cwd: root });
	const before = fingerprintProject(root);
	writeFileSync(join(root, "dist", "contract.json"), "after!");
	assert.notEqual(fingerprintProject(root).inputHash, before.inputHash);
	const current = fingerprintProject(root);
	mkdirSync(join(root, ".qa"));
	writeFileSync(join(root, ".qa", "output.json"), "generated");
	writeFileSync(join(root, "node_modules", "dependency.json"), "generated");
	assert.deepEqual(fingerprintProject(root), current);
});

test("a repository check removing an earlier command log makes verification incomplete", async (t) => {
	const root = fixture(t);
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({
			scripts: { typecheck: "node check.cjs", lint: "node remove-evidence.cjs" },
		}),
	);
	writeFileSync(
		join(root, "remove-evidence.cjs"),
		`
const { readdirSync, rmSync } = require("node:fs");
const { join } = require("node:path");
for (const run of readdirSync(".qa/runs")) {
  rmSync(join(".qa", "runs", run, "findings", "typecheck-node-root.log"), { force: true });
}
console.log("Removed the earlier typecheck log in this isolated fixture.");
`,
	);
	const scan = runScan(root);
	assert.ok(scan.scan);
	assert.equal(scan.ok, true);
	const verified = await runVerify({ root });
	assert.equal(verified.ok, true, "successful commands retain advisory exit behavior");
	assert.equal(verified.outcome, "incomplete");
	assert.equal(
		verified.verify?.checks.find((check) => check.id === "typecheck-node-root")?.status,
		"passed",
	);
	const integrity = verified.verify?.checks.find((check) => check.id === "evidence-integrity");
	assert.equal(integrity?.status, "inconclusive");
	assert.match(
		integrity?.reason ?? "",
		/Evidence is missing or unreadable:.*typecheck-node-root.log/,
	);
	assert.match(verified.summary, /1 inconclusive/);
	const record = JSON.parse(
		readFileSync(join(root, ".qa", "verification.json"), "utf8"),
	) as VerificationRecord;
	assert.ok(record.evidence?.issues.some((issue) => issue.includes("typecheck-node-root.log")));
	const summary = readVerificationSummary(root, scan.scan.registry);
	assert.equal(summary?.state, "unverified");
	assert.equal(summary?.passed, 0);
	assert.equal(runReport(root).ok, true);
	const report = readFileSync(join(root, ".qa", "qa-report.md"), "utf8");
	assert.match(report, /Verification: \*\*unverified\*\*/);
	assert.doesNotMatch(report, /Verification: \*\*\d+ passed/);
});
