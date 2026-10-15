/**
 * Validate every SKILL.md / prompt frontmatter parses as YAML with the required fields.
 *
 * Pi's skill loader parses this frontmatter, and the lint/typecheck/test gate does NOT
 * otherwise touch it - so a stray colon in an unquoted value (which YAML reads as a nested
 * mapping) ships silently. This test is the guard: it runs in `prepublishOnly`.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** Find every SKILL.md (and any *.md with frontmatter under skills/prompts). */
function findSkillFiles(dir: string, acc: string[] = []): string[] {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return acc;
	}
	for (const name of entries) {
		if (name === "node_modules" || name === ".git" || name === "dist") continue;
		const full = join(dir, name);
		if (statSync(full).isDirectory()) findSkillFiles(full, acc);
		else if (name === "SKILL.md") acc.push(full);
	}
	return acc;
}

const skillFiles = findSkillFiles(join(repoRoot, "skills"));

test("at least one SKILL.md exists", () => {
	assert.ok(skillFiles.length > 0, "expected skills/**/SKILL.md");
});

for (const file of skillFiles) {
	const rel = file.slice(repoRoot.length);
	test(`frontmatter is valid YAML: ${rel}`, () => {
		const text = readFileSync(file, "utf8");
		const m = /^---\n([\s\S]*?)\n---/.exec(text);
		assert.ok(m, `${rel}: missing --- frontmatter block`);
		let data: unknown;
		assert.doesNotThrow(() => {
			data = parseYaml(m[1] as string);
		}, `${rel}: frontmatter is not valid YAML`);
		assert.ok(
			data && typeof data === "object" && !Array.isArray(data),
			`${rel}: frontmatter must be a mapping`,
		);
		const fm = data as Record<string, unknown>;
		assert.equal(typeof fm.name, "string", `${rel}: 'name' must be a string`);
		assert.equal(
			typeof fm.description,
			"string",
			`${rel}: 'description' must be a string (a stray ': ' makes YAML read it as a nested mapping)`,
		);
	});
}
