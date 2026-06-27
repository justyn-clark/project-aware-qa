/**
 * Generic, any-language fallback adapter.
 *
 * For stacks without a deep adapter (Go, Rust, Zig, Python, Ruby, Java, C#, C/C++, Godot,
 * Elixir-without-Phoenix, …) this gives a real baseline instead of "0 files / valid ✅":
 * it identifies the project type from its build file (or dominant source extension), maps
 * best-effort runnable checks (build/test/lint), counts tests, and emits a test-gap
 * surface. The verifier runs the checks (gated); no deep route/form parsing here.
 */
import { scoreRisk } from "../inference/risk.js";
import type { RepoFiles } from "../scanner/files.js";
import type { CheckCommand, StackChecks, StackInfo, Surface } from "../types.js";
import { emptyBundle, type StackAdapter, type StackMatch, type StackScan } from "./types.js";

interface LangSpec {
	id: string;
	label: string;
	language: string;
	packageManager: string;
	/** Higher wins when several markers share a directory (language manifest > build tool). */
	priority?: number;
	/** Marker basenames that anchor this stack. */
	markers: string[];
	/** Source extensions counted toward "code" for the test-gap ratio. */
	exts: string[];
	/** Test-file matcher (repo-relative path). */
	isTest: (path: string) => boolean;
	/** Build the check commands run from `rootRel`. */
	checks: (rootRel: string) => StackChecks;
}

const cwd = (rootRel: string) => rootRel;
const cmd = (command: string, rootRel: string): CheckCommand => ({ command, cwd: cwd(rootRel) });

const LANG_SPECS: LangSpec[] = [
	{
		id: "elixir",
		label: "Elixir / Mix",
		language: "elixir",
		packageManager: "mix",
		markers: ["mix.exs"],
		exts: [".ex", ".exs"],
		isTest: (p) => /_test\.exs$/.test(p),
		checks: (r) => ({
			build: cmd("mix compile --warnings-as-errors", r),
			test: cmd("mix test", r),
			lint: cmd("mix format --check-formatted", r),
		}),
	},
	{
		id: "go",
		label: "Go",
		language: "go",
		packageManager: "go",
		markers: ["go.mod"],
		exts: [".go"],
		isTest: (p) => /_test\.go$/.test(p),
		checks: (r) => ({
			build: cmd("go build ./...", r),
			test: cmd("go test ./...", r),
			lint: cmd("go vet ./...", r),
		}),
	},
	{
		id: "rust",
		label: "Rust / Cargo",
		language: "rust",
		packageManager: "cargo",
		markers: ["Cargo.toml"],
		exts: [".rs"],
		isTest: (p) => /(^|\/)tests\//.test(p) || /_test\.rs$|^test_.*\.rs$/.test(p),
		checks: (r) => ({
			build: cmd("cargo build", r),
			test: cmd("cargo test", r),
			lint: cmd("cargo clippy", r),
		}),
	},
	{
		id: "zig",
		label: "Zig",
		language: "zig",
		packageManager: "zig",
		markers: ["build.zig"],
		exts: [".zig"],
		isTest: (p) => /(^|\/)test/.test(p),
		checks: (r) => ({ build: cmd("zig build", r), test: cmd("zig build test", r) }),
	},
	{
		id: "python",
		label: "Python",
		language: "python",
		packageManager: "pip",
		markers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"],
		exts: [".py"],
		isTest: (p) => /(^|\/)tests?\//.test(p) || /(^|\/)test_[^/]*\.py$|_test\.py$/.test(p),
		checks: (r) => ({
			test: cmd("pytest -q", r),
			typecheck: cmd("mypy .", r),
			lint: cmd("ruff check .", r),
		}),
	},
	{
		id: "ruby",
		label: "Ruby",
		language: "ruby",
		packageManager: "bundler",
		markers: ["Gemfile"],
		exts: [".rb"],
		isTest: (p) => /_spec\.rb$|_test\.rb$/.test(p),
		checks: (r) => ({
			test: cmd("bundle exec rake test", r),
			lint: cmd("bundle exec rubocop", r),
		}),
	},
	{
		id: "java-maven",
		label: "Java (Maven)",
		language: "java",
		packageManager: "maven",
		markers: ["pom.xml"],
		exts: [".java", ".kt"],
		isTest: (p) => /Tests?\.java$|IT\.java$/.test(p),
		checks: (r) => ({ build: cmd("mvn -q compile", r), test: cmd("mvn -q test", r) }),
	},
	{
		id: "java-gradle",
		label: "JVM (Gradle)",
		language: "java",
		packageManager: "gradle",
		markers: ["build.gradle", "build.gradle.kts"],
		exts: [".java", ".kt", ".kts", ".scala", ".groovy"],
		isTest: (p) => /Tests?\.(java|kt)$|Spec\.(kt|scala)$/.test(p),
		checks: (r) => ({ build: cmd("./gradlew build -x test", r), test: cmd("./gradlew test", r) }),
	},
	{
		id: "dotnet",
		label: ".NET / C#",
		language: "csharp",
		packageManager: "dotnet",
		markers: [], // matched by *.csproj/*.sln suffix below
		exts: [".cs", ".fs", ".razor", ".cshtml"],
		isTest: (p) => /Tests?\.cs$/.test(p),
		checks: (r) => ({ build: cmd("dotnet build", r), test: cmd("dotnet test", r) }),
	},
	{
		id: "c-cpp",
		label: "C / C++",
		language: "c-cpp",
		packageManager: "make",
		// A Makefile is a weak signal — language manifests (mix.exs, go.mod, …) outrank it.
		priority: 30,
		markers: ["CMakeLists.txt", "Makefile", "makefile", "meson.build"],
		exts: [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh"],
		isTest: (p) =>
			/(^|\/)tests?\//.test(p) || /_test\.(c|cc|cpp|cxx)$|^test_.*\.(c|cc|cpp)$/.test(p),
		checks: (r) => ({
			build: cmd("cmake --build build", r),
			test: cmd("ctest --test-dir build", r),
		}),
	},
	{
		id: "godot",
		label: "Godot (GDScript)",
		language: "gdscript",
		packageManager: "godot",
		markers: ["project.godot"],
		exts: [".gd"],
		// GUT convention: test/unit/test_*.gd or *_test.gd anywhere.
		isTest: (p) => /(^|\/)tests?\//.test(p) || /(^|\/)test_[^/]*\.gd$|_test\.gd$/.test(p),
		checks: (r) => ({
			build: cmd("godot --headless --import", r),
			test: cmd("godot --headless -s res://addons/gut/gut_cmdln.gd -gexit", r),
		}),
	},
];

/** Detect a stack by *.suffix markers (e.g. C# project files) for dirs without a basename marker. */
function suffixLang(name: string): LangSpec | undefined {
	if (/\.(csproj|fsproj|sln)$/.test(name)) return LANG_SPECS.find((l) => l.id === "dotnet");
	if (/\.gemspec$/.test(name)) return LANG_SPECS.find((l) => l.id === "ruby");
	return undefined;
}

function dirOf(path: string): string {
	const i = path.lastIndexOf("/");
	return i < 0 ? "" : path.slice(0, i);
}
function basename(path: string): string {
	const i = path.lastIndexOf("/");
	return i < 0 ? path : path.slice(i + 1);
}
function slug(s: string): string {
	return (
		s
			.replace(/[^a-z0-9]+/gi, "-")
			.replace(/^-+|-+$/g, "")
			.toLowerCase() || "stack"
	);
}

/** Dominant source language by file extension, for repos with no recognized build file. */
function dominantByExtension(repo: RepoFiles): LangSpec | undefined {
	const counts = new Map<string, number>();
	for (const f of repo.files) counts.set(f.ext, (counts.get(f.ext) ?? 0) + 1);
	let best: { spec: LangSpec; n: number } | undefined;
	for (const spec of LANG_SPECS) {
		const n = spec.exts.reduce((sum, e) => sum + (counts.get(e) ?? 0), 0);
		if (n > 0 && (!best || n > best.n)) best = { spec, n };
	}
	// Extension-only languages without a marker manifest (Odin, Swift, …) get real checks.
	const extraLangs: Array<{
		ext: string;
		id: string;
		label: string;
		pm: string;
		checks: (r: string) => StackChecks;
	}> = [
		{
			ext: ".odin",
			id: "odin",
			label: "Odin",
			pm: "odin",
			checks: (r) => ({ build: cmd("odin build .", r), test: cmd("odin test .", r) }),
		},
		{
			ext: ".swift",
			id: "swift",
			label: "Swift",
			pm: "swift",
			checks: (r) => ({ build: cmd("swift build", r), test: cmd("swift test", r) }),
		},
		{
			ext: ".php",
			id: "php",
			label: "PHP",
			pm: "composer",
			checks: (r) => ({ test: cmd("composer test", r) }),
		},
	];
	for (const l of extraLangs) {
		const n = counts.get(l.ext) ?? 0;
		if (n > 0 && (!best || n > best.n)) {
			best = {
				spec: {
					id: l.id,
					label: l.label,
					language: l.id,
					packageManager: l.pm,
					markers: [],
					exts: [l.ext],
					isTest: (p) => /(^|\/)tests?\//.test(p) || /_test\.|test_/.test(basename(p)),
					checks: l.checks,
				},
				n,
			};
		}
	}
	return best?.spec;
}

function buildStackScan(
	repo: RepoFiles,
	spec: LangSpec,
	rootRel: string,
	label: string,
): StackScan {
	const inDir = (p: string) =>
		rootRel === "" ? true : p === rootRel || p.startsWith(`${rootRel}/`);
	const source = repo.files.filter((f) => inDir(f.path) && spec.exts.includes(f.ext));
	const tests = source.filter((f) => spec.isTest(f.path));
	const sourceCount = source.length;
	const testCount = tests.length;

	const stack: StackInfo = {
		adapter: "generic",
		label,
		language: spec.language,
		rootRel,
		packageManager: spec.packageManager,
		frameworks: [],
		scripts: {},
		checks: spec.checks(rootRel),
		testRunners: testCount > 0 ? [`${spec.language}-tests`] : [],
		depth: "generic",
	};

	const bundle = emptyBundle();
	bundle.tests = tests.map((t) => ({
		file: t.path,
		kind: "unit" as const,
		runner: "unknown" as const,
		targets: [],
	}));

	// One baseline test-gap surface per stack, risk-scaled by how thin coverage looks.
	const extraSurfaces: Surface[] = [];
	if (sourceCount > 0) {
		const ratio = testCount / sourceCount;
		const thin = testCount === 0 || ratio < 0.1;
		const risk = scoreRisk({ type: "test-gap", hasTests: testCount > 0 });
		extraSurfaces.push({
			id: `gap:${slug(spec.id)}:${slug(rootRel || "root")}`,
			type: "test-gap",
			title: `${label} test coverage${rootRel ? ` (${rootRel})` : ""}`,
			entity: undefined,
			files: [rootRel || "."],
			risk: thin ? (risk.level === "low" ? "medium" : risk.level) : "low",
			riskScore: risk.score,
			riskReasons: risk.reasons,
			inferredTests: [
				{
					kind: "unit",
					description: `Run ${spec.label} tests (${stack.checks.test?.command ?? "no test command detected"})`,
					status: testCount > 0 ? "present" : "missing",
				},
				{
					kind: "smoke",
					description: `Build/compile cleanly (${stack.checks.build?.command ?? "n/a"})`,
					status: "unknown",
				},
			],
			evidence: [
				{
					kind: "note",
					detail: `${sourceCount} ${spec.language} source files, ${testCount} test files`,
				},
			],
			gaps:
				testCount === 0
					? [`No tests detected for the ${spec.label} stack`]
					: thin
						? [`Thin test coverage: ${testCount} tests for ${sourceCount} source files`]
						: [],
		});
	}
	return { stack, bundle, extraSurfaces };
}

export const genericAdapter: StackAdapter = {
	id: "generic",
	name: "Generic (any language)",
	kind: "generic",
	extensions: [],
	markers: LANG_SPECS.flatMap((l) => l.markers),

	detect(repo: RepoFiles): StackMatch[] {
		const prio = (s: LangSpec) => s.priority ?? 80;
		const byDir = new Map<string, { spec: LangSpec; label: string }>();
		for (const f of repo.files) {
			const name = basename(f.path);
			const spec = LANG_SPECS.find((l) => l.markers.includes(name)) ?? suffixLang(name);
			if (!spec) continue;
			const dir = dirOf(f.path);
			const existing = byDir.get(dir);
			// Strongest marker in a directory wins (mix.exs over Makefile, etc.).
			if (!existing || prio(spec) > prio(existing.spec))
				byDir.set(dir, { spec, label: spec.label });
		}
		if (byDir.size === 0) {
			// No recognized build file — fall back to the dominant source language.
			const spec = dominantByExtension(repo);
			if (spec) return [{ adapter: "generic", rootRel: "", label: spec.label, confidence: 20 }];
			return [];
		}
		return [...byDir.entries()].map(([dir, { label }]) => ({
			adapter: "generic",
			rootRel: dir,
			label,
			confidence: 40,
		}));
	},

	scan(repo: RepoFiles, match: StackMatch): StackScan {
		const name = match.label;
		const spec = LANG_SPECS.find((l) => l.label === name) ?? dominantByExtension(repo);
		if (!spec) {
			// Unknown — emit a minimal stack so the report still says something honest.
			const stack: StackInfo = {
				adapter: "generic",
				label: match.label || "Unknown",
				language: "unknown",
				rootRel: match.rootRel,
				packageManager: "unknown",
				frameworks: [],
				scripts: {},
				checks: {},
				testRunners: [],
				depth: "generic",
			};
			return { stack, bundle: emptyBundle(), extraSurfaces: [] };
		}
		return buildStackScan(repo, spec, match.rootRel, match.label || spec.label);
	},
};
