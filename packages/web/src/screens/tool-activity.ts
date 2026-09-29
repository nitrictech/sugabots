import {
	builtInToolCatalog,
	CONNECTION_TOOL_SEPARATOR,
	type ToolCallPart,
} from "@sugabots/contracts";

/*
 * How a reply's tool calls are named and timed where the thread shows them:
 * the tool line above the reply and an approval card among its bubbles.
 *
 * What the bot says just before a call is narration ("Now let me get the
 * cycle:"). The thread leaves it out, where it would read as a sentence
 * pointing at nothing; the tool line stands for what it introduced.
 */

/** Calls to the product's own tools sit under this handle, which no connection can take. */
export const BUILT_IN_HANDLE = "";

/**
 * Whether the call is stopped until a person allows or denies it. An allowed
 * call keeps `awaiting_approval` until its turn starts it, a moment later, but
 * waits on nobody.
 */
export function awaitsApproval(call: ToolCallPart): boolean {
	return call.status === "awaiting_approval" && call.approval?.status === "pending";
}

/**
 * What a connection is called wherever one of its tools is shown. A handle with
 * no connection behind it any more is written out rather than shown raw, so a
 * deleted connection reads as `Linear` and not as `linear`.
 */
export function connectionLabel(handle: string, name?: string): string {
	if (handle === BUILT_IN_HANDLE) return "Built-in tools";
	return name ?? wordsFromKey(handle);
}

/**
 * A tool key as the connection and the tool it names. A key with no separator
 * is one of the product's own tools, which belong to no connection.
 */
export function splitToolKey(tool: string): { handle: string; name: string } {
	const at = tool.indexOf(CONNECTION_TOOL_SEPARATOR);
	if (at < 0) return { handle: BUILT_IN_HANDLE, name: tool };
	return { handle: tool.slice(0, at), name: tool.slice(at + CONNECTION_TOOL_SEPARATOR.length) };
}

/**
 * What a step is called in the log.
 *
 * The product's own tools have written names in the catalog. A connection's tool
 * has only the key its server published, so the key is what gets written out:
 * `search_issues` reads as `Search issues`. That relies on the `verb_noun`
 * naming MCP servers conventionally use, and a server that names a tool
 * `API-post-search` or `doIt` gets that back tidied rather than fixed — a known
 * and accepted limit, to be dealt with if such a server turns up.
 *
 * Note this says which tool ran, never what it found. Saying what a call
 * returned means summarising its output, which nothing here produces.
 */
export function stepLabel(tool: string, name = splitToolKey(tool).name): string {
	const builtIn = builtInToolCatalog.find((entry) => entry.key === tool);
	return builtIn ? builtIn.name : wordsFromKey(name);
}

/**
 * A machine key written out as words: `search_issues` as `Search issues`,
 * `sentry` as `Sentry`, a tool argument's `due_date` or `dueDate` as `Due date`.
 */
export function wordsFromKey(key: string): string {
	const words = key
		.replace(
			/([a-z0-9])([A-Z])/g,
			(_, before: string, capital: string) => `${before} ${capital.toLowerCase()}`,
		)
		.replace(/[_-]+/g, " ")
		.trim();
	if (!words) return key;
	return words.charAt(0).toUpperCase() + words.slice(1);
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
