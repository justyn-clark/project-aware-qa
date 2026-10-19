import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { digest, safePath } from "./config.js";

export type Tree = Map<string, Buffer>;
export function readTree(root: string): Tree {
	const tree: Tree = new Map();
	let total = 0;
	let entries = 0;
	function visit(dir: string, prefix: string): void {
		if (prefix.split("/").length > 64) throw new Error("Tree nesting exceeds 64 levels");
		if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink())
			throw new Error(`Unsafe directory: ${prefix}`);
		for (const name of readdirSync(dir).sort()) {
			if (++entries > 10000) throw new Error("Tree exceeds 10000 entries");
			const path = safePath(prefix ? `${prefix}/${name}` : name);
			const absolute = join(dir, name);
			const stat = lstatSync(absolute);
			if (stat.isDirectory()) visit(absolute, path);
			else {
				if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024)
					throw new Error(`Unsupported file: ${path}`);
				total += stat.size;
				if (total > 64 * 1024 * 1024 || tree.size >= 10000)
					throw new Error("Evaluation tree exceeds 64 MiB or 10000 files");
				tree.set(path, readFileSync(absolute));
			}
		}
	}
	visit(root, "");
	return tree;
}
export function writeTree(root: string, tree: Tree): void {
	mkdirSync(root, { recursive: true });
	for (const [path, contents] of tree) {
		const target = join(root, safePath(path));
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, contents, { flag: "wx", mode: 0o600 });
	}
}
export function treeHash(tree: Tree): string {
	return digest(
		JSON.stringify(
			[...tree].sort(([a], [b]) => a.localeCompare(b)).map(([p, b]) => [p, digest(b)]),
		),
	);
}
export function changes(before: Tree, after: Tree): string[] {
	return [...new Set([...before.keys(), ...after.keys()])]
		.filter((p) => !before.get(p)?.equals(after.get(p) ?? Buffer.alloc(0)) || !after.has(p))
		.sort();
}
export function allowedChange(path: string, allowed: string[]): boolean {
	return allowed.some((p) => path === p || path.startsWith(`${p}/`));
}
export function gitSnapshot(root: string, heldOut: string): { tree: Tree; commit: string } {
	const git = (args: string[]) =>
		execFileSync("git", ["-C", root, ...args], { maxBuffer: 72 * 1024 * 1024 });
	if (git(["status", "--porcelain", "--untracked-files=normal"]).toString().trim())
		throw new Error("Agent evaluations require a clean Git checkout (including untracked files)");
	if (git(["rev-parse", "--show-prefix"]).toString().trim())
		throw new Error("Evaluation root must be the Git repository root");
	const commit = git(["rev-parse", "HEAD"]).toString().trim();
	const tree: Tree = new Map();
	let total = 0;
	for (const entry of git(["ls-tree", "-rz", commit]).toString().split("\0").filter(Boolean)) {
		const match = /^(\d+) blob ([a-f0-9]+)\t(.+)$/.exec(entry);
		if (!match) throw new Error("Submodules and non-blob Git entries are unsupported");
		const mode = match[1] as string;
		const oid = match[2] as string;
		const name = match[3] as string;
		if (name === heldOut || name.startsWith(`${heldOut}/`)) continue;
		if (mode !== "100644" && mode !== "100755")
			throw new Error(`Symlinks are unsupported: ${name}`);
		const path = safePath(name);
		const bytes = git(["cat-file", "blob", oid]);
		total += bytes.length;
		if (bytes.length > 8 * 1024 * 1024 || total > 64 * 1024 * 1024 || tree.size >= 10000)
			throw new Error("Git snapshot exceeds evaluation limits");
		tree.set(path, bytes);
	}
	return { tree, commit };
}
