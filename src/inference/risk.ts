/**
 * Risk scoring (Phase 5 input).
 *
 * Additive, explainable scoring: each contributing factor adds points and a reason
 * string, so every risk level can be justified in the report. The thresholds map to the
 * plan's depth tiers (high -> full runtime+form+API+cache+screenshots, medium ->
 * route/API/basic UI, low -> smoke only).
 */
import type { Risk, SurfaceType } from "../types.js";

export interface RiskInput {
	type: SurfaceType;
	isAdmin?: boolean;
	isMutation?: boolean;
	hasForm?: boolean;
	/** A mutation with no detected cache invalidation. */
	staleRisk?: boolean;
	hasTests?: boolean;
	fieldMismatch?: boolean;
	/** CRUD operations covered (0-5). */
	crudCoverage?: number;
	authGated?: boolean;
	usesStorage?: boolean;
	/** Number of distinct files touched (breadth proxy). */
	fileCount?: number;
}

export interface RiskResult {
	score: number;
	level: Risk;
	reasons: string[];
}

const HIGH_THRESHOLD = 60;
const MEDIUM_THRESHOLD = 30;

export function riskLevelFromScore(score: number): Risk {
	if (score >= HIGH_THRESHOLD) return "high";
	if (score >= MEDIUM_THRESHOLD) return "medium";
	return "low";
}

export function scoreRisk(input: RiskInput): RiskResult {
	let score = 0;
	const reasons: string[] = [];
	const add = (points: number, reason: string) => {
		score += points;
		reasons.push(`${reason} (+${points})`);
	};

	// Base weight by surface type.
	const base: Record<SurfaceType, number> = {
		"crud-flow": 25,
		form: 20,
		"api-endpoint": 15,
		"cache-risk": 35,
		route: 8,
		"visual-page": 10,
		"test-gap": 15,
	};
	add(base[input.type], `${input.type} base`);

	if (input.isAdmin) add(20, "admin surface (privileged data)");
	if (input.isMutation) add(15, "mutating operation");
	if (input.hasForm) add(10, "user-editable form");
	if (input.staleRisk) add(25, "mutation without proven cache invalidation");
	if (input.fieldMismatch) add(12, "form/DTO field mismatch");
	if (input.usesStorage) add(8, "depends on browser storage");
	if (input.authGated) add(10, "auth-gated (needs credentials to verify)");

	if (typeof input.crudCoverage === "number") {
		if (input.crudCoverage >= 4) add(10, "broad CRUD surface (4+ operations)");
		else if (input.crudCoverage >= 2) add(5, "multi-operation surface");
	}
	if (typeof input.fileCount === "number" && input.fileCount >= 4) {
		add(5, `spans ${input.fileCount} files`);
	}

	// Tests reduce risk; their absence is itself a risk amplifier.
	if (input.hasTests) add(-15, "existing tests present");
	else reasons.push("no covering tests found (+0)");

	score = Math.max(0, Math.min(100, score));
	return { score, level: riskLevelFromScore(score), reasons };
}
