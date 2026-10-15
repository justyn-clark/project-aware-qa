import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("project-owned source, documentation and templates must be ASCII only", () => {
	const root = fileURLToPath(new URL("..", import.meta.url));
	const files = execFileSync(
		"git",
		["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
		{
			cwd: root,
			encoding: "utf8",
		},
	)
		.split("\0")
		.filter(Boolean);
	const violations: string[] = [];
	for (const file of new Set(files)) {
		const bytes = readFileSync(join(root, file));
		if (bytes.includes(0)) continue; // Binary assets are not text documents.
		if ([...file].some((char) => char.charCodeAt(0) > 127) || bytes.some((byte) => byte > 127))
			violations.push(file);
	}
	assert.deepEqual(violations, [], "Use ASCII punctuation and status labels in project-owned text");
});
