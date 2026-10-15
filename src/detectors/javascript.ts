/** Small lexical reader for static declarations. Never executes repository code. */
export interface Token {
	value: string;
	kind: "name" | "string" | "symbol";
	offset: number;
}

export function tokens(source: string): Token[] {
	const out: Token[] = [];
	let i = 0;
	while (i < source.length) {
		const c = source[i] as string;
		if (/\s/.test(c)) {
			i++;
			continue;
		}
		if (source.startsWith("//", i)) {
			const end = source.indexOf("\n", i);
			i = end < 0 ? source.length : end;
			continue;
		}
		if (source.startsWith("/*", i)) {
			const end = source.indexOf("*/", i + 2);
			i = end < 0 ? source.length : end + 2;
			continue;
		}
		const offset = i;
		if (c === "'" || c === '"' || c === "`") {
			i++;
			let value = "";
			let dynamic = false;
			while (i < source.length && source[i] !== c) {
				if (source[i] === "\\") {
					dynamic = true;
					i += 2;
					continue;
				}
				if (c === "`" && source.startsWith("${", i)) dynamic = true;
				value += source[i++];
			}
			i++;
			out.push({
				value: dynamic ? "<dynamic>" : value,
				kind: dynamic ? "symbol" : "string",
				offset,
			});
			continue;
		}
		if (/[A-Za-z_$]/.test(c)) {
			while (i < source.length && /[\w$]/.test(source[i] as string)) i++;
			out.push({ value: source.slice(offset, i), kind: "name", offset });
			continue;
		}
		// Skip regex bodies so text resembling declarations cannot create endpoints.
		if (c === "/" && (!out.length || /^(=|\(|,|:|return|=>|!|\[)$/.test(out.at(-1)?.value ?? ""))) {
			i++;
			let bracket = false;
			while (i < source.length) {
				if (source[i] === "\\") {
					i += 2;
					continue;
				}
				if (source[i] === "[") bracket = true;
				if (source[i] === "]") bracket = false;
				if (source[i++] === "/" && !bracket) break;
			}
			out.push({ value: "<regex>", kind: "symbol", offset });
			continue;
		}
		out.push({ value: c, kind: "symbol", offset });
		i++;
	}
	return out;
}

export function argumentsAt(
	ts: Token[],
	open: number,
): { args: Token[][]; end: number } | undefined {
	if (ts[open]?.value !== "(") return;
	const args: Token[][] = [];
	let start = open + 1;
	let depth = 0;
	for (let i = start; i < ts.length; i++) {
		const t = ts[i] as Token;
		if (t.kind === "symbol") {
			if (t.value === ")" && depth === 0) {
				args.push(ts.slice(start, i));
				return { args, end: i };
			}
			if ("([{".includes(t.value)) depth++;
			if (")]}".includes(t.value)) depth--;
			if (t.value === "," && depth === 0) {
				args.push(ts.slice(start, i));
				start = i + 1;
			}
		}
	}
}

export function literal(ts: Token[] | undefined): string | undefined {
	return ts?.length === 1 && ts[0]?.kind === "string" ? ts[0].value : undefined;
}

export function codeFile(path: string): boolean {
	return (
		/\.[cm]?[jt]sx?$/.test(path) &&
		!/\.(test|spec|d)\.[cm]?[jt]sx?$/.test(path) &&
		!/(^|\/)(__tests__|__mocks__|test|tests)\//.test(path)
	);
}
