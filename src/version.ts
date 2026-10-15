import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function packageVersion(): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	for (;;) {
		try {
			const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
			if (pkg.name === "@justynclark/project-aware-qa" && typeof pkg.version === "string") {
				return pkg.version;
			}
		} catch {
			// Source and compiled layouts put the package manifest at different depths.
		}
		const parent = dirname(dir);
		if (parent === dir) throw new Error("Cannot locate project-aware-qa package metadata");
		dir = parent;
	}
}

export const TOOL = { name: "project-aware-qa", version: packageVersion() } as const;
