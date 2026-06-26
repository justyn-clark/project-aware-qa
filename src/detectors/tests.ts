/**
 * Existing-test detection.
 *
 * We classify test files and infer their subjects (from filename and imports) so the
 * planner can mark inferred tests as already "present" and the report can quantify the
 * test-gap. We intentionally do not run anything here — that is the verifier's job.
 */
import type { RepoFiles } from "../scanner/files.js";
import { readFileCached } from "../scanner/files.js";
import { words } from "./entities.js";
import type { TestInfo } from "./types.js";

const TEST_FILE_RE = /\.(test|spec)\.(t|j)sx?$/;
const E2E_HINT_RE = /(^|\/)(e2e|tests?\/e2e|playwright)(\/|$)/;

function inferRunner(file: string, content: string): TestInfo["runner"] {
	if (/@playwright\/test/.test(content) || /\bplaywright\b/.test(file)) return "playwright";
	if (/from\s+["']vitest["']|import\s+.*vitest/.test(content)) return "vitest";
	if (/@jest\/globals|ts-jest|jest\./.test(content)) return "jest";
	return "unknown";
}

function inferKind(file: string, runner: TestInfo["runner"]): TestInfo["kind"] {
	if (runner === "playwright" || E2E_HINT_RE.test(file)) return "e2e";
	if (file.endsWith(".spec.ts")) return "spec";
	if (/\.(test|spec)\.(t|j)sx$/.test(file)) return "component";
	return "unit";
}

function inferTargets(file: string, content: string): string[] {
	const targets = new Set<string>();
	// Subject from the test filename ("album.controller.spec.ts" → "album controller").
	const base = file.split("/").pop() ?? file;
	for (const w of words(base)) targets.add(w);
	// Subjects from relative imports of the unit under test.
	const importRe = /import\s+[^;]*?from\s+["'](\.[^"']+)["']/g;
	let m = importRe.exec(content);
	for (; m !== null; m = importRe.exec(content)) {
		const spec = m[1] as string;
		const name = spec.split("/").pop() ?? spec;
		for (const w of words(name)) targets.add(w);
	}
	return [...targets];
}

export function detectTests(repo: RepoFiles): TestInfo[] {
	const tests: TestInfo[] = [];
	for (const f of repo.files) {
		const isTest =
			TEST_FILE_RE.test(f.path) || (E2E_HINT_RE.test(f.path) && /\.(t|j)sx?$/.test(f.path));
		if (!isTest) continue;
		const content = readFileCached(f.abs) ?? "";
		// e2e dirs may contain helpers; require an assertion/test construct.
		if (!TEST_FILE_RE.test(f.path) && !/\b(test|it|describe|expect)\s*\(/.test(content)) continue;
		const runner = inferRunner(f.path, content);
		tests.push({
			file: f.path,
			kind: inferKind(f.path, runner),
			runner,
			targets: inferTargets(f.path, content),
		});
	}
	return tests.sort((a, b) => a.file.localeCompare(b.file));
}
