/**
 * Top-level scan orchestration: walk the repo, detect every applicable stack via the
 * adapter registry, infer flows, and assemble the surface registry. Pure and side-effect
 * free except for reading files - callers decide where to write the artifacts.
 */
import { detectPlaywright, type PlaywrightConfig } from "../detectors/playwright.js";
import type { DetectionBundle } from "../detectors/types.js";
import type { CrudFlow } from "../inference/crud.js";
import { buildRegistry } from "../registry/build.js";
import { scanStacks } from "../stacks/index.js";
import type { ProjectInfo, SurfaceRegistry } from "../types.js";
import { clearFileCache, type RepoFiles, walkRepo } from "./files.js";

export interface ScanResult {
	repo: RepoFiles;
	project: ProjectInfo;
	bundle: DetectionBundle;
	playwright: PlaywrightConfig;
	registry: SurfaceRegistry;
	flows: CrudFlow[];
}

export interface ScanOptions {
	maxFiles?: number;
	generatedAt?: string;
}

export function scanRepo(root: string, options: ScanOptions = {}): ScanResult {
	clearFileCache();
	const repo = walkRepo(root, { maxFiles: options.maxFiles });

	const { project, bundle, extraSurfaces } = scanStacks(repo);
	const playwright = detectPlaywright(repo);

	const { registry, flows } = buildRegistry(repo, project, bundle, {
		generatedAt: options.generatedAt ?? new Date().toISOString(),
		extraSurfaces,
	});

	return { repo, project, bundle, playwright, registry, flows };
}
