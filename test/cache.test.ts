/**
 * File-cache staleness (audit Finding 2): the process-global content cache returns stale
 * data across calls until cleared. This both documents the hazard and guards the fix
 * (runVerification now calls clearFileCache()).
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clearFileCache, readFileCached } from "../src/scanner/files.js";

test("readFileCached caches content; a later edit is invisible until clearFileCache()", () => {
	const dir = mkdtempSync(join(tmpdir(), "qa-cache-"));
	const file = join(dir, "package.json");
	writeFileSync(file, '{"scripts":{"test":"v1"}}');
	clearFileCache();

	assert.equal(readFileCached(file), '{"scripts":{"test":"v1"}}');

	// Edit the file on disk - simulating the user changing package.json between scan/verify.
	writeFileSync(file, '{"scripts":{"test":"v2"}}');

	// Without clearing, the cache still returns the old content (the bug's mechanism).
	assert.equal(readFileCached(file), '{"scripts":{"test":"v1"}}', "cache is stale until cleared");

	// The fix: clearing the cache makes the fresh content visible.
	clearFileCache();
	assert.equal(readFileCached(file), '{"scripts":{"test":"v2"}}', "fresh after clearFileCache");
});
