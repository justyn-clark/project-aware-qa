/**
 * Local ambient type shim for the subset of the Pi extension API this pack uses.
 *
 * Pi loads `extensions/qa.ts` with its own bundled TypeScript loader and injects the
 * real `ExtensionAPI` at runtime, so this shim only needs to satisfy `tsc` during
 * `npm run build`. It is deliberately a faithful *subset* of
 * `@earendil-works/pi-coding-agent` (v0.80.x) — not the full surface.
 *
 * If you install `@earendil-works/pi-coding-agent` as a dependency, delete this file
 * and the real types take over.
 */
declare module "@earendil-works/pi-coding-agent" {
	export type ExtensionNotifyType = "info" | "warning" | "error";

	export interface ExtensionUIContext {
		/** Show a notification to the user. */
		notify(message: string, type?: ExtensionNotifyType): void;
		/** Set status text in the footer/status bar. Pass undefined to clear. */
		setStatus(key: string, text: string | undefined): void;
		/** Set the working/loading message shown during streaming. */
		setWorkingMessage(message?: string): void;
		/** Show a selector and return the user's choice. */
		select(title: string, options: string[], opts?: unknown): Promise<string | undefined>;
		/** Show a confirmation dialog. */
		confirm(title: string, message: string, opts?: unknown): Promise<boolean>;
		/** Show a text input dialog. */
		input(title: string, placeholder?: string, opts?: unknown): Promise<string | undefined>;
	}

	export interface ExtensionContext {
		ui: ExtensionUIContext;
		mode: "tui" | "rpc" | "print" | string;
		hasUI: boolean;
		cwd: string;
		isIdle(): boolean;
		signal: AbortSignal | undefined;
	}

	export interface ExtensionCommandContext extends ExtensionContext {
		/** Reload extensions, skills, prompts, and themes. */
		reload(): Promise<void>;
		waitForIdle(): Promise<void>;
	}

	export interface RegisteredCommandOptions {
		description?: string;
		getArgumentCompletions?: (
			argumentPrefix: string,
		) => unknown[] | null | Promise<unknown[] | null>;
		handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
	}

	export interface SendMessageInput {
		customType: string;
		content: string;
		display?: boolean;
		details?: unknown;
	}

	export interface ExtensionAPI {
		registerCommand(name: string, options: RegisteredCommandOptions): void;
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown): void;
		sendMessage(
			message: SendMessageInput,
			options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
		): void;
		exec(
			command: string,
			args: string[],
			options?: unknown,
		): Promise<{ stdout: string; stderr: string; code: number }>;
	}

	export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;
}
