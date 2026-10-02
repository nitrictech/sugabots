import { builtInToolCatalog, CONNECTION_TOOL_SEPARATOR } from "@sugabots/contracts";

/**
 * What a tool call is called wherever it is shown: the tool line and approval
 * card in a thread, and a chat list row waiting on one.
 */

/** Calls to the product's own tools sit under this handle, which no connection can take. */
export const BUILT_IN_HANDLE = "";

/** The built-in tool an agent asks with for its sandbox to reach another host. */
export const NETWORK_REQUEST_TOOL = "request_network_access";

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

/** A tool as its approval card titles it: `List issues in Linear`, or a built-in tool's name alone. */
export function toolTitle(tool: string): string {
	const { handle, name } = splitToolKey(tool);
	const label = stepLabel(tool, name);
	return handle ? `${label} in ${connectionLabel(handle)}` : label;
}

/**
 * What a chat waiting for approval of `tool` is doing: `Waiting to list issues
 * in Linear`, or `Waiting to read web pages`. Tool names, built-in or
 * connected, read as what the tool does, so they follow "to".
 */
export function waitingText(tool: string): string {
	const title = toolTitle(tool);
	return `Waiting to ${title.charAt(0).toLowerCase()}${title.slice(1)}`;
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
