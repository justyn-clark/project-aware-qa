import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";

const root = fileURLToPath(new URL("..", import.meta.url));

test("packed release contains loadable skills and all four QA commands", async () => {
	const temp = mkdtempSync(join(tmpdir(), "qa-release-"));
	try {
		execFileSync("npm", ["run", "build"], { cwd: root, encoding: "utf8" });
		const output = execFileSync(
			"npm",
			[
				"pack",
				"--json",
				"--ignore-scripts",
				"--pack-destination",
				temp,
				"--cache",
				join(temp, "cache"),
			],
			{ cwd: root, encoding: "utf8", env: { ...process.env, npm_config_offline: "true" } },
		);
		const packedFiles = JSON.parse(output) as Array<{ filename: string }>;
		const filename = packedFiles[0]?.filename;
		assert.ok(filename);
		execFileSync("tar", ["-xzf", join(temp, filename), "-C", temp]);
		const packed = join(temp, "package");
		const manifest = JSON.parse(readFileSync(join(packed, "package.json"), "utf8"));
		assert.equal(
			manifest.version,
			JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version,
		);
		assert.ok(manifest.pi.skills.length > 0);
		for (const skill of manifest.pi.skills as string[]) {
			const content = readFileSync(join(packed, skill, "SKILL.md"), "utf8");
			const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
			assert.ok(frontmatter, `${skill}: missing frontmatter`);
			const metadata = parse(frontmatter[1] as string);
			assert.equal(typeof metadata.name, "string");
			assert.equal(typeof metadata.description, "string");
		}
		const commands: string[] = [];
		for (const extension of manifest.pi.extensions as string[]) {
			assert.ok(existsSync(join(packed, extension)));
			const module = await import(pathToFileURL(join(packed, extension)).href);
			module.default({ registerCommand: (name: string) => commands.push(name) });
		}
		assert.deepEqual(commands.sort(), ["qa-plan", "qa-report", "qa-scan", "qa-verify"]);
		// The published CLI must work with plain Node, without tsx or installed dev dependencies.
		const executable = join(packed, manifest.bin["project-aware-qa"]);
		assert.equal(
			execFileSync(process.execPath, [executable, "--version"], { encoding: "utf8" }).trim(),
			manifest.version,
		);
		const scanned = JSON.parse(
			execFileSync(process.execPath, [executable, "scan", packed, "--json"], { encoding: "utf8" }),
		);
		assert.equal(scanned.ok, true);
		assert.equal(scanned.scan.registry.tool.version, manifest.version);
		assert.ok(scanned.scan.registry.provenance.inputHash);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});
