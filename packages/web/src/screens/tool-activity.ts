import type { ToolCallPart } from "@sugabots/contracts";

/*
 * How a reply's tool calls stand and are timed where the thread shows them:
 * the tool line above the reply and an approval card among its bubbles. What
 * they are called is `@/lib/tool-names.ts`.
 *
 * What the bot says just before a call is narration ("Now let me get the
 * cycle:"). The thread leaves it out, where it would read as a sentence
 * pointing at nothing; the tool line stands for what it introduced.
 */

/**
 * Whether the call is stopped until a person allows or denies it. An allowed
 * call keeps `awaiting_approval` until its turn starts it, a moment later, but
 * waits on nobody.
 */
export function awaitsApproval(call: ToolCallPart): boolean {
	return call.status === "awaiting_approval" && call.approval?.status === "pending";
}

export function durationOf(call: ToolCallPart): number {
	if (!call.finishedAt) return 0;
	return Math.max(new Date(call.finishedAt).getTime() - new Date(call.startedAt).getTime(), 0);
}

/** What one step or one connection took: `473ms`, `1.4s`, `30.6s`. */
export function formatDuration(ms: number): string {
	if (ms < 1_000) return `${Math.round(ms)}ms`;
	return `${(ms / 1_000).toFixed(1)}s`;
}

/**
 * What the whole turn took: `32s`. Rounded where a step is not, because the
 * total is there to be read at a glance rather than added up.
 */
export function formatTotal(ms: number): string {
	if (ms < 1_000) return `${Math.round(ms)}ms`;
	return `${Math.round(ms / 1_000)}s`;
}

/**
 * Why a failed step failed, once per distinct reason — a row folded from
 * several calls that all timed out has one thing to say, not four.
 */
