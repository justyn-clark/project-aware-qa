/**
 * Route detection across React Router flavours.
 *
 * Brittleness is the known risk here (RR6 config vs RR7 framework vs Remix flat-routes),
 * so we support several strategies and tag each route with how it was found:
 *  - "remix-file": file-based routes under app/routes/** (Remix v2 / RR7 fs-routes / flat-routes)
 *  - "rr-config" : route() / index() / layout() calls in a routes config (RR7 framework mode)
 *  - "rr-jsx"    : <Route path="..."> JSX elements (RR6 declarative)
 *  - "next-app"  : Next.js app-router page.tsx files (light support)
 */
import type { RepoFiles } from "../scanner/files.js";
import { grepContent, readFileCached } from "../scanner/files.js";
import { entityFromSegments } from "./entities.js";
import type { RouteInfo } from "./types.js";

const ROUTE_FILE_RE = /\.(tsx|jsx|ts|js)$/;

function hasExport(content: string, name: string): boolean {
	const re = new RegExp(
		`export\\s+(?:async\\s+)?(?:function|const|let|var)\\s+${name}\\b|export\\s*\\{[^}]*\\b${name}\\b`,
	);
	return re.test(content);
}

function isAdminPath(routePath: string, file: string): boolean {
	return /(^|\/)admin(\/|$)/.test(routePath) || /(^|\/)admin(\/|\.)/.test(file);
}

/**
 * Reject strings that matched a route regex but cannot be real URL paths - guards against
 * picking up `path:`/`<Route>`/`route()` occurrences inside comments, regexes, or docs
 * (a real risk for codebases that *talk about* routing, including this tool itself).
 */
function isPlausibleRoutePath(p: string): boolean {
	if (!p || p.length > 120) return false;
	if (/\s/.test(p)) return false; // URL paths have no whitespace
	if (/[`{}()|\\<>[\]"']/.test(p)) return false; // code/regex metacharacters
	if (!p.startsWith("/")) return false;
	// Must contain at least one real (alphanumeric) segment, unless it is exactly "/".
	if (p !== "/" && !/[a-z0-9]/i.test(p.replace(/[:*?]/g, ""))) return false;
	return true;
}

/**
 * Convert a Remix/flat-routes file path to a URL path.
 * Handles hybrid folders + dotted flat filenames, pathless `_` segments, `$param`
 * dynamic segments, `_index`, and the `.route` suffix.
 */
export function remixFilePathToRoute(relFromRoutes: string): {
	routePath: string;
	isIndex: boolean;
	isLayout: boolean;
	params: string[];
} {
	let p = relFromRoutes.replace(ROUTE_FILE_RE, "");
	// "folder/route" (folder-as-route) -> drop trailing "route"
	p = p.replace(/\/route$/, "");
	// ".route" suffix on a flat file
	p = p.replace(/\.route$/, "");
	// Treat path separators and dots uniformly as segment separators.
	const rawSegments = p.split("/").flatMap((part) => part.split("."));
	const params: string[] = [];
	let isIndex = false;
	let isLayout = false;
	const out: string[] = [];
	for (const segRaw of rawSegments) {
		const seg = segRaw.trim();
		if (!seg) continue;
		if (seg === "route") continue;
		if (seg === "_index") {
			isIndex = true;
			continue;
		}
		// Pathless layout segments (e.g. _layout, _admin, _dashboard).
		if (seg.startsWith("_")) {
			if (/layout/i.test(seg)) isLayout = true;
			continue;
		}
		// Grouping folders (remix-flat-routes "+" suffix) contribute nothing extra.
		if (seg.endsWith("+")) {
			const base = seg.slice(0, -1);
			if (base && !base.startsWith("_")) out.push(base);
			continue;
		}
		// Opt-out-of-nesting trailing underscore: parent_.child
		const noTrailingUnderscore = seg.replace(/_$/, "");
		// Optional dynamic: ($param)
		const optional = /^\(\$?.+\)$/.test(noTrailingUnderscore);
		const inner = noTrailingUnderscore.replace(/^\(|\)$/g, "");
		if (inner.startsWith("$")) {
			const param = inner.slice(1) || "splat";
			params.push(param);
			out.push(`:${param}${optional ? "?" : ""}`);
			continue;
		}
		if (inner === "*") {
			params.push("splat");
			out.push("*");
			continue;
		}
		out.push(inner);
	}
	const routePath = `/${out.join("/")}`.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
	return { routePath, isIndex, isLayout, params };
}

const ROUTE_SUFFIX_RE = /\.route\.(tsx|jsx|ts|js)$/;
const FOLDER_ROUTE_RE = /(^|\/)route\.(tsx|jsx|ts|js)$/;
// Folders that hold colocated, non-route files in flat-routes projects.
const COLOCATED_DIR_RE =
	/\/(components?|_components|\+components|utils?|hooks?|lib|styles?|helpers?|context|store|stores|types?)\//i;

function detectRemixFileRoutes(repo: RepoFiles): RouteInfo[] {
	const routes: RouteInfo[] = [];
	const routeDirRe = /(^|\/)(app|src)\/routes\//;
	const inRoutesDir = repo.files.filter(
		(f) => ROUTE_FILE_RE.test(f.path) && routeDirRe.test(f.path),
	);
	// If the project uses the `.route.tsx` convention (or folder `route.tsx`), then plain
	// files under routes/ are colocated components, not routes - require the convention.
	const usesRouteConvention = inRoutesDir.some(
		(f) => ROUTE_SUFFIX_RE.test(f.path) || FOLDER_ROUTE_RE.test(f.path),
	);
	for (const f of inRoutesDir) {
		const m = routeDirRe.exec(f.path);
		if (!m) continue;
		const relFromRoutes = f.path.slice((m.index ?? 0) + m[0].length);
		// Skip non-route helpers commonly colocated (e.g. *.server.ts, components).
		if (/\.(server|client)\.(t|j)sx?$/.test(f.path)) continue;
		if (usesRouteConvention) {
			if (!ROUTE_SUFFIX_RE.test(f.path) && !FOLDER_ROUTE_RE.test(f.path)) continue;
		} else {
			// No explicit convention: still drop obvious colocated component dirs and
			// PascalCase component filenames (Remix routes are lowercase/dotted).
			if (COLOCATED_DIR_RE.test(`/${relFromRoutes}`)) continue;
			const base = relFromRoutes.split("/").pop() ?? "";
			if (/^[A-Z][A-Za-z0-9]*\.(t|j)sx?$/.test(base)) continue;
		}
		const { routePath, isIndex, isLayout, params } = remixFilePathToRoute(relFromRoutes);
		const content = readFileCached(f.abs) ?? "";
		const hasLoader = hasExport(content, "loader");
		const hasAction = hasExport(content, "action");
		const hasDefault = /export\s+default/.test(content);
		// A file with neither a default component nor loader/action is unlikely a route.
		if (!hasDefault && !hasLoader && !hasAction) continue;
		routes.push({
			routePath,
			file: f.path,
			kind: "remix-file",
			isAdmin: isAdminPath(routePath, f.path),
			isIndex,
			isLayout,
			hasLoader,
			hasAction,
			params,
			// Derive the entity from the URL path, not the raw filename (avoids extensions).
			entity: entityFromSegments(routePath.split("/")),
		});
	}
	return routes;
}

function detectConfigRoutes(repo: RepoFiles): RouteInfo[] {
	const routes: RouteInfo[] = [];
	// RR7 framework config: route("path", "file"), index("file"), layout("file", [...])
	const configFileRe = /(routes\.(t|j)sx?|router\.(t|j)sx?)$/;
	const routeCallRe = /\broute\(\s*["'`]([^"'`]+)["'`]/g;
	const indexCallRe = /\bindex\(\s*["'`]([^"'`]+)["'`]/g;
	for (const f of repo.files) {
		if (!configFileRe.test(f.path)) continue;
		const content = readFileCached(f.abs);
		if (!content) continue;
		if (!/react-router|createBrowserRouter|@react-router\/dev|defineRoutes|\broute\(/.test(content))
			continue;
		for (const match of grepContent(f.path, content, routeCallRe)) {
			const raw = match.groups[0] ?? "";
			const params = [...raw.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1] as string);
			const routePath = raw.startsWith("/") ? raw : `/${raw}`;
			if (!isPlausibleRoutePath(routePath)) continue;
			routes.push({
				routePath,
				file: f.path,
				kind: "rr-config",
				isAdmin: isAdminPath(routePath, f.path),
				isIndex: false,
				isLayout: false,
				hasLoader: false,
				hasAction: false,
				params,
				entity: entityFromSegments(routePath.split("/")),
			});
		}
		for (const _ of grepContent(f.path, content, indexCallRe)) {
			routes.push({
				routePath: "/",
				file: f.path,
				kind: "rr-config",
				isAdmin: false,
				isIndex: true,
				isLayout: false,
				hasLoader: false,
				hasAction: false,
				params: [],
			});
		}
	}
	return routes;
}

function detectJsxRoutes(repo: RepoFiles): RouteInfo[] {
	const routes: RouteInfo[] = [];
	const jsxRouteRe = /<Route\s+[^>]*?path\s*=\s*["'`]([^"'`]+)["'`]/g;
	const objPathRe = /\bpath\s*:\s*["'`]([^"'`]+)["'`]/g;
	for (const f of repo.files) {
		if (!ROUTE_FILE_RE.test(f.path)) continue;
		const content = readFileCached(f.abs);
		if (!content) continue;
		const usesRouter = /react-router|createBrowserRouter|<Routes?\b|<Route\b/.test(content);
		if (!usesRouter) continue;
		const seen = new Set<string>();
		const collect = (re: RegExp, kind: RouteInfo["kind"]) => {
			for (const match of grepContent(f.path, content, re)) {
				const raw = match.groups[0] ?? "";
				if (!raw || raw === "/" + "*" || seen.has(raw)) continue;
				seen.add(raw);
				const routePath = raw.startsWith("/") ? raw : `/${raw}`;
				if (!isPlausibleRoutePath(routePath)) continue;
				const params = [...raw.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1] as string);
				routes.push({
					routePath,
					file: f.path,
					kind,
					isAdmin: isAdminPath(routePath, f.path),
					isIndex: false,
					isLayout: false,
					hasLoader: false,
					hasAction: false,
					params,
					entity: entityFromSegments(routePath.split("/")),
				});
			}
		};
		collect(jsxRouteRe, "rr-jsx");
		// Only mine object `path:` keys when a router factory is in the same file.
		if (/createBrowserRouter|createHashRouter|createMemoryRouter/.test(content)) {
			collect(objPathRe, "rr-config");
		}
	}
	return routes;
}

/** Detect routes using whichever strategies match the project's frameworks. */
export function detectRoutes(repo: RepoFiles, frameworks: string[]): RouteInfo[] {
	const all: RouteInfo[] = [];
	const fw = new Set(frameworks);
	if (fw.has("remix") || fw.has("react-router")) {
		all.push(...detectRemixFileRoutes(repo));
		all.push(...detectConfigRoutes(repo));
		all.push(...detectJsxRoutes(repo));
	}

	// If no framework matched but route files exist, still try file-based detection.
	if (
		all.length === 0 &&
		!["next", "express", "fastify", "nuxt", "sveltekit", "astro", "angular"].some((id) =>
			fw.has(id),
		)
	) {
		all.push(...detectRemixFileRoutes(repo));
		all.push(...detectJsxRoutes(repo));
	}

	// De-duplicate by (routePath, file); prefer entries carrying loader/action info.
	const byKey = new Map<string, RouteInfo>();
	for (const r of all) {
		if (!isPlausibleRoutePath(r.routePath)) continue;
		const key = `${r.routePath}::${r.file}`;
		const existing = byKey.get(key);
		if (!existing) {
			byKey.set(key, r);
		} else if ((r.hasLoader || r.hasAction) && !(existing.hasLoader || existing.hasAction)) {
			byKey.set(key, r);
		}
	}
	return [...byKey.values()].sort((a, b) => a.routePath.localeCompare(b.routePath));
}
