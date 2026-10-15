/**
 * Entity-name normalization shared across detectors and inference.
 *
 * Entity names are the glue that maps a frontend route ("/admin/tracks") to a backend
 * controller (@Controller('track')) to a form to a cache key. We normalize aggressively
 * (kebab/camel/snake -> words, plural -> singular) so "tracks", "Track", "track-genre"
 * collapse onto comparable keys.
 */

const STOPWORDS = new Set([
	"admin",
	"dashboard",
	"api",
	"app",
	"routes",
	"route",
	"index",
	"new",
	"edit",
	"create",
	"update",
	"delete",
	"list",
	"detail",
	"details",
	"view",
	"show",
	"manage",
	"management",
	"layout",
	"page",
	"pages",
	"src",
	"modules",
	"module",
	"controller",
	"controllers",
	"service",
	"services",
	"dto",
	"dtos",
	"id",
	"slug",
	"form",
	"forms",
	"component",
	"components",
	"ui",
	"utils",
	"util",
	"lib",
	"libs",
	"hook",
	"hooks",
	"helper",
	"helpers",
	"common",
	"shared",
	"server",
	"client",
	"spec",
	"test",
	"tests",
	// file extensions (segments after splitting paths on ".")
	"ts",
	"tsx",
	"js",
	"jsx",
	"mjs",
	"cjs",
	"vue",
	"svelte",
	"_",
	"",
]);

/** Split an identifier of any case style into lowercase words. */
export function words(input: string): string[] {
	return input
		.replace(/\.(route|controller|service|dto|spec|test|tsx?|jsx?)$/i, "")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.split(/[^a-zA-Z0-9]+/)
		.map((w) => w.toLowerCase())
		.filter(Boolean);
}

/** Naive English singularization - good enough for entity matching. */
export function singularize(word: string): string {
	const w = word.toLowerCase();
	if (w.length <= 3) return w;
	if (w.endsWith("ies")) return `${w.slice(0, -3)}y`;
	if (
		w.endsWith("ses") ||
		w.endsWith("xes") ||
		w.endsWith("zes") ||
		w.endsWith("ches") ||
		w.endsWith("shes")
	) {
		return w.slice(0, -2);
	}
	if (w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
	return w;
}

/** A stable comparison key for an entity (singular, lowercase, no separators). */
export function entityKey(name: string): string {
	return singularize(words(name).join(""));
}

/**
 * Extract the most likely entity from a list of path/identifier segments, skipping
 * stopwords and dynamic params. Returns the last meaningful noun, singularized.
 */
export function entityFromSegments(segments: string[]): string | undefined {
	const candidates: string[] = [];
	for (const seg of segments) {
		for (const w of words(seg)) {
			if (STOPWORDS.has(w)) continue;
			if (/^\d+$/.test(w)) continue;
			candidates.push(w);
		}
	}
	if (candidates.length === 0) return undefined;
	// Prefer the last meaningful word; it's usually the entity (e.g. ".../playlist/new").
	const last = candidates[candidates.length - 1] as string;
	return singularize(last);
}

/** Derive an entity from a NestJS controller prefix like 'album' or 'artist-track'. */
export function entityFromControllerPrefix(prefix: string): string | undefined {
	const cleaned = prefix.replace(/^\/+|\/+$/g, "");
	const first = cleaned.split("/")[0] ?? "";
	const e = entityFromSegments([first]);
	return e;
}

/** Title-case a singular entity for display ("track" -> "Track"). */
export function entityTitle(entity: string): string {
	return entity
		.split(/[^a-zA-Z0-9]+/)
		.filter(Boolean)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");
}

/** True when two entity names refer to the same thing. */
export function sameEntity(a: string | undefined, b: string | undefined): boolean {
	if (!a || !b) return false;
	return entityKey(a) === entityKey(b);
}
