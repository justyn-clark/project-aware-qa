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

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "ALL";

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
export interface ProjectInfo {
	name?: string;
	root: string;
	packageManager: PackageManager;
	/** Detected framework ids, e.g. "react-router", "nestjs", "playwright". */
	frameworks: string[];
	/** npm scripts from package.json (merged across discovered package.json files). */
	scripts: Record<string, string>;
	/** Script name → command, for the checks the verifier knows how to run. */
	checks: {
		typecheck?: string;
		lint?: string;
		test?: string;
		build?: string;
		dev?: string;
	};
	testRunners: string[];
	/** Repo-relative package.json paths discovered. */
	packageJsonPaths: string[];
	dependencies: Record<string, string>;
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
	schema: string;
	version: string;
	generatedAt: string;
	tool: { name: string; version: string };
	project: ProjectInfo;
	surfaces: Surface[];
	stats: RegistryStats;
}

export const SCHEMA_ID = "https://project-aware-qa/schemas/surface-registry.json";
export const REGISTRY_VERSION = "1";
