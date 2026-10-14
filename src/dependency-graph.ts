import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, posix, relative, resolve } from "node:path";
import { localInput, readTeamConfig, type TeamConfig } from "./team-config.js";
import type { ProjectInfo, Surface } from "./types.js";

export interface DependencyGraph {
	roots: string[];
	edges: Array<{ consumer: string; dependency: string; source: "manifest" | "config" }>;
}
export function ownerOf(file: string, roots: string[]): string | undefined {
	return [...roots]
		.sort((a, b) => b.length - a.length)
		.find((root) => !root || file === root || file.startsWith(`${root}/`));
}
export function surfaceRoots(surface: Surface, roots: string[]): string[] {
	return [
		...new Set(
			[
				...surface.files,
				...surface.evidence.flatMap((entry) => (entry.file ? [entry.file] : [])),
			].flatMap((file) => {
				const owner = ownerOf(file, roots);
				return owner === undefined ? [] : [owner];
			}),
		),
	];
}
/** Infer local Node package references; cross-language and service edges are explicit. */
export function dependencyGraph(
	root: string,
	project: ProjectInfo,
	config: TeamConfig = readTeamConfig(root),
): DependencyGraph {
	const roots = new Set(project.stacks.map((stack) => stack.rootRel));
	const manifests = project.packageJsonPaths
		.filter((path) => path === "package.json" || path.endsWith("/package.json"))
		.map((path) => {
			const directory = dirname(path) === "." ? "" : dirname(path).replaceAll("\\", "/");
			roots.add(directory);
			return { directory, data: JSON.parse(readFileSync(localInput(root, path), "utf8")) };
		});
	const names = new Map<string, string>();
	for (const { directory, data } of manifests) {
		if (typeof data.name === "string") {
			if (names.has(data.name)) throw new Error(`Ambiguous local package name: ${data.name}`);
			names.set(data.name, directory);
		}
	}
	const edges: DependencyGraph["edges"] = [];
	for (const { directory: consumer, data } of manifests) {
		for (const [name, version] of Object.entries({
			...data.dependencies,
			...data.devDependencies,
			...data.peerDependencies,
			...data.optionalDependencies,
		})) {
			let dependency = names.get(name);
			if (typeof version === "string" && /^(file:|link:)/.test(version)) {
				const path = posix
					.normalize(posix.join(consumer, version.replace(/^(file:|link:)/, "")))
					.replace(/^\.$/, "");
				if (roots.has(path)) dependency = path;
			}
			if (dependency !== undefined && dependency !== consumer)
				edges.push({ consumer, dependency, source: "manifest" });
		}
	}
	for (const [consumer, dependencies] of Object.entries(config.dependencies)) {
		if (!roots.has(consumer))
			throw new Error(
				`Dependency consumer must be a detected stack or package root: ${consumer || "."}`,
			);
		for (const path of [consumer, ...dependencies]) {
			const full = resolve(root, path);
			if (!existsSync(full) || !statSync(full).isDirectory())
				throw new Error(`Configured dependency directory does not exist: ${path || "."}`);
			if (relative(realpathSync(root), realpathSync(full)).startsWith(".."))
				throw new Error(`Dependency leaves project root: ${path}`);
			roots.add(path);
		}
		for (const dependency of dependencies) edges.push({ consumer, dependency, source: "config" });
	}
	return {
		roots: [...roots].sort(),
		edges: edges.sort((a, b) =>
			`${a.consumer}:${a.dependency}`.localeCompare(`${b.consumer}:${b.dependency}`),
		),
	};
}
export function affectedRoots(graph: DependencyGraph, changed: string[]): string[] {
	const affected = new Set(changed);
	for (let previous = -1; previous !== affected.size; ) {
		previous = affected.size;
		for (const edge of graph.edges) if (affected.has(edge.dependency)) affected.add(edge.consumer);
	}
	return [...affected].sort();
}
