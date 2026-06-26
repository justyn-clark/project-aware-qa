/**
 * Top-level scan orchestration: walk the repo, detect the toolchain, run every detector,
 * infer flows, and assemble the surface registry. Pure and side-effect free except for
 * reading files — callers decide where to write the artifacts.
 */
import { detectCacheSignals } from "../detectors/cache.js";
import { detectForms } from "../detectors/forms.js";
import { detectControllers, detectDtos } from "../detectors/nestjs.js";
import { detectPlaywright, type PlaywrightConfig } from "../detectors/playwright.js";
import { detectRoutes } from "../detectors/react-router.js";
import { detectTests } from "../detectors/tests.js";
import type { DetectionBundle } from "../detectors/types.js";
import type { CrudFlow } from "../inference/crud.js";
import { buildRegistry } from "../registry/build.js";
import type { ProjectInfo, SurfaceRegistry } from "../types.js";
import { clearFileCache, type RepoFiles, walkRepo } from "./files.js";
import { scanPackages } from "./package.js";

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
	const { project } = scanPackages(repo);

	const bundle: DetectionBundle = {
		routes: detectRoutes(repo, project),
		endpoints: detectControllers(repo),
		dtos: detectDtos(repo),
		forms: detectForms(repo),
		cacheSignals: detectCacheSignals(repo),
		tests: detectTests(repo),
	};
	const playwright = detectPlaywright(repo);

	const { registry, flows } = buildRegistry(repo, project, bundle, {
		generatedAt: options.generatedAt ?? new Date().toISOString(),
	});

	return { repo, project, bundle, playwright, registry, flows };
}
