/**
 * `.qa/` artifact I/O. All generated reports, the registry, screenshots and findings
 * live under `<repo>/.qa`. This is the only module that writes to disk.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { SurfaceRegistry } from "./types.js";

export const QA_DIRNAME = ".qa";

export function qaDir(root: string): string {
	return join(resolve(root), QA_DIRNAME);
}

export function qaPath(root: string, ...parts: string[]): string {
	return join(qaDir(root), ...parts);
}

/** Create `.qa/`, `.qa/screenshots/`, `.qa/findings/` if missing. */
export function ensureQaDirs(root: string): void {
	for (const sub of ["", "screenshots", "findings"]) {
		const dir = sub ? qaPath(root, sub) : qaDir(root);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	}
}

export function writeArtifact(root: string, relPath: string, content: string): string {
	const full = qaPath(root, relPath);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, content, "utf8");
	return full;
}

export function writeJsonArtifact(root: string, relPath: string, data: unknown): string {
	return writeArtifact(root, relPath, `${JSON.stringify(data, null, 2)}\n`);
}

export function readRegistry(root: string): SurfaceRegistry | null {
	const file = qaPath(root, "surface-registry.json");
	if (!existsSync(file)) return null;
	try {
		return JSON.parse(readFileSync(file, "utf8")) as SurfaceRegistry;
	} catch {
		return null;
	}
}

export function registryExists(root: string): boolean {
	return existsSync(qaPath(root, "surface-registry.json"));
}
