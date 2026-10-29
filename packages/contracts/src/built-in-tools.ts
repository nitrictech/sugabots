import { Schema } from "effect";

/**
 * The built-in tools the product ships: tools that do work for an agent,
 * offered to every crew agent unless an admin switches one off for it (ADR
 * 005). A key is what an agent's `disabledTools` lists; for every tool but
 * `routines` it is also what the model calls and what a `tool_call` records,
 * and `routines` covers the tools a bot reads and changes its own routines
 * with. The names and descriptions are for the agent's settings page.
 */
export const builtInToolKeySchema = Schema.Literals([
	"web_fetch",
	"web_search",
	"routines",
	"artifact_list",
	"artifact_read",
	"artifact_write",
	"artifact_edit",
	"ask_form",
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
		name: "Manage its routines",
		description: "Lists, sets up and changes its own schedules when a pod admin asks it to.",
		usesWeb: false,
	},
	{
		key: "artifact_list",
		name: "List artifacts",
		description: "Lists the documents and HTML pages kept in the bot's pod.",
		usesWeb: false,
	},
	{
		key: "artifact_read",
		name: "Read artifacts",
		description: "Reads a document or HTML page kept in the bot's pod.",
		usesWeb: false,
	},
	{
		key: "artifact_write",
		name: "Write artifacts",
		description: "Makes a document or HTML page the pod keeps, or saves a new version of one.",
		usesWeb: false,
	},
	{
		key: "artifact_edit",
		name: "Edit artifacts",
		description: "Changes part of a document or HTML page, as a new version.",
		usesWeb: false,
	},
	{
		key: "ask_form",
		name: "Ask with a form",
		description:
			"Asks the people in a conversation to fill in a form, and waits for their answer before it carries on.",
		usesWeb: false,
	},
];
