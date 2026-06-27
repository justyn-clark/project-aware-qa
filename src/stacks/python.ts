/**
 * Python deep adapter — FastAPI, Flask, and Django.
 *
 * Emits the shared DetectionBundle so the language-agnostic inference works unchanged:
 *  - FastAPI/Flask: decorator routes (`@router.get("/{id}")`, `@app.route(..., methods=…)`)
 *    with APIRouter/Blueprint prefixes and Pydantic body types
 *  - Django: `urls.py` `path(...)`, DRF `router.register` (REST expansion), and
 *    `@admin.register` / `admin.site.register` (admin CRUD per model)
 *  - DTOs: Pydantic `BaseModel`, DRF serializers, Django `Form`/`ModelForm` and models
 *  - Forms: `<form>` in Django/Jinja templates
 *  - Cache: django cache framework, `@cache_page`, `lru_cache`
 *  - Tests: `test_*.py` / `*_test.py`
 *
 * Plain Python with no web framework falls through to the generic adapter.
 */
import { entityFromControllerPrefix, entityFromSegments } from "../detectors/entities.js";
import type {
	CacheSignal,
	DetectionBundle,
	DtoInfo,
	EndpointInfo,
	FormInfo,
	RouteInfo,
	TestInfo,
} from "../detectors/types.js";
import { grepContent, type RepoFiles, readFileCached } from "../scanner/files.js";
import type { HttpMethod, StackChecks, StackInfo } from "../types.js";
import type { StackAdapter, StackMatch, StackScan } from "./types.js";

type PyFramework = "fastapi" | "flask" | "django";

function inDir(rootRel: string, path: string): boolean {
	return rootRel === "" ? true : path === rootRel || path.startsWith(`${rootRel}/`);
}
function join(prefix: string, sub: string): string {
	const a = prefix.replace(/\/+$/, "");
	const b = sub === "" ? "" : sub.startsWith("/") ? sub : `/${sub}`;
	return `${a}${b}`.replace(/\/+/g, "/").replace(/(.)\/$/, "$1") || "/";
}
/** FastAPI/Flask `{id}` and Django/regex params → our `:id` convention. */
function normParams(path: string): string {
	return path
		.replace(/\{([A-Za-z0-9_]+)(?::[^}]+)?\}/g, ":$1")
		.replace(/<(?:[^:>]+:)?([A-Za-z0-9_]+)>/g, ":$1");
}
function shortName(expr: string): string {
	const parts = expr.replace(/\.as_view\(\)$/, "").split(".");
	return parts[parts.length - 1] ?? expr;
}

// --------------------------------------------------------------------------- DTOs

function detectPyDtos(repo: RepoFiles, rootRel: string): DtoInfo[] {
	const dtos: DtoInfo[] = [];
	for (const f of repo.files) {
		if (f.ext !== ".py" || !inDir(rootRel, f.path)) continue;
		const content = readFileCached(f.abs);
		if (!content) continue;
		if (!/\b(BaseModel|serializers\.|forms\.(Form|ModelForm)|models\.Model)\b/.test(content))
			continue;
		const lines = content.split("\n");
		let current: { name: string; indent: number; fields: Set<string>; kind: string } | null = null;
		const flush = () => {
			if (current && current.fields.size > 0) {
				dtos.push({
					name: current.name,
					file: f.path,
					fields: [...current.fields].map((n) => ({ name: n, validators: [], optional: false })),
				});
			}
			current = null;
		};
		for (const raw of lines) {
			const classM = /^(\s*)class\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)\s*:/.exec(raw);
			if (classM) {
				flush();
				const bases = classM[3] ?? "";
				if (
					/BaseModel|Schema|serializers\.|forms\.(Form|ModelForm)|Form\b|models\.Model/.test(bases)
				) {
					current = {
						name: classM[2] as string,
						indent: (classM[1] ?? "").length,
						fields: new Set(),
						kind: bases,
					};
				}
				continue;
			}
			if (!current) continue;
			const indent = (/^(\s*)/.exec(raw)?.[1] ?? "").length;
			if (raw.trim() && indent <= current.indent) {
				flush();
				continue;
			}
			// Pydantic annotated field:  name: type[= default]
			const ann = /^\s+([a-z_][A-Za-z0-9_]*)\s*:\s*[^=\n]+/.exec(raw);
			if (ann && !raw.includes("def ") && (ann[1] ?? "") !== "model_config")
				current.fields.add(ann[1] as string);
			// DRF / Django field:  name = serializers.X() | models.X() | forms.X()
			const assign = /^\s+([a-z_][A-Za-z0-9_]*)\s*=\s*(?:serializers|models|forms)\./.exec(raw);
			if (assign) current.fields.add(assign[1] as string);
			// DRF Meta.fields = ["a", "b"]
			const meta = /\bfields\s*=\s*[([]([^\])]*)[)\]]/.exec(raw);
			if (meta)
				for (const fn of (meta[1] ?? "").split(",").map((s) => s.replace(/['"\s]/g, "")))
					if (fn && fn !== "__all__") current.fields.add(fn);
		}
		flush();
	}
	return dtos;
}

function knownModelNames(dtos: DtoInfo[]): Set<string> {
	return new Set(dtos.map((d) => d.name));
}

// --------------------------------------------------------------------------- FastAPI / Flask routes

export function parsePyDecoratorRoutes(
	file: string,
	content: string,
	models: Set<string>,
): EndpointInfo[] {
	const endpoints: EndpointInfo[] = [];
	const prefixes = new Map<string, string>();
	for (const m of content.matchAll(/([A-Za-z0-9_]+)\s*=\s*APIRouter\(([^)]*)\)/g)) {
		prefixes.set(m[1] as string, /prefix\s*=\s*["']([^"']*)["']/.exec(m[2] ?? "")?.[1] ?? "");
	}
	for (const m of content.matchAll(/([A-Za-z0-9_]+)\s*=\s*Blueprint\(([^)]*)\)/g)) {
		prefixes.set(m[1] as string, /url_prefix\s*=\s*["']([^"']*)["']/.exec(m[2] ?? "")?.[1] ?? "");
	}
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = (lines[i] ?? "").trim();
		const dec =
			/^@([A-Za-z0-9_]+)\.(get|post|put|patch|delete|route)\(\s*["']([^"']*)["']([^)]*)\)/.exec(
				line,
			);
		if (!dec) continue;
		const varName = dec[1] as string;
		const verb = dec[2] as string;
		const sub = dec[3] ?? "";
		const rest = dec[4] ?? "";
		let methods: HttpMethod[];
		if (verb === "route") {
			const mm = /methods\s*=\s*\[([^\]]*)\]/.exec(rest);
			methods = mm
				? ((mm[1] ?? "")
						.split(",")
						.map((s) => s.replace(/['"\s]/g, "").toUpperCase())
						.filter(Boolean) as HttpMethod[])
				: ["GET"];
		} else {
			methods = [verb.toUpperCase() as HttpMethod];
		}
		// Function signature (may span lines): capture name + param block.
		const blob = lines.slice(i + 1, i + 10).join("\n");
		const sig = /(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*\(([\s\S]*?)\)\s*(?:->|:)/.exec(blob);
		const handler = sig?.[1] ?? "handler";
		const params = sig?.[2] ?? "";
		const bodyDto = [...params.matchAll(/:\s*([A-Z][A-Za-z0-9_]*)/g)]
			.map((m) => m[1] as string)
			.find((n) => models.has(n));
		const prefix = prefixes.get(varName) ?? "";
		const path = normParams(join(prefix, sub));
		const entity = entityFromSegments(path.split("/")) ?? entityFromControllerPrefix(handler);
		for (const method of methods) {
			endpoints.push({
				method,
				path,
				controller: varName,
				controllerPrefix: prefix,
				handler,
				file,
				line: i + 1,
				entity,
				bodyDto,
				isAdmin: /(^|\/)admin(\/|$)/.test(path),
				isMutation: method !== "GET",
			});
		}
	}
	return endpoints;
}

// --------------------------------------------------------------------------- Django

const REST = [
	{ action: "list", method: "GET" as HttpMethod, suffix: "" },
	{ action: "create", method: "POST" as HttpMethod, suffix: "" },
	{ action: "retrieve", method: "GET" as HttpMethod, suffix: "/:id" },
	{ action: "update", method: "PUT" as HttpMethod, suffix: "/:id" },
	{ action: "destroy", method: "DELETE" as HttpMethod, suffix: "/:id" },
];

export function parseDjangoUrls(
	file: string,
	content: string,
): { routes: RouteInfo[]; endpoints: EndpointInfo[] } {
	const routes: RouteInfo[] = [];
	const endpoints: EndpointInfo[] = [];
	// path("route/", view) and re_path(r"^route$", view)
	for (const m of content.matchAll(
		/\b(?:path|re_path|url)\(\s*r?["']([^"']*)["']\s*,\s*([A-Za-z0-9_.]+(?:\.as_view\(\))?)/g,
	)) {
		const raw = (m[1] ?? "").replace(/^\^/, "").replace(/\$$/, "");
		const view = shortName(m[2] ?? "view");
		// Skip admin mounts, messy regex paths, and nested urlconfs (`include(...)`).
		if (/^admin\b/.test(raw) || raw.includes("(") || view === "include") continue;
		const path = normParams(`/${raw}`);
		const entity = entityFromSegments(path.split("/")) ?? entityFromControllerPrefix(view);
		routes.push({
			routePath: path,
			file,
			kind: "django-url",
			isAdmin: /(^|\/)admin(\/|$)/.test(path),
			isIndex: path === "/",
			isLayout: false,
			hasLoader: true,
			hasAction: false,
			params: [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((x) => x[1] as string),
			entity,
		});
		endpoints.push({
			method: "GET",
			path,
			controller: view,
			controllerPrefix: "",
			handler: view,
			file,
			line: 1,
			entity,
			isAdmin: /(^|\/)admin(\/|$)/.test(path),
			isMutation: false,
		});
	}
	// DRF: router.register("users", UserViewSet)
	for (const m of content.matchAll(
		/\brouter\.register\(\s*r?["']([^"']+)["']\s*,\s*([A-Za-z0-9_]+)/g,
	)) {
		const base = normParams(`/${(m[1] ?? "").replace(/\/$/, "")}`);
		const view = m[2] as string;
		const entity = entityFromSegments(base.split("/")) ?? entityFromControllerPrefix(view);
		for (const r of REST) {
			endpoints.push({
				method: r.method,
				path: join(base, r.suffix),
				controller: view,
				controllerPrefix: base,
				handler: r.action,
				file,
				line: 1,
				entity,
				isAdmin: /(^|\/)admin(\/|$)/.test(base),
				isMutation: r.method !== "GET",
			});
		}
	}
	return { routes, endpoints };
}

function detectDjangoAdmin(repo: RepoFiles, rootRel: string): EndpointInfo[] {
	const endpoints: EndpointInfo[] = [];
	const models = new Set<string>();
	for (const f of repo.files) {
		if (f.ext !== ".py" || !inDir(rootRel, f.path) || !/admin/.test(f.path)) continue;
		const content = readFileCached(f.abs);
		if (!content) continue;
		for (const m of grepContent(f.path, content, /@admin\.register\(\s*([A-Za-z0-9_,\s]+)\)/)) {
			for (const name of (m.groups[0] ?? "")
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean))
				models.add(name);
		}
		for (const m of grepContent(f.path, content, /admin\.site\.register\(\s*([A-Za-z0-9_]+)/)) {
			if (m.groups[0]) models.add(m.groups[0]);
		}
	}
	for (const model of models) {
		const entity = entityFromControllerPrefix(model);
		const slug = model.toLowerCase();
		const ops: Array<[HttpMethod, string, boolean]> = [
			["GET", `/admin/${slug}/`, false],
			["POST", `/admin/${slug}/add/`, true],
			["POST", `/admin/${slug}/:id/change/`, true],
			["POST", `/admin/${slug}/:id/delete/`, true],
		];
		for (const [method, path, mut] of ops) {
			endpoints.push({
				method,
				path,
				controller: `${model}Admin`,
				controllerPrefix: `/admin/${slug}`,
				handler:
					method === "GET" ? "changelist" : (path.split("/").filter(Boolean).pop() ?? "admin"),
				file: "django-admin",
				line: 1,
				entity,
				isAdmin: true,
				isMutation: mut,
			});
		}
	}
	return endpoints;
}

// --------------------------------------------------------------------------- forms / cache / tests

function detectPyForms(repo: RepoFiles, rootRel: string): FormInfo[] {
	const forms: FormInfo[] = [];
	for (const f of repo.files) {
		if (f.ext !== ".html" || !inDir(rootRel, f.path)) continue;
		const content = readFileCached(f.abs);
		if (!content || !/<form\b/.test(content)) continue;
		const fields = new Set<string>();
		for (const m of grepContent(f.path, content, /\bname=["']([A-Za-z0-9_]+)["']/))
			if (m.groups[0]) fields.add(m.groups[0]);
		for (const m of grepContent(f.path, content, /\{\{\s*form\.([A-Za-z0-9_]+)/))
			if (m.groups[0]) fields.add(m.groups[0]);
		if (fields.size === 0) continue;
		forms.push({
			file: f.path,
			line: grepContent(f.path, content, /<form\b/)[0]?.line ?? 1,
			method: /method=["']post["']/i.test(content) ? "post" : "get",
			kind: "html-form",
			fields: [...fields].sort(),
			entity: entityFromSegments(f.path.split(/[/.]/)),
		});
	}
	return forms;
}

function detectPyCache(repo: RepoFiles, rootRel: string): CacheSignal[] {
	const signals: CacheSignal[] = [];
	for (const f of repo.files) {
		if (f.ext !== ".py" || !inDir(rootRel, f.path)) continue;
		const content = readFileCached(f.abs);
		if (!content || !/\bcache\b|lru_cache|cache_page/.test(content)) continue;
		const entity = entityFromSegments(f.path.split(/[/.]/));
		for (const m of grepContent(f.path, content, /\bcache\.(get|set)\b|@cache_page|@?lru_cache/)) {
			signals.push({
				kind: "backend-cache",
				library: "django-cache",
				detail: m.text.slice(0, 60),
				file: f.path,
				line: m.line,
				entity,
			});
		}
		for (const m of grepContent(f.path, content, /\bcache\.(delete|clear)\b/)) {
			signals.push({
				kind: "cache-clear",
				library: "django-cache",
				detail: m.text.slice(0, 60),
				file: f.path,
				line: m.line,
				entity,
			});
		}
	}
	return signals;
}

function detectPyTests(repo: RepoFiles, rootRel: string): TestInfo[] {
	const tests: TestInfo[] = [];
	for (const f of repo.files) {
		if (f.ext !== ".py" || !inDir(rootRel, f.path)) continue;
		const base = f.path.split("/").pop() ?? f.path;
		const isTest =
			/^test_.*\.py$/.test(base) || /_test\.py$/.test(base) || /(^|\/)tests?\//.test(f.path);
		if (!isTest) continue;
		const content = readFileCached(f.abs) ?? "";
		if (!/\bdef test_|\bclass .*\(.*TestCase\)|\bimport pytest/.test(content)) continue;
		const targets = new Set<string>();
		for (const w of base.replace(/\.py$/, "").split(/[^a-z0-9]+/i))
			if (w && w !== "test") targets.add(w.toLowerCase());
		tests.push({
			file: f.path,
			kind: /\bTestCase\b|client\.(get|post)/.test(content) ? "e2e" : "unit",
			runner: /import pytest|@pytest/.test(content) ? "unknown" : "unknown",
			targets: [...targets],
		});
	}
	return tests;
}

// --------------------------------------------------------------------------- adapter

function depsText(repo: RepoFiles, rootRel: string): string {
	let text = "";
	for (const name of ["pyproject.toml", "requirements.txt", "Pipfile", "setup.py", "setup.cfg"]) {
		const p = rootRel ? `${rootRel}/${name}` : name;
		const f = repo.files.find((x) => x.path === p);
		if (f) text += `\n${readFileCached(f.abs) ?? ""}`;
	}
	return text.toLowerCase();
}

function detectFrameworks(repo: RepoFiles, rootRel: string): Set<PyFramework> {
	const fw = new Set<PyFramework>();
	const deps = depsText(repo, rootRel);
	if (/\bdjango\b/.test(deps)) fw.add("django");
	if (/\bfastapi\b/.test(deps)) fw.add("fastapi");
	if (/\bflask\b/.test(deps)) fw.add("flask");
	const hasManage = repo.files.some(
		(f) => f.path === (rootRel ? `${rootRel}/manage.py` : "manage.py"),
	);
	if (hasManage) fw.add("django");
	if (fw.size === 0) {
		// Fall back to a light source-import scan over this stack's files.
		for (const f of repo.files.slice(0, 4000)) {
			if (f.ext !== ".py" || !inDir(rootRel, f.path)) continue;
			const c = readFileCached(f.abs);
			if (!c) continue;
			if (/\bfrom fastapi\b|\bimport fastapi\b|FastAPI\(|APIRouter\(/.test(c)) fw.add("fastapi");
			if (/\bfrom flask\b|Flask\(__name__|Blueprint\(/.test(c)) fw.add("flask");
			if (/\bfrom django\b/.test(c)) fw.add("django");
			if (fw.size > 0) break;
		}
	}
	return fw;
}

function pyPackageManager(repo: RepoFiles, rootRel: string): string {
	const pyproject = repo.files.find(
		(f) => f.path === (rootRel ? `${rootRel}/pyproject.toml` : "pyproject.toml"),
	);
	if (pyproject) {
		const c = readFileCached(pyproject.abs) ?? "";
		if (/\[tool\.poetry\]/.test(c)) return "poetry";
		if (/\[tool\.pdm\]/.test(c)) return "pdm";
		if (/\[tool\.uv\]|^\s*\[tool\.uv/.test(c)) return "uv";
	}
	if (repo.files.some((f) => f.path === (rootRel ? `${rootRel}/Pipfile` : "Pipfile")))
		return "pipenv";
	return "pip";
}

const PY_MARKERS = ["pyproject.toml", "setup.py", "requirements.txt", "Pipfile", "manage.py"];

export const pythonAdapter: StackAdapter = {
	id: "python",
	name: "Python (FastAPI / Flask / Django)",
	kind: "deep",
	extensions: [".py", ".html"],
	markers: PY_MARKERS,

	detect(repo: RepoFiles): StackMatch[] {
		const dirs = new Set<string>();
		for (const f of repo.files) {
			const base = f.path.split("/").pop() ?? f.path;
			if (!PY_MARKERS.includes(base)) continue;
			dirs.add(f.path === base ? "" : f.path.slice(0, f.path.length - base.length - 1));
		}
		const label = (fw: Set<PyFramework>) =>
			fw.has("django")
				? "Python / Django"
				: fw.has("fastapi")
					? "Python / FastAPI"
					: "Python / Flask";
		const matches: StackMatch[] = [];
		for (const dir of dirs) {
			const fw = detectFrameworks(repo, dir);
			if (fw.size === 0) continue; // plain Python → generic adapter handles it
			matches.push({ adapter: "python", rootRel: dir, label: label(fw), confidence: 85 });
		}
		// No marker matched a framework (e.g. the build file lives in a parent dir): fall back
		// to a source-import scan anchored at the repo root.
		if (matches.length === 0) {
			const fw = detectFrameworks(repo, "");
			if (fw.size > 0)
				matches.push({ adapter: "python", rootRel: "", label: label(fw), confidence: 70 });
		}
		return matches;
	},

	scan(repo: RepoFiles, match: StackMatch): StackScan {
		const rootRel = match.rootRel;
		const fw = detectFrameworks(repo, rootRel);
		const dtos = detectPyDtos(repo, rootRel);
		const models = knownModelNames(dtos);

		const routes: RouteInfo[] = [];
		const endpoints: EndpointInfo[] = [];
		for (const f of repo.files) {
			if (f.ext !== ".py" || !inDir(rootRel, f.path)) continue;
			const content = readFileCached(f.abs);
			if (!content) continue;
			if (fw.has("fastapi") || fw.has("flask")) {
				if (/@[A-Za-z0-9_]+\.(get|post|put|patch|delete|route)\(/.test(content)) {
					endpoints.push(...parsePyDecoratorRoutes(f.path, content, models));
				}
			}
			if (
				fw.has("django") &&
				(f.path.endsWith("urls.py") || /\brouter\.register\(|urlpatterns\b/.test(content))
			) {
				const parsed = parseDjangoUrls(f.path, content);
				routes.push(...parsed.routes);
				endpoints.push(...parsed.endpoints);
			}
		}
		if (fw.has("django")) endpoints.push(...detectDjangoAdmin(repo, rootRel));

		const bundle: DetectionBundle = {
			routes,
			endpoints,
			dtos,
			forms: detectPyForms(repo, rootRel),
			cacheSignals: detectPyCache(repo, rootRel),
			tests: detectPyTests(repo, rootRel),
		};

		const frameworks = ["python", ...fw];
		const pm = pyPackageManager(repo, rootRel);
		const c = (command: string): { command: string; cwd: string } => ({ command, cwd: rootRel });
		const checks: StackChecks = {
			test: c("pytest -q"),
			typecheck: c("mypy ."),
			lint: c("ruff check ."),
		};
		if (fw.has("django")) checks.dev = c("python manage.py runserver");
		else if (fw.has("fastapi")) checks.dev = c("uvicorn app.main:app --reload");
		else if (fw.has("flask")) checks.dev = c("flask run");

		const stack: StackInfo = {
			adapter: "python",
			label: match.label,
			language: "python",
			rootRel,
			packageManager: pm,
			frameworks,
			scripts: {},
			checks,
			testRunners: ["pytest"],
			depth: "deep",
		};
		return { stack, bundle, extraSurfaces: [] };
	},
};
