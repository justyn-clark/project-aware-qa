/**
 * Stack adapter contract.
 *
 * The core (file walking, entity-correlated inference, risk scoring, registry assembly,
 * reports, calibrated verify) is language-agnostic. Everything stack-specific lives behind
 * a `StackAdapter`: which files to read, how to detect the toolchain, and how that
 * ecosystem expresses routes/endpoints/forms/schemas/cache/tests. A repo can match several
 * adapters (monorepo) - the scanner runs each over its subtree and merges the results.
 */
import type { DetectionBundle } from "../detectors/types.js";
import type { RepoFiles } from "../scanner/files.js";
import type { StackInfo, Surface } from "../types.js";

/** A place in the repo where an adapter applies (one per marker-file location). */
export interface StackMatch {
	adapter: string;
	/** Repo-relative root of this stack ("" = repo root). */
	rootRel: string;
	label: string;
	/** Higher wins when ordering / picking the primary stack. */
	confidence: number;
}

/** What an adapter produces for one matched location. */
export interface StackScan {
	stack: StackInfo;
	/** Per-layer detector output fed to the shared entity-correlation inference. */
	bundle: DetectionBundle;
	/** Adapter-specific surfaces appended verbatim (e.g. the generic baseline). */
	extraSurfaces: Surface[];
}

export interface StackAdapter {
	id: string;
	name: string;
	/** "deep" parses real web surfaces; "generic" is the any-language baseline. */
	kind: "deep" | "generic";
	/** File extensions whose contents this adapter reads (for the walker's allowlist). */
	extensions: string[];
	/** Build-file / marker names that indicate this stack (e.g. "package.json", "mix.exs"). */
	markers: string[];
	/** Find every location in the repo where this stack applies. */
	detect(repo: RepoFiles): StackMatch[];
	/** Scan one matched location into a stack info + detection bundle + extra surfaces. */
	scan(repo: RepoFiles, match: StackMatch): StackScan;
}

/** Empty bundle helper for adapters that only fill some layers. */
export function emptyBundle(): DetectionBundle {
	return { routes: [], endpoints: [], dtos: [], forms: [], cacheSignals: [], tests: [] };
}
