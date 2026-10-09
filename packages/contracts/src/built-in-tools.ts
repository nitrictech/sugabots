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
	"artifact_create",
	"artifact_replace",
	"document_replace_section",
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
		key: "artifact_create",
		name: "Create artifacts",
		description: "Makes a document or HTML page the pod keeps.",
	},
	{
		key: "artifact_replace",
		name: "Rewrite artifacts",
		description: "Saves a new version of a document or HTML page.",
	},
	{
		key: "document_replace_section",
		name: "Edit document sections",
		description: "Rewrites one section of a document, as a new version.",
	},
];
