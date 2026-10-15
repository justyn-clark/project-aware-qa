import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { localInput, type Suppression, type TeamConfig } from "./team-config.js";
import type { SurfaceRegistry } from "./types.js";
import { TOOL } from "./version.js";

export const OWNER_FILES = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];
export interface Ownership {
	file?: string;
	warnings: string[];
	bySurface: Record<string, string[]>;
}

function ownerPattern(pattern: string): RegExp | undefined {
	if (/[![\]\\]/.test(pattern)) return undefined;
	const anchored = pattern.startsWith("/") || pattern.replace(/\/$/, "").includes("/");
	const directory = pattern.endsWith("/");
	const path = pattern.replace(/^\//, "").replace(/\/$/, "");
	let expression = "";
	for (let i = 0; i < path.length; i++) {
		const char = path[i] as string;
		if (char === "*" && path[i + 1] === "*") {
			i++;
			if (path[i + 1] === "/") {
				expression += "(?:.*/)?";
				i++;
			} else expression += ".*";
		} else if (char === "*") expression += "[^/]*";
		else if (char === "?") expression += "[^/]";
		else expression += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}
	// Wildcard file patterns match one level; literal directories cover their descendants.
	return new RegExp(
		`${anchored ? "^" : "(?:^|/)"}${expression}${directory ? "/" : /[*?]/.test(path) ? "$" : "(?:/|$)"}`,
	);
}

/** Local checkout ownership hints; account permissions and PR base-branch rules remain GitHub's job. */
export function readOwnership(root: string, registry: SurfaceRegistry): Ownership {
	const file = OWNER_FILES.find((path) => existsSync(resolve(root, path)));
	const result: Ownership = { file, warnings: [], bySurface: {} };
	if (!file) return result;
	const source = readFileSync(localInput(root, file, 3 * 1024 * 1024 - 1), "utf8");
	const rules: Array<{ pattern: RegExp; owners: string[] }> = [];
	for (const [index, raw] of source.split(/\r?\n/).entries()) {
		const line = raw.split("#", 1)[0]?.trim();
		if (!line) continue;
		const [path, ...owners] = line.split(/\s+/);
		const pattern = ownerPattern(path as string);
		if (
			!pattern ||
			owners.some((owner) => !/^(@[\w-]+(?:\/[\w.-]+)?|[^\s@]+@[^\s@]+\.[^\s@]+)$/.test(owner))
		) {
			result.warnings.push(`${file}:${index + 1}: unsupported pattern or invalid owner syntax`);
			continue;
		}
		rules.push({ pattern, owners });
	}
	for (const surface of registry.surfaces) {
		const owners = new Set<string>();
		const files = [
			...new Set([
				...surface.files,
				...surface.evidence.flatMap((entry) => (entry.file ? [entry.file] : [])),
			]),
		];
		for (const file of files) {
			let matching: string[] = [];
			for (const rule of rules) if (rule.pattern.test(file)) matching = rule.owners;
			for (const owner of matching) owners.add(owner);
		}
		result.bySurface[surface.id] = [...owners].sort();
	}
	return result;
}

export interface Baseline {
	version: 1;
	toolVersion: string;
	generatedAt: string;
	sourceHash: string;
	surfaces: Array<{ id: string; riskScore: number; gaps: string[] }>;
}
export interface BaselineComparison {
	path: string;
	new: string[];
	resolved: string[];
	worsened: string[];
	improved: string[];
	unchanged: string[];
	newHighRisk: string[];
}
export interface TeamInsights {
	ownership: Ownership;
	suppressions: Array<Suppression & { status: "active" | "expired" | "unmatched" }>;
	baseline?: BaselineComparison;
}

export function createBaseline(registry: SurfaceRegistry): Baseline {
	if (!registry.provenance?.complete)
		throw new Error("A baseline requires a complete source snapshot. Scan again.");
	return {
		version: 1,
		toolVersion: TOOL.version,
		generatedAt: registry.generatedAt,
		sourceHash: registry.provenance.inputHash,
		surfaces: registry.surfaces
			.map(({ id, riskScore, gaps }) => ({ id, riskScore, gaps: [...gaps].sort() }))
			.sort((a, b) => a.id.localeCompare(b.id)),
	};
}

export function analyzeTeam(
	root: string,
	registry: SurfaceRegistry,
	config: TeamConfig,
	now = new Date(),
): TeamInsights {
	const surfaces = new Map(registry.surfaces.map((surface) => [surface.id, surface]));
	const suppressions: TeamInsights["suppressions"] = config.suppressions.map((entry) => ({
		...entry,
		status:
			entry.expires < now.toISOString().slice(0, 10)
				? "expired"
				: surfaces.get(entry.surfaceId)?.gaps.includes(entry.gap)
					? "active"
					: "unmatched",
	}));
	const result: TeamInsights = { ownership: readOwnership(root, registry), suppressions };
	if (!config.baseline) return result;
	const baseline = JSON.parse(readFileSync(localInput(root, config.baseline), "utf8")) as Baseline;
	if (
		baseline.version !== 1 ||
		baseline.toolVersion !== TOOL.version ||
		!/^[a-f0-9]{64}$/.test(baseline.sourceHash ?? "") ||
		!Array.isArray(baseline.surfaces)
	)
		throw new Error("Invalid or incompatible baseline; regenerate it with this tool version.");
	const old = new Map<string, Baseline["surfaces"][number]>();
	for (const entry of baseline.surfaces) {
		if (
			!entry ||
			typeof entry.id !== "string" ||
			!entry.id ||
			old.has(entry.id) ||
			!Number.isFinite(entry.riskScore) ||
			entry.riskScore < 0 ||
			entry.riskScore > 100 ||
			!Array.isArray(entry.gaps) ||
			entry.gaps.some((gap) => typeof gap !== "string")
		)
			throw new Error("Invalid or duplicate baseline surface");
		old.set(entry.id, entry);
	}
	const comparison: BaselineComparison = {
		path: config.baseline,
		new: [],
		resolved: [...old.keys()].filter((id) => !surfaces.has(id)),
		worsened: [],
		improved: [],
		unchanged: [],
		newHighRisk: [],
	};
	for (const surface of registry.surfaces) {
		const previous = old.get(surface.id);
		const worsened =
			previous &&
			(surface.riskScore > previous.riskScore ||
				surface.gaps.some((gap) => !previous.gaps.includes(gap)));
		if (!previous) comparison.new.push(surface.id);
		else if (worsened) comparison.worsened.push(surface.id);
		else if (
			surface.riskScore < previous.riskScore ||
			previous.gaps.some((gap) => !surface.gaps.includes(gap))
		)
			comparison.improved.push(surface.id);
		else comparison.unchanged.push(surface.id);
		const accepted =
			surface.gaps.length > 0 &&
			surface.gaps.every((gap) =>
				suppressions.some(
					(entry) =>
						entry.status === "active" && entry.surfaceId === surface.id && entry.gap === gap,
				),
			);
		if ((!previous || worsened) && surface.risk === "high" && !accepted)
			comparison.newHighRisk.push(surface.id);
	}
	result.baseline = comparison;
	return result;
}

export function renderTeamReport(insights: TeamInsights): string {
	const lines = [
		"# Team QA review",
		"",
		"Ownership is from this checkout. Suppressions accept specific advisory gaps; they never turn a failed check into a pass.",
		"",
		"## Ownership",
		"",
		`Source: ${insights.ownership.file ?? "No CODEOWNERS file found"}`,
	];
	for (const [id, owners] of Object.entries(insights.ownership.bySurface))
		lines.push(`- ${id}: ${owners.join(", ") || "unassigned"}`);
	lines.push(...insights.ownership.warnings.map((warning) => `- Warning: ${warning}`));
	lines.push("", "## Suppressions", "");
	for (const entry of insights.suppressions)
		lines.push(
			`- **${entry.status}** ${entry.surfaceId} | ${entry.gap} | ${entry.owner} | expires ${entry.expires} UTC | ${entry.reason}`,
		);
	if (!insights.suppressions.length) lines.push("None.");
	if (insights.baseline) {
		lines.push("", `## Baseline: ${insights.baseline.path}`, "");
		for (const key of [
			"new",
			"resolved",
			"worsened",
			"improved",
			"unchanged",
			"newHighRisk",
		] as const)
			lines.push(
				`- ${key}: ${insights.baseline[key].length}${insights.baseline[key].length ? ` (${insights.baseline[key].join(", ")})` : ""}`,
			);
	}
	return `${lines.join("\n")}\n`;
}
