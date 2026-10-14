import type { CheckResult } from "./verify/index.js";

export interface VerificationPolicy {
	requiredChecks: string[];
	failOnIncomplete: boolean;
}

export interface PolicyEvaluation extends VerificationPolicy {
	passed: boolean;
	violations: string[];
}

export function normalizeRequiredChecks(checks: string[]): string[] {
	const normalized = checks.map((check) => check.trim().toLowerCase()).filter(Boolean);
	for (const check of normalized) {
		if (!/^[a-z0-9][a-z0-9._:-]*$/.test(check)) {
			throw new Error(`Invalid required check ${JSON.stringify(check)}.`);
		}
	}
	return [...new Set(normalized)];
}

function matchesRequirement(checkId: string, requirement: string): boolean {
	return (
		checkId === requirement ||
		checkId.startsWith(`${requirement}-`) ||
		checkId.startsWith(`${requirement}:`)
	);
}

/** Evaluate explicit CI policy without changing the underlying check statuses. */
export function evaluatePolicy(
	checks: CheckResult[],
	policy: VerificationPolicy,
): PolicyEvaluation {
	const requiredChecks = normalizeRequiredChecks(policy.requiredChecks);
	const violations: string[] = [];
	for (const requirement of requiredChecks) {
		const matches = checks.filter((check) => matchesRequirement(check.id, requirement));
		if (!matches.length) {
			violations.push(`Required check ${requirement} did not run.`);
			continue;
		}
		for (const check of matches) {
			if (check.status !== "passed") {
				violations.push(`Required check ${check.id} was ${check.status}.`);
			}
		}
	}
	if (policy.failOnIncomplete) {
		for (const check of checks) {
			if (check.status === "skipped" || check.status === "inconclusive") {
				violations.push(`Check ${check.id} was ${check.status}.`);
			}
		}
	}
	return {
		requiredChecks,
		failOnIncomplete: policy.failOnIncomplete,
		passed: !violations.length,
		violations,
	};
}
