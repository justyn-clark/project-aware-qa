import { execFileSync } from "node:child_process";
import {
	affectedRoots,
	type DependencyGraph,
	dependencyGraph,
	ownerOf,
	surfaceRoots,
} from "./dependency-graph.js";
import { CONFIG_FILE } from "./team-config.js";
import type { ProjectInfo, Surface, SurfaceRegistry } from "./types.js";

const MAX_CHANGED_FILES = 20_000;
const GLOBAL_FILES = new Set([
	"package.json",
	"package-lock.json",
	"pnpm-lock.yaml",
	"pnpm-workspace.yaml",
	"yarn.lock",
	"bun.lock",
	"bun.lockb",
	"turbo.json",
	"nx.json",
	"lerna.json",
	"tsconfig.json",
	"go.work",
	"Cargo.lock",
	"mix.lock",
	"pyproject.toml",
	"requirements.txt",
	"Gemfile.lock",
	"pom.xml",
	"settings.gradle",
	"settings.gradle.kts",
]);

export interface ChangeSelection {
	mode: "changed";
	baseRef: string;
	baseCommit: string;
	changedFiles: string[];
	stackRoots: string[];
	surfaceIds: string[];
	globalImpact: boolean;
	dependencyGraph: DependencyGraph;
	affectedRoots: string[];
	directSurfaceIds: string[];
	reasons: string[];
}

function git(root: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 15_000,
		maxBuffer: 32 * 1024 * 1024,
	});
}

function paths(output: string): string[] {
	return output
		.split("\0")
		.map((path) => path.replace(/^\.\//, ""))
		.filter(
			(path) =>
				path &&
				path !== "." &&
				!path.startsWith("../") &&
				!path.startsWith("/") &&
				path !== ".qa" &&
				!path.startsWith(".qa/") &&
				path !== "node_modules" &&
				!path.startsWith("node_modules/"),
		);
}

function changedPaths(root: string, baseCommit: string): string[] {
	const outputs = [
		git(root, [
			"diff",
			"--no-renames",
			"--relative",
			"--name-only",
			"-z",
			`${baseCommit}...HEAD`,
			"--",
			".",
		]),
		git(root, ["diff", "--no-renames", "--relative", "--name-only", "-z", "--cached", "--", "."]),
		git(root, ["diff", "--no-renames", "--relative", "--name-only", "-z", "--", "."]),
		git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", "."]),
	];
	const files = [...new Set(outputs.flatMap(paths))].sort();
	if (files.length > MAX_CHANGED_FILES) {
		throw new Error(
			`Change selection found ${files.length} files, above the ${MAX_CHANGED_FILES} safety limit. Narrow the project root or choose a newer base ref.`,
		);
	}
	return files;
}

function surfaceFiles(surface: Surface): Set<string> {
	return new Set(
		[...surface.files, ...surface.evidence.flatMap((item) => (item.file ? [item.file] : []))].map(
			(file) => file.replaceAll("\\", "/").replace(/^\.\//, ""),
		),
	);
}

function isGlobal(path: string): boolean {
	return !path.includes("/") && GLOBAL_FILES.has(path);
}

/** Resolve committed plus local changes into the stack and surface boundaries they affect. */
export function selectChanges(
	root: string,
	registry: SurfaceRegistry,
	project: ProjectInfo,
	baseRef: string,
): ChangeSelection {
	const ref = baseRef.trim();
	if (!ref || ref.startsWith("-") || /[\0\r\n]/.test(ref)) {
		throw new Error(`Invalid change-selection base ref: ${JSON.stringify(baseRef)}`);
	}
	let baseCommit: string;
	try {
		baseCommit = git(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).trim();
	} catch {
		throw new Error(`Cannot resolve change-selection base ref ${JSON.stringify(ref)}.`);
	}
	const changedFiles = changedPaths(root, baseCommit);
	const graph = dependencyGraph(root, project);
	const reasons: string[] = [];
	for (const file of changedFiles) {
		const owner = ownerOf(file, graph.roots);
		// A changed/deleted manifest may have removed an edge, so the current graph alone is insufficient.
		if (
			isGlobal(file) ||
			file === CONFIG_FILE ||
			/(^|\/)(package.json|go.mod|Cargo.toml|mix.exs|pyproject.toml|pom.xml|build.gradle)$/.test(
				file,
			)
		)
			reasons.push(`Dependency or global configuration changed: ${file}`);
		else if (owner === undefined || owner === "")
			reasons.push(`Root or unmapped shared input: ${file}`);
	}
	const globalImpact = reasons.length > 0;
	const affected = globalImpact
		? graph.roots
		: affectedRoots(
				graph,
				changedFiles.flatMap((file) => {
					const owner = ownerOf(file, graph.roots);
					return owner === undefined ? [] : [owner];
				}),
			);
	const stackRoots = [
		...new Set(
			project.stacks
				.filter((stack) => affected.includes(stack.rootRel))
				.map((stack) => stack.rootRel),
		),
	].sort();
	const directSurfaceIds = registry.surfaces
		.filter((surface) => changedFiles.some((file) => surfaceFiles(surface).has(file)))
		.map((surface) => surface.id)
		.sort();
	// Helpers, layouts, DTOs and dependency changes can affect any surface in a selected service.
	const surfaceIds = registry.surfaces
		.filter(
			(surface) =>
				globalImpact ||
				surfaceRoots(surface, graph.roots).some((owner) => affected.includes(owner)),
		)
		.map((surface) => surface.id)
		.sort();
	return {
		mode: "changed",
		baseRef: ref,
		baseCommit,
		changedFiles,
		stackRoots,
		surfaceIds,
		globalImpact,
		dependencyGraph: graph,
		affectedRoots: affected,
		directSurfaceIds,
		reasons,
	};
}
