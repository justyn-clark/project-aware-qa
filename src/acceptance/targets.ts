import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { digest, safePath } from "../agent-evals/config.js";
import type { AcceptancePlan } from "./config.js";

const excluded = /^(?:\.git|\.qa|node_modules|vendor|\.env.*|.*\.(?:pem|key|p12|pfx))$/i;
export function localPath(root: string, path: string): string {
	const base = realpathSync(root),
		target = resolve(base, safePath(path));
	let current = base;
	for (const part of relative(base, target).split(sep)) {
		current = join(current, part);
		if (lstatSync(current).isSymbolicLink())
			throw new Error("Symlink targets and evidence are unsupported");
	}
	if (!realpathSync(target).startsWith(`${base}${sep}`)) throw new Error("Path escapes root");
	return target;
}
export function readBounded(path: string): Buffer {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024)
		throw new Error("Expected regular file no larger than 4 MiB");
	return readFileSync(path);
}
export function captureTarget(
	root: string,
	target: AcceptancePlan["target"],
): {
	kind: string;
	value: string;
	buildId?: string;
	hash?: string;
	files?: Array<{ path: string; hash: string }>;
	excluded?: string[];
} {
	if (target.kind === "url") return { ...target };
	const absolute = localPath(root, target.value);
	if (target.value.split("/").some((p) => excluded.test(p)))
		throw new Error("Target matches a private/dependency exclusion");
	const files: Array<{ path: string; hash: string }> = [],
		skipped: string[] = [];
	let total = 0,
		count = 0;
	function visit(path: string, name: string, depth: number): void {
		if (++count > 10000 || depth > 32) throw new Error("Target exceeds traversal limits");
		if (excluded.test(name.split("/").pop() ?? "")) {
			skipped.push(name);
			return;
		}
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) throw new Error("Target contains unsupported symlinks");
		if (stat.isDirectory())
			for (const file of readdirSync(path).sort())
				visit(join(path, file), name ? `${name}/${file}` : file, depth + 1);
		else {
			const data = readBounded(path);
			total += data.length;
			if (total > 32 * 1024 * 1024) throw new Error("Target exceeds 32 MiB");
			files.push({ path: name, hash: digest(data) });
		}
	}
	if (target.kind === "directory" && !lstatSync(absolute).isDirectory())
		throw new Error("Expected directory target");
	if (target.kind === "file" && !lstatSync(absolute).isFile())
		throw new Error("Expected file target");
	visit(absolute, target.kind === "file" ? target.value : "", 0);
	return { ...target, files, excluded: skipped, hash: digest(JSON.stringify({ files, skipped })) };
}
