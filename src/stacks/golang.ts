/**
 * Go deep adapter — chi, gin, echo, fiber, gorilla/mux, and net/http.
 *
 * Emits the shared DetectionBundle:
 *  - routes/endpoints from `recv.Get("/path", handler)` (chi/gin/echo/fiber) and
 *    `mux.HandleFunc("pattern", handler)` (gorilla/stdlib, incl. Go 1.22 "GET /path" and
 *    gorilla `.Methods(...)`), with two prefix mechanisms resolved:
 *      • chi `Route("/p", func(r){…})` closures via a brace-depth stack
 *      • `g := app.Group("/p")` variables via a prefix map
 *  - DTOs from request/response structs (json-tagged or *Request/*Input/… named)
 *  - tests from `*_test.go`; toolchain `go build/test/vet` (+ golangci-lint when configured)
 *
 * A Go module with no web routing falls through to the generic adapter (which already
 * provides `go build/test/vet`).
 */
import { entityFromControllerPrefix, entityFromSegments } from "../detectors/entities.js";
import type { DetectionBundle, DtoInfo, EndpointInfo, TestInfo } from "../detectors/types.js";
import { type RepoFiles, readFileCached } from "../scanner/files.js";
import type { HttpMethod, StackChecks, StackInfo } from "../types.js";
import type { StackAdapter, StackMatch, StackScan } from "./types.js";

const VERBS = "Get|Post|Put|Patch|Delete|Head|Options|GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS";
const ROUTER_CTORS =
	/chi\.NewRouter|chi\.NewMux|gin\.New|gin\.Default|echo\.New|fiber\.New|mux\.NewRouter|http\.NewServeMux/;

function inDir(rootRel: string, path: string): boolean {
	return rootRel === "" ? true : path === rootRel || path.startsWith(`${rootRel}/`);
}
function join(prefix: string, sub: string): string {
	const a = prefix.replace(/\/+$/, "");
	const b = sub === "" ? "" : sub.startsWith("/") ? sub : `/${sub}`;
	return `${a}${b}`.replace(/\/+/g, "/").replace(/(.)\/$/, "$1") || "/";
}
/** chi/gorilla `{id}`(+regex), gin/echo/fiber `:id` and `*splat` → our `:id`. */
function normParams(path: string): string {
	return path
		.replace(/\{([A-Za-z0-9_]+)(?::[^}]+)?\}/g, ":$1")
		.replace(/\*([A-Za-z0-9_]+)/g, ":$1");
}
/** Strip string/raw-string literals + line comments so brace counting isn't fooled. */
function bracesOnly(line: string): string {
	return line
		.replace(/"(?:\\.|[^"\\])*"/g, '""')
		.replace(/`[^`]*`/g, "``")
		.replace(/\/\/.*$/, "");
}

function pushEndpoint(
	method: HttpMethod,
	path: string,
	handlerExpr: string,
	recv: string,
	file: string,
	line: number,
	out: EndpointInfo[],
): void {
	const handler = handlerExpr.split(".").pop() ?? handlerExpr;
	const entity = entityFromSegments(path.split("/")) ?? entityFromControllerPrefix(handler);
	out.push({
		method,
		path,
		controller: handlerExpr.includes(".") ? (handlerExpr.split(".")[0] as string) : recv,
		controllerPrefix: "",
		handler,
		file,
		line,
		entity,
		isAdmin: /(^|\/)admin(\/|$)/.test(path),
		isMutation: method !== "GET",
	});
}

export function parseGoRoutes(file: string, content: string): EndpointInfo[] {
	const endpoints: EndpointInfo[] = [];
	const groupPrefix = new Map<string, string>();
	// Router/mux constructors anchor at "".
	for (const m of content.matchAll(
		new RegExp(`([A-Za-z_]\\w*)\\s*:?=\\s*(?:${ROUTER_CTORS.source})\\(`, "g"),
	)) {
		groupPrefix.set(m[1] as string, "");
	}
	// Group variables: v := recv.Group("/p")
	for (const m of content.matchAll(/([A-Za-z_]\w*)\s*:?=\s*([A-Za-z_]\w*)\.Group\(\s*"([^"]*)"/g)) {
		groupPrefix.set(m[1] as string, join(groupPrefix.get(m[2] as string) ?? "", m[3] ?? ""));
	}
	// gorilla subrouter: v := recv.PathPrefix("/p").Subrouter()
	for (const m of content.matchAll(
		/([A-Za-z_]\w*)\s*:?=\s*([A-Za-z_]\w*)\.PathPrefix\(\s*"([^"]*)"\s*\)\.Subrouter\(\)/g,
	)) {
		groupPrefix.set(m[1] as string, join(groupPrefix.get(m[2] as string) ?? "", m[3] ?? ""));
	}

	const verbRe = new RegExp(
		`\\b([A-Za-z_]\\w*)\\.(${VERBS})\\(\\s*"([^"]*)"\\s*,\\s*([A-Za-z0-9_.]+)`,
	);
	const lines = content.split("\n");
	let depth = 0;
	const chiStack: Array<{ prefix: string; depth: number }> = [];
	let pending: string | null = null;
	const chiTop = () =>
		chiStack.length ? (chiStack[chiStack.length - 1] as { prefix: string }).prefix : "";
	// Inside a chi `Route` closure, the closure param shadows the outer router var (often the
	// same name), so the closure prefix must win over the Group-variable map.
	const prefixFor = (recv: string) => (chiStack.length ? chiTop() : (groupPrefix.get(recv) ?? ""));

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";

		const vm = verbRe.exec(line);
		if (vm) {
			const method = (vm[2] as string).toUpperCase() as HttpMethod;
			pushEndpoint(
				method,
				normParams(join(prefixFor(vm[1] as string), vm[3] ?? "")),
				vm[4] as string,
				vm[1] as string,
				file,
				i + 1,
				endpoints,
			);
		}

		// gorilla / net-http HandleFunc (method-less, .Methods(...), or Go 1.22 "GET /path").
		const hm = /\b([A-Za-z_]\w*)\.HandleFunc\(\s*"([^"]*)"\s*,\s*([A-Za-z0-9_.]+)/.exec(line);
		if (hm && !vm) {
			let methods: HttpMethod[] = ["GET"];
			let pat = hm[2] ?? "";
			const go122 = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(.+)$/.exec(pat);
			if (go122) {
				methods = [go122[1] as HttpMethod];
				pat = go122[2] as string;
			} else {
				const meth = /\.Methods\(([^)]*)\)/.exec(line);
				if (meth) {
					methods = (meth[1] ?? "")
						.split(",")
						.map((s) => s.replace(/["'\s]/g, "").toUpperCase())
						.filter(Boolean) as HttpMethod[];
				}
			}
			const prefix = prefixFor(hm[1] as string);
			for (const method of methods) {
				pushEndpoint(
					method,
					normParams(join(prefix, pat)),
					hm[3] as string,
					hm[1] as string,
					file,
					i + 1,
					endpoints,
				);
			}
		}

		// chi Route("/p", func(r){ … }) opens a prefix closure.
		const cr = /\.Route\(\s*"([^"]*)"\s*,\s*func/.exec(line);
		if (cr) pending = join(chiTop(), cr[1] ?? "");

		const b = bracesOnly(line);
		for (const ch of b) {
			if (ch === "{") {
				depth++;
				if (pending !== null) {
					chiStack.push({ prefix: pending, depth });
					pending = null;
				}
			} else if (ch === "}") {
				while (
					chiStack.length &&
					(chiStack[chiStack.length - 1] as { depth: number }).depth === depth
				)
					chiStack.pop();
				depth--;
			}
		}
	}
	return endpoints;
}

const DTO_NAME = /(Request|Response|Input|Output|Params|Body|Payload|Dto|Form)$/;

function detectGoDtos(repo: RepoFiles, rootRel: string): DtoInfo[] {
	const dtos: DtoInfo[] = [];
	for (const f of repo.files) {
		if (f.ext !== ".go" || f.path.endsWith("_test.go") || !inDir(rootRel, f.path)) continue;
		const content = readFileCached(f.abs);
		if (!content || !/\btype\s+[A-Z]\w*\s+struct\s*\{/.test(content)) continue;
		const lines = content.split("\n");
		let cur: { name: string; fields: Set<string>; jsonTags: number } | null = null;
		const flush = () => {
			if (cur && (cur.jsonTags > 0 || DTO_NAME.test(cur.name)) && cur.fields.size > 0) {
				dtos.push({
					name: cur.name,
					file: f.path,
					fields: [...cur.fields].map((n) => ({ name: n, validators: [], optional: false })),
				});
			}
			cur = null;
		};
		for (const raw of lines) {
			const open = /^type\s+([A-Z]\w*)\s+struct\s*\{/.exec(raw.trim());
			if (open) {
				flush();
				cur = { name: open[1] as string, fields: new Set(), jsonTags: 0 };
				continue;
			}
			if (!cur) continue;
			if (raw.trim() === "}") {
				flush();
				continue;
			}
			// Field:  Name Type `json:"name,omitempty"`
			const field = /^\s*([A-Z]\w*)\s+[^\n]*$/.exec(raw);
			if (field && !raw.includes("func")) {
				const jsonTag = /json:"([^",]+)"/.exec(raw);
				if (jsonTag && jsonTag[1] !== "-") {
					cur.jsonTags++;
					cur.fields.add(jsonTag[1] as string);
				} else {
					cur.fields.add((field[1] as string).toLowerCase());
				}
			}
		}
		flush();
	}
	return dtos;
}

function detectGoTests(repo: RepoFiles, rootRel: string): TestInfo[] {
	const tests: TestInfo[] = [];
	for (const f of repo.files) {
		if (!f.path.endsWith("_test.go") || !inDir(rootRel, f.path)) continue;
		const content = readFileCached(f.abs) ?? "";
		if (!/\bfunc\s+(Test|Benchmark|Fuzz)\w*\s*\(/.test(content)) continue;
		const base = f.path.split("/").pop() ?? f.path;
		const targets = new Set<string>();
		for (const w of base.replace(/_test\.go$/, "").split(/[^a-z0-9]+/i))
			if (w) targets.add(w.toLowerCase());
		tests.push({
			file: f.path,
			kind: /httptest|\.ServeHTTP|client\.(Get|Post|Do)/.test(content) ? "e2e" : "unit",
			runner: "unknown",
			targets: [...targets],
		});
	}
	return tests;
}

const GO_WEB_FRAMEWORKS =
	/go-chi\/chi|gin-gonic\/gin|labstack\/echo|gorilla\/mux|gofiber\/fiber|beego|kataras\/iris|gobuffalo/;

function goModText(repo: RepoFiles, rootRel: string): string {
	const f = repo.files.find((x) => x.path === (rootRel ? `${rootRel}/go.mod` : "go.mod"));
	return f ? (readFileCached(f.abs) ?? "") : "";
}

function detectGoFrameworks(repo: RepoFiles, rootRel: string): string[] {
	const fw = new Set<string>();
	const mod = goModText(repo, rootRel);
	if (/go-chi\/chi/.test(mod)) fw.add("chi");
	if (/gin-gonic\/gin/.test(mod)) fw.add("gin");
	if (/labstack\/echo/.test(mod)) fw.add("echo");
	if (/gorilla\/mux/.test(mod)) fw.add("gorilla");
	if (/gofiber\/fiber/.test(mod)) fw.add("fiber");
	if (fw.size === 0) {
		// stdlib net/http routing detection over source.
		for (const f of repo.files) {
			if (f.ext !== ".go" || f.path.endsWith("_test.go") || !inDir(rootRel, f.path)) continue;
			const c = readFileCached(f.abs);
			if (c && /\.HandleFunc\(|http\.NewServeMux|http\.Handle\(/.test(c)) {
				fw.add("net/http");
				break;
			}
		}
	}
	return [...fw];
}

function devCommand(repo: RepoFiles, rootRel: string): string {
	const base = rootRel ? `${rootRel}/` : "";
	const cmd = repo.files.find(
		(f) => f.path.startsWith(`${base}cmd/`) && f.path.endsWith("main.go"),
	);
	if (cmd) {
		const dir = cmd.path.slice(base.length, cmd.path.lastIndexOf("/"));
		return `go run ./${dir}`;
	}
	return "go run .";
}

export const goAdapter: StackAdapter = {
	id: "go",
	name: "Go (chi / gin / echo / fiber / net-http)",
	kind: "deep",
	extensions: [".go"],
	markers: ["go.mod"],

	detect(repo: RepoFiles): StackMatch[] {
		const matches: StackMatch[] = [];
		for (const f of repo.files) {
			if (!(f.path === "go.mod" || f.path.endsWith("/go.mod"))) continue;
			const dir = f.path === "go.mod" ? "" : f.path.slice(0, -"/go.mod".length);
			const mod = readFileCached(f.abs) ?? "";
			const isWeb = GO_WEB_FRAMEWORKS.test(mod) || detectGoFrameworks(repo, dir).length > 0;
			if (!isWeb) continue; // plain Go module → generic adapter
			matches.push({ adapter: "go", rootRel: dir, label: "Go", confidence: 85 });
		}
		return matches;
	},

	scan(repo: RepoFiles, match: StackMatch): StackScan {
		const rootRel = match.rootRel;
		const frameworks = detectGoFrameworks(repo, rootRel);
		const endpoints: EndpointInfo[] = [];
		for (const f of repo.files) {
			if (f.ext !== ".go" || f.path.endsWith("_test.go") || !inDir(rootRel, f.path)) continue;
			const content = readFileCached(f.abs);
			if (!content || !new RegExp(`\\.(${VERBS})\\(\\s*"|\\.HandleFunc\\(`).test(content)) continue;
			endpoints.push(...parseGoRoutes(f.path, content));
		}
		// De-duplicate (method, path) — routes can be referenced from more than one file.
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
			dtos: detectGoDtos(repo, rootRel),
			forms: [],
			cacheSignals: [],
			tests: detectGoTests(repo, rootRel),
		};

		const hasLinter = repo.files.some((f) => /(^|\/)\.golangci\.(yml|yaml|toml)$/.test(f.path));
		const c = (command: string): { command: string; cwd: string } => ({ command, cwd: rootRel });
		const checks: StackChecks = {
			build: c("go build ./..."),
			test: c("go test ./..."),
			lint: c(hasLinter ? "golangci-lint run" : "go vet ./..."),
			dev: c(devCommand(repo, rootRel)),
		};

		const label = frameworks.length ? `Go (${frameworks.join(", ")})` : "Go";
		const stack: StackInfo = {
			adapter: "go",
			label,
			language: "go",
			rootRel,
			packageManager: "go",
			frameworks: ["go", ...frameworks],
			scripts: {},
			checks,
			testRunners: ["go-test"],
			depth: "deep",
		};
		return { stack, bundle, extraSurfaces: [] };
	},
};
