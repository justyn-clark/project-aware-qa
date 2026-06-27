/**
 * Structured outputs produced by the detectors. The registry builder consumes these
 * and turns them into `Surface` objects; inference correlates them across layers.
 */
import type { HttpMethod } from "../types.js";

export interface RouteInfo {
	routePath: string;
	file: string;
	kind:
		| "remix-file"
		| "rr-config"
		| "rr-jsx"
		| "next-app"
		| "next-pages"
		| "phoenix-router"
		| "phoenix-live"
		| "django-url";
	isAdmin: boolean;
	isIndex: boolean;
	isLayout: boolean;
	hasLoader: boolean;
	hasAction: boolean;
	params: string[];
	entity?: string;
}

export interface EndpointInfo {
	method: HttpMethod;
	/** Full path including controller prefix, e.g. "/album/:id". */
	path: string;
	controller: string;
	controllerPrefix: string;
	handler: string;
	file: string;
	line: number;
	entity?: string;
	/** DTO class name referenced by @Body(), when resolvable. */
	bodyDto?: string;
	isAdmin: boolean;
	isMutation: boolean;
}

export interface DtoField {
	name: string;
	validators: string[];
	optional: boolean;
}

export interface DtoInfo {
	name: string;
	file: string;
	fields: DtoField[];
}

export interface FormInfo {
	file: string;
	line: number;
	method: string;
	kind: "remix-form" | "html-form" | "react-hook-form" | "formik";
	fields: string[];
	entity?: string;
	action?: string;
}

export type CacheSignalKind =
	| "query"
	| "mutation"
	| "invalidation"
	| "revalidation"
	| "storage"
	| "backend-cache"
	| "cachified"
	| "cache-clear";

export interface CacheSignal {
	kind: CacheSignalKind;
	library: string;
	detail: string;
	file: string;
	line: number;
	key?: string;
	entity?: string;
}

export interface TestInfo {
	file: string;
	kind: "unit" | "e2e" | "component" | "spec";
	runner: "vitest" | "jest" | "playwright" | "unknown";
	/** Subject names inferred from the test file (imports / describe blocks / filename). */
	targets: string[];
}

export interface DetectionBundle {
	routes: RouteInfo[];
	endpoints: EndpointInfo[];
	dtos: DtoInfo[];
	forms: FormInfo[];
	cacheSignals: CacheSignal[];
	tests: TestInfo[];
}
