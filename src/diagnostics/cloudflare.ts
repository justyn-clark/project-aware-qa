import type { DiagnosticCheck } from "./config.js";
import { number, object, text } from "./config.js";

/** Fixed-origin GET only. Credentials and provider response bodies are never persisted. */
export async function inspectCloudflare(
	check: DiagnosticCheck,
	signal: AbortSignal,
	request: typeof fetch = fetch,
) {
	const token = process.env[check.tokenEnv];
	if (!token) throw Error(`Missing environment variable: ${check.tokenEnv}`);
	const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(check.accountId as string)}/workers/scripts/${encodeURIComponent(check.worker as string)}/deployments`;
	const response = await request(url, {
		method: "GET",
		headers: { Authorization: `Bearer ${token}` },
		redirect: "error",
		signal,
	});
	if (!response.ok) throw Error(`Cloudflare GET returned HTTP ${response.status}`);
	const reader = response.body?.getReader();
	if (!reader) throw Error("Missing Cloudflare response");
	let bytes = 0;
	const chunks: Uint8Array[] = [];
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.length;
			if (bytes > 2 * 1024 * 1024) throw Error("Cloudflare response exceeds limit");
			chunks.push(value);
		}
	} finally {
		await reader.cancel();
	}
	const data = object(JSON.parse(Buffer.concat(chunks).toString()), "Cloudflare response");
	if (data.success !== true) throw Error("Cloudflare API reported failure");
	const result = object(data.result, "Cloudflare result");
	if (!Array.isArray(result.deployments) || !result.deployments.length)
		throw Error("No active deployment returned");
	// Cloudflare documents the first deployment as the latest actively serving traffic.
	const deployment = object(result.deployments[0], "deployment");
	const id = text(deployment.id, "deployment.id");
	if (!Array.isArray(deployment.versions) || !deployment.versions.length)
		throw Error("Missing deployment versions");
	const versions = deployment.versions.map((v) => {
		const item = object(v, "version");
		const percentage = number(item.percentage, "percentage");
		if (percentage > 100) throw Error("Invalid traffic percentage");
		return { id: text(item.version_id, "version_id"), percentage };
	});
	if (Math.abs(versions.reduce((n, v) => n + v.percentage, 0) - 100) > 0.01)
		throw Error("Incomplete traffic allocation");
	const matched =
		versions.length === 1 &&
		versions[0]?.id === check.expectedVersion &&
		versions[0]?.percentage === 100;
	return {
		status: matched ? ("passed" as const) : ("failed" as const),
		summary: matched
			? "Expected Worker version serves 100% of traffic; health and bindings were not verified"
			: "Active deployment does not assign 100% of traffic to the expected version",
		details: {
			provider: "cloudflare",
			accountId: check.accountId,
			worker: check.worker,
			observedAt: new Date().toISOString(),
			deploymentId: id,
			versions,
			expectedVersion: check.expectedVersion,
			method: "GET",
			boundary: "deployment identity only",
		},
	};
}
