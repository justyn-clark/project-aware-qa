/**
 * Java/JVM deep adapter — Spring (Boot/MVC/WebFlux) and JAX-RS.
 *
 *  - Spring:  `@RestController` + class `@RequestMapping("/base")` + method
 *             `@GetMapping("/x")` / `@PostMapping` / `@RequestMapping(method=…)`,
 *             with `@RequestBody Dto` body types
 *  - JAX-RS:  `@Path("/base")` class + `@GET`/`@POST` + method `@Path("/x")`
 *  - DTOs:    records `record CreateUser(String name)` and *Request/*Dto/*Response classes
 *  - tests:   `*Test.java` / `*Tests.java`; toolchain maven or gradle
 *
 * Plain Java with no web framework falls through to the generic adapter.
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
	// Always anchor at "/" so a class @RequestMapping("api/x") still yields "/api/x".
	const a = `/${prefix.replace(/^\/+|\/+$/g, "")}`;
	const b = sub === "" ? "" : sub.startsWith("/") ? sub : `/${sub}`;
	return `${a}${b}`.replace(/\/+/g, "/").replace(/(.)\/$/, "$1") || "/";
}
const normParams = (p: string) => p.replace(/\{([A-Za-z0-9_]+)(?::[^}]+)?\}/g, ":$1");

// Match only the annotation itself (group 2 = its own args), not the method signature.
const MAPPING = /@(Get|Post|Put|Delete|Patch|Request)Mapping\b(?:\(([^)]*)\))?/;

export function parseJavaController(file: string, content: string): EndpointInfo[] {
	const endpoints: EndpointInfo[] = [];
	if (!/@(RestController|Controller|Path)\b/.test(content)) return endpoints;

	const classM = /(?:public\s+)?(?:final\s+)?class\s+([A-Za-z0-9_]+)/.exec(content);
	const controller = classM?.[1] ?? "Controller";
	const beforeClass = classM ? content.slice(0, classM.index) : content;
	const classPrefix =
		/@RequestMapping\(\s*(?:value\s*=\s*|path\s*=\s*)?(?:\{?\s*)?"([^"]*)"/.exec(
			beforeClass,
		)?.[1] ??
		/@Path\(\s*"([^"]*)"/.exec(beforeClass)?.[1] ??
		"";
	const entityBase =
		entityFromControllerPrefix(controller.replace(/Controller$/, "")) ??
		entityFromSegments(`/${classPrefix}`.split("/"));

	const mapRe = new RegExp(MAPPING.source, "g");
	let m: RegExpExecArray | null = mapRe.exec(content);
	for (; m !== null; m = mapRe.exec(content)) {
		// Skip the class-level @RequestMapping.
		if (classM && m.index < classM.index) continue;
		const kind = m[1] as string;
		const args = m[2] ?? "";
		let method: HttpMethod = "GET";
		if (kind === "Get") method = "GET";
		else if (kind === "Post") method = "POST";
		else if (kind === "Put") method = "PUT";
		else if (kind === "Delete") method = "DELETE";
		else if (kind === "Patch") method = "PATCH";
		else method = (/method\s*=\s*RequestMethod\.([A-Z]+)/.exec(args)?.[1] ?? "GET") as HttpMethod;
		const sub = /"([^"]*)"/.exec(args)?.[1] ?? "";
		const after = content.slice(m.index + m[0].length, m.index + m[0].length + 400);
		const sig =
			/(?:public|protected|private)?\s*[A-Za-z0-9_<>,?\s]+?\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)/.exec(
				after,
			);
		const handler = sig?.[1] ?? "handler";
		const bodyDto = /@RequestBody\s+(?:final\s+)?([A-Z][A-Za-z0-9_]*)/.exec(sig?.[2] ?? "")?.[1];
		const path = normParams(join(classPrefix, sub));
		endpoints.push({
			method,
			path,
			controller,
			controllerPrefix: classPrefix,
			handler,
			file,
			line: content.slice(0, m.index).split("\n").length,
			entity: entityFromSegments(path.split("/")) ?? entityBase,
			bodyDto,
			isAdmin: /(^|\/)admin(\/|$)/.test(path),
			isMutation: method !== "GET",
		});
	}

	// JAX-RS: @GET/@POST with method-level @Path.
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const jx = /^@(GET|POST|PUT|DELETE|PATCH|HEAD)\b/.exec((lines[i] ?? "").trim());
		if (!jx) continue;
		const blob = lines.slice(i, i + 6).join("\n");
		const sub = /@Path\(\s*"([^"]*)"/.exec(blob)?.[1] ?? "";
		const fn = /(?:public|protected)?\s*[A-Za-z0-9_<>,?\s]+?\s+([A-Za-z0-9_]+)\s*\(/.exec(
			blob.replace(/@\w+(\([^)]*\))?/g, ""),
		);
		const path = normParams(join(classPrefix, sub));
		endpoints.push({
			method: jx[1] as HttpMethod,
			path,
			controller,
			controllerPrefix: classPrefix,
			handler: fn?.[1] ?? "handler",
			file,
			line: i + 1,
			entity: entityFromSegments(path.split("/")) ?? entityBase,
			isAdmin: /(^|\/)admin(\/|$)/.test(path),
			isMutation: jx[1] !== "GET",
		});
	}
	return endpoints;
}

const DTO_NAME = /(Request|Response|Input|Dto|Form|Payload)$/;

function detectJavaDtos(repo: RepoFiles, rootRel: string): DtoInfo[] {
	const dtos: DtoInfo[] = [];
	for (const f of repo.files) {
		if (f.ext !== ".java" || !inDir(rootRel, f.path)) continue;
		const content = readFileCached(f.abs);
		if (!content) continue;
		// records: record CreateUser(String name, int age)
		for (const m of content.matchAll(/record\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)/g)) {
			const fields = [
				...(m[2] ?? "").matchAll(/[A-Za-z0-9_<>,.?]+\s+([A-Za-z0-9_]+)\s*(?:,|$)/g),
			].map((x) => x[1] as string);
			if (fields.length)
				dtos.push({
					name: m[1] as string,
					file: f.path,
					fields: fields.map((n) => ({ name: n, validators: [], optional: false })),
				});
		}
		// *Request/*Dto classes with private fields
		for (const m of content.matchAll(/class\s+([A-Za-z0-9_]+)/g)) {
			const name = m[1] as string;
			if (!DTO_NAME.test(name)) continue;
			const body = content.slice(m.index, m.index + 1500);
			const fields = [
				...body.matchAll(/private\s+(?:final\s+)?[A-Za-z0-9_<>,.?]+\s+([A-Za-z0-9_]+)\s*[;=]/g),
			].map((x) => x[1] as string);
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

function detectJavaTests(repo: RepoFiles, rootRel: string): TestInfo[] {
	const tests: TestInfo[] = [];
	for (const f of repo.files) {
		if (f.ext !== ".java" || !inDir(rootRel, f.path)) continue;
		if (!/(Test|Tests|IT)\.java$/.test(f.path)) continue;
		const content = readFileCached(f.abs) ?? "";
		if (!/@Test\b|extends\s+\w*TestCase/.test(content)) continue;
		const base = f.path.split("/").pop() ?? f.path;
		tests.push({
			file: f.path,
			kind: /@SpringBootTest|MockMvc|WebTestClient|@WebMvcTest/.test(content) ? "e2e" : "unit",
			runner: "unknown",
			targets: base
				.replace(/\.java$/, "")
				.split(/(?=[A-Z])|[^a-z0-9]+/i)
				.filter(Boolean)
				.map((s) => s.toLowerCase()),
		});
	}
	return tests;
}

export const javaAdapter: StackAdapter = {
	id: "java",
	name: "Java / JVM (Spring / JAX-RS)",
	kind: "deep",
	extensions: [".java"],
	markers: ["pom.xml", "build.gradle", "build.gradle.kts"],

	detect(repo: RepoFiles): StackMatch[] {
		const matches: StackMatch[] = [];
		const seen = new Set<string>();
		for (const f of repo.files) {
			const base = f.path.split("/").pop() ?? f.path;
			if (!["pom.xml", "build.gradle", "build.gradle.kts"].includes(base)) continue;
			const dir = f.path === base ? "" : f.path.slice(0, f.path.length - base.length - 1);
			if (seen.has(dir)) continue;
			const build = readFileCached(f.abs) ?? "";
			const web =
				/spring-boot|springframework|jakarta\.ws\.rs|javax\.ws\.rs|micronaut|quarkus/.test(build);
			if (!web) continue; // plain JVM build → generic
			seen.add(dir);
			matches.push({ adapter: "java", rootRel: dir, label: "Java / Spring", confidence: 85 });
		}
		return matches;
	},

	scan(repo: RepoFiles, match: StackMatch): StackScan {
		const rootRel = match.rootRel;
		const gradle = repo.files.some(
			(f) =>
				f.path === (rootRel ? `${rootRel}/build.gradle` : "build.gradle") ||
				f.path.endsWith("/build.gradle.kts") ||
				f.path === "build.gradle.kts",
		);
		const endpoints: EndpointInfo[] = [];
		for (const f of repo.files) {
			if (f.ext !== ".java" || !inDir(rootRel, f.path)) continue;
			const content = readFileCached(f.abs);
			if (!content || !/@(RestController|Controller|Path)\b/.test(content)) continue;
			endpoints.push(...parseJavaController(f.path, content));
		}
		const bundle: DetectionBundle = {
			routes: [],
			endpoints,
			dtos: detectJavaDtos(repo, rootRel),
			forms: [],
			cacheSignals: [],
			tests: detectJavaTests(repo, rootRel),
		};
		const pm = gradle ? "gradle" : "maven";
		const c = (command: string) => ({ command, cwd: rootRel });
		const checks: StackChecks = gradle
			? {
					build: c("./gradlew build -x test"),
					test: c("./gradlew test"),
					dev: c("./gradlew bootRun"),
				}
			: { build: c("mvn -q compile"), test: c("mvn -q test"), dev: c("mvn spring-boot:run") };
		const stack: StackInfo = {
			adapter: "java",
			label: "Java / Spring",
			language: "java",
			rootRel,
			packageManager: pm,
			frameworks: ["java", "spring"],
			scripts: {},
			checks,
			testRunners: [gradle ? "gradle" : "junit"],
			depth: "deep",
		};
		return { stack, bundle, extraSurfaces: [] };
	},
};
