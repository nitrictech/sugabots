import type { ToolCallPart } from "@sugabots/contracts";

/*
 * How a reply's tool calls stand and are timed where the chat shows them:
 * the tool line above the reply and an approval card among its bubbles. What
 * they are called is `@/lib/tool-names.ts`.
 */

/**
 * Whether the call is stopped until a person allows or denies it. An allowed
 * call keeps `awaiting_approval` until its turn starts it, a moment later, but
 * waits on nobody.
 */
export function awaitsApproval(call: ToolCallPart): boolean {
	return call.status === "awaiting_approval" && call.approval?.status === "pending";
}

/** How long a bot worked on a reply: `12s`, `4m 1s`, `1h 2m`. */
export function formatElapsed(ms: number): string {
	const seconds = Math.max(Math.round(ms / 1_000), 0);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
