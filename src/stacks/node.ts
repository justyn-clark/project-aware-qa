/**
 * Node / JavaScript-TypeScript stack adapter.
 *
 * Wraps the existing JS-TS detectors (React Router/Remix, NestJS, forms, cache, tests)
 * and package.json toolchain detection behind the StackAdapter interface. Behaviour for
 * JS/TS repos is unchanged — this is the reference "deep" adapter.
 */
import { detectCacheSignals } from "../detectors/cache.js";
import { detectForms } from "../detectors/forms.js";
import { detectControllers, detectDtos } from "../detectors/nestjs.js";
import { detectRoutes } from "../detectors/react-router.js";
import { detectTests } from "../detectors/tests.js";
import type { RepoFiles } from "../scanner/files.js";
import { nodePackageRoots, scanPackages, scopeNodePackage } from "../scanner/package.js";
import type { CheckCommand, PackageManager, StackChecks, StackInfo } from "../types.js";
import { packageManagerRun } from "../verify/commands.js";
import type { StackAdapter, StackMatch, StackScan } from "./types.js";

function checkCommand(pm: PackageManager, script: string, cwd: string): CheckCommand {
	const { command, args } = packageManagerRun(pm, script);
	return { command: `${command} ${args.join(" ")}`.trim(), cwd };
}

export const nodeAdapter: StackAdapter = {
	id: "node",
	name: "Node / JavaScript-TypeScript",
	kind: "deep",
	extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
	markers: ["package.json"],

	detect(repo: RepoFiles): StackMatch[] {
		// Only anchor a Node stack when there's a real project signal (a framework or a
		// runnable check script). An assets/tooling-only package.json — e.g. tailwind/esbuild
		// next to a Phoenix or Django app — shouldn't create a "Node (unknown)" stack.
		return nodePackageRoots(repo).flatMap((rootRel) => {
			const tc = scanPackages(repo, rootRel);
			if (tc.frameworks.length === 0 && Object.keys(tc.checkScripts).length === 0) return [];
			return [{ adapter: "node", rootRel, label: "Node", confidence: 80 }];
		});
	},

	scan(repo: RepoFiles, match: StackMatch): StackScan {
		const tc = scanPackages(repo, match.rootRel);
		const scopedRepo = scopeNodePackage(repo, match.rootRel);
		const checks: StackChecks = {};
		for (const kind of ["typecheck", "lint", "test", "build", "dev"] as const) {
			const script = tc.checkScripts[kind];
			if (script) checks[kind] = checkCommand(tc.packageManager, script, match.rootRel);
		}
		const usesTs = scopedRepo.files.some((f) => f.path.endsWith(".ts") || f.path.endsWith(".tsx"));
		const stack: StackInfo = {
			adapter: "node",
			label: `Node (${tc.packageManager})${match.rootRel ? ` — ${match.rootRel}` : ""}`,
			language: usesTs ? "typescript" : "javascript",
			rootRel: match.rootRel,
			packageManager: tc.packageManager,
			frameworks: tc.frameworks,
			scripts: tc.scripts,
			checks,
			testRunners: tc.testRunners,
			depth: "deep",
		};
		const bundle = {
			routes: detectRoutes(scopedRepo, tc.frameworks),
			endpoints: detectControllers(scopedRepo),
			dtos: detectDtos(scopedRepo),
			forms: detectForms(scopedRepo),
			cacheSignals: detectCacheSignals(scopedRepo),
			tests: detectTests(scopedRepo),
		};
		return { stack, bundle, extraSurfaces: [] };
	},
};

/** Node toolchain facts the scanner reuses for top-level ProjectInfo back-compat. */
export { scanPackages };
