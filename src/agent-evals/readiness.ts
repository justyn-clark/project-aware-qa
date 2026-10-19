import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StepResult } from "../core.js";
import { outputDirectory } from "./run.js";

export interface ReadinessFinding {
	id: string;
	status: "discovered" | "missing";
	evidence: string[];
	guidance: string;
}
/** Static discovery only. Never executes project scripts or treats file presence as quality. */
export function inspectReadiness(root: string): ReadinessFinding[] {
	const groups: Array<[string, string[], string]> = [
		[
			"instructions",
			["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md"],
			"Explain setup, boundaries, verification and completion criteria.",
		],
		[
			"onboarding",
			["README.md", "CONTRIBUTING.md"],
			"Document a reproducible setup and first successful check.",
		],
		[
			"architecture",
			["ARCHITECTURE.md", "docs/architecture.md"],
			"Explain component boundaries and where changes belong.",
		],
		[
			"dependency-pins",
			[
				"package-lock.json",
				"pnpm-lock.yaml",
				"yarn.lock",
				"bun.lock",
				"Cargo.lock",
				"go.sum",
				"uv.lock",
				"poetry.lock",
			],
			"Pin dependencies and toolchain versions for repeatable work.",
		],
		[
			"automation",
			[".github/workflows", ".gitlab-ci.yml", "azure-pipelines.yml", "Jenkinsfile"],
			"Make acceptance checks reproducible locally and in CI.",
		],
		[
			"test-entrypoints",
			[
				"Makefile",
				"justfile",
				"Cargo.toml",
				"go.mod",
				"pyproject.toml",
				"build.zig",
				"CMakeLists.txt",
			],
			"Provide explicit build, test and lint commands with meaningful failures.",
		],
		[
			"agent-evaluations",
			[".qa-evals/suite.json"],
			"Measure representative tasks with held-out assertions and repeated trials.",
		],
	];
	const findings = groups.map(([id, paths, guidance]) => {
		const evidence = paths.filter((path) => {
			const full = join(root, path);
			return existsSync(full) && !lstatSync(full).isSymbolicLink();
		});
		return {
			id,
			status: evidence.length ? ("discovered" as const) : ("missing" as const),
			evidence,
			guidance,
		};
	});
	const pkg = join(root, "package.json");
	if (existsSync(pkg) && !lstatSync(pkg).isSymbolicLink() && lstatSync(pkg).size < 1024 * 1024) {
		try {
			const scripts = JSON.parse(readFileSync(pkg, "utf8")).scripts;
			if (scripts && typeof scripts === "object") {
				const finding = findings.find((f) => f.id === "test-entrypoints");
				for (const key of ["test", "check", "lint", "build"])
					if (typeof scripts[key] === "string" && scripts[key].trim())
						finding?.evidence.push(`package.json#scripts.${key}`);
				if (finding?.evidence.length) finding.status = "discovered";
			}
		} catch {
			/* Malformed package metadata supplies no evidence. */
		}
	}
	return findings;
}
export function runAgentReadiness(root: string): StepResult {
	const findings = inspectReadiness(root);
	const output = outputDirectory(root, "agent-readiness");
	const json = join(output, "readiness.json");
	const markdown = join(output, "readiness.md");
	writeFileSync(
		json,
		JSON.stringify(
			{ version: 1, kind: "agent-readiness", verification: "static-only", findings },
			null,
			2,
		),
	);
	writeFileSync(
		markdown,
		`# Agent readiness evidence\n\nStatic discovery only. File presence does not establish quality, executable setup or agent success. No readiness score is assigned. Conventional paths only; custom layouts may be missed.\n\n${findings.map((f) => `- ${f.id}: ${f.status}\n  Evidence: ${f.evidence.join(", ") || "none"}\n  Action: ${f.guidance}`).join("\n")}\n`,
	);
	return {
		ok: true,
		summary:
			"Static readiness evidence written; no project commands executed or agent capability claimed.",
		writtenFiles: [json, markdown],
	};
}
