/**
 * Cache & invalidation signal detection (Phase 8).
 *
 * Stale-data bugs hide in the gap between a mutation and the cache it should invalidate.
 * We surface every relevant signal so inference can pair mutations with (missing)
 * invalidations:
 *  - TanStack Query: useQuery / useMutation / invalidateQueries / setQueryData
 *  - SWR: useSWR / mutate
 *  - Remix & React Router: loader / action / useRevalidator / shouldRevalidate
 *  - cachified-style server caches: cachified(...) / clearCacheKey(...)
 *  - NestJS backend cache: CacheInterceptor / @CacheKey / cacheManager.del
 *  - Browser storage: localStorage / sessionStorage / useLocalStorage
 */
import type { RepoFiles } from "../scanner/files.js";
import { grepContent, readFileCached } from "../scanner/files.js";
import { entityFromSegments } from "./entities.js";
import type { CacheSignal, CacheSignalKind } from "./types.js";

interface Pattern {
	re: RegExp;
	kind: CacheSignalKind;
	library: string;
	/** Group index (1-based) holding a cache/query key, when present. */
	keyGroup?: number;
	label: (groups: string[]) => string;
}

const PATTERNS: Pattern[] = [
	// TanStack Query
	{
		re: /\buseQuery\s*(?:<[^>]*>)?\(\s*\{?\s*(?:queryKey\s*:\s*(\[[^\]]*\]|['"`][^'"`]+['"`]))?/,
		kind: "query",
		library: "tanstack-query",
		keyGroup: 1,
		label: (g) => `useQuery${g[0] ? ` key=${g[0]}` : ""}`,
	},
	{
		re: /\buseMutation\s*(?:<[^>]*>)?\(/,
		kind: "mutation",
		library: "tanstack-query",
		label: () => "useMutation",
	},
	{
		re: /\.invalidateQueries\s*\(\s*\{?\s*(?:queryKey\s*:\s*)?(\[[^\]]*\]|['"`][^'"`]+['"`])?/,
		kind: "invalidation",
		library: "tanstack-query",
		keyGroup: 1,
		label: (g) => `invalidateQueries${g[0] ? ` ${g[0]}` : ""}`,
	},
	{
		re: /\.setQueryData\s*\(\s*(\[[^\]]*\]|['"`][^'"`]+['"`])?/,
		kind: "invalidation",
		library: "tanstack-query",
		keyGroup: 1,
		label: (g) => `setQueryData${g[0] ? ` ${g[0]}` : ""}`,
	},
	// SWR
	{
		re: /\buseSWR\s*(?:<[^>]*>)?\(\s*(['"`][^'"`]+['"`]|\[[^\]]*\])?/,
		kind: "query",
		library: "swr",
		keyGroup: 1,
		label: (g) => `useSWR${g[0] ? ` key=${g[0]}` : ""}`,
	},
	{
		re: /(?:^|[^A-Za-z0-9_])mutate\s*\(\s*(['"`][^'"`]+['"`]|\[[^\]]*\])?/,
		kind: "invalidation",
		library: "swr",
		keyGroup: 1,
		label: (g) => `mutate${g[0] ? ` ${g[0]}` : ""}`,
	},
	// Remix / React Router revalidation
	{
		re: /\buseRevalidator\s*\(/,
		kind: "revalidation",
		library: "react-router",
		label: () => "useRevalidator",
	},
	{
		re: /\bshouldRevalidate\b/,
		kind: "revalidation",
		library: "react-router",
		label: () => "shouldRevalidate",
	},
	// cachified-style server cache
	{
		re: /\bcachified\s*\(\s*\{?\s*(?:[^}]*?\bkey\s*:\s*(['"`][^'"`]+['"`]|`[^`]+`))?/s,
		kind: "cachified",
		library: "cachified",
		keyGroup: 1,
		label: (g) => `cachified${g[0] ? ` key=${g[0]}` : ""}`,
	},
	{
		re: /\bclearCacheKey\s*\(\s*(['"`][^'"`]+['"`]|`[^`]+`)?/,
		kind: "cache-clear",
		library: "cachified",
		keyGroup: 1,
		label: (g) => `clearCacheKey${g[0] ? ` ${g[0]}` : ""}`,
	},
	{
		re: /\bcache\.(?:delete|del|clear)\s*\(\s*(['"`][^'"`]+['"`]|`[^`]+`)?/,
		kind: "cache-clear",
		library: "cache",
		keyGroup: 1,
		label: (g) => `cache.delete${g[0] ? ` ${g[0]}` : ""}`,
	},
	// NestJS backend cache
	{
		re: /\bCacheInterceptor\b/,
		kind: "backend-cache",
		library: "nestjs-cache-manager",
		label: () => "CacheInterceptor",
	},
	{
		re: /@CacheKey\s*\(\s*(['"`][^'"`]+['"`])?/,
		kind: "backend-cache",
		library: "nestjs-cache-manager",
		keyGroup: 1,
		label: (g) => `@CacheKey${g[0] ? ` ${g[0]}` : ""}`,
	},
	{
		re: /\bcacheManager\.(?:del|reset|set|store)\b/,
		kind: "backend-cache",
		library: "nestjs-cache-manager",
		label: () => "cacheManager mutation",
	},
	// Browser storage
	{
		re: /\b(?:window\.)?(localStorage|sessionStorage)\.(?:setItem|getItem|removeItem)\s*\(\s*(['"`][^'"`]+['"`])?/,
		kind: "storage",
		library: "web-storage",
		keyGroup: 2,
		label: (g) => `${g[0] || "storage"}${g[1] ? ` ${g[1]}` : ""}`,
	},
	{
		re: /\buse(?:Local|Session)Storage\s*(?:<[^>]*>)?\(\s*(['"`][^'"`]+['"`])?/,
		kind: "storage",
		library: "web-storage-hook",
		keyGroup: 1,
		label: (g) => `useLocalStorage${g[0] ? ` ${g[0]}` : ""}`,
	},
];

function cleanKey(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	return raw.replace(/^[`'"]|[`'"]$/g, "").trim() || undefined;
}

export function detectCacheSignals(repo: RepoFiles): CacheSignal[] {
	const signals: CacheSignal[] = [];
	for (const f of repo.files) {
		if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f.path)) continue;
		const content = readFileCached(f.abs);
		if (!content) continue;
		// Cheap pre-filter: skip files with no cache-ish tokens at all.
		if (
			!/Query|invalidateQueries|useSWR|mutate|cachified|clearCacheKey|Cache|localStorage|sessionStorage|Revalidat|revalidat/.test(
				content,
			)
		) {
			continue;
		}
		const entity = entityFromSegments(f.path.split(/[/.]/));
		for (const pat of PATTERNS) {
			const re = new RegExp(
				pat.re.source,
				pat.re.flags.includes("g") ? pat.re.flags : `${pat.re.flags}g`,
			);
			for (const m of grepContent(f.path, content, re)) {
				const keyRaw = pat.keyGroup ? m.groups[pat.keyGroup - 1] : undefined;
				signals.push({
					kind: pat.kind,
					library: pat.library,
					detail: pat.label(m.groups),
					file: f.path,
					line: m.line,
					key: cleanKey(keyRaw),
					entity,
				});
			}
		}
	}
	return signals;
}
