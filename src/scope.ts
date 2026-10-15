import { RISK_LEVELS, SURFACE_TYPES, type Surface } from "./types.js";

/** One scope contract for planning, plan counts, and runtime route selection. */
export function matchesScope(surface: Surface, scope?: string): boolean {
	const query = scope?.trim().toLowerCase();
	if (!query) return true;
	if (RISK_LEVELS.some((risk) => risk === query)) return surface.risk === query;
	if (SURFACE_TYPES.some((type) => type === query)) return surface.type === query;
	const textMatches = [surface.entity, surface.title, surface.frontendRoute].some((text) =>
		text?.toLowerCase().includes(query),
	);
	if (query === "admin") {
		return textMatches || surface.riskReasons.some((reason) => /admin/i.test(reason));
	}
	return textMatches;
}
