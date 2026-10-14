import type { CheckResult, VerifyResult } from "../verify/index.js";
import { TOOL } from "../version.js";

function xml(value: string): string {
	return [...value]
		.filter((character) => {
			const code = character.codePointAt(0) as number;
			return (
				code === 9 ||
				code === 10 ||
				code === 13 ||
				(code >= 32 && code <= 0xd7ff) ||
				(code >= 0xe000 && code <= 0xfffd) ||
				(code >= 0x10000 && code <= 0x10ffff)
			);
		})
		.join("")
		.replace(/[<>&"']/g, (character) => {
			const entities: Record<string, string> = {
				"<": "&lt;",
				">": "&gt;",
				"&": "&amp;",
				'"': "&quot;",
				"'": "&apos;",
			};
			return entities[character] as string;
		});
}

function detail(check: CheckResult): string {
	return check.reason ?? check.summary ?? check.status;
}

export function renderJUnit(result: VerifyResult): string {
	const failures = result.checks.filter((check) => check.status === "failed").length;
	const skipped = result.checks.filter(
		(check) => check.status === "skipped" || check.status === "inconclusive",
	).length;
	const duration =
		result.checks.reduce((total, check) => total + (check.durationMs ?? 0), 0) / 1000;
	const cases = result.checks.map((check) => {
		const seconds = (check.durationMs ?? 0) / 1000;
		const resultNode =
			check.status === "failed"
				? `<failure message="${xml(detail(check))}" type="verification">${xml(detail(check))}</failure>`
				: check.status === "skipped" || check.status === "inconclusive"
					? `<skipped message="${xml(detail(check))}"/>`
					: "";
		const output = check.evidencePath
			? `<system-out>${xml(`Evidence: .qa/${check.evidencePath}`)}</system-out>`
			: "";
		return `<testcase classname="project-aware-qa" name="${xml(check.id)}" time="${seconds.toFixed(3)}">${resultNode}${output}</testcase>`;
	});
	return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites tests="${result.checks.length}" failures="${failures}" skipped="${skipped}" time="${duration.toFixed(3)}"><testsuite name="project-aware-qa" timestamp="${xml(result.generatedAt)}" tests="${result.checks.length}" failures="${failures}" skipped="${skipped}" time="${duration.toFixed(3)}">${cases.join("")}</testsuite></testsuites>\n`;
}

export function renderSarif(result: VerifyResult): string {
	const findings = result.checks.filter(
		(check) => check.status === "failed" || check.status === "inconclusive",
	);
	const rules = findings.map((check) => ({
		id: check.id,
		name: check.title,
		shortDescription: { text: check.title },
		help: { text: detail(check) },
	}));
	const results = findings.map((check) => ({
		ruleId: check.id,
		level: check.status === "failed" ? "error" : "warning",
		message: { text: detail(check) },
		properties: {
			status: check.status,
			...(check.command ? { command: check.command } : {}),
			...(check.evidencePath ? { evidencePath: `.qa/${check.evidencePath}` } : {}),
		},
		locations: (check.surfaceIds ?? []).flatMap((id) => {
			const surface = result.registry?.surfaces.find((surface) => surface.id === id);
			const file = surface?.files[0];
			return file && !file.startsWith("/") && !file.split("/").includes("..")
				? [
						{
							physicalLocation: {
								artifactLocation: {
									uri: file.split("/").map(encodeURIComponent).join("/"),
									uriBaseId: "%SRCROOT%",
								},
							},
						},
					]
				: [];
		}),
	}));
	return `${JSON.stringify(
		{
			$schema: "https://json.schemastore.org/sarif-2.1.0.json",
			version: "2.1.0",
			runs: [
				{
					tool: {
						driver: {
							name: "project-aware-qa",
							version: TOOL.version,
							informationUri: "https://github.com/justyn-clark/project-aware-qa",
							rules,
						},
					},
					results,
					invocations: [
						{
							executionSuccessful: !result.checks.some(
								(check) => check.id === "preflight" && check.status === "failed",
							),
						},
					],
					properties: {
						runId: result.runId,
						generatedAt: result.generatedAt,
						sourceHash: result.registry?.provenance?.inputHash,
						selection: result.selection,
						policy: result.policy,
					},
				},
			],
		},
		null,
		2,
	)}\n`;
}
