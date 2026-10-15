import { dirname } from "node:path";
import { type RepoFiles, readFileCached } from "./files.js";

export interface RuntimeDeclaration {
	runtime: string;
	file: string;
	rootRel: string;
	role: "package-manager" | "runtime-config" | "script" | "language";
	detail: string;
}
export interface InfrastructureDeclaration {
	provider: string;
	file: string;
	environment: string;
	level: "marker" | "declared" | "partial";
	resources: { type: string; name: string }[];
	note: string;
}
/** Remove JSONC comments/trailing commas without altering quoted strings. Never evaluates config. */
export function parseJsonConfig(source: string): Record<string, unknown> {
	let out = "",
		quoted = false,
		escaped = false;
	for (let i = 0; i < source.length; i++) {
		const c = source[i] as string;
		if (quoted) {
			out += c;
			if (escaped) escaped = false;
			else if (c === "\\") escaped = true;
			else if (c === '"') quoted = false;
			continue;
		}
		if (c === '"') {
			quoted = true;
			out += c;
			continue;
		}
		if (c === "/" && source[i + 1] === "/") {
			while (i < source.length && source[i] !== "\n") i++;
			out += "\n";
			continue;
		}
		if (c === "/" && source[i + 1] === "*") {
			const end = source.indexOf("*/", i + 2);
			if (end < 0) throw Error("Unterminated JSONC comment");
			out += " ";
			i = end + 1;
			continue;
		}
		out += c;
	}
	let cleaned = "";
	quoted = false;
	escaped = false;
	for (let i = 0; i < out.length; i++) {
		const c = out[i] as string;
		if (quoted) {
			cleaned += c;
			if (escaped) escaped = false;
			else if (c === "\\") escaped = true;
			else if (c === '"') quoted = false;
			continue;
		}
		if (c === '"') quoted = true;
		if (c === "," && /^\s*[}\]]/.test(out.slice(i + 1))) continue;
		cleaned += c;
	}
	const value = JSON.parse(cleaned);
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw Error("Expected configuration object");
	return value;
}
export function discoverPlatforms(repo: RepoFiles): {
	runtimes: RuntimeDeclaration[];
	infrastructure: InfrastructureDeclaration[];
} {
	const runtimes: RuntimeDeclaration[] = [];
	const infrastructure: InfrastructureDeclaration[] = [];
	const bindings = [
		"kv_namespaces",
		"r2_buckets",
		"d1_databases",
		"services",
		"durable_objects",
		"queues",
		"triggers",
		"workflows",
		"analytics_engine_datasets",
		"hyperdrive",
		"ai",
		"browser",
	];
	for (const file of repo.files) {
		const base = file.path.split("/").at(-1) as string;
		const rootRel = dirname(file.path) === "." ? "" : dirname(file.path);
		const source = readFileCached(file.abs) ?? "";
		const runtime = (name: string, role: RuntimeDeclaration["role"], detail: string) =>
			runtimes.push({ runtime: name, file: file.path, rootRel, role, detail });
		if (base === "bun.lock" || base === "bun.lockb")
			runtime("bun", "package-manager", "Bun lockfile; does not establish application runtime");
		if (base === "bunfig.toml")
			runtime("bun", "runtime-config", "Bun configuration; runtime version unverified");
		if (base === "deno.json" || base === "deno.jsonc")
			runtime("deno", "runtime-config", "Deno configuration; runtime version unverified");
		if (base === "go.mod")
			runtime(
				"go",
				"language",
				`Declared Go version: ${/^go\s+(\S+)/m.exec(source)?.[1] ?? "unknown"}`,
			);
		if (base === "package.json") {
			try {
				const pkg = JSON.parse(source);
				if (typeof pkg.packageManager === "string" && pkg.packageManager.startsWith("bun@"))
					runtime("bun", "package-manager", pkg.packageManager);
				for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
					if (typeof cmd !== "string") continue;
					const match = /^(bun|node|deno)\s/.exec(cmd.trim());
					if (match)
						runtime(match[1] as string, "script", `Script ${name} explicitly invokes ${match[1]}`);
				}
				if (typeof pkg.engines?.node === "string")
					runtime("node", "runtime-config", `engines.node: ${pkg.engines.node}`);
			} catch {
				/* Manifest parser reports no inferred facts for invalid input. */
			}
		}
		if (/^wrangler\.(jsonc?|toml)$/.test(base)) {
			if (base.endsWith(".toml")) {
				const resources: { type: string; name: string }[] = [];
				let section = "default";
				for (const line of source.split(/\r?\n/)) {
					const header = /^\s*\[\[?([\w.]+)\]\]?\s*(?:#.*)?$/.exec(line);
					if (header) section = header[1] as string;
					const binding = /^\s*(?:binding|name)\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/.exec(line);
					if (binding && bindings.some((b) => section.split(".").includes(b)))
						resources.push({ type: section, name: binding[1] as string });
				}
				infrastructure.push({
					provider: "cloudflare",
					file: file.path,
					environment: "see section-qualified resources",
					level: "partial",
					resources,
					note: "Literal TOML binding names only; complex TOML, inheritance and deployment state are not resolved.",
				});
			} else {
				try {
					const data = parseJsonConfig(source);
					const env =
						data.env && typeof data.env === "object" && !Array.isArray(data.env)
							? (data.env as Record<string, unknown>)
							: {};
					for (const [environment, config] of [["default", data], ...Object.entries(env)] as [
						string,
						unknown,
					][]) {
						if (!config || typeof config !== "object" || Array.isArray(config)) continue;
						const resources: { type: string; name: string }[] = [];
						for (const key of bindings) {
							const value = (config as Record<string, unknown>)[key];
							const visit = (v: unknown) => {
								if (Array.isArray(v)) {
									for (const entry of v) visit(entry);
								} else if (v && typeof v === "object") {
									const object = v as Record<string, unknown>;
									const name = object.binding ?? object.name ?? object.queue;
									if (typeof name === "string") resources.push({ type: key, name });
									for (const child of ["bindings", "producers", "consumers"])
										if (object[child]) visit(object[child]);
									if (key === "triggers" && Array.isArray(object.crons))
										for (const cron of object.crons)
											if (typeof cron === "string") resources.push({ type: "cron", name: cron });
								}
							};
							if (value) visit(value);
						}
						infrastructure.push({
							provider: "cloudflare",
							file: file.path,
							environment,
							level: "declared",
							resources,
							note: "Explicit configuration only; environment inheritance, secret values and live availability are not inferred.",
						});
					}
				} catch {
					infrastructure.push({
						provider: "cloudflare",
						file: file.path,
						environment: "unknown",
						level: "partial",
						resources: [],
						note: "Configuration could not be parsed; no bindings inferred.",
					});
				}
			}
		}
		const markers: [boolean, string, string][] = [
			[
				base === "cdk.json" ||
					base === "samconfig.toml" ||
					/^serverless\.ya?ml$/.test(base) ||
					(/^template\.ya?ml$/.test(base) && /AWSTemplateFormatVersion|AWS::/.test(source)),
				"aws",
				"AWS deployment configuration marker",
			],
			[
				base.endsWith(".bicep") || base === "host.json" || base === "azure.yaml",
				"azure",
				"Azure deployment configuration marker",
			],
			[
				base === "app.yaml" || base === "cloudbuild.yaml",
				"gcp",
				"Google Cloud configuration marker; confirm provider and environment",
			],
			[
				/^Pulumi\..*ya?ml$/.test(base) || base === "Pulumi.yaml",
				"pulumi",
				"IaC project marker; provider unresolved",
			],
			[
				base.endsWith(".tf"),
				"terraform-opentofu",
				"IaC source; expressions and provider aliases unresolved",
			],
		];
		for (const [matched, provider, note] of markers)
			if (matched)
				infrastructure.push({
					provider,
					file: file.path,
					environment: "unresolved",
					level: "marker",
					resources: [],
					note,
				});
	}
	return { runtimes, infrastructure };
}
export function renderPlatforms(data: ReturnType<typeof discoverPlatforms>): string {
	const lines = [
		"# Runtime and infrastructure declarations",
		"",
		"Source evidence only. Installed runtimes, resource existence and deployment health require verification.",
		"",
		"## Runtimes",
		"",
	];
	for (const r of data.runtimes) lines.push(`- ${r.runtime} (${r.role}) - ${r.file}: ${r.detail}`);
	if (!data.runtimes.length) lines.push("No explicit runtime declarations found.");
	lines.push("", "## Infrastructure", "");
	for (const entry of data.infrastructure) {
		lines.push(
			`- ${entry.provider} / ${entry.environment} [${entry.level}] - ${entry.file}`,
			`  ${entry.note}`,
		);
		for (const resource of entry.resources) lines.push(`  - ${resource.type}: ${resource.name}`);
	}
	if (!data.infrastructure.length)
		lines.push("No supported infrastructure configuration markers found.");
	return `${lines.join("\n")}\n`;
}
