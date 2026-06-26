/**
 * Playwright configuration detection.
 *
 * The verifier needs to know whether Playwright is set up, what base URL to hit, and
 * whether the config can start a dev server (`webServer`). We extract these from
 * playwright.config.* with regex; when absent, the visual runner falls back to the
 * project's dev script + a default port.
 */
import type { RepoFiles } from "../scanner/files.js";
import { readFileCached } from "../scanner/files.js";

export interface PlaywrightConfig {
	present: boolean;
	configFile?: string;
	baseUrl?: string;
	testDir?: string;
	hasWebServer: boolean;
	webServerCommand?: string;
	webServerUrl?: string;
	webServerPort?: number;
	projects: string[];
}

function firstString(content: string, re: RegExp): string | undefined {
	const m = re.exec(content);
	return m ? (m[1] as string) : undefined;
}

export function detectPlaywright(repo: RepoFiles): PlaywrightConfig {
	const configFile = repo.files.find((f) => /(^|\/)playwright\.config\.(t|j)s$/.test(f.path));
	if (!configFile) {
		return { present: false, hasWebServer: false, projects: [] };
	}
	const content = readFileCached(configFile.abs) ?? "";
	const baseUrl = firstString(content, /baseURL\s*:\s*["'`]([^"'`]+)["'`]/);
	const testDir = firstString(content, /testDir\s*:\s*["'`]([^"'`]+)["'`]/);
	const webServerCommand = firstString(
		content,
		/webServer\s*:\s*\{[^}]*?command\s*:\s*["'`]([^"'`]+)["'`]/s,
	);
	const webServerUrl = firstString(
		content,
		/webServer\s*:\s*\{[^}]*?url\s*:\s*["'`]([^"'`]+)["'`]/s,
	);
	const portStr = firstString(content, /webServer\s*:\s*\{[^}]*?port\s*:\s*(\d+)/s);
	const projects = [...content.matchAll(/\bname\s*:\s*["'`]([^"'`]+)["'`]/g)].map(
		(m) => m[1] as string,
	);

	return {
		present: true,
		configFile: configFile.path,
		baseUrl,
		testDir,
		hasWebServer: Boolean(webServerCommand),
		webServerCommand,
		webServerUrl,
		webServerPort: portStr ? Number(portStr) : undefined,
		projects: [...new Set(projects)],
	};
}
