import { Schema } from "effect";

/**
 * The built-in tools the product ships: tools that do work for a bot,
 * offered to every bot unless its creator or an admin switches one off for it
 * (ADR 005). A key is what a bot's `disabledTools` lists; for every tool but
 * `routines` it is also what the model calls and what a `tool_call` records,
 * and `routines` covers the tools a bot reads and changes its own automations
 * with. The names and descriptions are for the bot's settings page.
 */
export const builtInToolKeySchema = Schema.Literals([
	"web_fetch",
	"web_search",
	"routines",
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
		name: "Manage its automations",
		description: "Lists, sets up and changes its own automations when someone who manages it asks.",
		usesWeb: false,
	},
	{
		key: "artifact_list",
		name: "List files",
		description: "Lists the files it made, and those made in the channel it is in.",
		usesWeb: false,
	},
	{
		key: "artifact_read",
		name: "Read files",
		description: "Reads a file it made, or one made in the channel it is in.",
		usesWeb: false,
	},
	{
		key: "artifact_write",
		name: "Write files",
		description: "Makes a document or HTML page, or saves a new version of one.",
		usesWeb: false,
	},
	{
		key: "artifact_edit",
		name: "Edit files",
		description: "Changes part of a document or HTML page, as a new version.",
		usesWeb: false,
	},
];
