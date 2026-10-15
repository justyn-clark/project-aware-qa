/**
 * File discovery + lightweight content scanning.
 *
 * Zero external dependencies: a small recursive walker with sane ignore rules plus
 * helpers for reading files and grepping for patterns with line numbers. Detectors
 * are built on top of these primitives.
 */
import { type Dirent, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

const DEFAULT_IGNORES = new Set([
	"node_modules",
	".terraform",
	".wrangler",
	".aws-sam",
	"cdk.out",
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
	"venv",
	"tmp",
	".react-router",
	// non-JS ecosystems
	"deps", // Elixir
	"_build", // Elixir
	"target", // Rust / JVM
	"obj", // .NET
	"Pods", // CocoaPods
	"zig-cache",
	"zig-out",
	".godot",
	".mix",
]);

// Broad, multi-language source set - adapters filter this down to their own extensions.
const CODE_EXTENSIONS = new Set([
	// JS/TS + web
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".vue",
	".svelte",
	".astro",
	".html",
	// Elixir / Phoenix
	".ex",
	".exs",
	".heex",
	".eex",
	".leex",
	// Python
	".py",
	".pyi",
	// Ruby
	".rb",
	".erb",
	".rake",
	// Go
	".go",
	// Rust / Zig / Odin / Swift
	".rs",
	".zig",
	".odin",
	".swift",
	// JVM
	".java",
	".kt",
	".kts",
	".scala",
	".groovy",
	// .NET
	".cs",
	".razor",
	".cshtml",
	".fs",
	// C / C++
	".c",
	".h",
	".cc",
	".cpp",
	".cxx",
	".hpp",
	".hh",
	// PHP
	".php",
	// Game / other
	".gd",
]);

// Build-file / marker basenames that indicate a stack and are worth reading.
const MARKER_FILES = new Set([
	"bunfig.toml",
	"bun.lock",
	"bun.lockb",
	"wrangler.json",
	"wrangler.jsonc",
	"wrangler.toml",
	"cdk.json",
	"samconfig.toml",
	"serverless.yml",
	"serverless.yaml",
	"template.yaml",
	"template.yml",
	"host.json",
	"azure.yaml",
	"app.yaml",
	"cloudbuild.yaml",
	"Pulumi.yaml",
	"package.json",
	"tsconfig.json",
	"nest-cli.json",
	"deno.json",
	"deno.jsonc",
	"mix.exs",
	"mix.lock",
	"go.mod",
	"go.work",
	"Cargo.toml",
	"build.zig",
	"build.zig.zon",
	"pyproject.toml",
	"setup.py",
	"setup.cfg",
	"requirements.txt",
	"Pipfile",
	"poetry.lock",
	"Gemfile",
	"Rakefile",
	"pom.xml",
	"build.gradle",
	"build.gradle.kts",
	"settings.gradle",
	"composer.json",
	"CMakeLists.txt",
	"Makefile",
	"makefile",
	"meson.build",
	"project.godot",
]);
const MARKER_SUFFIXES = [".tf", ".bicep", ".csproj", ".fsproj", ".sln", ".gemspec"];
const CONFIG_PREFIXES = [
	"playwright.config.",
	"vite.config.",
	"react-router.config.",
	"remix.config.",
];

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
	/** Discovery was capped or an input could not be inspected safely. */
	truncated: boolean;
	/** Bounded diagnostics explaining incomplete discovery; never includes file contents. */
	issues?: string[];
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
	const issues: string[] = [];
	const note = (message: string) => {
		truncated = true;
		if (issues.length < 20 && !issues.includes(message)) issues.push(message);
	};
	let canonicalRoot: string;
	try {
		canonicalRoot = realpathSync(root);
	} catch {
		return {
			root,
			files,
			totalSeen: false,
			truncated: true,
			issues: ["Cannot resolve scan root"],
		};
	}
	const inside = (path: string): boolean => {
		const rel = relative(canonicalRoot, path);
		return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
	};
	const display = (path: string): string => toPosix(relative(root, path)) || ".";

	const stack: Array<{ dir: string; ancestors: Set<string> }> = [
		{ dir: root, ancestors: new Set() },
	];
	while (stack.length > 0) {
		const { dir, ancestors } = stack.pop() as (typeof stack)[number];
		let entries: Dirent<string>[];
		let actual: string;
		try {
			actual = realpathSync(dir);
			if (!inside(actual)) {
				note(`Directory symlink leaves the project root: ${display(dir)}`);
				continue;
			}
			if (ancestors.has(actual)) {
				note(`Directory symlink cycle skipped: ${display(dir)}`);
				continue;
			}
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			note(`Cannot read input directory: ${display(dir)}`);
			continue;
		}
		const childAncestors = new Set([...ancestors, actual]);
		for (const entry of entries) {
			if (entry.name.startsWith(".") && entry.name !== ".env") {
				// Skip dotfiles/dirs except a few we care about; .env handled elsewhere.
				if (entry.isDirectory()) continue;
			}
			const abs = join(dir, entry.name);
			let isDir = entry.isDirectory();
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				if (ignore.has(entry.name)) continue;
				try {
					if (!inside(realpathSync(abs))) {
						note(`Input symlink leaves the project root: ${display(abs)}`);
						continue;
					}
					const st = statSync(abs);
					isDir = st.isDirectory();
					isFile = st.isFile();
				} catch {
					note(`Cannot inspect input symlink: ${display(abs)}`);
					continue;
				}
			}
			if (isDir) {
				if (ignore.has(entry.name) || entry.name.startsWith(".")) continue;
				stack.push({ dir: abs, ancestors: childAncestors });
				continue;
			}
			if (!isFile) continue;
			const ext = extname(entry.name);
			if (!CODE_EXTENSIONS.has(ext) && !isInterestingNonCode(entry.name)) continue;
			let size = 0;
			try {
				size = statSync(abs).size;
			} catch {
				note(`Cannot inspect input file: ${display(abs)}`);
				continue;
			}
			files.push({ path: toPosix(relative(root, abs)), abs, ext, size });
			if (files.length >= maxFiles) {
				note(`Discovery reached ${maxFiles} files; increase maxFiles or reduce the project scope`);
				stack.length = 0;
				break;
			}
		}
	}

	files.sort((a, b) => a.path.localeCompare(b.path));
	return { root, files, totalSeen: true, truncated, ...(issues.length ? { issues } : {}) };
}

function isInterestingNonCode(name: string): boolean {
	if (MARKER_FILES.has(name)) return true;
	if (MARKER_SUFFIXES.some((s) => name.endsWith(s))) return true;
	if (CONFIG_PREFIXES.some((p) => name.startsWith(p))) return true;
	return false;
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

/** Build sorted offsets of each line start, for O(log n) index->line lookup. */
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
