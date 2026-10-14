import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	fstatSync,
	lstatSync,
	openSync,
	readdirSync,
	readlinkSync,
	readSync,
	realpathSync,
	statSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { walkRepo } from "./scanner/files.js";
import type { ProjectFingerprint, SurfaceRegistry } from "./types.js";

// Fingerprinting covers all input types, unlike the detector's source-language allowlist.
const EXCLUDED_DIRECTORIES = new Set([
	".git",
	".qa",
	".pi",
	".codex",
	".small",
	"node_modules",
	"vendor",
	"deps",
	"dist",
	"build",
	"out",
	"coverage",
	".next",
	".turbo",
	".cache",
	".react-router",
	"__pycache__",
	".venv",
	"venv",
	"_build",
	"target",
	"obj",
	"Pods",
	"zig-cache",
	"zig-out",
	".godot",
	".mix",
	"tmp",
]);
const OPERATIONAL_DIRECTORIES = new Set([".git", ".qa", "node_modules"]);
const MAX_INPUT_FILES = 100_000;
const MAX_INPUT_BYTES = 2 * 1024 * 1024 * 1024;

export function validateProjectRoot(root: string): string | undefined {
	try {
		if (!statSync(root).isDirectory()) return `Project root is not a directory: ${root}`;
		readdirSync(root);
		return undefined;
	} catch {
		return `Project root does not exist or cannot be read: ${root}`;
	}
}

function inside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function excluded(path: string, gitInventory: boolean): boolean {
	const directories = gitInventory ? OPERATIONAL_DIRECTORIES : EXCLUDED_DIRECTORIES;
	return path.split(sep).some((part) => directories.has(part));
}

/** Hash content in bounded chunks; never expose file contents in metadata or diagnostics. */
export function fingerprintProject(root: string): ProjectFingerprint {
	const hash = createHash("sha256");
	const issues: string[] = [];
	const note = (message: string) => {
		if (issues.length < 10 && !issues.includes(message)) issues.push(message);
	};
	const invalid = validateProjectRoot(root);
	if (invalid) {
		return {
			inputHash: hash.digest("hex"),
			commit: null,
			files: 0,
			complete: false,
			issues: [invalid],
		};
	}
	let canonicalRoot: string;
	try {
		canonicalRoot = realpathSync(root);
	} catch {
		return {
			inputHash: hash.digest("hex"),
			commit: null,
			files: 0,
			complete: false,
			issues: ["Project root changed while resolving its path. Scan again."],
		};
	}
	let gitInventory = false;
	const inputs = new Set<string>();
	const visited = new Set<string>();
	const add = (path: string) => {
		const rel = relative(canonicalRoot, path);
		if (!inside(canonicalRoot, path) || excluded(rel, gitInventory)) return;
		if (inputs.size >= MAX_INPUT_FILES && !inputs.has(path)) {
			note(`Fingerprint exceeded ${MAX_INPUT_FILES} input files; reduce the project scope.`);
			return;
		}
		inputs.add(path);
	};
	const walk = (directory: string) => {
		if (inputs.size >= MAX_INPUT_FILES) {
			note(`Fingerprint reached ${MAX_INPUT_FILES} input files; reduce the project scope.`);
			return;
		}
		let actual: string;
		try {
			actual = realpathSync(directory);
		} catch {
			note(`Cannot resolve input directory: ${relative(canonicalRoot, directory) || "."}`);
			return;
		}
		if (!inside(canonicalRoot, actual)) {
			note(`Input symlink leaves the project root: ${relative(canonicalRoot, directory)}`);
			return;
		}
		if (visited.has(actual)) return;
		visited.add(actual);
		try {
			for (const entry of readdirSync(directory, { withFileTypes: true })) {
				if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
				const path = join(directory, entry.name);
				if (entry.isDirectory()) walk(path);
				else add(path);
			}
		} catch {
			note(`Cannot read input directory: ${relative(canonicalRoot, directory) || "."}`);
		}
	};
	const git = (args: string[], cwd: string) =>
		execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 10_000,
			maxBuffer: 32 * 1024 * 1024,
		});
	let gitRoot: string | undefined;
	let commit: string | null = null;
	try {
		gitRoot = realpathSync(git(["rev-parse", "--show-toplevel"], canonicalRoot).trim());
	} catch {
		// A standalone folder has no ignore index; conservatively include its non-generated inputs.
	}
	if (gitRoot) {
		gitInventory = true;
		try {
			commit = git(["rev-parse", "--verify", "HEAD"], canonicalRoot).trim();
		} catch {
			// New repositories may not have their first commit yet.
		}
		try {
			const target = relative(gitRoot, canonicalRoot).split(sep).join("/") || ".";
			const paths = git(
				["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", target],
				gitRoot,
			);
			for (const path of paths.split("\0")) {
				if (path) add(resolve(gitRoot, path));
			}
		} catch {
			note("Cannot enumerate Git inputs; check repository access and scan again.");
			walk(canonicalRoot);
		}
	} else {
		walk(canonicalRoot);
	}
	// Detectors may inspect Git-ignored source. Keep their actual inputs in the snapshot too.
	const scanner = walkRepo(canonicalRoot, { maxFiles: MAX_INPUT_FILES });
	for (const file of scanner.files) add(file.abs);
	if (scanner.truncated) note("Scanner input discovery was incomplete; reduce the project scope.");
	for (const issue of scanner.issues ?? []) note(issue);
	// Include internal symlink directory inputs; external targets are never read.
	for (const path of inputs) {
		try {
			const stat = lstatSync(path);
			if (stat.isSymbolicLink()) {
				const actual = realpathSync(path);
				if (!inside(canonicalRoot, actual)) {
					note(`Input symlink leaves the project root: ${relative(canonicalRoot, path)}`);
				} else if (statSync(actual).isDirectory()) walk(path);
			} else if (stat.isDirectory()) walk(path); // Git submodules.
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				note(`Cannot inspect input: ${relative(canonicalRoot, path)}`);
			}
		}
	}
	const buffer = Buffer.allocUnsafe(64 * 1024);
	let bytes = 0;
	for (const path of [...inputs].sort()) {
		const rel = relative(canonicalRoot, path).split(sep).join("/");
		hash.update(JSON.stringify([rel]));
		let descriptor: number | undefined;
		try {
			const entry = lstatSync(path);
			if (entry.isSymbolicLink()) hash.update(JSON.stringify(["symlink", readlinkSync(path)]));
			const actual = realpathSync(path);
			if (!inside(canonicalRoot, actual)) {
				note(`Input symlink leaves the project root: ${rel}`);
				continue;
			}
			const stat = statSync(path);
			if (stat.isDirectory()) {
				hash.update("directory");
				continue;
			}
			if (!stat.isFile()) {
				note(`Unsupported input type: ${rel}`);
				continue;
			}
			bytes += stat.size;
			if (bytes > MAX_INPUT_BYTES) {
				note("Fingerprint exceeded 2 GiB of inputs; reduce the project scope.");
				break;
			}
			hash.update(JSON.stringify(["file", stat.size, stat.mode & 0o777]));
			descriptor = openSync(path, "r");
			let remaining = stat.size;
			while (remaining > 0) {
				const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, remaining), null);
				if (!count) {
					note(`Input changed while fingerprinting: ${rel}`);
					break;
				}
				hash.update(buffer.subarray(0, count));
				remaining -= count;
			}
			const after = fstatSync(descriptor);
			if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ino !== stat.ino) {
				note(`Input changed while fingerprinting: ${rel}`);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				// A tracked working-tree deletion is an input state, not a failed read.
				hash.update("missing");
			} else {
				note(`Cannot read input: ${rel}`);
			}
		} finally {
			if (descriptor !== undefined) closeSync(descriptor);
		}
	}
	return {
		inputHash: hash.digest("hex"),
		commit,
		files: inputs.size,
		complete: issues.length === 0,
		...(issues.length ? { issues } : {}),
	};
}

export function sameFingerprint(a: ProjectFingerprint, b: ProjectFingerprint): boolean {
	return a.complete && b.complete && a.inputHash === b.inputHash && a.commit === b.commit;
}

export function registryFingerprint(registry: SurfaceRegistry): string {
	return createHash("sha256").update(JSON.stringify(registry)).digest("hex");
}
