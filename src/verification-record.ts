import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	fstatSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	statSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { qaPath } from "./io.js";
import { fingerprintProject, registryFingerprint, sameFingerprint } from "./provenance.js";
import type { ProjectFingerprint, SurfaceRegistry } from "./types.js";
import type { VerifyResult } from "./verify/index.js";

export interface VerificationRecord {
	version: 1;
	runId: string;
	tool: { name: string; version: string };
	scope: string | null;
	registryHash: string;
	sourceBefore: ProjectFingerprint;
	sourceAfter: ProjectFingerprint;
	result: VerifyResult;
	evidence?: EvidenceManifest;
}

export interface EvidenceManifest {
	files: Array<{ path: string; sha256: string; bytes: number }>;
	issues: string[];
}

function inside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Capture the exact logs/probes/screenshots referenced by a run, without exposing contents. */
export function captureEvidenceManifest(root: string, result: VerifyResult): EvidenceManifest {
	const files: EvidenceManifest["files"] = [];
	const issues: string[] = [];
	const refs = new Set<string>();
	for (const check of result.checks) {
		for (const attachment of check.attachments ?? []) refs.add(attachment);
		if (check.evidencePath) refs.add(check.evidencePath);
		else if (check.command && (check.status === "passed" || check.status === "failed")) {
			issues.push(`Command evidence is not recorded for ${check.id}.`);
		}
	}
	for (const screenshot of result.screenshots ?? []) {
		if (screenshot.file) refs.add(screenshot.file);
		else if (screenshot.ok) issues.push("A successful screenshot has no recorded file.");
	}
	const qaRoot = resolve(root, ".qa");
	const seen = new Set<string>();
	for (const ref of refs) {
		const path = isAbsolute(ref) ? resolve(ref) : resolve(qaRoot, ref);
		const rel = relative(qaRoot, path).split(sep).join("/");
		let descriptor: number | undefined;
		try {
			const actualQa = realpathSync(qaRoot);
			if (
				!inside(qaRoot, path) ||
				!inside(realpathSync(root), actualQa) ||
				!inside(actualQa, realpathSync(path))
			) {
				issues.push(`Evidence path leaves the QA artifact directory: ${ref}`);
				continue;
			}
			if (seen.has(rel)) continue;
			seen.add(rel);
			const stat = statSync(path);
			if (!stat.isFile() || stat.size > 256 * 1024 * 1024) {
				issues.push(`Evidence is not a readable bounded file: ${rel}`);
				continue;
			}
			const hash = createHash("sha256");
			const buffer = Buffer.allocUnsafe(64 * 1024);
			descriptor = openSync(path, "r");
			let remaining = stat.size;
			while (remaining > 0) {
				const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, remaining), null);
				if (!count) break;
				hash.update(buffer.subarray(0, count));
				remaining -= count;
			}
			const after = fstatSync(descriptor);
			if (
				remaining ||
				after.size !== stat.size ||
				after.mtimeMs !== stat.mtimeMs ||
				after.ino !== stat.ino
			) {
				issues.push(`Evidence changed while reading: ${rel}`);
				continue;
			}
			files.push({ path: rel, sha256: hash.digest("hex"), bytes: stat.size });
		} catch {
			issues.push(`Evidence is missing or unreadable: ${rel}`);
		} finally {
			if (descriptor !== undefined) closeSync(descriptor);
		}
	}
	files.sort((a, b) => a.path.localeCompare(b.path));
	return { files, issues };
}

export interface VerificationSummary {
	state: "current" | "stale" | "unverified";
	passed: number;
	failed: number;
	skipped: number;
	inconclusive: number;
	runId?: string;
	generatedAt?: string;
	scope?: string | null;
	reason?: string;
}

/** Old Markdown counts are never promoted into evidence for the current snapshot. */
export function readVerificationSummary(
	root: string,
	registry: SurfaceRegistry,
	now = new Date(),
): VerificationSummary | undefined {
	const file = qaPath(root, "verification.json");
	const unknown = (state: "stale" | "unverified", reason: string): VerificationSummary => ({
		state,
		passed: 0,
		failed: 0,
		skipped: 0,
		inconclusive: 0,
		reason,
	});
	if (!existsSync(file)) {
		return existsSync(qaPath(root, "verification-report.md"))
			? unknown(
					"unverified",
					"Legacy verification has no source fingerprint. Run /qa-verify again.",
				)
			: undefined;
	}
	try {
		const record = JSON.parse(readFileSync(file, "utf8")) as VerificationRecord;
		const preflightError = (record as VerificationRecord & { preflightError?: string })
			.preflightError;
		if (preflightError) return unknown("unverified", preflightError);
		if (
			record.version !== 1 ||
			!record.sourceBefore ||
			!record.sourceAfter ||
			!Array.isArray(record.result?.checks) ||
			record.result.checks.some(
				(c) => !["passed", "failed", "skipped", "inconclusive"].includes(c.status),
			)
		) {
			return unknown("unverified", "Verification metadata is invalid. Run /qa-verify again.");
		}
		const current = fingerprintProject(root);
		if (
			record.result.team?.suppressions.some(
				(entry) => entry.status === "active" && entry.expires < now.toISOString().slice(0, 10),
			)
		)
			return unknown("stale", "A suppression expired since verification. Run verification again.");
		if (!current.complete) {
			return unknown(
				"unverified",
				`Cannot fingerprint current source: ${current.issues?.[0] ?? "incomplete snapshot"} Scan and verify again.`,
			);
		}
		if (
			record.registryHash !== registryFingerprint(registry) ||
			!sameFingerprint(record.sourceBefore, record.sourceAfter) ||
			!sameFingerprint(record.sourceAfter, current)
		) {
			return unknown(
				"stale",
				"Source or registry changed since verification. Scan and verify again.",
			);
		}
		if (
			!record.evidence ||
			!Array.isArray(record.evidence.files) ||
			!Array.isArray(record.evidence.issues)
		) {
			return unknown("unverified", "Verification has no evidence manifest. Run /qa-verify again.");
		}
		const evidence = captureEvidenceManifest(root, record.result);
		if (record.evidence.issues.length || evidence.issues.length) {
			return unknown(
				"unverified",
				`${evidence.issues[0] ?? record.evidence.issues[0]} Run /qa-verify again.`,
			);
		}
		if (JSON.stringify(record.evidence.files) !== JSON.stringify(evidence.files)) {
			return unknown("stale", "Evidence files changed since verification. Run /qa-verify again.");
		}
		const count = (status: string) =>
			record.result.checks.filter((c) => c.status === status).length;
		return {
			state: "current",
			passed: count("passed"),
			failed: count("failed"),
			skipped: count("skipped"),
			inconclusive: count("inconclusive"),
			runId: record.runId,
			generatedAt: record.result.generatedAt,
			scope: record.scope,
		};
	} catch {
		return unknown("unverified", "Cannot read verification metadata. Run /qa-verify again.");
	}
}
