/**
 * Lightweight structural validation for the surface registry.
 *
 * We avoid a heavyweight JSON-Schema runtime dependency: this validator checks the same
 * contract that `templates/surface-registry.schema.json` documents (required fields,
 * enum membership, array shapes) and returns precise paths for every violation. The
 * verifier runs this so a malformed registry is caught with evidence.
 */
import { RISK_LEVELS, SURFACE_TYPES, type SurfaceRegistry } from "../types.js";

export interface ValidationError {
	path: string;
	message: string;
}

export interface ValidationResult {
	valid: boolean;
	errors: ValidationError[];
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function validateRegistry(input: unknown): ValidationResult {
	const errors: ValidationError[] = [];
	const err = (path: string, message: string) => errors.push({ path, message });

	if (!isObject(input)) {
		return { valid: false, errors: [{ path: "$", message: "registry must be an object" }] };
	}

	for (const key of ["schema", "version", "generatedAt"] as const) {
		if (typeof input[key] !== "string") err(`$.${key}`, "expected string");
	}
	if (!isObject(input.project)) {
		err("$.project", "expected object");
	} else {
		const p = input.project;
		if (typeof p.root !== "string") err("$.project.root", "expected string");
		if (typeof p.packageManager !== "string") err("$.project.packageManager", "expected string");
		if (!Array.isArray(p.frameworks)) err("$.project.frameworks", "expected array");
		if (!isObject(p.scripts)) err("$.project.scripts", "expected object");
	}

	const surfaces = input.surfaces;
	if (!Array.isArray(surfaces)) {
		err("$.surfaces", "expected array");
		return { valid: errors.length === 0, errors };
	}

	const ids = new Set<string>();
	const surfaceTypes = new Set<string>(SURFACE_TYPES);
	const riskLevels = new Set<string>(RISK_LEVELS);

	surfaces.forEach((s, i) => {
		const at = `$.surfaces[${i}]`;
		if (!isObject(s)) {
			err(at, "expected object");
			return;
		}
		if (typeof s.id !== "string" || !s.id) err(`${at}.id`, "expected non-empty string");
		else {
			if (ids.has(s.id)) err(`${at}.id`, `duplicate id "${s.id}"`);
			ids.add(s.id);
		}
		if (typeof s.type !== "string" || !surfaceTypes.has(s.type)) {
			err(`${at}.type`, `must be one of ${[...surfaceTypes].join(", ")}`);
		}
		if (typeof s.title !== "string") err(`${at}.title`, "expected string");
		if (typeof s.risk !== "string" || !riskLevels.has(s.risk)) {
			err(`${at}.risk`, `must be one of ${[...riskLevels].join(", ")}`);
		}
		if (typeof s.riskScore !== "number") err(`${at}.riskScore`, "expected number");
		if (!Array.isArray(s.files)) err(`${at}.files`, "expected array");
		if (!Array.isArray(s.riskReasons)) err(`${at}.riskReasons`, "expected array");
		if (!Array.isArray(s.gaps)) err(`${at}.gaps`, "expected array");
		if (!Array.isArray(s.evidence)) err(`${at}.evidence`, "expected array");
		if (!Array.isArray(s.inferredTests)) {
			err(`${at}.inferredTests`, "expected array");
		} else {
			s.inferredTests.forEach((t, j) => {
				if (!isObject(t)) {
					err(`${at}.inferredTests[${j}]`, "expected object");
					return;
				}
				if (typeof t.description !== "string")
					err(`${at}.inferredTests[${j}].description`, "expected string");
				if (!["present", "missing", "unknown"].includes(String(t.status))) {
					err(`${at}.inferredTests[${j}].status`, "must be present|missing|unknown");
				}
			});
		}
	});

	if (!isObject(input.stats)) err("$.stats", "expected object");

	return { valid: errors.length === 0, errors };
}

/** Assert helper for scripts: throws with a readable message when invalid. */
export function assertValidRegistry(registry: SurfaceRegistry): void {
	const { valid, errors } = validateRegistry(registry);
	if (!valid) {
		const detail = errors
			.slice(0, 20)
			.map((e) => `  - ${e.path}: ${e.message}`)
			.join("\n");
		throw new Error(`Surface registry failed validation:\n${detail}`);
	}
}
