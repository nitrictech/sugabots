import { Schema } from "effect";

/**
 * The built-in tools the product ships: tools that do work for an agent,
 * offered to every crew agent unless an admin switches one off for it (ADR
 * 005). The keys are what the model calls and what a `tool_call` records;
 * the names and descriptions are for the agent's settings page.
 */
export const builtInToolKeySchema = Schema.Literals(["web_fetch", "web_search"]);
export type BuiltInToolKey = typeof builtInToolKeySchema.Type;

export interface BuiltInToolEntry {
	key: BuiltInToolKey;
	name: string;
	/** What the tool does, in one plain sentence. */
	description: string;
}

export const builtInToolCatalog: readonly BuiltInToolEntry[] = [
	{
		key: "web_fetch",
		name: "Read web pages",
		description: "Fetches a public page by its address and reads it as text.",
	},
	{
		key: "web_search",
		name: "Search the web",
		description: "Searches through the workspace's search provider, when one is switched on.",
	},
];
