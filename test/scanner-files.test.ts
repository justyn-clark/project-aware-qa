import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { walkRepo } from "../src/scanner/files.js";

function fixture(t: TestContext): string {
	const root = mkdtempSync(join(tmpdir(), "qa-walker-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

test("walker excludes external file and directory symlinks with incomplete diagnostics", (t) => {
	const root = fixture(t);
	const outside = fixture(t);
	writeFileSync(join(root, "local.ts"), "export const local = true;");
	writeFileSync(join(outside, "external.ts"), "export const external = true;");
	symlinkSync(join(outside, "external.ts"), join(root, "external.ts"));
	symlinkSync(outside, join(root, "external-directory"));
	const repo = walkRepo(root);
	assert.deepEqual(
		repo.files.map((f) => f.path),
		["local.ts"],
	);
	assert.equal(repo.truncated, true);
	assert.equal(repo.issues?.length, 2);
	assert.ok(repo.issues?.every((issue) => issue.includes("symlink leaves the project root")));
});

test("walker detects directory symlink cycles before they duplicate discovery", (t) => {
	const root = fixture(t);
	writeFileSync(join(root, "local.ts"), "export const local = true;");
	mkdirSync(join(root, "nested"));
	symlinkSync(root, join(root, "nested", "cycle"));
	const repo = walkRepo(root);
	assert.deepEqual(
		repo.files.map((f) => f.path),
		["local.ts"],
	);
	assert.equal(repo.truncated, true);
	assert.deepEqual(repo.issues, ["Directory symlink cycle skipped: nested/cycle"]);
});

test("walker preserves ordinary internal aliases without claiming a cycle", (t) => {
	const root = fixture(t);
	mkdirSync(join(root, "source"));
	writeFileSync(join(root, "source", "users.ts"), "export const users = [];");
	symlinkSync(join(root, "source"), join(root, "alias"));
	const repo = walkRepo(root);
	assert.deepEqual(
		repo.files.map((f) => f.path),
		["alias/users.ts", "source/users.ts"],
	);
	assert.equal(repo.truncated, false);
	assert.equal(repo.issues, undefined);
});

test("broken symlinks and inaccessible directories make discovery incomplete", (t) => {
	const root = fixture(t);
	symlinkSync(join(root, "absent.ts"), join(root, "broken.ts"));
	const hidden = join(root, "unreadable");
	mkdirSync(hidden);
	writeFileSync(join(hidden, "data.ts"), "export const data = true;");
	chmodSync(hidden, 0);
	try {
		const repo = walkRepo(root);
		assert.equal(repo.truncated, true);
		assert.ok(repo.issues?.includes("Cannot inspect input symlink: broken.ts"));
		// Root may read chmod(000) directories on elevated CI runners.
		if (process.getuid?.() !== 0) {
			assert.ok(repo.issues?.includes("Cannot read input directory: unreadable"));
			assert.equal(repo.files.length, 0);
		}
	} finally {
		chmodSync(hidden, 0o700);
	}
});

test("missing roots and discovery caps carry explicit diagnostics", (t) => {
	const root = fixture(t);
	const missing = walkRepo(join(root, "absent"));
	assert.equal(missing.truncated, true);
	assert.deepEqual(missing.issues, ["Cannot resolve scan root"]);
	writeFileSync(join(root, "first.ts"), "export const first = true;");
	writeFileSync(join(root, "second.ts"), "export const second = true;");
	const capped = walkRepo(root, { maxFiles: 1 });
	assert.equal(capped.files.length, 1);
	assert.equal(capped.truncated, true);
	assert.match(capped.issues?.[0] ?? "", /Discovery reached 1 files/);
});
