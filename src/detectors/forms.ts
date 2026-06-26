/**
 * Form detection.
 *
 * Over-detection is the known risk, so we only treat a file as containing a form when
 * there is a real form construct (Remix <Form>, raw <form>, react-hook-form useForm,
 * or Formik) AND we can pull at least one field name. Field names come from `name="..."`
 * attributes, react-hook-form `register("...")`, and Formik `<Field name="...">`.
 */
import type { RepoFiles } from "../scanner/files.js";
import { grepContent, readFileCached } from "../scanner/files.js";
import { entityFromSegments } from "./entities.js";
import type { FormInfo } from "./types.js";

const NAME_ATTR_RE = /\bname\s*=\s*["'`]([A-Za-z0-9_.[\]]+)["'`]/g;
const REGISTER_RE = /\bregister\(\s*["'`]([A-Za-z0-9_.[\]]+)["'`]/g;
const FIELD_NAME_RE = /<Field\b[^>]*\bname\s*=\s*["'`]([A-Za-z0-9_.[\]]+)["'`]/g;
const FORM_METHOD_RE = /<[Ff]orm\b[^>]*\bmethod\s*=\s*["'`]([A-Za-z]+)["'`]/;
const FORM_ACTION_RE = /<[Ff]orm\b[^>]*\baction\s*=\s*["'`]([^"'`]+)["'`]/;

function collectNames(file: string, content: string, re: RegExp): string[] {
	const names = new Set<string>();
	for (const m of grepContent(file, content, re)) {
		const n = m.groups[0];
		if (n) names.add(n.replace(/\[\d*\]$/, ""));
	}
	return [...names];
}

export function detectForms(repo: RepoFiles): FormInfo[] {
	const forms: FormInfo[] = [];
	for (const f of repo.files) {
		if (!/\.(tsx|jsx)$/.test(f.path)) continue;
		const content = readFileCached(f.abs);
		if (!content) continue;

		const hasRemixForm = /<Form\b/.test(content) && /@remix-run\/react|react-router/.test(content);
		const hasHtmlForm = /<form\b/.test(content);
		const usesRHF = /\buseForm\s*\(/.test(content) || /react-hook-form/.test(content);
		const usesFormik = /<Formik\b/.test(content) || /\buseFormik\s*\(/.test(content);
		if (!hasRemixForm && !hasHtmlForm && !usesRHF && !usesFormik) continue;

		const fields = new Set<string>();
		for (const n of collectNames(f.path, content, NAME_ATTR_RE)) fields.add(n);
		if (usesRHF) for (const n of collectNames(f.path, content, REGISTER_RE)) fields.add(n);
		if (usesFormik) for (const n of collectNames(f.path, content, FIELD_NAME_RE)) fields.add(n);

		// Require evidence of actual fields to avoid flagging search bars / layout forms.
		if (fields.size === 0) continue;
		// Skip forms whose only fields are search/filter inputs (common in headers/navs).
		const SEARCH_FIELDS = new Set([
			"q",
			"query",
			"search",
			"term",
			"keyword",
			"filter",
			"s",
			"sort",
		]);
		const meaningful = [...fields].filter((f) => !SEARCH_FIELDS.has(f.toLowerCase()));
		if (meaningful.length === 0) continue;

		let kind: FormInfo["kind"] = "html-form";
		if (usesRHF) kind = "react-hook-form";
		else if (usesFormik) kind = "formik";
		else if (hasRemixForm) kind = "remix-form";

		const methodMatch = FORM_METHOD_RE.exec(content);
		const actionMatch = FORM_ACTION_RE.exec(content);
		const method = (methodMatch?.[1] ?? (kind === "remix-form" ? "post" : "get")).toLowerCase();
		const line = grepContent(f.path, content, /<[Ff]orm\b|useForm\s*\(|<Formik\b/)[0]?.line ?? 1;
		forms.push({
			file: f.path,
			line,
			method,
			kind,
			fields: [...fields].sort(),
			entity: entityFromSegments(f.path.split(/[/.]/)),
			action: actionMatch ? actionMatch[1] : undefined,
		});
	}
	return forms.sort((a, b) => a.file.localeCompare(b.file));
}
