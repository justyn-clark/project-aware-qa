/**
 * Elixir / Phoenix deep adapter.
 *
 * Parses the Phoenix surface area the same way the Node adapter parses React Router/NestJS,
 * emitting the shared DetectionBundle so the language-agnostic inference (entity-correlated
 * CRUD flows, risk, reports) works unchanged:
 *  - router.ex  → routes (live) + endpoints (verbs + `resources` expansion), with nested
 *                 `scope` prefixes and `pipe_through` auth/admin awareness
 *  - *_controller.ex → handler/action files (endpoint evidence)
 *  - Ecto schemas/changesets → DTOs (fields + cast allow-list)
 *  - HEEx/EEx `<.form>` / `<form>` → forms (field names)
 *  - Cachex / ETS / persistent_term → cache signals
 *  - *_test.exs → tests
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
import type { HttpMethod, StackInfo } from "../types.js";
import type { StackAdapter, StackMatch, StackScan } from "./types.js";

const AUTH_PIPELINES = /auth|require_|ensure_|logged_in|admin|protect/i;

function inDir(rootRel: string, path: string): boolean {
	return rootRel === "" ? true : path === rootRel || path.startsWith(`${rootRel}/`);
}

function joinPath(prefix: string, sub: string): string {
	const a = prefix.replace(/\/+$/, "");
	const b = sub.startsWith("/") ? sub : `/${sub}`;
	return `${a}${b}`.replace(/\/+/g, "/").replace(/(.)\/$/, "$1") || "/";
}

function shortModule(expr: string): string {
	const parts = expr.split(".");
	return parts[parts.length - 1] ?? expr;
}

function countToken(line: string, token: "do" | "end"): number {
	// `do` as a block opener (not the `do:` keyword form); `end` as a block closer.
	const re = token === "do" ? /\bdo\b(?!:)/g : /\bend\b/g;
	return (line.match(re) ?? []).length;
}

interface Frame {
	prefix: string;
	pipelines: string[];
	depth: number;
}

const REST_ACTIONS: Array<{ action: string; method: HttpMethod; suffix: string }> = [
	{ action: "index", method: "GET", suffix: "" },
	{ action: "new", method: "GET", suffix: "/new" },
	{ action: "create", method: "POST", suffix: "" },
	{ action: "show", method: "GET", suffix: "/:id" },
	{ action: "edit", method: "GET", suffix: "/:id/edit" },
	{ action: "update", method: "PATCH", suffix: "/:id" },
	{ action: "delete", method: "DELETE", suffix: "/:id" },
];

export function parseRouter(
	file: string,
	content: string,
	controllerFiles: Map<string, string>,
): {
	routes: RouteInfo[];
	endpoints: EndpointInfo[];
} {
	const routes: RouteInfo[] = [];
	const endpoints: EndpointInfo[] = [];
	const stack: Frame[] = [];
	let depth = 0;
	let pending: Omit<Frame, "depth"> | null = null;
	const cur = (): Omit<Frame, "depth"> =>
		stack.length ? (stack[stack.length - 1] as Frame) : { prefix: "", pipelines: [] };

	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = (lines[i] ?? "").replace(/#.*$/, "").trim();
		if (!line) continue;
		const frame = cur();
		const isAdmin = (p: string) => /(^|\/)admin(\/|$)/.test(p);
		const authGated = frame.pipelines.some((p) => AUTH_PIPELINES.test(p));

		// pipe_through :a  |  pipe_through [:a, :b]
		const pt = /^pipe_through\s+(?:\[([^\]]*)\]|:([a-z0-9_]+))/.exec(line);
		if (pt) {
			const names = (pt[1] ?? pt[2] ?? "")
				.split(",")
				.map((s) => s.replace(/[:\s]/g, ""))
				.filter(Boolean);
			if (stack.length) (stack[stack.length - 1] as Frame).pipelines.push(...names);
		}

		// verb "path", Controller, :action
		const verb =
			/^(get|post|put|patch|delete)\s+"([^"]*)"\s*,\s*([A-Za-z0-9_.]+)\s*,\s*:([a-z0-9_]+)/.exec(
				line,
			);
		if (verb) {
			const method = (verb[1] as string).toUpperCase() as HttpMethod;
			const path = joinPath(frame.prefix, verb[2] ?? "");
			const controller = shortModule(verb[3] ?? "");
			const action = verb[4] ?? "handler";
			endpoints.push({
				method,
				path,
				controller,
				controllerPrefix: frame.prefix,
				handler: action,
				file: controllerFiles.get(controller) ?? file,
				line: i + 1,
				entity:
					entityFromControllerPrefix(controller.replace(/Controller$/, "")) ??
					entityFromSegments(path.split("/")),
				isAdmin: isAdmin(path) || authGated,
				isMutation: method !== "GET",
			});
		}

		// resources "path", Controller [, only:/except: [...]]
		const res =
			/^resources\s+"([^"]*)"\s*,\s*([A-Za-z0-9_.]+)(?:\s*,\s*(only|except):\s*\[([^\]]*)\])?/.exec(
				line,
			);
		if (res) {
			const base = joinPath(frame.prefix, res[1] ?? "");
			const controller = shortModule(res[2] ?? "");
			const filter = res[3];
			const list = (res[4] ?? "")
				.split(",")
				.map((s) => s.replace(/[:\s]/g, ""))
				.filter(Boolean);
			const entity =
				entityFromControllerPrefix(controller.replace(/Controller$/, "")) ??
				entityFromSegments(base.split("/"));
			for (const r of REST_ACTIONS) {
				if (filter === "only" && !list.includes(r.action)) continue;
				if (filter === "except" && list.includes(r.action)) continue;
				endpoints.push({
					method: r.method,
					path: joinPath(base, r.suffix),
					controller,
					controllerPrefix: base,
					handler: r.action,
					file: controllerFiles.get(controller) ?? file,
					line: i + 1,
					entity,
					isAdmin: isAdmin(base) || authGated,
					isMutation: r.method !== "GET",
				});
			}
		}

		// live "path", Module [, :action]
		const live = /^live\s+"([^"]*)"\s*,\s*([A-Za-z0-9_.]+)(?:\s*,\s*:([a-z0-9_]+))?/.exec(line);
		if (live) {
			const path = joinPath(frame.prefix, live[1] ?? "");
			const params = [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1] as string);
			routes.push({
				routePath: path,
				file,
				kind: "phoenix-live",
				isAdmin: isAdmin(path) || authGated,
				isIndex: (live[3] ?? "") === "index",
				isLayout: false,
				hasLoader: true, // LiveView mount/render
				hasAction: true, // handle_event
				params,
				entity: entityFromSegments(path.split("/")),
			});
		}

		// browser GET routes are also navigable pages.
		if (verb && verb[1] === "get") {
			const path = joinPath(frame.prefix, verb[2] ?? "");
			routes.push({
				routePath: path,
				file,
				kind: "phoenix-router",
				isAdmin: isAdmin(path) || authGated,
				isIndex: false,
				isLayout: false,
				hasLoader: false,
				hasAction: false,
				params: [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1] as string),
				entity: entityFromSegments(path.split("/")),
			});
		}

		// Block bookkeeping. scope/live_session contribute a prefix frame on their `do`.
		const scope =
			/^scope\s+"([^"]*)"/.exec(line) ?? /^scope\s+[A-Za-z0-9_.]+\s*,\s*"([^"]*)"/.exec(line);
		if (line.startsWith("scope")) {
			pending = {
				prefix: joinPath(frame.prefix, scope?.[1] ?? ""),
				pipelines: [...frame.pipelines],
			};
		} else if (line.startsWith("live_session")) {
			pending = { prefix: frame.prefix, pipelines: [...frame.pipelines] };
		}

		for (let o = 0; o < countToken(line, "do"); o++) {
			depth++;
			if (pending) {
				stack.push({ ...pending, depth });
				pending = null;
			}
		}
		for (let c = 0; c < countToken(line, "end"); c++) {
			while (stack.length && (stack[stack.length - 1] as Frame).depth === depth) stack.pop();
			depth--;
		}
	}
	return { routes, endpoints };
}

function detectControllers(repo: RepoFiles, rootRel: string): Map<string, string> {
	const map = new Map<string, string>();
	for (const f of repo.files) {
		if (!f.path.endsWith("_controller.ex") || !inDir(rootRel, f.path)) continue;
		const content = readFileCached(f.abs);
		if (!content) continue;
		const m = /defmodule\s+[A-Za-z0-9_.]*?([A-Za-z0-9_]+Controller)\b/.exec(content);
		if (m?.[1]) map.set(m[1], f.path);
	}
	return map;
}

function detectSchemas(repo: RepoFiles, rootRel: string): DtoInfo[] {
	const dtos: DtoInfo[] = [];
	for (const f of repo.files) {
		if (!f.path.endsWith(".ex") || !inDir(rootRel, f.path)) continue;
		const content = readFileCached(f.abs);
		if (!content || !/use\s+Ecto\.Schema|\bschema\s+"/.test(content)) continue;
		const moduleM = /defmodule\s+([A-Za-z0-9_.]+)\s+do/.exec(content);
		const tableM = /\bschema\s+"([^"]+)"/.exec(content);
		const name = tableM?.[1] ?? (moduleM ? shortModule(moduleM[1] as string) : f.path);
		const fields = new Set<string>();
		for (const m of grepContent(f.path, content, /\bfield\s+:([a-z0-9_]+)/)) {
			if (m.groups[0]) fields.add(m.groups[0]);
		}
		for (const m of grepContent(
			f.path,
			content,
			/\b(?:belongs_to|has_many|has_one)\s+:([a-z0-9_]+)/,
		)) {
			if (m.groups[0]) fields.add(m.groups[0]);
		}
		// changeset cast allow-list is the closest analogue to a DTO's accepted fields.
		const cast = /\bcast\(\s*[a-z_]+\s*,\s*\[([^\]]*)\]/.exec(content);
		const castFields = new Set(
			(cast?.[1] ?? "")
				.split(",")
				.map((s) => s.replace(/[:\s]/g, ""))
				.filter(Boolean),
		);
		const allFields = castFields.size > 0 ? castFields : fields;
		dtos.push({
			name,
			file: f.path,
			fields: [...allFields].map((fn) => ({
				name: fn,
				validators: [],
				optional: !castFields.has(fn),
			})),
		});
	}
	return dtos;
}

function detectPhoenixForms(repo: RepoFiles, rootRel: string): FormInfo[] {
	const forms: FormInfo[] = [];
	for (const f of repo.files) {
		if (!/\.(heex|eex|ex)$/.test(f.path) || !inDir(rootRel, f.path)) continue;
		const content = readFileCached(f.abs);
		if (!content || !/<\.form\b|<form\b|simple_form/.test(content)) continue;
		const fields = new Set<string>();
		for (const m of grepContent(f.path, content, /@?\bform\[:([a-z0-9_]+)\]/)) {
			if (m.groups[0]) fields.add(m.groups[0]);
		}
		for (const m of grepContent(f.path, content, /\bfield=\{[^}]*:([a-z0-9_]+)\}/)) {
			if (m.groups[0]) fields.add(m.groups[0]);
		}
		for (const m of grepContent(f.path, content, /\bname="(?:[a-z0-9_]+\[)?([a-z0-9_]+)\]?"/)) {
			if (m.groups[0]) fields.add(m.groups[0]);
		}
		if (fields.size === 0) continue;
		const line = grepContent(f.path, content, /<\.form\b|<form\b|simple_form/)[0]?.line ?? 1;
		forms.push({
			file: f.path,
			line,
			method: "post",
			kind: "html-form",
			fields: [...fields].sort(),
			entity: entityFromSegments(f.path.split(/[/.]/)),
		});
	}
	return forms;
}

function detectPhoenixCache(repo: RepoFiles, rootRel: string): CacheSignal[] {
	const signals: CacheSignal[] = [];
	for (const f of repo.files) {
		if (!f.path.endsWith(".ex") || !inDir(rootRel, f.path)) continue;
		const content = readFileCached(f.abs);
		if (!content || !/Cachex|:persistent_term|:ets|Cache\b/.test(content)) continue;
		const entity = entityFromSegments(f.path.split(/[/.]/));
		for (const m of grepContent(f.path, content, /\bCachex\.(get|fetch)\b/)) {
			signals.push({
				kind: "query",
				library: "cachex",
				detail: "Cachex.get",
				file: f.path,
				line: m.line,
				entity,
			});
		}
		for (const m of grepContent(f.path, content, /\bCachex\.(put|del|clear)\b/)) {
			const k =
				(m.text.match(/Cachex\.(put|del|clear)/)?.[1] ?? "put") === "put"
					? "backend-cache"
					: "cache-clear";
			signals.push({
				kind: k,
				library: "cachex",
				detail: m.text.slice(0, 60),
				file: f.path,
				line: m.line,
				entity,
			});
		}
		for (const m of grepContent(f.path, content, /:persistent_term\.(get|put|erase)/)) {
			signals.push({
				kind: "backend-cache",
				library: "persistent_term",
				detail: m.text.slice(0, 60),
				file: f.path,
				line: m.line,
				entity,
			});
		}
	}
	return signals;
}

function detectExUnit(repo: RepoFiles, rootRel: string): TestInfo[] {
	const tests: TestInfo[] = [];
	for (const f of repo.files) {
		if (!f.path.endsWith("_test.exs") || !inDir(rootRel, f.path)) continue;
		const content = readFileCached(f.abs) ?? "";
		const targets = new Set<string>();
		const base = f.path.split("/").pop() ?? f.path;
		for (const w of base.replace(/_test\.exs$/, "").split(/[^a-z0-9]+/i))
			if (w) targets.add(w.toLowerCase());
		const modM = /describe\s+"([^"]+)"/.exec(content);
		if (modM?.[1])
			for (const w of modM[1].split(/[^a-z0-9]+/i)) if (w) targets.add(w.toLowerCase());
		tests.push({
			file: f.path,
			kind: /(^|\/)test\/.*(feature|integration|e2e|_web)/.test(f.path) ? "e2e" : "unit",
			runner: "unknown",
			targets: [...targets],
		});
	}
	return tests;
}

function isPhoenixMix(content: string | null): boolean {
	return !!content && /\{:phoenix\b/.test(content);
}

export const phoenixAdapter: StackAdapter = {
	id: "phoenix",
	name: "Elixir / Phoenix",
	kind: "deep",
	extensions: [".ex", ".exs", ".heex", ".eex"],
	markers: ["mix.exs"],

	detect(repo: RepoFiles): StackMatch[] {
		const matches: StackMatch[] = [];
		for (const f of repo.files) {
			if (!(f.path === "mix.exs" || f.path.endsWith("/mix.exs"))) continue;
			if (!isPhoenixMix(readFileCached(f.abs))) continue;
			const dir = f.path === "mix.exs" ? "" : f.path.slice(0, -"/mix.exs".length);
			matches.push({ adapter: "phoenix", rootRel: dir, label: "Elixir / Phoenix", confidence: 85 });
		}
		return matches;
	},

	scan(repo: RepoFiles, match: StackMatch): StackScan {
		const rootRel = match.rootRel;
		const mixPath = rootRel ? `${rootRel}/mix.exs` : "mix.exs";
		const mix = repo.files.find((f) => f.path === mixPath);
		const mixContent = mix ? (readFileCached(mix.abs) ?? "") : "";
		const frameworks = ["elixir", "phoenix"];
		if (/\{:phoenix_live_view\b/.test(mixContent)) frameworks.push("liveview");
		if (/\{:ecto\b|\{:ecto_sql\b/.test(mixContent)) frameworks.push("ecto");

		const controllerFiles = detectControllers(repo, rootRel);
		const routerFiles = repo.files.filter(
			(f) => f.path.endsWith("router.ex") && inDir(rootRel, f.path),
		);
		const routes: RouteInfo[] = [];
		const endpoints: EndpointInfo[] = [];
		for (const rf of routerFiles) {
			const content = readFileCached(rf.abs);
			if (!content) continue;
			const parsed = parseRouter(rf.path, content, controllerFiles);
			routes.push(...parsed.routes);
			endpoints.push(...parsed.endpoints);
		}

		const bundle: DetectionBundle = {
			routes,
			endpoints,
			dtos: detectSchemas(repo, rootRel),
			forms: detectPhoenixForms(repo, rootRel),
			cacheSignals: detectPhoenixCache(repo, rootRel),
			tests: detectExUnit(repo, rootRel),
		};

		const stack: StackInfo = {
			adapter: "phoenix",
			label: "Elixir / Phoenix",
			language: "elixir",
			rootRel,
			packageManager: "mix",
			frameworks,
			scripts: {},
			checks: {
				build: { command: "mix compile --warnings-as-errors", cwd: rootRel },
				test: { command: "mix test", cwd: rootRel },
				lint: { command: "mix format --check-formatted", cwd: rootRel },
				dev: { command: "mix phx.server", cwd: rootRel },
			},
			testRunners: ["exunit"],
			depth: "deep",
		};
		return { stack, bundle, extraSurfaces: [] };
	},
};
