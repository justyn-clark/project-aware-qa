export interface RunProgress {
	stage: string;
	task?: string;
	command?: string;
	elapsedMs: number;
	remainingMs: number;
}
export type ProgressListener = (event: RunProgress) => void;
/** UI failures must not change test outcomes or skip cleanup. */
export function notifyProgress(listener: ProgressListener | undefined, event: RunProgress): void {
	try {
		listener?.(event);
	} catch {
		/* Reporting is advisory. */
	}
}
export function progressLabel(event: RunProgress): string {
	return `${event.stage}${event.task ? ` ${event.task}` : ""}: ${Math.round(event.elapsedMs / 1000)}s elapsed, ${Math.ceil(event.remainingMs / 1000)}s remaining${event.command ? ` (${event.command})` : ""}`;
}
