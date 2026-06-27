/**
 * Stack adapter registry + multi-stack orchestration.
 *
 * Runs every deep adapter first, then the generic fallback only where no deep adapter
 * already claimed a location — so a Phoenix app gets the deep adapter, a plain Go module
 * gets the generic baseline, and a monorepo gets one stack per sub-project. Merges all
 * per-stack DetectionBundles and surfaces into the shape the registry builder expects.
 */
import type { DetectionBundle } from "../detectors/types.js";
import type { RepoFiles } from "../scanner/files.js";
import type { PackageManager, ProjectInfo, StackInfo, Surface } from "../types.js";
import { genericAdapter } from "./generic.js";
import { goAdapter } from "./golang.js";
import { nodeAdapter } from "./node.js";
import { phoenixAdapter } from "./phoenix.js";
import { pythonAdapter } from "./python.js";
import type { StackAdapter, StackScan } from "./types.js";

/** Deep adapters run first; the generic fallback fills the gaps. */
export const DEEP_ADAPTERS: StackAdapter[] = [
	nodeAdapter,
	phoenixAdapter,
	pythonAdapter,
	goAdapter,
];
export const ADAPTERS: StackAdapter[] = [...DEEP_ADAPTERS, genericAdapter];

function mergeBundles(bundles: DetectionBundle[]): DetectionBundle {
	const merged: DetectionBundle = {
		routes: [],
		endpoints: [],
		dtos: [],
		forms: [],
		cacheSignals: [],
		tests: [],
	};
	for (const b of bundles) {
		merged.routes.push(...b.routes);
		merged.endpoints.push(...b.endpoints);
		merged.dtos.push(...b.dtos);
		merged.forms.push(...b.forms);
		merged.cacheSignals.push(...b.cacheSignals);
		merged.tests.push(...b.tests);
	}
	return merged;
}

export interface MultiStackScan {
	project: ProjectInfo;
	bundle: DetectionBundle;
	extraSurfaces: Surface[];
}

/** Detect applicable stacks, scan each, and merge into one project + bundle + surfaces. */
export function scanStacks(repo: RepoFiles): MultiStackScan {
	const scans: StackScan[] = [];

	// 1. Deep adapters claim their locations.
	const claimed = new Set<string>(); // `${rootRel}` keys claimed by a deep adapter
	for (const adapter of DEEP_ADAPTERS) {
		for (const match of adapter.detect(repo)) {
			scans.push(adapter.scan(repo, match));
			claimed.add(match.rootRel);
		}
	}

	// 2. Generic fallback fills locations no deep adapter claimed.
	for (const match of genericAdapter.detect(repo)) {
		if (claimed.has(match.rootRel)) continue;
		scans.push(genericAdapter.scan(repo, match));
	}

	const stacks: StackInfo[] = scans.map((s) => s.stack);
	const bundle = mergeBundles(scans.map((s) => s.bundle));
	const extraSurfaces = scans.flatMap((s) => s.extraSurfaces);

	const project = buildProjectInfo(repo, stacks, scans);
	return { project, bundle, extraSurfaces };
}

function buildProjectInfo(repo: RepoFiles, stacks: StackInfo[], scans: StackScan[]): ProjectInfo {
	// Primary stack = highest-depth, then richest frameworks (for at-a-glance fields).
	const primary = [...stacks].sort((a, b) => {
		if (a.depth !== b.depth) return a.depth === "deep" ? -1 : 1;
		return b.frameworks.length - a.frameworks.length;
	})[0];

	const frameworks = [...new Set(stacks.flatMap((s) => s.frameworks))];
	const testRunners = [...new Set(stacks.flatMap((s) => s.testRunners))];
	const buildFiles = repo.files
		.filter((f) =>
			/(^|\/)(package\.json|mix\.exs|go\.mod|Cargo\.toml|pyproject\.toml|Gemfile|pom\.xml|build\.gradle(\.kts)?|build\.zig|project\.godot|CMakeLists\.txt)$/.test(
				f.path,
			),
		)
		.map((f) => f.path);

	// Reuse node dependencies if a node stack is present (handy for downstream consumers).
	const nodeScan = scans.find((s) => s.stack.adapter === "node");
	const dependencies: Record<string, string> = {};
	void nodeScan; // dependencies are derived in the node toolchain; kept empty here intentionally.

	return {
		name: undefined,
		root: repo.root,
		packageManager: (primary?.packageManager ?? "unknown") as PackageManager,
		frameworks,
		scripts: primary?.scripts ?? {},
		testRunners,
		packageJsonPaths: buildFiles,
		dependencies,
		stacks,
	};
}
