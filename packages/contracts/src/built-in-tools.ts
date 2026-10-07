import { Schema } from "effect";

/**
 * The built-in tools the product ships: tools that do work for an agent,
 * offered to every crew agent unless an admin switches one off for it (ADR
 * 005). A key is what an agent's `disabledTools` lists; for the web tools it
 * is also what the model calls and what a `tool_call` records, and `routines`
 * covers the tools a bot reads and changes its own routines with. The names
 * and descriptions are for the agent's settings page.
 */
export const builtInToolKeySchema = Schema.Literals(["web_fetch", "web_search", "routines"]);
export type BuiltInToolKey = typeof builtInToolKeySchema.Type;

export interface BuiltInToolEntry {
	key: BuiltInToolKey;
	name: string;
	/** What the tool does, in one plain sentence. */
	description: string;
	/** Whether it reaches the web, so works only while the workspace allows that. */
	usesWeb: boolean;
}

export const builtInToolCatalog: readonly BuiltInToolEntry[] = [
	{
		key: "web_fetch",
		name: "Read web pages",
		description: "Fetches a public page by its address and reads it as text.",
		usesWeb: true,
	},
	{
		key: "web_search",
		name: "Search the web",
		description: "Searches through the workspace's search provider, when one is switched on.",
		usesWeb: true,
	},
	{
		key: "routines",
		name: "Manage its routines",
		description: "Lists, sets up and changes its own schedules when a pod admin asks it to.",
		usesWeb: false,
	},
];
