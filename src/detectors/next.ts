import { type RepoFiles, readFileCached } from "../scanner/files.js";
import type { HttpMethod } from "../types.js";
import { entityFromSegments } from "./entities.js";
import { tokens } from "./javascript.js";
import type { EndpointInfo, RouteInfo } from "./types.js";

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/** Filesystem conventions only; rewrites, custom extensions and interception are not guessed. */
export function detectNext(
	repo: RepoFiles,
	rootRel = "",
): { routes: RouteInfo[]; endpoints: EndpointInfo[] } {
	const routes: RouteInfo[] = [];
	const endpoints: EndpointInfo[] = [];
	const prefix = rootRel ? `${rootRel}/` : "";
	const rootDirs = ["app", "pages"].filter((dir) =>
		repo.files.some((f) => f.path.startsWith(`${prefix}${dir}/`)),
	);
	for (const f of repo.files) {
		const rel = f.path.slice(prefix.length);
		if (rootDirs.some((dir) => rel.startsWith(`src/${dir}/`))) continue;
		const match = /^(?:src\/)?(app|pages)\/(.+)\.(?:[jt]sx?)$/.exec(rel);
		if (!match || /\.(test|spec|d)$/.test(match[2] ?? "")) continue;
		const app = match[1] === "app";
		const segments = (match[2] as string).split("/");
		const leaf = segments.at(-1) as string;
		if (app && leaf !== "page" && leaf !== "route") continue;
		if (app && segments.some((s) => s.startsWith("_") || /^\(\.\.?/.test(s))) continue;
		if (!app && ["_app", "_document", "_error"].includes(segments[0] as string)) continue;
		const api = app ? leaf === "route" : segments[0] === "api";
		if (app || leaf === "index") segments.pop();
		const params: string[] = [];
		const parts: string[] = [];
		for (const segment of segments) {
			if (app && (/^\([^)]*\)$/.test(segment) || segment.startsWith("@"))) continue;
			const optional = /^\[\[\.\.\.(\w+)\]\]$/.exec(segment);
			const catchAll = /^\[\.\.\.(\w+)\]$/.exec(segment);
			const dynamic = /^\[(\w+)\]$/.exec(segment);
			const name = optional?.[1] ?? catchAll?.[1] ?? dynamic?.[1];
			if (name) {
				params.push(name);
				parts.push(`:${name}${optional ? "*" : catchAll ? "+" : ""}`);
			} else parts.push(segment);
		}
		const path = `/${parts.join("/")}`;
		const entity = entityFromSegments(parts.filter((p) => !p.startsWith(":")));
		const isAdmin = /(^|\/)admin(\/|$)/.test(path);
		const source = readFileCached(f.abs) ?? "";
		const ts = tokens(source);
		if (!api) {
			routes.push({
				routePath: path,
				file: f.path,
				kind: app ? "next-app" : "next-pages",
				isAdmin,
				isIndex: path === "/",
				isLayout: false,
				hasLoader: false,
				hasAction: false,
				params,
				entity,
			});
			continue;
		}
		const methods = new Map<string, number>();
		if (app) {
			let depth = 0;
			for (let i = 0; i < ts.length; i++) {
				const t = ts[i];
				if (depth === 0 && t?.kind === "name" && t.value === "export") {
					let j = i + 1;
					if (ts[j]?.value === "async") j++;
					if (["function", "const", "let", "var"].includes(ts[j]?.value ?? "")) {
						const method = ts[j + 1]?.value;
						if (method && METHODS.has(method)) methods.set(method, t.offset);
					} else if (ts[j]?.value === "{") {
						for (j++; j < ts.length && ts[j]?.value !== "}"; j++) {
							if (!["{", ","].includes(ts[j - 1]?.value ?? "")) continue;
							if (ts[j]?.value === "type") continue;
							const method = ts[j + 1]?.value === "as" ? ts[j + 2]?.value : ts[j]?.value;
							if (method && METHODS.has(method)) methods.set(method, t.offset);
						}
					}
				}
				if (t?.kind === "symbol" && t.value === "{") depth++;
				if (t?.kind === "symbol" && t.value === "}") depth--;
			}
		} else {
			// Pages API handlers can accept any method; branching is not a complete method contract.
			const declaration = ts.find(
				(t, i) => t.kind === "name" && t.value === "export" && ts[i + 1]?.value === "default",
			);
			if (declaration) methods.set("ALL", declaration.offset);
		}
		for (const [method, offset] of methods)
			endpoints.push({
				method: method as HttpMethod,
				path,
				controller: app ? "NextRouteHandler" : "NextApiRoute",
				controllerPrefix: "",
				handler: app ? method : "default",
				file: f.path,
				line: source.slice(0, offset).split("\n").length,
				entity,
				isAdmin,
				isMutation: method === "ALL" || ["POST", "PUT", "PATCH", "DELETE"].includes(method),
			});
	}
	return { routes, endpoints };
}
