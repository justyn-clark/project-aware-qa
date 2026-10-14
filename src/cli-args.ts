import { resolve } from "node:path";
import { normalizeRequiredChecks } from "./verification-policy.js";

export type QaCommand = "scan" | "plan" | "verify" | "report";

export class ArgumentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ArgumentError";
	}
}

export interface VerifyFlags {
	scope?: string;
	runInstall: boolean;
	runTests: boolean;
	runScreenshots: boolean;
	startDevServer: boolean;
	baseUrl?: string;
	service?: string;
	maxRoutes?: number;
	timeoutMs?: number;
	changedSince?: string;
	requiredChecks: string[];
	failOnIncomplete: boolean;
	exportFormats: Array<"junit" | "sarif">;
}

export interface ParsedArgs {
	root: string;
	flags: Set<string>;
	values: Map<string, string>;
	positionals: string[];
	scope?: string;
	maxFiles?: number;
	baseline?: string;
	saveBaseline?: boolean;
}

const VERIFY_BOOLEANS = [
	"install",
	"tests",
	"screenshots",
	"start-dev-server",
	"fail-on-incomplete",
	"junit",
	"sarif",
];
const VALUE_OPTIONS: Record<QaCommand, string[]> = {
	scan: ["max-files", "baseline"],
	plan: ["scope"],
	verify: ["scope", "base-url", "service", "max-routes", "timeout", "changed-since", "require"],
	report: [],
};
const NUMBER_OPTIONS = new Set(["max-files", "max-routes", "timeout"]);

/** Tokenize Pi's raw command text without expanding variables or executing shell syntax. */
export function tokenizeArgs(raw: string): string[] {
	const tokens: string[] = [];
	let token = "";
	let started = false;
	let quote: "'" | '"' | undefined;
	for (let i = 0; i < raw.length; i++) {
		const char = raw[i] as string;
		if (char === "\\" && quote !== "'") {
			const next = raw[++i];
			if (next === undefined) throw new ArgumentError("Unfinished escape in arguments.");
			token += next;
			started = true;
		} else if (quote) {
			if (char === quote) quote = undefined;
			else token += char;
		} else if (char === "'" || char === '"') {
			quote = char;
			started = true;
		} else if (/\s/.test(char)) {
			if (started) tokens.push(token);
			token = "";
			started = false;
		} else {
			token += char;
			started = true;
		}
	}
	if (quote) throw new ArgumentError("Unclosed quote in arguments.");
	if (started) tokens.push(token);
	return tokens;
}

function positiveInteger(value: string, option: string): number {
	const number = Number(value);
	if (!value.trim() || !Number.isSafeInteger(number) || number <= 0) {
		throw new ArgumentError(
			`--${option} requires a positive integer; received ${JSON.stringify(value)}.`,
		);
	}
	return number;
}

/** Shared schemas keep CLI argv and Pi command text equally strict. */
export function parseQaArgs(
	argv: string[],
	command: QaCommand,
	options: { mode?: "cli" | "pi"; cwd?: string } = {},
): ParsedArgs {
	const mode = options.mode ?? "cli";
	const flags = new Set<string>();
	const values = new Map<string, string>();
	const positionals: string[] = [];
	const booleans = new Set([
		...(command === "scan" ? ["save-baseline"] : []),
		...(command === "verify" ? VERIFY_BOOLEANS : []),
		...(mode === "cli" ? ["json"] : []),
	]);
	const valueOptions = new Set([...VALUE_OPTIONS[command], ...(mode === "cli" ? ["root"] : [])]);
	let positionalOnly = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		if (!positionalOnly && arg === "--") {
			positionalOnly = true;
			continue;
		}
		if (!positionalOnly && arg.startsWith("-")) {
			const equals = arg.indexOf("=");
			const key = arg.slice(2, equals === -1 ? undefined : equals);
			if (!arg.startsWith("--") || (!booleans.has(key) && !valueOptions.has(key))) {
				throw new ArgumentError(`Unknown option ${JSON.stringify(arg)} for qa-${command}.`);
			}
			if (flags.has(key) || values.has(key)) {
				throw new ArgumentError(`Option --${key} was provided more than once.`);
			}
			if (booleans.has(key)) {
				if (equals !== -1) throw new ArgumentError(`--${key} does not take a value.`);
				flags.add(key);
				continue;
			}
			const value = equals !== -1 ? arg.slice(equals + 1) : argv[++i];
			if (
				value === undefined ||
				!value.trim() ||
				(equals === -1 && value.startsWith("-") && !NUMBER_OPTIONS.has(key)) ||
				value === "--"
			) {
				throw new ArgumentError(`--${key} requires a value.`);
			}
			if (NUMBER_OPTIONS.has(key)) positiveInteger(value, key);
			values.set(key, value);
		} else {
			if (!arg.trim()) throw new ArgumentError("Positional arguments must not be empty.");
			positionals.push(arg);
		}
	}
	const hasScope = command === "plan" || command === "verify";
	const rootIsPositional = mode === "cli" && !values.has("root");
	const scopeIndex = rootIsPositional ? 1 : 0;
	const maxPositionals = (rootIsPositional ? 1 : 0) + (hasScope ? 1 : 0);
	if (positionals.length > maxPositionals) {
		throw new ArgumentError(
			`Too many positional arguments for qa-${command}. Quote paths or scopes containing spaces.`,
		);
	}
	if (hasScope && values.has("scope") && positionals[scopeIndex] !== undefined) {
		throw new ArgumentError("Scope was provided both positionally and with --scope.");
	}
	if (values.has("require")) {
		try {
			normalizeRequiredChecks((values.get("require") as string).split(","));
		} catch (error) {
			throw new ArgumentError((error as Error).message);
		}
	}
	return {
		root: resolve(
			options.cwd ?? process.cwd(),
			values.get("root") ?? (rootIsPositional ? positionals[0] : undefined) ?? ".",
		),
		flags,
		values,
		positionals,
		scope: hasScope ? (values.get("scope") ?? positionals[scopeIndex]) : undefined,
		maxFiles: values.has("max-files") ? Number(values.get("max-files")) : undefined,
		baseline: values.get("baseline"),
		saveBaseline: flags.has("save-baseline"),
	};
}

export function verifyFlags(args: ParsedArgs): VerifyFlags {
	const requiredChecks = (args.values.get("require") ?? "")
		.split(",")
		.map((check) => check.trim().toLowerCase())
		.filter(Boolean);
	for (const check of requiredChecks) {
		if (!/^[a-z0-9][a-z0-9._:-]*$/.test(check)) {
			throw new ArgumentError(`Invalid required check ${JSON.stringify(check)}.`);
		}
	}
	return {
		scope: args.scope,
		runInstall: args.flags.has("install"),
		runTests: args.flags.has("tests"),
		runScreenshots: args.flags.has("screenshots"),
		startDevServer: args.flags.has("start-dev-server"),
		baseUrl: args.values.get("base-url"),
		service: args.values.get("service"),
		maxRoutes: args.values.has("max-routes") ? Number(args.values.get("max-routes")) : undefined,
		timeoutMs: args.values.has("timeout") ? Number(args.values.get("timeout")) : undefined,
		changedSince: args.values.get("changed-since"),
		requiredChecks: [...new Set(requiredChecks)],
		failOnIncomplete: args.flags.has("fail-on-incomplete"),
		exportFormats: [
			...(args.flags.has("junit") ? (["junit"] as const) : []),
			...(args.flags.has("sarif") ? (["sarif"] as const) : []),
		],
	};
}

export function parseVerifyArgs(raw: string): VerifyFlags {
	return verifyFlags(parseQaArgs(tokenizeArgs(raw), "verify", { mode: "pi" }));
}

/** Recognize the output mode even when another argument prevents complete parsing. */
export function wantsJson(argv: string[]): boolean {
	const terminator = argv.indexOf("--");
	return (terminator === -1 ? argv : argv.slice(0, terminator)).includes("--json");
}
