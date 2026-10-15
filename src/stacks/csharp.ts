/**
 * C# / .NET deep adapter - ASP.NET Core minimal APIs and MVC controllers.
 *
 *  - minimal:    `app.MapGet("/path", handler)`, `var g = app.MapGroup("/api")`
 *  - controllers:`[ApiController] [Route("api/[controller]")]` + `[HttpGet("{id}")]` /
 *                `[HttpPost]`, with `[FromBody] Dto` body types
 *  - DTOs:       records `record CreateUser(string Name)` and *Request/*Dto/*Response classes
 *  - tests:      `*Tests.cs` / `*Test.cs`; toolchain dotnet build/test
 *
 * A plain .NET project with no web framework falls through to the generic adapter.
 */
import { entityFromControllerPrefix, entityFromSegments } from "../detectors/entities.js";
import type { DetectionBundle, DtoInfo, EndpointInfo, TestInfo } from "../detectors/types.js";
import { type RepoFiles, readFileCached } from "../scanner/files.js";
import type { HttpMethod, StackChecks, StackInfo } from "../types.js";
import type { StackAdapter, StackMatch, StackScan } from "./types.js";

function inDir(rootRel: string, path: string): boolean {
	return rootRel === "" ? true : path === rootRel || path.startsWith(`${rootRel}/`);
}
function join(prefix: string, sub: string): string {
	// `[Route("api/[controller]")]` has no leading slash - anchor at "/".
	const a = `/${prefix.replace(/^\/+|\/+$/g, "")}`;
	const b = sub === "" ? "" : sub.startsWith("/") ? sub : `/${sub}`;
	return `${a}${b}`.replace(/\/+/g, "/").replace(/(.)\/$/, "$1") || "/";
}
const normParams = (p: string) => p.replace(/\{([A-Za-z0-9_]+)(?::[^}]+)?\}/g, ":$1");

export function parseCSharpRoutes(file: string, content: string): EndpointInfo[] {
	const endpoints: EndpointInfo[] = [];

	// Minimal APIs: app.MapGet("/path", handler) / MapGroup prefixes.
	const groupPrefix = new Map<string, string>();
	for (const m of content.matchAll(
		/(?:var\s+)?([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\.MapGroup\(\s*"([^"]*)"/g,
	)) {
		groupPrefix.set(m[1] as string, join(groupPrefix.get(m[2] as string) ?? "", m[3] ?? ""));
	}
	for (const m of content.matchAll(
		/\b([A-Za-z_]\w*)\.Map(Get|Post|Put|Patch|Delete)\(\s*"([^"]*)"\s*,\s*([A-Za-z0-9_.]+)?/g,
	)) {
		const prefix = groupPrefix.get(m[1] as string) ?? "";
		const path = normParams(join(prefix, m[3] ?? ""));
		const method = (m[2] as string).toUpperCase() as HttpMethod;
		const handler = (m[4] ?? "handler").split(".").pop() ?? "handler";
		endpoints.push({
			method,
			path,
			controller: m[1] as string,
			controllerPrefix: prefix,
			handler,
			file,
			line: content.slice(0, m.index).split("\n").length,
			entity: entityFromSegments(path.split("/")),
			isAdmin: /(^|\/)admin(\/|$)/.test(path),
			isMutation: method !== "GET",
		});
	}

	// MVC controllers: [Route("api/[controller]")] class + [HttpGet("{id}")]
	const classM = /(?:public\s+)?class\s+([A-Za-z0-9_]+)Controller\b/.exec(content);
	if (classM) {
		const controller = `${classM[1]}Controller`;
		const entityName = (classM[1] as string).toLowerCase();
		const before = content.slice(0, classM.index);
		let classPrefix = /\[Route\(\s*"([^"]*)"/.exec(before)?.[1] ?? "";
		classPrefix = classPrefix.replace(/\[controller\]/gi, entityName).replace(/\[action\]/gi, "");
		const attrRe = /\[Http(Get|Post|Put|Patch|Delete)(?:\(\s*"([^"]*)")?\s*\)?\]/g;
		let a: RegExpExecArray | null = attrRe.exec(content);
		for (; a !== null; a = attrRe.exec(content)) {
			if (a.index < classM.index) continue;
			const method = (a[1] as string).toUpperCase() as HttpMethod;
			const sub = a[2] ?? "";
			const after = content.slice(a.index + a[0].length, a.index + a[0].length + 400);
			const sig =
				/(?:public|private|protected)\s+(?:async\s+)?[A-Za-z0-9_<>,?\s]+?\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)/.exec(
					after,
				);
			const handler = sig?.[1] ?? "handler";
			const bodyDto = /\[FromBody\]\s*([A-Z][A-Za-z0-9_]*)/.exec(sig?.[2] ?? "")?.[1];
			const path = normParams(join(classPrefix, sub));
			endpoints.push({
				method,
				path,
				controller,
				controllerPrefix: classPrefix,
				handler,
				file,
				line: content.slice(0, a.index).split("\n").length,
				entity: entityFromSegments(path.split("/")) ?? entityFromControllerPrefix(entityName),
				bodyDto,
				isAdmin: /(^|\/)admin(\/|$)/.test(path),
				isMutation: method !== "GET",
			});
		}
	}
	return endpoints;
}

const DTO_NAME = /(Request|Response|Input|Dto|Form|Payload)$/;

function detectCSharpDtos(repo: RepoFiles, rootRel: string): DtoInfo[] {
	const dtos: DtoInfo[] = [];
	for (const f of repo.files) {
		if (f.ext !== ".cs" || !inDir(rootRel, f.path)) continue;
		const content = readFileCached(f.abs);
		if (!content) continue;
		// positional records: record CreateUser(string Name, int Age)
		for (const m of content.matchAll(
			/record\s+(?:class\s+|struct\s+)?([A-Za-z0-9_]+)\s*\(([^)]*)\)/g,
		)) {
			const fields = [
				...(m[2] ?? "").matchAll(/[A-Za-z0-9_<>?[\].]+\s+([A-Za-z0-9_]+)\s*(?:,|$)/g),
			].map((x) => (x[1] as string).toLowerCase());
			if (fields.length)
				dtos.push({
					name: m[1] as string,
					file: f.path,
					fields: fields.map((n) => ({ name: n, validators: [], optional: false })),
				});
		}
		// *Request/*Dto classes/records with auto-properties
		for (const m of content.matchAll(/(?:class|record)\s+([A-Za-z0-9_]+)/g)) {
			const name = m[1] as string;
			if (!DTO_NAME.test(name)) continue;
			const body = content.slice(m.index, m.index + 1500);
			const fields = [
				...body.matchAll(/public\s+[A-Za-z0-9_<>?[\].]+\s+([A-Za-z0-9_]+)\s*\{\s*get/g),
			].map((x) => (x[1] as string).toLowerCase());
			if (fields.length)
				dtos.push({
					name,
					file: f.path,
					fields: [...new Set(fields)].map((n) => ({ name: n, validators: [], optional: false })),
				});
		}
	}
	return dtos;
}

function detectCSharpTests(repo: RepoFiles, rootRel: string): TestInfo[] {
	const tests: TestInfo[] = [];
	for (const f of repo.files) {
		if (f.ext !== ".cs" || !inDir(rootRel, f.path) || !/Tests?\.cs$/.test(f.path)) continue;
		const content = readFileCached(f.abs) ?? "";
		if (!/\[(Fact|Theory|Test|TestMethod)\]/.test(content)) continue;
		const base = f.path.split("/").pop() ?? f.path;
		tests.push({
			file: f.path,
			kind: /WebApplicationFactory|HttpClient|TestServer/.test(content) ? "e2e" : "unit",
			runner: "unknown",
			targets: base
				.replace(/\.cs$/, "")
				.split(/(?=[A-Z])|[^a-z0-9]+/i)
				.filter(Boolean)
				.map((s) => s.toLowerCase()),
		});
	}
	return tests;
}

function isAspNet(repo: RepoFiles, rootRel: string): boolean {
	for (const f of repo.files) {
		const base = f.path.split("/").pop() ?? "";
		if (!inDir(rootRel, f.path)) continue;
		if (base.endsWith(".csproj")) {
			const c = readFileCached(f.abs) ?? "";
			if (/Microsoft\.NET\.Sdk\.Web|Microsoft\.AspNetCore/.test(c)) return true;
		}
		if (f.ext === ".cs") {
			const c = readFileCached(f.abs);
			if (
				c &&
				/WebApplication\.CreateBuilder|\.Map(Get|Post|Controllers)\(|\[ApiController\]/.test(c)
			)
				return true;
		}
	}
	return false;
}

export const csharpAdapter: StackAdapter = {
	id: "csharp",
	name: ".NET / C# (ASP.NET Core)",
	kind: "deep",
	extensions: [".cs"],
	markers: [],

	detect(repo: RepoFiles): StackMatch[] {
		const dirs = new Set<string>();
		for (const f of repo.files) {
			if (!/\.(csproj|sln)$/.test(f.path)) continue;
			const i = f.path.lastIndexOf("/");
			dirs.add(i < 0 ? "" : f.path.slice(0, i));
		}
		if (dirs.size === 0 && repo.files.some((f) => f.ext === ".cs")) dirs.add("");
		const matches: StackMatch[] = [];
		for (const dir of dirs) {
			if (!isAspNet(repo, dir)) continue; // plain .NET -> generic
			matches.push({
				adapter: "csharp",
				rootRel: dir,
				label: ".NET / ASP.NET Core",
				confidence: 85,
			});
		}
		return matches.slice(0, 1); // a solution's web project anchors at one root
	},

	scan(repo: RepoFiles, match: StackMatch): StackScan {
		const rootRel = match.rootRel;
		const endpoints: EndpointInfo[] = [];
		for (const f of repo.files) {
			if (f.ext !== ".cs" || !inDir(rootRel, f.path)) continue;
			const content = readFileCached(f.abs);
			if (
				!content ||
				!/\.Map(Get|Post|Put|Patch|Delete)\(|\[Http(Get|Post|Put|Patch|Delete)/.test(content)
			)
				continue;
			endpoints.push(...parseCSharpRoutes(f.path, content));
		}
		const seen = new Set<string>();
		const deduped = endpoints.filter((e) => {
			const k = `${e.method} ${e.path}`;
			if (seen.has(k)) return false;
			seen.add(k);
			return true;
		});
		const bundle: DetectionBundle = {
			routes: [],
			endpoints: deduped,
			dtos: detectCSharpDtos(repo, rootRel),
			forms: [],
			cacheSignals: [],
			tests: detectCSharpTests(repo, rootRel),
		};
		const c = (command: string) => ({ command, cwd: rootRel });
		const checks: StackChecks = {
			build: c("dotnet build"),
			test: c("dotnet test"),
			dev: c("dotnet run"),
		};
		const stack: StackInfo = {
			adapter: "csharp",
			label: ".NET / ASP.NET Core",
			language: "csharp",
			rootRel,
			packageManager: "dotnet",
			frameworks: ["dotnet", "aspnetcore"],
			scripts: {},
			checks,
			testRunners: ["dotnet-test"],
			depth: "deep",
		};
		return { stack, bundle, extraSurfaces: [] };
	},
};
