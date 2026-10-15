/**
 * CRUD / admin flow inference (Phase 4).
 *
 * Correlates the per-layer detector outputs into entity-centric flows:
 *  - groups routes, endpoints, forms and DTOs by normalized entity
 *  - classifies create/read/list/update/delete coverage
 *  - maps each form to its most likely endpoint and diffs form fields vs DTO fields
 *  - pairs mutations with cache invalidations and flags the ones missing it
 *
 * Heuristics: an entity is a "CRUD flow" when it has admin routes or mutating endpoints.
 */

import { entityKey, entityTitle, sameEntity, singularize, words } from "../detectors/entities.js";
import type {
	CacheSignal,
	DtoInfo,
	EndpointInfo,
	FormInfo,
	RouteInfo,
} from "../detectors/types.js";
import type { HttpMethod } from "../types.js";

export type CrudOp = "create" | "read" | "list" | "update" | "delete";

export interface FormEndpointLink {
	form: FormInfo;
	endpoint?: EndpointInfo;
	dto?: DtoInfo;
	matchedFields: string[];
	/** Form fields with no matching DTO field (possible typo / over-post). */
	unmatchedFormFields: string[];
	/** Required DTO fields not present in the form (possible incomplete form). */
	missingDtoFields: string[];
}

export interface MutationInvalidationLink {
	/** Human label of the mutation site. */
	mutation: string;
	file: string;
	line: number;
	source: "endpoint" | "tanstack" | "remix-action" | "swr";
	invalidations: CacheSignal[];
	/** Detected signals are candidates; static co-occurrence cannot prove execution order. */
	invalidationStatus: "unknown" | "not-detected";
	/** True only with a proven execution link; current heuristics cannot establish one. */
	hasInvalidation: boolean;
	/**
	 * True only when the entity is actually cached somewhere (a query/cachified/backend
	 * cache reads it) AND this mutation has no proven invalidation. A mutation against
	 * an uncached entity is not a stale-data risk - there is nothing to invalidate.
	 */
	staleRisk: boolean;
}

export interface CrudFlow {
	entity: string;
	title: string;
	isAdmin: boolean;
	routes: RouteInfo[];
	endpoints: EndpointInfo[];
	forms: FormInfo[];
	dtos: DtoInfo[];
	operations: Record<CrudOp, boolean>;
	formEndpointLinks: FormEndpointLink[];
	mutationLinks: MutationInvalidationLink[];
	files: string[];
}

function dtoEntity(name: string): string {
	// CreateAlbumDto / UpdateArtistTrackDto -> entity
	const stripped = name.replace(/^(Create|Update|Edit|New|Patch|Upsert)/, "").replace(/Dto$/, "");
	return singularize(words(stripped).join(""));
}

function classifyEndpointOp(ep: EndpointInfo): CrudOp {
	switch (ep.method) {
		case "POST":
			return "create";
		case "PUT":
		case "PATCH":
			return "update";
		case "DELETE":
			return "delete";
		default: {
			// GET: list vs read based on a trailing param.
			return /:[A-Za-z0-9_]+\/?$|\/slug\//.test(ep.path) ? "read" : "list";
		}
	}
}

function classifyRouteOps(route: RouteInfo): CrudOp[] {
	const ops: CrudOp[] = [];
	const tokens = new Set(words(route.routePath));
	if (tokens.has("new") || tokens.has("create")) ops.push("create");
	if (tokens.has("edit") || tokens.has("update") || (route.params.length > 0 && route.hasAction))
		ops.push("update");
	if (
		route.isIndex ||
		tokens.has("list") ||
		(route.params.length === 0 && route.hasLoader && ops.length === 0)
	) {
		ops.push("list");
	}
	if (route.params.length > 0 && !ops.includes("update")) ops.push("read");
	if (route.hasAction && tokens.has("delete")) ops.push("delete");
	return ops;
}

function methodMatchesForm(form: FormInfo, ep: EndpointInfo): number {
	let score = 0;
	if (sameEntity(form.entity, ep.entity)) score += 3;
	const m = form.method.toUpperCase();
	const wantsCreate = ep.method === "POST";
	const wantsUpdate = ep.method === "PUT" || ep.method === "PATCH";
	if ((m === "POST" || m === "PUT" || m === "PATCH") && (wantsCreate || wantsUpdate)) score += 1;
	if (
		form.action &&
		ep.path &&
		form.action.includes(ep.path.split("/").filter(Boolean).pop() ?? "###")
	)
		score += 1;
	return score;
}

function buildFormEndpointLink(
	form: FormInfo,
	endpoints: EndpointInfo[],
	dtos: DtoInfo[],
): FormEndpointLink {
	let best: EndpointInfo | undefined;
	let bestScore = 0;
	for (const ep of endpoints) {
		if (!ep.isMutation) continue;
		const s = methodMatchesForm(form, ep);
		if (s > bestScore) {
			bestScore = s;
			best = ep;
		}
	}
	const dto = best?.bodyDto ? dtos.find((d) => d.name === best?.bodyDto) : undefined;
	const dtoFieldNames = new Set((dto?.fields ?? []).map((f) => f.name.toLowerCase()));
	const formFieldNames = form.fields.map((f) => f.toLowerCase());
	const matched: string[] = [];
	const unmatched: string[] = [];
	for (const f of form.fields) {
		if (dtoFieldNames.has(f.toLowerCase())) matched.push(f);
		else unmatched.push(f);
	}
	const missing = (dto?.fields ?? [])
		.filter((d) => !d.optional && !formFieldNames.includes(d.name.toLowerCase()))
		.map((d) => d.name);
	return {
		form,
		endpoint: bestScore >= 3 ? best : undefined,
		dto: bestScore >= 3 ? dto : undefined,
		matchedFields: matched,
		unmatchedFormFields: dto ? unmatched : [],
		missingDtoFields: dto ? missing : [],
	};
}

function buildMutationLinks(
	entity: string,
	endpoints: EndpointInfo[],
	routes: RouteInfo[],
	cacheSignals: CacheSignal[],
): MutationInvalidationLink[] {
	const links: MutationInvalidationLink[] = [];
	const invalidations = cacheSignals.filter(
		(s) => s.kind === "invalidation" || s.kind === "revalidation" || s.kind === "cache-clear",
	);
	// The entity is only at risk of staleness if something caches it for reads.
	const entityCached = cacheSignals.some(
		(s) => s.kind === "query" || s.kind === "cachified" || s.kind === "backend-cache",
	);
	const matchInvalidations = (matchEntity: string | undefined, key?: string): CacheSignal[] => {
		return invalidations.filter((inv) => {
			if (sameEntity(inv.entity, matchEntity)) return true;
			if (key && inv.key?.includes(key)) return true;
			if (inv.key && matchEntity && inv.key.toLowerCase().includes(entityKey(matchEntity)))
				return true;
			return false;
		});
	};

	// Backend mutating endpoints.
	for (const ep of endpoints) {
		if (!ep.isMutation) continue;
		const invs = matchInvalidations(ep.entity, ep.entity);
		links.push({
			mutation: `${ep.method} ${ep.path} (${ep.controller}.${ep.handler})`,
			file: ep.file,
			line: ep.line,
			source: "endpoint",
			invalidations: invs,
			invalidationStatus: invs.length > 0 ? "unknown" : "not-detected",
			hasInvalidation: false,
			staleRisk: entityCached,
		});
	}

	// Frontend mutations: TanStack useMutation + Remix actions.
	const mutations = cacheSignals.filter(
		(s) => s.kind === "mutation" && sameEntity(s.entity, entity),
	);
	for (const mut of mutations) {
		const invs = matchInvalidations(mut.entity, mut.key);
		links.push({
			mutation: mut.detail,
			file: mut.file,
			line: mut.line,
			source: "tanstack",
			invalidations: invs,
			invalidationStatus: invs.length > 0 ? "unknown" : "not-detected",
			hasInvalidation: false,
			staleRisk: entityCached,
		});
	}
	for (const route of routes) {
		if (!route.hasAction) continue;
		const related = new Set(matchInvalidations(route.entity));
		const invs = invalidations.filter((inv) => inv.file === route.file || related.has(inv));
		links.push({
			mutation: `action in ${route.routePath}`,
			file: route.file,
			line: 1,
			source: "remix-action",
			invalidations: invs,
			invalidationStatus: invs.length > 0 ? "unknown" : "not-detected",
			hasInvalidation: false,
			staleRisk: entityCached,
		});
	}
	return links;
}

export interface CrudInferenceInput {
	routes: RouteInfo[];
	endpoints: EndpointInfo[];
	forms: FormInfo[];
	dtos: DtoInfo[];
	cacheSignals: CacheSignal[];
}

export function inferCrudFlows(input: CrudInferenceInput): CrudFlow[] {
	const { routes, endpoints, forms, dtos, cacheSignals } = input;
	const entities = new Set<string>();
	const add = (e?: string) => {
		if (e && entityKey(e)) entities.add(entityKey(e));
	};
	for (const r of routes) add(r.entity);
	for (const e of endpoints) add(e.entity);
	for (const f of forms) add(f.entity);
	for (const d of dtos) add(dtoEntity(d.name));

	const flows: CrudFlow[] = [];
	for (const key of entities) {
		const eRoutes = routes.filter((r) => entityKey(r.entity ?? "") === key);
		const eEndpoints = endpoints.filter((e) => entityKey(e.entity ?? "") === key);
		const eForms = forms.filter((f) => entityKey(f.entity ?? "") === key);
		const eDtos = dtos.filter((d) => entityKey(dtoEntity(d.name)) === key);
		const eCache = cacheSignals.filter((s) => entityKey(s.entity ?? "") === key);

		const hasAdminRoute = eRoutes.some((r) => r.isAdmin);
		const hasMutation = eEndpoints.some((e) => e.isMutation) || eRoutes.some((r) => r.hasAction);
		// A form only counts toward a CRUD flow when it belongs to a page (has a route);
		// a stray form in a shared component shouldn't mint an entity flow.
		const formWithRoute = eForms.length > 0 && eRoutes.length > 0;
		// Require a real CRUD signal; skip incidental entity matches (e.g. lone route).
		if (!hasAdminRoute && !hasMutation && !formWithRoute) continue;

		const operations: Record<CrudOp, boolean> = {
			create: false,
			read: false,
			list: false,
			update: false,
			delete: false,
		};
		for (const ep of eEndpoints) operations[classifyEndpointOp(ep)] = true;
		for (const r of eRoutes) for (const op of classifyRouteOps(r)) operations[op] = true;

		const displayEntity = singularize(key);
		const formLinks = eForms.map((f) => buildFormEndpointLink(f, eEndpoints, eDtos));
		const mutationLinks = buildMutationLinks(displayEntity, eEndpoints, eRoutes, eCache);

		const files = [
			...new Set([
				...eRoutes.map((r) => r.file),
				...eEndpoints.map((e) => e.file),
				...eForms.map((f) => f.file),
				...eDtos.map((d) => d.file),
			]),
		];

		flows.push({
			entity: displayEntity,
			title: `${entityTitle(displayEntity)} ${hasAdminRoute ? "admin " : ""}CRUD`
				.replace(/\s+/g, " ")
				.trim(),
			isAdmin: hasAdminRoute,
			routes: eRoutes,
			endpoints: eEndpoints,
			forms: eForms,
			dtos: eDtos,
			operations,
			formEndpointLinks: formLinks,
			mutationLinks,
			files,
		});
	}
	return flows.sort((a, b) => {
		if (a.isAdmin !== b.isAdmin) return a.isAdmin ? -1 : 1;
		return a.entity.localeCompare(b.entity);
	});
}

export function crudCoverageCount(flow: CrudFlow): number {
	return (["create", "read", "list", "update", "delete"] as CrudOp[]).filter(
		(op) => flow.operations[op],
	).length;
}

export type { HttpMethod };
