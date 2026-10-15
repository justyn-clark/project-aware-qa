/**
 * Package & toolchain detection.
 *
 * Discovers every package.json in the repo, infers the package manager from lockfiles,
 * merges scripts/dependencies, and classifies the runnable checks (typecheck/lint/test/
 * build/dev) plus the frameworks in play. Monorepo-friendly: a repo can hold both a
 * Remix frontend and a NestJS backend.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { CheckKind, PackageManager } from "../types.js";
import { type FileEntry, type RepoFiles, readFileCached, toPosix } from "./files.js";

interface RawPackageJson {
	name?: string;
	packageManager?: string;
	scripts?: Record<string, string>;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	workspaces?: unknown;
}

/** Raw Node toolchain facts; the node adapter turns `checkScripts` into run commands. */
export interface NodeToolchain {
	name?: string;
	packageManager: PackageManager;
	frameworks: string[];
	scripts: Record<string, string>;
	/** Conventional script names for each check kind (resolved from package.json scripts). */
	checkScripts: Partial<Record<CheckKind, string>>;
	testRunners: string[];
	packageJsonPaths: string[];
	dependencies: Record<string, string>;
}

/** Detect the package manager by lockfile presence at the repo root. */
export function detectPackageManager(root: string): PackageManager {
	if (existsSync(join(root, "bun.lockb")) || existsSync(join(root, "bun.lock"))) return "bun";
	if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
	if (existsSync(join(root, "yarn.lock"))) return "yarn";
	if (existsSync(join(root, "package-lock.json"))) return "npm";
	return "unknown";
}

/** Resolve a package's own toolchain, inheriting only from enclosing directories. */
function packageManagerFor(repoRoot: string, rootRel: string): PackageManager {
	const root = resolve(repoRoot);
	let dir = join(root, rootRel);
	for (;;) {
		const declared = parsePackageJson(join(dir, "package.json"))?.packageManager;
		const pm = typeof declared === "string" ? declared.split("@")[0] : undefined;
		if (pm === "npm" || pm === "pnpm" || pm === "yarn" || pm === "bun") return pm;
		const fromLockfile = detectPackageManager(dir);
		if (fromLockfile !== "unknown") return fromLockfile;
		if (dir === root) break;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return "unknown";
}

/** Manifest boundaries stop scripts and source evidence leaking between packages. */
export function nodePackageRoots(repo: RepoFiles): string[] {
	return repo.files
		.filter((f) => f.path === "package.json" || f.path.endsWith("/package.json"))
		.map((f) => (f.path === "package.json" ? "" : f.path.slice(0, -"/package.json".length)))
		.sort();
}

export function scopeNodePackage(repo: RepoFiles, rootRel: string): RepoFiles {
	const children = nodePackageRoots(repo).filter(
		(p) => p !== rootRel && (rootRel === "" || p.startsWith(`${rootRel}/`)),
	);
	return {
		...repo,
		files: repo.files.filter(
			(f) =>
				(rootRel === "" || f.path.startsWith(`${rootRel}/`)) &&
				!children.some((child) => f.path.startsWith(`${child}/`)),
		),
	};
}

function parsePackageJson(abs: string): RawPackageJson | null {
	const raw = readFileCached(abs);
	if (!raw) return null;
	try {
		return JSON.parse(raw) as RawPackageJson;
	} catch {
		return null;
	}
}

const FRAMEWORK_SIGNATURES: Array<{ id: string; deps: string[] }> = [
	{
		id: "react-router",
		deps: ["react-router", "react-router-dom", "@react-router/dev", "@react-router/node"],
	},
	{ id: "remix", deps: ["@remix-run/react", "@remix-run/node", "@remix-run/serve", "remix"] },
	{ id: "nestjs", deps: ["@nestjs/core", "@nestjs/common"] },
	{ id: "playwright", deps: ["@playwright/test", "playwright"] },
	{ id: "react", deps: ["react"] },
	{ id: "next", deps: ["next"] },
	{ id: "vite", deps: ["vite"] },
	{ id: "tanstack-query", deps: ["@tanstack/react-query", "react-query"] },
	{ id: "swr", deps: ["swr"] },
	{ id: "vitest", deps: ["vitest"] },
	{ id: "jest", deps: ["jest", "ts-jest"] },
	{ id: "react-hook-form", deps: ["react-hook-form"] },
	{ id: "formik", deps: ["formik"] },
];

/** Pick a check command for a known script name, preferring conventional names. */
function pickScript(scripts: Record<string, string>, candidates: string[]): string | undefined {
	for (const name of candidates) {
		if (scripts[name]) return name;
	}
	return undefined;
}

export function scanPackages(repo: RepoFiles, rootRel?: string): NodeToolchain {
	const root = repo.root;
	const pkgFiles = repo.files.filter((f) =>
		rootRel === undefined
			? f.path === "package.json" || f.path.endsWith("/package.json")
			: f.path === (rootRel ? `${rootRel}/package.json` : "package.json"),
	);

	const mergedScripts: Record<string, string> = {};
	const mergedDeps: Record<string, string> = {};
	const packageJsonPaths: string[] = [];
	let rootName: string | undefined;

	// Sort so the shallowest (root) package.json wins on name and is processed first.
	const sorted = [...pkgFiles].sort((a, b) => a.path.split("/").length - b.path.split("/").length);
	for (const f of sorted) {
		const pkg = parsePackageJson(f.abs);
		if (!pkg) continue;
		packageJsonPaths.push(f.path);
		if ((rootRel !== undefined || f.path === "package.json") && pkg.name) rootName = pkg.name;
		for (const [k, v] of Object.entries(pkg.scripts ?? {})) {
			if (!(k in mergedScripts)) mergedScripts[k] = v;
		}
		for (const [k, v] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
			if (!(k in mergedDeps)) mergedDeps[k] = v;
		}
	}

	const frameworks: string[] = [];
	for (const sig of FRAMEWORK_SIGNATURES) {
		if (sig.deps.some((d) => d in mergedDeps)) frameworks.push(sig.id);
	}
	// Remix runs on React Router internally; surface react-router capability too.
	if (frameworks.includes("remix") && !frameworks.includes("react-router")) {
		frameworks.push("react-router");
	}

	const testRunners: string[] = [];
	if ("vitest" in mergedDeps) testRunners.push("vitest");
	if ("jest" in mergedDeps || "ts-jest" in mergedDeps) testRunners.push("jest");
	if ("@playwright/test" in mergedDeps || "playwright" in mergedDeps)
		testRunners.push("playwright");
	if (mergedScripts.test && testRunners.length === 0) testRunners.push("npm-test");

	const checkScripts: NodeToolchain["checkScripts"] = {};
	const typecheckName = pickScript(mergedScripts, [
		"typecheck",
		"type-check",
		"tsc",
		"check-types",
		"check",
	]);
	if (typecheckName) checkScripts.typecheck = typecheckName;
	const lintName = pickScript(mergedScripts, ["lint", "lint:check", "biome:lint", "eslint"]);
	if (lintName) checkScripts.lint = lintName;
	const testName = pickScript(mergedScripts, ["test", "test:unit", "test:ci"]);
	if (testName) checkScripts.test = testName;
	const buildName = pickScript(mergedScripts, ["build"]);
	if (buildName) checkScripts.build = buildName;
	const devName = pickScript(mergedScripts, ["dev", "start:dev", "develop", "serve"]);
	if (devName) checkScripts.dev = devName;

	return {
		name: rootName,
		packageManager: packageManagerFor(root, rootRel ?? ""),
		frameworks,
		scripts: mergedScripts,
		checkScripts,
		testRunners,
		packageJsonPaths,
		dependencies: mergedDeps,
	};
}

/** True when node_modules is absent at the repo root (verify must gate on install). */
export function nodeModulesMissing(root: string): boolean {
	return !existsSync(join(root, "node_modules"));
}

/** Find the nearest package.json directory above a file (for monorepo-aware commands). */
export function nearestPackageDir(repoRoot: string, file: FileEntry): string {
	let dir = dirname(file.abs);
	while (dir.startsWith(repoRoot)) {
		if (existsSync(join(dir, "package.json"))) return toPosix(dir);
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return toPosix(repoRoot);
}
