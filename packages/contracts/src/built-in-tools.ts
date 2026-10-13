import { Schema } from "effect";

/**
 * The built-in tools the product ships: tools that do work for an agent,
 * offered to every crew agent unless an admin switches one off for it (ADR
 * 005). The keys are what the model calls and what a `tool_call` records;
 * the names and descriptions are for the agent's settings page.
 */
export const builtInToolKeySchema = Schema.Literals([
	"web_fetch",
	"web_search",
	"artifact_list",
	"artifact_read",
	"artifact_write",
	"artifact_edit",
]);
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
	{
		key: "artifact_list",
		name: "List artifacts",
		description: "Lists the documents and HTML pages kept in the bot's pod.",
	},
	{
		key: "artifact_read",
		name: "Read artifacts",
		description: "Reads a document or HTML page kept in the bot's pod.",
	},
	{
		key: "artifact_write",
		name: "Write artifacts",
		description: "Makes a document or HTML page the pod keeps, or saves a new version of one.",
	},
	{
		key: "artifact_edit",
		name: "Edit artifacts",
		description: "Changes part of a document or HTML page, as a new version.",
	},
];
