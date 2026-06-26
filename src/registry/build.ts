/**
 * Registry assembly.
 *
 * Turns detector + inference outputs into a deduplicated set of `Surface` objects and
 * the full `SurfaceRegistry` artifact. Surface taxonomy (each route maps to exactly one
 * of route/visual-page so there is no double counting):
 *  - crud-flow    : one per entity admin/CRUD aggregate
 *  - api-endpoint : one per backend endpoint
 *  - form         : one per detected form
 *  - cache-risk   : one per stale-data risk (mutation w/o invalidation) or storage use
 *  - visual-page  : renderable page routes (screenshot targets)
 *  - route        : resource/layout routes (loader/action only, no rendered page)
 *  - test-gap     : mutating areas with no covering tests at all
 */

import { entityKey, entityTitle } from "../detectors/entities.js";
import type {
	CacheSignal,
	DetectionBundle,
	EndpointInfo,
	FormInfo,
	RouteInfo,
} from "../detectors/types.js";
import { type CrudFlow, crudCoverageCount, inferCrudFlows } from "../inference/crud.js";
import { scoreRisk } from "../inference/risk.js";
import type { RepoFiles } from "../scanner/files.js";
import {
	type EvidenceItem,
	type InferredTest,
	type ProjectInfo,
	REGISTRY_VERSION,
	type RegistryStats,
	type Risk,
	SCHEMA_ID,
	type Surface,
	type SurfaceRegistry,
	type SurfaceType,
} from "../types.js";

const TOOL = { name: "project-aware-qa", version: "0.1.0" } as const;

function slug(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
}

/** Index existing tests by the entity/subject tokens they appear to cover. */
function buildTestIndex(bundle: DetectionBundle): {
	entities: Set<string>;
	tokens: Set<string>;
	hasAny: boolean;
} {
	const entities = new Set<string>();
	const tokens = new Set<string>();
	for (const t of bundle.tests) {
		for (const target of t.targets) {
			tokens.add(target.toLowerCase());
			entities.add(entityKey(target));
		}
	}
	return { entities, tokens, hasAny: bundle.tests.length > 0 };
}

function entityHasTests(
	entity: string | undefined,
	index: ReturnType<typeof buildTestIndex>,
): boolean {
	if (!entity) return false;
	return index.entities.has(entityKey(entity));
}

function isRenderable(route: RouteInfo): boolean {
	// Resource routes (loader/action only) and layouts aren't screenshot targets.
	if (route.isLayout) return false;
	// A route with an action but no params and named like a resource is often non-visual;
	// keep it visual only when it plausibly renders (default component implied by detector).
	return true;
}

function makeInferredTest(
	kind: InferredTest["kind"],
	description: string,
	present: boolean,
): InferredTest {
	return { kind, description, status: present ? "present" : "missing" };
}

function buildCrudSurfaces(
	flows: CrudFlow[],
	testIndex: ReturnType<typeof buildTestIndex>,
): Surface[] {
	const surfaces: Surface[] = [];
	for (const flow of flows) {
		const evidence: EvidenceItem[] = [];
		for (const r of flow.routes.slice(0, 8)) {
			evidence.push({ kind: "route", detail: r.routePath, file: r.file });
		}
		for (const ep of flow.endpoints.slice(0, 12)) {
			evidence.push({
				kind: "endpoint",
				detail: `${ep.method} ${ep.path}`,
				file: ep.file,
				line: ep.line,
			});
		}
		for (const f of flow.forms.slice(0, 6)) {
			evidence.push({
				kind: "form",
				detail: `${f.kind} [${f.fields.join(", ")}]`,
				file: f.file,
				line: f.line,
			});
		}
		for (const d of flow.dtos.slice(0, 6)) {
			evidence.push({ kind: "dto", detail: `${d.name} (${d.fields.length} fields)`, file: d.file });
		}

		const staleLinks = flow.mutationLinks.filter((m) => m.staleRisk);
		const fieldMismatch = flow.formEndpointLinks.some(
			(l) => l.unmatchedFormFields.length > 0 || l.missingDtoFields.length > 0,
		);
		const hasTests = entityHasTests(flow.entity, testIndex);

		const gaps: string[] = [];
		const ops = flow.operations;
		const missingOps = (["create", "read", "list", "update", "delete"] as const).filter(
			(op) => !ops[op],
		);
		if (flow.isAdmin && missingOps.length > 0) {
			gaps.push(`No detected handler for: ${missingOps.join(", ")}`);
		}
		if (!hasTests) gaps.push("No tests reference this entity");
		for (const l of flow.formEndpointLinks) {
			if (l.missingDtoFields.length > 0) {
				gaps.push(
					`Form ${l.form.file} missing required DTO fields: ${l.missingDtoFields.join(", ")}`,
				);
			}
			if (l.unmatchedFormFields.length > 0) {
				gaps.push(`Form ${l.form.file} fields not in DTO: ${l.unmatchedFormFields.join(", ")}`);
			}
			if (l.form.fields.length > 0 && !l.endpoint) {
				gaps.push(`Form ${l.form.file} has no confidently matched backend endpoint`);
			}
		}
		for (const m of staleLinks) {
			gaps.push(`Mutation without detected invalidation: ${m.mutation}`);
		}

		const inferredTests: InferredTest[] = [];
		if (ops.list || ops.read)
			inferredTests.push(makeInferredTest("smoke", `Load ${flow.entity} list/detail`, hasTests));
		if (ops.create || ops.update) {
			inferredTests.push(
				makeInferredTest(
					"form",
					`Submit ${flow.entity} create/update form and assert persistence`,
					hasTests,
				),
			);
		}
		for (const ep of flow.endpoints.filter((e) => e.isMutation).slice(0, 6)) {
			inferredTests.push(
				makeInferredTest("api", `${ep.method} ${ep.path} happy-path + validation`, hasTests),
			);
		}
		if (staleLinks.length > 0) {
			inferredTests.push(
				makeInferredTest(
					"cache",
					`Mutate ${flow.entity} then assert UI/list reflects change`,
					false,
				),
			);
		}
		if (flow.isAdmin) {
			inferredTests.push(
				makeInferredTest(
					"screenshot",
					`Screenshot ${flow.entity} admin pages (desktop+mobile)`,
					false,
				),
			);
		}

		const risk = scoreRisk({
			type: "crud-flow",
			isAdmin: flow.isAdmin,
			isMutation: flow.endpoints.some((e) => e.isMutation) || flow.routes.some((r) => r.hasAction),
			hasForm: flow.forms.length > 0,
			staleRisk: staleLinks.length > 0,
			fieldMismatch,
			hasTests,
			crudCoverage: crudCoverageCount(flow),
			authGated: flow.isAdmin,
			fileCount: flow.files.length,
		});

		surfaces.push({
			id: `crud:${slug(flow.entity)}`,
			type: "crud-flow",
			title: flow.title,
			entity: flow.entity,
			frontendRoute: flow.routes.find((r) => r.isAdmin)?.routePath ?? flow.routes[0]?.routePath,
			backendEndpoint: flow.endpoints.find((e) => e.isMutation)
				? `${flow.endpoints.find((e) => e.isMutation)?.method} ${flow.endpoints.find((e) => e.isMutation)?.path}`
				: undefined,
			files: flow.files,
			risk: risk.level,
			riskScore: risk.score,
			riskReasons: risk.reasons,
			inferredTests,
			evidence,
			gaps,
		});
	}
	return surfaces;
}

function buildEndpointSurfaces(
	endpoints: EndpointInfo[],
	testIndex: ReturnType<typeof buildTestIndex>,
): Surface[] {
	return endpoints.map((ep) => {
		const hasTests =
			entityHasTests(ep.entity, testIndex) || testIndex.tokens.has(ep.handler.toLowerCase());
		const risk = scoreRisk({
			type: "api-endpoint",
			isAdmin: ep.isAdmin,
			isMutation: ep.isMutation,
			hasTests,
			authGated: ep.isAdmin,
		});
		const gaps: string[] = [];
		if (!hasTests) gaps.push("No spec/e2e references this handler");
		if (ep.isMutation && !ep.bodyDto)
			gaps.push("No @Body() DTO detected — validation coverage unknown");
		const inferredTests: InferredTest[] = [
			makeInferredTest("api", `${ep.method} ${ep.path} → expected status + shape`, hasTests),
		];
		if (ep.isMutation) {
			inferredTests.push(
				makeInferredTest("api", `${ep.method} ${ep.path} validation/error path`, hasTests),
			);
		}
		return {
			id: `api:${slug(`${ep.method}-${ep.path}`)}`,
			type: "api-endpoint" as SurfaceType,
			title: `${ep.method} ${ep.path}`,
			entity: ep.entity,
			backendEndpoint: `${ep.method} ${ep.path}`,
			files: [ep.file],
			risk: risk.level,
			riskScore: risk.score,
			riskReasons: risk.reasons,
			inferredTests,
			evidence: [
				{
					kind: "endpoint",
					detail: `${ep.controller}.${ep.handler}`,
					file: ep.file,
					line: ep.line,
				},
				...(ep.bodyDto ? [{ kind: "dto" as const, detail: ep.bodyDto, file: ep.file }] : []),
			],
			gaps,
		};
	});
}

function buildFormSurfaces(
	forms: FormInfo[],
	flows: CrudFlow[],
	testIndex: ReturnType<typeof buildTestIndex>,
): Surface[] {
	const linkByForm = new Map<string, CrudFlow["formEndpointLinks"][number]>();
	for (const flow of flows) {
		for (const l of flow.formEndpointLinks) linkByForm.set(`${l.form.file}:${l.form.line}`, l);
	}
	return forms.map((f) => {
		const link = linkByForm.get(`${f.file}:${f.line}`);
		const fieldMismatch = Boolean(
			link && (link.unmatchedFormFields.length > 0 || link.missingDtoFields.length > 0),
		);
		const hasTests = entityHasTests(f.entity, testIndex);
		const risk = scoreRisk({
			type: "form",
			hasForm: true,
			fieldMismatch,
			hasTests,
			isMutation: f.method !== "get",
		});
		const gaps: string[] = [];
		if (link?.missingDtoFields.length)
			gaps.push(`Missing required fields vs DTO: ${link.missingDtoFields.join(", ")}`);
		if (link?.unmatchedFormFields.length)
			gaps.push(`Fields not in DTO: ${link.unmatchedFormFields.join(", ")}`);
		if (!link?.endpoint) gaps.push("No confidently matched submit endpoint");
		if (!hasTests) gaps.push("No form/component test detected");
		return {
			id: `form:${slug(f.file)}-${f.line}`,
			type: "form" as SurfaceType,
			title: `${f.kind} form (${f.fields.length} fields) in ${f.file.split("/").pop()}`,
			entity: f.entity,
			frontendRoute: f.action,
			backendEndpoint: link?.endpoint ? `${link.endpoint.method} ${link.endpoint.path}` : undefined,
			files: [f.file],
			risk: risk.level,
			riskScore: risk.score,
			riskReasons: risk.reasons,
			inferredTests: [
				makeInferredTest(
					"form",
					`Fill + submit; assert success and validation on ${f.fields.slice(0, 6).join(", ")}`,
					hasTests,
				),
			],
			evidence: [
				{ kind: "form", detail: `fields: ${f.fields.join(", ")}`, file: f.file, line: f.line },
			],
			gaps,
		};
	});
}

function buildCacheRiskSurfaces(flows: CrudFlow[], cacheSignals: CacheSignal[]): Surface[] {
	const surfaces: Surface[] = [];
	const seen = new Set<string>();
	for (const flow of flows) {
		for (const m of flow.mutationLinks) {
			if (!m.staleRisk) continue;
			const id = `cache:${slug(flow.entity)}:${slug(m.file)}-${m.line}`;
			if (seen.has(id)) continue;
			seen.add(id);
			const risk = scoreRisk({
				type: "cache-risk",
				isMutation: true,
				staleRisk: true,
				isAdmin: flow.isAdmin,
			});
			surfaces.push({
				id,
				type: "cache-risk",
				title: `Stale-data risk: ${flow.entity} mutation without invalidation`,
				entity: flow.entity,
				files: [m.file],
				risk: risk.level,
				riskScore: risk.score,
				riskReasons: risk.reasons,
				inferredTests: [
					makeInferredTest(
						"cache",
						`After ${m.mutation}, assert query/list/cache reflects the change`,
						false,
					),
				],
				evidence: [{ kind: "mutation", detail: m.mutation, file: m.file, line: m.line }],
				gaps: [
					`No invalidateQueries / mutate / clearCacheKey / revalidation found for this mutation`,
				],
			});
		}
	}
	// Standalone browser-storage risks (state that can desync across tabs/sessions).
	for (const s of cacheSignals.filter((c) => c.kind === "storage")) {
		const id = `cache:storage:${slug(s.file)}-${s.line}`;
		if (seen.has(id)) continue;
		seen.add(id);
		const risk = scoreRisk({ type: "cache-risk", usesStorage: true });
		surfaces.push({
			id,
			type: "cache-risk",
			title: `Browser storage dependency (${s.detail})`,
			entity: s.entity,
			files: [s.file],
			risk: risk.level,
			riskScore: risk.score,
			riskReasons: risk.reasons,
			inferredTests: [
				makeInferredTest(
					"cache",
					`Verify ${s.detail} hydrates/clears correctly across reloads`,
					false,
				),
			],
			evidence: [{ kind: "storage", detail: s.detail, file: s.file, line: s.line }],
			gaps: ["Browser storage can desync from server state; confirm refresh/logout behaviour"],
		});
	}
	return surfaces;
}

function buildRouteSurfaces(
	routes: RouteInfo[],
	flows: CrudFlow[],
	testIndex: ReturnType<typeof buildTestIndex>,
): Surface[] {
	const adminEntities = new Set(flows.filter((f) => f.isAdmin).map((f) => entityKey(f.entity)));
	const surfaces: Surface[] = [];
	const seenPaths = new Set<string>();
	for (const r of routes) {
		const dedupKey = `${r.routePath}::${r.kind}`;
		if (seenPaths.has(dedupKey)) continue;
		seenPaths.add(dedupKey);
		const renderable = isRenderable(r);
		const hasTests = entityHasTests(r.entity, testIndex);
		const authGated = r.isAdmin || adminEntities.has(entityKey(r.entity ?? ""));
		const type: SurfaceType = renderable ? "visual-page" : "route";
		const risk = scoreRisk({
			type,
			isAdmin: r.isAdmin,
			isMutation: r.hasAction,
			hasTests,
			authGated,
		});
		const inferredTests: InferredTest[] = [
			makeInferredTest("smoke", `Navigate ${r.routePath} → 200, no console errors`, hasTests),
		];
		if (renderable) {
			inferredTests.push(
				makeInferredTest(
					"screenshot",
					`Screenshot ${r.routePath} (desktop 1280 + mobile 390)`,
					false,
				),
			);
		}
		if (r.hasAction)
			inferredTests.push(makeInferredTest("e2e", `Exercise action on ${r.routePath}`, hasTests));
		const gaps: string[] = [];
		if (authGated) gaps.push("Auth-gated: needs credentials/session to verify at runtime");
		if (r.params.length > 0)
			gaps.push(`Dynamic params ${r.params.join(", ")}: needs seed data / valid ids`);
		surfaces.push({
			id: `${renderable ? "visual" : "route"}:${slug(r.routePath)}:${slug(r.file)}`,
			type,
			title: `${r.routePath}${r.isIndex ? " (index)" : ""}${r.isLayout ? " (layout)" : ""}`,
			entity: r.entity,
			frontendRoute: r.routePath,
			files: [r.file],
			risk: risk.level,
			riskScore: risk.score,
			riskReasons: risk.reasons,
			inferredTests,
			evidence: [
				{
					kind: "route",
					detail: `${r.kind}${r.hasLoader ? " loader" : ""}${r.hasAction ? " action" : ""}`,
					file: r.file,
				},
			],
			gaps,
		});
	}
	return surfaces;
}

function buildTestGapSurfaces(
	flows: CrudFlow[],
	testIndex: ReturnType<typeof buildTestIndex>,
): Surface[] {
	const surfaces: Surface[] = [];
	for (const flow of flows) {
		const hasMutation =
			flow.endpoints.some((e) => e.isMutation) || flow.routes.some((r) => r.hasAction);
		if (!hasMutation) continue;
		if (entityHasTests(flow.entity, testIndex)) continue;
		const risk = scoreRisk({
			type: "test-gap",
			isAdmin: flow.isAdmin,
			isMutation: true,
			hasTests: false,
		});
		surfaces.push({
			id: `gap:${slug(flow.entity)}`,
			type: "test-gap",
			title: `Untested mutating area: ${entityTitle(flow.entity)}`,
			entity: flow.entity,
			files: flow.files,
			risk: risk.level,
			riskScore: risk.score,
			riskReasons: risk.reasons,
			inferredTests: [
				makeInferredTest("api", `Add API tests for ${flow.entity} mutations`, false),
				makeInferredTest("e2e", `Add e2e for ${flow.entity} admin flow`, false),
			],
			evidence: [
				{
					kind: "note",
					detail: `${flow.endpoints.length} endpoints, ${flow.forms.length} forms, 0 tests`,
				},
			],
			gaps: [`Entire ${flow.entity} mutation surface lacks automated coverage`],
		});
	}
	return surfaces;
}

function computeStats(repo: RepoFiles, surfaces: Surface[]): RegistryStats {
	const byType: Record<string, number> = {};
	const byRisk: Record<Risk, number> = { high: 0, medium: 0, low: 0 };
	for (const s of surfaces) {
		byType[s.type] = (byType[s.type] ?? 0) + 1;
		byRisk[s.risk] += 1;
	}
	return {
		totalFiles: repo.files.length,
		scannedFiles: repo.files.length,
		surfaces: surfaces.length,
		byType,
		byRisk,
	};
}

export interface BuildOptions {
	generatedAt: string;
}

export function buildRegistry(
	repo: RepoFiles,
	project: ProjectInfo,
	bundle: DetectionBundle,
	options: BuildOptions,
): { registry: SurfaceRegistry; flows: CrudFlow[] } {
	const flows = inferCrudFlows({
		routes: bundle.routes,
		endpoints: bundle.endpoints,
		forms: bundle.forms,
		dtos: bundle.dtos,
		cacheSignals: bundle.cacheSignals,
	});
	const testIndex = buildTestIndex(bundle);

	const surfaces: Surface[] = [
		...buildCrudSurfaces(flows, testIndex),
		...buildEndpointSurfaces(bundle.endpoints, testIndex),
		...buildFormSurfaces(bundle.forms, flows, testIndex),
		...buildCacheRiskSurfaces(flows, bundle.cacheSignals),
		...buildRouteSurfaces(bundle.routes, flows, testIndex),
		...buildTestGapSurfaces(flows, testIndex),
	];

	// Stable ordering: risk desc, then type, then id.
	const riskRank: Record<Risk, number> = { high: 0, medium: 1, low: 2 };
	surfaces.sort((a, b) => {
		if (riskRank[a.risk] !== riskRank[b.risk]) return riskRank[a.risk] - riskRank[b.risk];
		if (b.riskScore !== a.riskScore) return b.riskScore - a.riskScore;
		if (a.type !== b.type) return a.type.localeCompare(b.type);
		return a.id.localeCompare(b.id);
	});

	const registry: SurfaceRegistry = {
		schema: SCHEMA_ID,
		version: REGISTRY_VERSION,
		generatedAt: options.generatedAt,
		tool: TOOL,
		project,
		surfaces,
		stats: computeStats(repo, surfaces),
	};
	return { registry, flows };
}
