/**
 * Core data model for project-aware-qa.
 *
 * The `Surface` is the central object: an inferred unit of behaviour that QA should
 * care about (a route, a form, an API endpoint, a CRUD flow, a cache risk, a visual
 * page, or a test gap). Every surface carries its own evidence, inferred tests, risk,
 * and known gaps so downstream plan/verify/report steps never have to re-derive them.
 */

export const SURFACE_TYPES = [
	"crud-flow",
	"form",
	"api-endpoint",
	"route",
	"cache-risk",
	"visual-page",
	"test-gap",
] as const;
export type SurfaceType = (typeof SURFACE_TYPES)[number];

export const RISK_LEVELS = ["high", "medium", "low"] as const;
export type Risk = (typeof RISK_LEVELS)[number];

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" | "ALL";

/** A single piece of evidence backing a surface or finding. */
export interface EvidenceItem {
	kind:
		| "file"
		| "route"
		| "endpoint"
		| "form"
		| "dto"
		| "query"
		| "mutation"
		| "invalidation"
		| "storage"
		| "test"
		| "script"
		| "note";
	detail: string;
	/** Repo-relative file path, when the evidence points at a specific file. */
	file?: string;
	line?: number;
}

export type InferredTestKind =
	| "smoke"
	| "route"
	| "form"
	| "api"
	| "cache"
	| "screenshot"
	| "e2e"
	| "unit";

/** A test the surface *should* have, regardless of whether it currently exists. */
export interface InferredTest {
	kind: InferredTestKind;
	description: string;
	/** Whether a matching test was found in the repo. */
	status: "present" | "missing" | "unknown";
}

/** The central surface object (Phase 3). */
export interface Surface {
	id: string;
	type: SurfaceType;
	/** Human-readable label, e.g. "Admin tracks CRUD" or "POST /admin/tracks". */
	title: string;
	entity?: string;
	frontendRoute?: string;
	/** Canonical "METHOD /path" string, e.g. "POST /admin/tracks". */
	backendEndpoint?: string;
	files: string[];
	risk: Risk;
	/** Numeric score (0-100) used to derive `risk`; higher = riskier. */
	riskScore: number;
	riskReasons: string[];
	inferredTests: InferredTest[];
	evidence: EvidenceItem[];
	gaps: string[];
}

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun" | "unknown";

/** Project-level facts shared across all surfaces. */
/** A runnable check command and the directory it runs in (language-agnostic). */
export interface CheckCommand {
	/** Full command line, e.g. "npm run --silent typecheck", "mix test", "go test ./...". */
	command: string;
	/** Repo-relative working directory ("" = repo root). */
	cwd: string;
}

export type CheckKind = "typecheck" | "lint" | "test" | "build" | "dev";
export type StackChecks = Partial<Record<CheckKind, CheckCommand>>;

/**
 * A single technology stack detected in the repo (a repo may contain several - e.g. a
 * Node frontend + a Phoenix backend in a monorepo). Produced by a StackAdapter.
 */
export interface StackInfo {
	/** Adapter id that produced this, e.g. "node", "phoenix", "generic". */
	adapter: string;
	/** Human label, e.g. "Node (npm)", "Elixir / Phoenix", "Go". */
	label: string;
	/** Language id, e.g. "typescript", "elixir", "go", "rust", "python". */
	language: string;
	/** Repo-relative root of this stack ("" = repo root). */
	rootRel: string;
	packageManager: string;
	frameworks: string[];
	/** Build-file scripts (npm scripts / mix aliases / make targets), when discoverable. */
	scripts: Record<string, string>;
	/** Runnable checks as full commands (the verifier runs these directly). */
	checks: StackChecks;
	testRunners: string[];
	/** Whether a deep adapter parsed real surfaces, or this is a generic baseline. */
	depth: "deep" | "generic";
}

export interface ProjectInfo {
	name?: string;
	root: string;
	/** Primary (highest-confidence) stack's package manager, for at-a-glance reporting. */
	packageManager: PackageManager;
	/** Aggregated framework ids across all stacks, e.g. "react-router", "nestjs", "phoenix". */
	frameworks: string[];
	/** Primary stack's build-file scripts. */
	scripts: Record<string, string>;
	testRunners: string[];
	/** Repo-relative build-file paths discovered (package.json, mix.exs, go.mod, ...). */
	packageJsonPaths: string[];
	dependencies: Record<string, string>;
	/** Every detected stack (length 1 for a single-language repo). */
	stacks: StackInfo[];
}

export interface RegistryStats {
	totalFiles: number;
	scannedFiles: number;
	surfaces: number;
	byType: Record<string, number>;
	byRisk: Record<Risk, number>;
}

/** The full artifact written to `.qa/surface-registry.json`. */
export interface SurfaceRegistry {
	team?: import("./team-insights.js").TeamInsights;
	schema: string;
	version: string;
	generatedAt: string;
	tool: { name: string; version: string };
	project: ProjectInfo;
	surfaces: Surface[];
	stats: RegistryStats;
	/** Source snapshot associated with a scan; old registries require a fresh scan. */
	provenance?: ProjectFingerprint;
}

export interface ProjectFingerprint {
	inputHash: string;
	commit: string | null;
	files: number;
	/** False when discovery/read limits prevented a complete input snapshot. */
	complete: boolean;
	issues?: string[];
}

export const SCHEMA_ID = "https://project-aware-qa/schemas/surface-registry.json";
export const REGISTRY_VERSION = "1";
