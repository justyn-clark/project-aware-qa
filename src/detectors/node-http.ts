import { posix } from "node:path";
import { type RepoFiles, readFileCached } from "../scanner/files.js";
import type { HttpMethod } from "../types.js";
import { entityFromSegments } from "./entities.js";
import { argumentsAt, codeFile, literal, type Token, tokens } from "./javascript.js";
import type { EndpointInfo } from "./types.js";

const methods = new Set(["get", "post", "put", "patch", "delete", "head", "options", "all"]);
interface Receiver {
	id: string;
	framework: string;
	root: boolean;
}
interface Route {
	receiver: string;
	method: HttpMethod;
	path: string;
	file: string;
	line: number;
}
interface Module {
	file: string;
	source: string;
	ts: Token[];
	constructors: Map<string, string>;
	receivers: Map<string, Receiver>;
	imports: Map<string, { path: string; name: string }>;
	exports: Map<string, string>;
}

/** Literal, module-level registrations only. No execution, factory or plugin guessing. */
export function detectNodeHttp(repo: RepoFiles, frameworks: string[]): EndpointInfo[] {
	if (!frameworks.some((f) => f === "express" || f === "fastify")) return [];
	const modules = new Map<string, Module>();
	for (const f of repo.files.filter((f) => codeFile(f.path))) {
		const source = readFileCached(f.abs) ?? "";
		modules.set(f.path, {
			file: f.path,
			source,
			ts: tokens(source),
			constructors: new Map(),
			receivers: new Map(),
			imports: new Map(),
			exports: new Map(),
		});
	}
	const routes: Route[] = [];
	const mounts: { parent: string; child: string; prefix: string }[] = [];
	const resolveFile = (file: string, path: string) => {
		const base = posix.normalize(posix.join(posix.dirname(file), path));
		return [
			base,
			...[".ts", ".tsx", ".js", ".mjs", ".cjs"].flatMap((ext) => [
				base + ext,
				base.replace(/\.[cm]?js$/, ext),
				`${base}/index${ext}`,
			]),
		].find((p) => modules.has(p));
	};
	for (const m of modules.values()) {
		const { ts } = m;
		// Imports and require bindings establish provenance before reading registrations.
		let importDepth = 0;
		for (let i = 0; i < ts.length; i++) {
			const token = ts[i] as Token;
			if (token.kind === "symbol" && "({[".includes(token.value)) importDepth++;
			if (token.kind === "symbol" && ")}]".includes(token.value)) importDepth--;
			if (importDepth !== 0 || token.kind !== "name") continue;
			if (["const", "let", "var"].includes(token.value) && ts[i + 1]?.value === "{") {
				let end = i + 2;
				while (end < ts.length && ts[end]?.value !== "}") end++;
				if (ts[end + 1]?.value === "=" && ts[end + 2]?.value === "require") {
					const path = literal(argumentsAt(ts, end + 3)?.args[0]);
					if (path === "express" && frameworks.includes(path)) {
						for (let j = i + 2; j < end; j++) {
							if (ts[j]?.value === "Router" && ["{", ","].includes(ts[j - 1]?.value ?? "")) {
								const local = ts[j + 1]?.value === ":" ? ts[j + 2]?.value : "Router";
								if (local) m.constructors.set(local, "router");
							}
						}
					}
				}
			}
			if (ts[i]?.value === "import") {
				let end = i + 1;
				while (end < ts.length && !["from", ";"].includes(ts[end]?.value ?? "")) end++;
				if (ts[end]?.value !== "from" || ts[end + 1]?.kind !== "string") continue;
				const path = ts[end + 1]?.value as string;
				const bindings = ts.slice(i + 1, end);
				const fw =
					frameworks.includes(path) && ["express", "fastify"].includes(path) ? path : undefined;
				if (bindings[0]?.kind === "name" && bindings[0].value !== "type") {
					if (fw) m.constructors.set(bindings[0].value, fw);
					else if (path.startsWith("."))
						m.imports.set(bindings[0].value, { path, name: "default" });
				}
				for (let j = 0; j < bindings.length; j++) {
					const b = bindings[j];
					if (b?.kind !== "name" || !["{", ","].includes(bindings[j - 1]?.value ?? "")) continue;
					const local = bindings[j + 1]?.value === "as" ? bindings[j + 2]?.value : b.value;
					if (!local) continue;
					if (fw === "express" && b.value === "Router") m.constructors.set(local, "router");
					else if (fw === "fastify" && b.value === "fastify") m.constructors.set(local, fw);
					else if (path.startsWith(".")) m.imports.set(local, { path, name: b.value });
				}
			}
			if (
				["const", "let", "var"].includes(ts[i]?.value ?? "") &&
				ts[i + 1]?.kind === "name" &&
				ts[i + 2]?.value === "=" &&
				ts[i + 3]?.value === "require"
			) {
				const call = argumentsAt(ts, i + 4);
				const path = literal(call?.args[0]);
				if (!path) continue;
				const name = ts[i + 1]?.value as string;
				if (frameworks.includes(path) && ["express", "fastify"].includes(path)) {
					if (call && ts[call.end + 1]?.value === "(") {
						m.receivers.set(name, { id: `${m.file}:${name}`, framework: path, root: true });
					} else m.constructors.set(name, path);
				} else if (path.startsWith(".")) m.imports.set(name, { path, name: "default" });
			}
		}
		let depth = 0;
		for (let i = 0; i < ts.length; i++) {
			const t = ts[i] as Token;
			if (depth === 0 && t.kind === "name") {
				if (
					["const", "let", "var"].includes(t.value) &&
					ts[i + 1]?.kind === "name" &&
					ts[i + 2]?.value === "="
				) {
					const name = ts[i + 1]?.value as string;
					const ctor = ts[i + 3]?.value as string;
					const fw = m.constructors.get(ctor);
					const router =
						fw === "router" ||
						(fw === "express" && ts[i + 4]?.value === "." && ts[i + 5]?.value === "Router");
					const open = router && fw !== "router" ? i + 6 : i + 4;
					if (fw && ts[open]?.value === "(") {
						m.receivers.set(name, {
							id: `${m.file}:${name}`,
							framework: fw === "router" ? "express" : fw,
							root: !router,
						});
						if (ts[i - 1]?.value === "export") m.exports.set(name, name);
					}
				}
				if (t.value === "export" && ts[i + 1]?.value === "default" && ts[i + 2]?.kind === "name")
					m.exports.set("default", ts[i + 2]?.value as string);
				if (t.value === "export" && ts[i + 1]?.value === "{") {
					for (let j = i + 2; j < ts.length && ts[j]?.value !== "}"; j++) {
						if (ts[j]?.kind !== "name" || !["{", ","].includes(ts[j - 1]?.value ?? "")) continue;
						m.exports.set(
							ts[j + 1]?.value === "as" ? (ts[j + 2]?.value as string) : (ts[j]?.value as string),
							ts[j]?.value as string,
						);
					}
				}
				if (
					t.value === "module" &&
					ts[i + 1]?.value === "." &&
					ts[i + 2]?.value === "exports" &&
					ts[i + 3]?.value === "=" &&
					ts[i + 4]?.kind === "name"
				)
					m.exports.set("default", ts[i + 4]?.value as string);
			}
			if (t.kind === "symbol" && "({[".includes(t.value)) depth++;
			if (t.kind === "symbol" && ")}]".includes(t.value)) depth--;
		}
	}
	function receiver(m: Module, name: string): Receiver | undefined {
		const local = m.receivers.get(name);
		if (local) return local;
		const imp = m.imports.get(name);
		if (!imp) return;
		const file = resolveFile(m.file, imp.path);
		const target = file ? modules.get(file) : undefined;
		const exported = target?.exports.get(imp.name);
		return exported ? target?.receivers.get(exported) : undefined;
	}
	for (const m of modules.values()) {
		const { ts } = m;
		let depth = 0;
		const add = (r: Receiver, method: string, path: string | undefined, offset: number) => {
			if (!path?.startsWith("/") || !methods.has(method)) return;
			routes.push({
				receiver: r.id,
				method: method.toUpperCase() as HttpMethod,
				path,
				file: m.file,
				line: m.source.slice(0, offset).split("\n").length,
			});
		};
		for (let i = 0; i < ts.length; i++) {
			const t = ts[i] as Token;
			const r = depth === 0 && t.kind === "name" ? receiver(m, t.value) : undefined;
			if (r && ts[i + 1]?.value === "." && ts[i + 2]?.kind === "name") {
				const method = ts[i + 2]?.value as string;
				const call = argumentsAt(ts, i + 3);
				if (call) {
					if (methods.has(method) && call.args.length >= 2)
						add(r, method, literal(call.args[0]), t.offset);
					if (method === "use" && r.framework === "express") {
						const prefix = literal(call.args[0]);
						const args = prefix === undefined ? call.args : call.args.slice(1);
						// A dynamic first argument must never be silently treated as a root mount.
						if (
							prefix !== undefined ||
							(args[0]?.length === 1 && receiver(m, args[0][0]?.value ?? ""))
						) {
							for (const arg of args) {
								const child = arg.length === 1 ? receiver(m, arg[0]?.value ?? "") : undefined;
								if (child?.framework === "express")
									mounts.push({ parent: r.id, child: child.id, prefix: prefix ?? "" });
							}
						}
					}
					if (method === "route" && r.framework === "express") {
						const path = literal(call.args[0]);
						let end = call.end;
						while (ts[end + 1]?.value === "." && methods.has(ts[end + 2]?.value ?? "")) {
							const chained = argumentsAt(ts, end + 3);
							if (!chained) break;
							add(r, ts[end + 2]?.value as string, path, t.offset);
							end = chained.end;
						}
					}
					if (method === "route" && r.framework === "fastify") {
						const obj = call.args[0] ?? [];
						let level = 0;
						let path: string | undefined;
						const found: string[] = [];
						for (let j = 0; j < obj.length; j++) {
							const token = obj[j] as Token;
							if (
								level === 1 &&
								["{", ","].includes(obj[j - 1]?.value ?? "") &&
								obj[j + 1]?.value === ":"
							) {
								if (
									["url", "path"].includes(token.value) &&
									obj[j + 2]?.kind === "string" &&
									[",", "}"].includes(obj[j + 3]?.value ?? "")
								)
									path = obj[j + 2]?.value;
								if (token.value === "method") {
									if (obj[j + 2]?.kind === "string" && [",", "}"].includes(obj[j + 3]?.value ?? ""))
										found.push(obj[j + 2]?.value as string);
									else if (obj[j + 2]?.value === "[") {
										let k = j + 3;
										const values: string[] = [];
										for (; k < obj.length && obj[k]?.value !== "]"; k++) {
											if (obj[k]?.kind === "string") values.push(obj[k]?.value as string);
											else if (obj[k]?.value !== ",") break;
										}
										if (obj[k]?.value === "]") found.push(...values);
									}
								}
							}
							if (token.kind === "symbol" && "({[".includes(token.value)) level++;
							if (token.kind === "symbol" && ")}]".includes(token.value)) level--;
						}
						for (const method of found) add(r, method.toLowerCase(), path, t.offset);
					}
				}
			}
			if (t.kind === "symbol" && "({[".includes(t.value)) depth++;
			if (t.kind === "symbol" && ")}]".includes(t.value)) depth--;
		}
	}
	const result = new Map<string, EndpointInfo>();
	function visit(id: string, prefix: string, seen: Set<string>) {
		if (seen.has(id)) return;
		const next = new Set([...seen, id]);
		for (const route of routes.filter((r) => r.receiver === id)) {
			const path = `${prefix}/${route.path}`.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
			const endpoint: EndpointInfo = {
				method: route.method,
				path,
				file: route.file,
				line: route.line,
				controller: id,
				controllerPrefix: prefix,
				handler: route.method,
				entity: entityFromSegments(path.split("/").filter((s) => s && !s.startsWith(":"))),
				isAdmin: /(^|\/)admin(\/|$)/.test(path),
				isMutation: ["POST", "PUT", "PATCH", "DELETE", "ALL"].includes(route.method),
			};
			result.set(`${route.file}:${route.line}:${route.method}:${path}`, endpoint);
		}
		for (const mount of mounts.filter((m) => m.parent === id))
			visit(mount.child, `${prefix}/${mount.prefix}`.replace(/\/{2,}/g, "/"), next);
	}
	for (const m of modules.values())
		for (const r of m.receivers.values()) if (r.root) visit(r.id, "", new Set());
	return [...result.values()];
}
