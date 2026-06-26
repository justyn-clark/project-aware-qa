/**
 * File discovery + lightweight content scanning.
 *
 * Zero external dependencies: a small recursive walker with sane ignore rules plus
 * helpers for reading files and grepping for patterns with line numbers. Detectors
 * are built on top of these primitives.
 */
import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const DEFAULT_IGNORES = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	"out",
	".next",
	".turbo",
	".cache",
	"coverage",
	".qa",
	".pi",
	".small",
	"vendor",
	"__pycache__",
	".venv",
	"tmp",
	".react-router",
]);

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte"]);

export interface FileEntry {
	/** Repo-relative path with forward slashes. */
	path: string;
	/** Absolute path on disk. */
	abs: string;
	ext: string;
	size: number;
}

export interface ScanFsOptions {
	maxFiles?: number;
	/** Extra directory names to ignore. */
	ignoreDirs?: string[];
	/** Cap individual file reads (bytes). Larger files are skipped for content scans. */
	maxFileBytes?: number;
}

export interface RepoFiles {
	root: string;
	files: FileEntry[];
	/** Count of files seen on disk before the maxFiles cap. */
	totalSeen: boolean;
	truncated: boolean;
}

/** Normalize a path to forward slashes for stable, cross-platform reporting. */
export function toPosix(p: string): string {
	return p.split(sep).join("/");
}

/** Recursively walk a repo, returning code-relevant files with ignore rules applied. */
export function walkRepo(root: string, options: ScanFsOptions = {}): RepoFiles {
	const maxFiles = options.maxFiles ?? 20000;
	const ignore = new Set(DEFAULT_IGNORES);
	for (const d of options.ignoreDirs ?? []) ignore.add(d);

	const files: FileEntry[] = [];
	let truncated = false;

	const stack: string[] = [root];
	while (stack.length > 0) {
		const dir = stack.pop() as string;
		let entries: Dirent<string>[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".") && entry.name !== ".env") {
				// Skip dotfiles/dirs except a few we care about; .env handled elsewhere.
				if (entry.isDirectory()) continue;
			}
			const abs = join(dir, entry.name);
			let isDir = entry.isDirectory();
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					const st = statSync(abs);
					isDir = st.isDirectory();
					isFile = st.isFile();
				} catch {
					continue;
				}
			}
			if (isDir) {
				if (ignore.has(entry.name)) continue;
				stack.push(abs);
				continue;
			}
			if (!isFile) continue;
			const ext = extname(entry.name);
			if (!CODE_EXTENSIONS.has(ext) && !isInterestingNonCode(entry.name)) continue;
			let size = 0;
			try {
				size = statSync(abs).size;
			} catch {
				continue;
			}
			files.push({ path: toPosix(relative(root, abs)), abs, ext, size });
			if (files.length >= maxFiles) {
				truncated = true;
				stack.length = 0;
				break;
			}
		}
	}

	files.sort((a, b) => a.path.localeCompare(b.path));
	return { root, files, totalSeen: true, truncated };
}

function isInterestingNonCode(name: string): boolean {
	return (
		name === "package.json" ||
		name === "tsconfig.json" ||
		name.startsWith("playwright.config.") ||
		name.startsWith("vite.config.") ||
		name.startsWith("react-router.config.") ||
		name.startsWith("remix.config.") ||
		name === "nest-cli.json"
	);
}

function extname(name: string): string {
	const i = name.lastIndexOf(".");
	return i < 0 ? "" : name.slice(i).toLowerCase();
}

const fileCache = new Map<string, string | null>();

/** Read a file as UTF-8, caching results. Returns null on error or if oversized. */
export function readFileCached(abs: string, maxBytes = 1_500_000): string | null {
	if (fileCache.has(abs)) return fileCache.get(abs) ?? null;
	let content: string | null = null;
	try {
		const st = statSync(abs);
		if (st.size <= maxBytes) content = readFileSync(abs, "utf8");
	} catch {
		content = null;
	}
	fileCache.set(abs, content);
	return content;
}

export function clearFileCache(): void {
	fileCache.clear();
}

export interface GrepMatch {
	file: string;
	line: number;
	text: string;
	groups: string[];
}

/** Build sorted offsets of each line start, for O(log n) index→line lookup. */
function lineStarts(content: string): number[] {
	const starts = [0];
	for (let i = 0; i < content.length; i++) {
		if (content[i] === "\n") starts.push(i + 1);
	}
	return starts;
}

function lineAt(starts: number[], index: number): number {
	let lo = 0;
	let hi = starts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if ((starts[mid] as number) <= index) lo = mid;
		else hi = mid - 1;
	}
	return lo + 1;
}

const MAX_MATCHES_PER_GREP = 5000;

/**
 * Grep a file's full content for a regex, returning matches with accurate line numbers.
 * Always matches globally over the whole content (so multi-line `/s` patterns work) and
 * is guarded against zero-width-match infinite loops and runaway match counts.
 */
export function grepContent(file: string, content: string, re: RegExp): GrepMatch[] {
	const matches: GrepMatch[] = [];
	const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
	const global = new RegExp(re.source, flags);
	const starts = lineStarts(content);
	let m = global.exec(content);
	for (; m !== null; m = global.exec(content)) {
		const line = lineAt(starts, m.index);
		const lineStart = starts[line - 1] ?? 0;
		const lineEnd = content.indexOf("\n", lineStart);
		const lineText = content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
		matches.push({
			file,
			line,
			text: lineText.trim().slice(0, 240),
			groups: m.slice(1).map((g) => g ?? ""),
		});
		// Avoid infinite loops on zero-width matches.
		if (m.index === global.lastIndex) global.lastIndex++;
		if (matches.length >= MAX_MATCHES_PER_GREP) break;
	}
	return matches;
}

/** Filter files by a set of basename suffixes (e.g. ".controller.ts"). */
export function filesEndingWith(files: FileEntry[], ...suffixes: string[]): FileEntry[] {
	return files.filter((f) => suffixes.some((s) => f.path.endsWith(s)));
}

/** Filter files whose posix path matches any of the provided substrings/segments. */
export function filesUnder(files: FileEntry[], ...segments: string[]): FileEntry[] {
	return files.filter((f) => segments.some((s) => f.path.includes(s)));
}
