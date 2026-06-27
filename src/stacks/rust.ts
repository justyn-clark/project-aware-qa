/**
 * Rust deep adapter — axum, actix-web, Rocket, warp/poem.
 *
 *  - axum:    `Router::new().route("/path/:id", get(handler).post(other))`
 *  - actix:   `#[get("/path")]` / `#[post("/path")]` attribute macros on handlers
 *  - Rocket:  `#[get("/path")]`, `#[post("/path", data = "<body>")]`
 *  - DTOs:    `#[derive(... Deserialize ...)] struct X { field: T }` (and *Request/*Input)
 *  - tests:   `#[test]` / `#[tokio::test]`; toolchain cargo build/test/clippy
 *
 * A plain Rust crate with no web framework falls through to the generic adapter.
 */
import { entityFromControllerPrefix, entityFromSegments } from "../detectors/entities.js";
import type { DetectionBundle, DtoInfo, EndpointInfo, TestInfo } from "../detectors/types.js";
import { type RepoFiles, readFileCached } from "../scanner/files.js";
import type { HttpMethod, StackChecks, StackInfo } from "../types.js";
import type { StackAdapter, StackMatch, StackScan } from "./types.js";

const WEB = /^\s*(axum|actix-web|rocket|warp|poem|tide|salvo)\b/m;

function inDir(rootRel: string, path: string): boolean {
	return rootRel === "" ? true : path === rootRel || path.startsWith(`${rootRel}/`);
}
function normParams(p: string): string {
	return p.replace(/\{([A-Za-z0-9_]+)(?::[^}]+)?\}/g, ":$1").replace(/<([A-Za-z0-9_]+)>/g, ":$1");
}

export function parseRustRoutes(file: string, content: string): EndpointInfo[] {
	const endpoints: EndpointInfo[] = [];
	const push = (method: HttpMethod, rawPath: string, handler: string, line: number) => {
		const path = normParams(rawPath.startsWith("/") ? rawPath : `/${rawPath}`);
		endpoints.push({
			method,
			path,
			controller: file.split("/").pop() ?? file,
			controllerPrefix: "",
			handler,
			file,
			line,
			entity: entityFromSegments(path.split("/")) ?? entityFromControllerPrefix(handler),
			isAdmin: /(^|\/)admin(\/|$)/.test(path),
			isMutation: method !== "GET",
		});
	};

	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		// axum: .route("/x", get(h).post(h2))
		const r = /\.route\(\s*"([^"]*)"\s*,\s*(.+)\)/.exec(line);
		if (r) {
			const path = r[1] ?? "";
			for (const mm of (r[2] ?? "").matchAll(
				/\b(get|post|put|patch|delete|head|options)\s*\(\s*([A-Za-z0-9_]+)/g,
			)) {
				push((mm[1] as string).toUpperCase() as HttpMethod, path, mm[2] as string, i + 1);
			}
		}
		// actix / Rocket attribute macro: #[get("/x")] then fn handler
		const attr = /^#\[(get|post|put|patch|delete|head|options)\(\s*"([^"]*)"/.exec(line.trim());
		if (attr) {
			const blob = lines.slice(i + 1, i + 6).join("\n");
			const fn = /(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)/.exec(blob);
			push(
				(attr[1] as string).toUpperCase() as HttpMethod,
				attr[2] ?? "",
				fn?.[1] ?? "handler",
				i + 1,
			);
		}
	}
	return endpoints;
}

const DTO_NAME = /(Request|Response|Input|Params|Body|Payload|Dto|Form)$/;

function detectRustDtos(repo: RepoFiles, rootRel: string): DtoInfo[] {
	const dtos: DtoInfo[] = [];
	for (const f of repo.files) {
		if (f.ext !== ".rs" || !inDir(rootRel, f.path)) continue;
		const content = readFileCached(f.abs);
		if (!content || !/struct\s+[A-Z]/.test(content)) continue;
		const lines = content.split("\n");
		let derivedSerde = false;
		for (let i = 0; i < lines.length; i++) {
			const line = (lines[i] ?? "").trim();
			if (/#\[derive\(/.test(line) && /Deserialize|Serialize/.test(line)) derivedSerde = true;
			const open = /^(?:pub\s+)?struct\s+([A-Z][A-Za-z0-9_]*)\s*\{/.exec(line);
			if (!open) {
				if (line && !line.startsWith("#") && !line.startsWith("//")) derivedSerde = false;
				continue;
			}
			const name = open[1] as string;
			if (!derivedSerde && !DTO_NAME.test(name)) {
				derivedSerde = false;
				continue;
			}
			const fields = new Set<string>();
			for (let j = i + 1; j < lines.length && !(lines[j] ?? "").includes("}"); j++) {
				const fm = /^\s*(?:pub\s+)?([a-z_][A-Za-z0-9_]*)\s*:/.exec(lines[j] ?? "");
				if (fm) fields.add(fm[1] as string);
			}
			if (fields.size > 0)
				dtos.push({
					name,
					file: f.path,
					fields: [...fields].map((n) => ({ name: n, validators: [], optional: false })),
				});
			derivedSerde = false;
		}
	}
	return dtos;
}

function detectRustTests(repo: RepoFiles, rootRel: string): TestInfo[] {
	const tests: TestInfo[] = [];
	for (const f of repo.files) {
		if (f.ext !== ".rs" || !inDir(rootRel, f.path)) continue;
		const content = readFileCached(f.abs);
		if (!content || !/#\[(?:tokio::)?test\]|#\[cfg\(test\)\]/.test(content)) continue;
		const isE2e = /(^|\/)tests\//.test(f.path);
		const base = f.path.split("/").pop() ?? f.path;
		tests.push({
			file: f.path,
			kind: isE2e ? "e2e" : "unit",
			runner: "unknown",
			targets: base
				.replace(/\.rs$/, "")
				.split(/[^a-z0-9]+/i)
				.filter(Boolean)
				.map((s) => s.toLowerCase()),
		});
	}
	return tests;
}

function cargoText(repo: RepoFiles, rootRel: string): string {
	const f = repo.files.find((x) => x.path === (rootRel ? `${rootRel}/Cargo.toml` : "Cargo.toml"));
	return f ? (readFileCached(f.abs) ?? "") : "";
}

export const rustAdapter: StackAdapter = {
	id: "rust",
	name: "Rust (axum / actix / Rocket)",
	kind: "deep",
	extensions: [".rs"],
	markers: ["Cargo.toml"],

	detect(repo: RepoFiles): StackMatch[] {
		const matches: StackMatch[] = [];
		for (const f of repo.files) {
			if (!(f.path === "Cargo.toml" || f.path.endsWith("/Cargo.toml"))) continue;
			if (!WEB.test(readFileCached(f.abs) ?? "")) continue; // plain crate → generic
			const dir = f.path === "Cargo.toml" ? "" : f.path.slice(0, -"/Cargo.toml".length);
			matches.push({ adapter: "rust", rootRel: dir, label: "Rust", confidence: 85 });
		}
		return matches;
	},

	scan(repo: RepoFiles, match: StackMatch): StackScan {
		const rootRel = match.rootRel;
		const cargo = cargoText(repo, rootRel);
		const fw = ["axum", "actix-web", "rocket", "warp", "poem"].filter((n) =>
			new RegExp(`^\\s*${n}\\b`, "m").test(cargo),
		);
		const endpoints: EndpointInfo[] = [];
		for (const f of repo.files) {
			if (f.ext !== ".rs" || !inDir(rootRel, f.path)) continue;
			const content = readFileCached(f.abs);
			if (!content || !/\.route\(|#\[(get|post|put|patch|delete)\(/.test(content)) continue;
			endpoints.push(...parseRustRoutes(f.path, content));
		}
		const bundle: DetectionBundle = {
			routes: [],
			endpoints,
			dtos: detectRustDtos(repo, rootRel),
			forms: [],
			cacheSignals: [],
			tests: detectRustTests(repo, rootRel),
		};
		const c = (command: string) => ({ command, cwd: rootRel });
		const checks: StackChecks = {
			build: c("cargo build"),
			test: c("cargo test"),
			lint: c("cargo clippy"),
			dev: c("cargo run"),
		};
		const stack: StackInfo = {
			adapter: "rust",
			label: fw.length ? `Rust (${fw.join(", ")})` : "Rust",
			language: "rust",
			rootRel,
			packageManager: "cargo",
			frameworks: ["rust", ...fw],
			scripts: {},
			checks,
			testRunners: ["cargo-test"],
			depth: "deep",
		};
		return { stack, bundle, extraSurfaces: [] };
	},
};
