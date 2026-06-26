/**
 * NestJS controller + DTO detection.
 *
 * Decorator parsing ideally wants an AST; we use careful, multi-line-aware regex which
 * handles the common shapes (@Controller('prefix'), @Get(':id'), interleaved
 * @UseGuards/@HttpCode, @Body() dto: SomeDto). Edge cases (computed paths, versioning,
 * @Controller({ path })) are handled where cheap and noted as gaps where not.
 */
import type { RepoFiles } from "../scanner/files.js";
import { readFileCached } from "../scanner/files.js";
import type { HttpMethod } from "../types.js";
import { entityFromControllerPrefix } from "./entities.js";
import type { DtoField, DtoInfo, EndpointInfo } from "./types.js";

const HTTP_METHODS = ["Get", "Post", "Put", "Patch", "Delete", "All", "Head", "Options"] as const;

function lineFromIndex(content: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index && i < content.length; i++) {
		if (content[i] === "\n") line++;
	}
	return line;
}

function extractControllerPrefix(content: string): string {
	// @Controller('album') | @Controller("v1/album") | @Controller() | @Controller({ path: 'x' })
	const objForm = /@Controller\(\s*\{[^}]*\bpath\s*:\s*['"`]([^'"`]+)['"`]/s.exec(content);
	if (objForm) return objForm[1] as string;
	const strForm = /@Controller\(\s*['"`]([^'"`]*)['"`]/s.exec(content);
	if (strForm) return strForm[1] as string;
	return "";
}

function extractClassName(content: string): string | undefined {
	const m = /export\s+class\s+([A-Za-z0-9_]+)/.exec(content);
	return m ? (m[1] as string) : undefined;
}

function joinPaths(prefix: string, sub: string): string {
	const a = prefix.replace(/^\/+|\/+$/g, "");
	const b = sub.replace(/^\/+|\/+$/g, "");
	const joined = [a, b].filter(Boolean).join("/");
	// NestJS uses :param; normalize toward the same convention we use for routes.
	return `/${joined}`.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}

export function detectControllers(repo: RepoFiles): EndpointInfo[] {
	const endpoints: EndpointInfo[] = [];
	const controllerFiles = repo.files.filter((f) => f.path.endsWith(".controller.ts"));
	for (const f of controllerFiles) {
		const content = readFileCached(f.abs);
		if (!content || !/@Controller\b/.test(content)) continue;
		const prefix = extractControllerPrefix(content);
		const className = extractClassName(content) ?? "UnknownController";
		const entity = entityFromControllerPrefix(prefix || className.replace(/Controller$/, ""));
		const isAdmin = /(^|\/)admin(\/|$)/.test(prefix) || /admin/i.test(f.path);

		const decoRe = new RegExp(
			`@(${HTTP_METHODS.join("|")})\\(\\s*(?:['"\`]([^'"\`]*)['"\`])?\\s*\\)`,
			"g",
		);
		let m = decoRe.exec(content);
		for (; m !== null; m = decoRe.exec(content)) {
			const methodName = (m[1] ?? "Get") as (typeof HTTP_METHODS)[number];
			const sub = m[2] ?? "";
			const after = content.slice(m.index + m[0].length, m.index + m[0].length + 600);
			// Skip interleaved method decorators, modifiers, then capture the handler name.
			const handlerMatch =
				/^(?:\s*@[A-Za-z]+\s*\([^)]*\)\s*)*\s*(?:public |private |protected |readonly |async |static )*([A-Za-z_$][\w$]*)\s*\(/m.exec(
					after,
				);
			const handler = handlerMatch ? (handlerMatch[1] as string) : "handler";
			// Bound @Body() lookup to this method's signature (up to the method body `{`),
			// so a later method's @Body() doesn't bleed onto a GET handler.
			const braceIdx = after.indexOf("{");
			const signature = braceIdx >= 0 ? after.slice(0, braceIdx) : after.slice(0, 200);
			const bodyDtoMatch = /@Body\(\s*[^)]*\)\s*[A-Za-z0-9_]+\??\s*:\s*([A-Za-z0-9_]+)/.exec(
				signature,
			);
			const upper = methodName.toUpperCase();
			const httpMethod: HttpMethod =
				upper === "HEAD" || upper === "OPTIONS" ? "GET" : (upper as HttpMethod);
			endpoints.push({
				method: httpMethod,
				path: joinPaths(prefix, sub),
				controller: className,
				controllerPrefix: prefix,
				handler,
				file: f.path,
				line: lineFromIndex(content, m.index),
				entity,
				bodyDto: bodyDtoMatch ? (bodyDtoMatch[1] as string) : undefined,
				isAdmin,
				isMutation:
					httpMethod === "POST" ||
					httpMethod === "PUT" ||
					httpMethod === "PATCH" ||
					httpMethod === "DELETE",
			});
		}
	}
	return endpoints.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

const VALIDATOR_RE =
	/@(Is[A-Za-z0-9]+|Min|Max|Length|MinLength|MaxLength|Matches|Type|ValidateNested|IsOptional|IsNotEmpty|IsEnum|IsArray|ArrayNotEmpty|Allow)\b/g;

function parseDtoFields(content: string): DtoField[] {
	const fields: DtoField[] = [];
	const lines = content.split("\n");
	let pendingValidators: string[] = [];
	let pendingOptional = false;
	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (line.startsWith("@")) {
			VALIDATOR_RE.lastIndex = 0;
			let vm = VALIDATOR_RE.exec(line);
			for (; vm !== null; vm = VALIDATOR_RE.exec(line)) {
				const v = vm[1] as string;
				pendingValidators.push(v);
				if (v === "IsOptional") pendingOptional = true;
			}
			continue;
		}
		// Property declaration: `name?: type;` (skip methods and braces).
		const propMatch = /^(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*(\?)?\s*[:!]\s*[^;=]+/.exec(line);
		if (propMatch && !line.includes("(")) {
			const name = propMatch[1] as string;
			const optional = Boolean(propMatch[2]) || pendingOptional;
			fields.push({ name, validators: [...new Set(pendingValidators)], optional });
			pendingValidators = [];
			pendingOptional = false;
			continue;
		}
		// Non-decorator, non-property line resets pending state (e.g. blank or `}`).
		if (line && !line.startsWith("//") && !line.startsWith("*") && !line.startsWith("/*")) {
			if (!/^(export|import|class|extends|implements|\{|\})/.test(line)) {
				pendingValidators = [];
				pendingOptional = false;
			}
		}
	}
	return fields;
}

export function detectDtos(repo: RepoFiles): DtoInfo[] {
	const dtos: DtoInfo[] = [];
	const dtoFiles = repo.files.filter((f) => f.path.endsWith(".dto.ts") || /\/dto\//.test(f.path));
	for (const f of dtoFiles) {
		const content = readFileCached(f.abs);
		if (!content) continue;
		const classRe = /export\s+class\s+([A-Za-z0-9_]+)\s*(?:extends[^{]+)?\{/g;
		const classPositions: Array<{ name: string; start: number }> = [];
		let cm = classRe.exec(content);
		for (; cm !== null; cm = classRe.exec(content)) {
			classPositions.push({ name: cm[1] as string, start: cm.index });
		}
		for (let i = 0; i < classPositions.length; i++) {
			const cur = classPositions[i] as { name: string; start: number };
			const end =
				i + 1 < classPositions.length
					? (classPositions[i + 1] as { start: number }).start
					: content.length;
			const body = content.slice(cur.start, end);
			const fields = parseDtoFields(body);
			dtos.push({ name: cur.name, file: f.path, fields });
		}
	}
	return dtos;
}
