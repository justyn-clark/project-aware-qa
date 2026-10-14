import { execFileSync } from "node:child_process";
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
		.map((path) => path.replace(/^\.\//, "").replaceAll("\\", "/"))
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
		git(root, ["diff", "--relative", "--name-only", "-z", `${baseCommit}...HEAD`, "--", "."]),
		git(root, ["diff", "--relative", "--name-only", "-z", "--cached", "--", "."]),
		git(root, ["diff", "--relative", "--name-only", "-z", "--", "."]),
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
	const roots = [...new Set(project.stacks.map((stack) => stack.rootRel))].sort(
		(a, b) => b.length - a.length || a.localeCompare(b),
	);
	const ownerOf = (file: string) =>
		roots.find((candidate) => !candidate || file.startsWith(`${candidate}/`));
	// Unmapped shared files can affect every package; prefer extra checks to under-selection.
	const globalImpact =
		changedFiles.some(isGlobal) || changedFiles.some((file) => ownerOf(file) === undefined);
	const stackRoots = globalImpact
		? [...roots].sort()
		: [
				...new Set(
					changedFiles.flatMap((file) => {
						const owner = ownerOf(file);
						return owner === undefined ? [] : [owner];
					}),
				),
			].sort();
	const surfaceIds = globalImpact
		? registry.surfaces.map((surface) => surface.id).sort()
		: registry.surfaces
				.filter((surface) => {
					const files = surfaceFiles(surface);
					return changedFiles.some((file) => files.has(file));
				})
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
	};
}
