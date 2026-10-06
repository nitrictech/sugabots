import { CONNECTION_TOOL_SEPARATOR } from "@sugabots/contracts";
import { asSchema, type JSONSchema7 } from "ai";
import type { OfferedTool } from "../connections.ts";

/** How many tools one search returns at most. */
const SEARCH_RESULT_LIMIT = 5;

/**
 * How much of one search's result may be input schemas: about 5,000 tokens.
 * A match past it is returned without its schema, and searching for it by
 * name returns it with its schema first.
 */
const SEARCH_SCHEMA_CHARACTERS = 20_000;

/** How much of the turn's note may list tools by name: about 2,000 tokens. */
export const LISTING_CHARACTERS = 8_000;

/** One connection tool as a request would define it. */
export interface CatalogEntry {
	/** What the model names it by: `linear__list_issues`. */
	key: string;
	/** The connection's handle: `linear`. */
	handle: string;
	/** The server's own name for it: `list_issues`. */
	name: string;
	description: string;
	inputSchema: JSONSchema7;
	/** Whether the pod's bots may call it at all. */
	callable: boolean;
}

/**
 * Every tool in `tools` as a request would define it, sorted by key so a
 * listing built from them is the same from turn to turn. Built once per turn:
 * it is both what is measured and what is searched.
 */
export function catalogOf(tools: Readonly<Record<string, OfferedTool>>): CatalogEntry[] {
	return Object.entries(tools)
		.map(([key, offered]) => ({
			key,
			handle: key.slice(
				0,
				key.length - CONNECTION_TOOL_SEPARATOR.length - offered.remoteToolName.length,
			),
			name: offered.remoteToolName,
			// An MCP tool's description is the server's text, never a function of the call.
			description: typeof offered.tool.description === "string" ? offered.tool.description : "",
			inputSchema: jsonSchemaOf(offered),
			callable: offered.access !== "off",
		}))
		.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** The tool's input schema as JSON Schema, as the request carries it. */
function jsonSchemaOf(offered: OfferedTool): JSONSchema7 {
	const schema = asSchema(offered.tool.inputSchema).jsonSchema;
	// Only a schema built lazily is a promise; an MCP server's never is.
	return "then" in schema ? {} : schema;
}

/** The JSON a request would carry to define `entry` as a tool of its own. */
export function definitionJson(entry: CatalogEntry): string {
	return JSON.stringify({
		name: entry.key,
		description: entry.description,
		inputSchema: entry.inputSchema,
	});
}

/** A match from `searchCatalog`: its schema is left out once the result's schema budget is spent. */
export interface FoundTool {
	tool: string;
	description: string;
	inputSchema?: JSONSchema7;
}

/**
 * The callable entries that best match `query`, best first. A tool that
 * matches more of the query's words ranks above one that matches fewer;
 * among those, a word in its name counts most, then its connection, then its
 * parameters and description. Ties go by key, so a search is repeatable.
 */
export function searchCatalog(entries: readonly CatalogEntry[], query: string): FoundTool[] {
	const terms = [...new Set(wordsOf(query))].filter((word) => !STOP_WORDS.has(word));
	const ranked = entries
		.filter((entry) => entry.callable)
		.map((entry) => ({ entry, ...matchOf(entry, terms) }))
		.filter(({ matched }) => matched > 0)
		.sort(
			(a, b) =>
				b.matched - a.matched || b.weight - a.weight || (a.entry.key < b.entry.key ? -1 : 1),
		)
		.slice(0, SEARCH_RESULT_LIMIT);
	let schemaCharacters = 0;
	return ranked.map(({ entry }) => {
		const found = { tool: entry.key, description: entry.description };
		schemaCharacters += JSON.stringify(entry.inputSchema).length;
		return schemaCharacters <= SEARCH_SCHEMA_CHARACTERS
			? { ...found, inputSchema: entry.inputSchema }
			: found;
	});
}

/** Words common enough in descriptions to say nothing about which tool is meant. */
const STOP_WORDS = new Set(
	"a an and are as at be by can do for from get i in is it me my of on or our that the this to we what when with you your".split(
		" ",
	),
);

function matchOf(
	entry: CatalogEntry,
	terms: readonly string[],
): { matched: number; weight: number } {
	const name = stemsOf(entry.name);
	const handle = stemsOf(entry.handle);
	const parameters = stemsOf(Object.keys(entry.inputSchema.properties ?? {}).join(" "));
	const description = stemsOf(entry.description);
	let matched = 0;
	let weight = 0;
	for (const term of terms.map(stem)) {
		const termWeight =
			(name.has(term) ? 3 : 0) +
			(handle.has(term) ? 2 : 0) +
			(parameters.has(term) ? 1 : 0) +
			(description.has(term) ? 1 : 0);
		if (termWeight > 0) matched += 1;
		weight += termWeight;
	}
	return { matched, weight };
}

function stemsOf(text: string): Set<string> {
	return new Set(wordsOf(text).map(stem));
}

/** Lower-case words, with `snake_case`, `kebab-case` and `camelCase` taken apart. */
function wordsOf(text: string): string[] {
	return text
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((word) => word.length > 0);
}

/** A word without a plural ending, so `issues` finds `list_issue` and `queries` finds `query`. */
function stem(word: string): string {
	if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
	if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
	return word;
}

/** Each connection with callable tools, and how many it has. */
export function connectionsOf(
	entries: readonly CatalogEntry[],
): { connection: string; tools: number }[] {
	const counts = new Map<string, number>();
	for (const entry of entries) {
		if (entry.callable) counts.set(entry.handle, (counts.get(entry.handle) ?? 0) + 1);
	}
	return [...counts].map(([connection, tools]) => ({ connection, tools }));
}

/**
 * One line per connection, naming as many of its callable tools as its share
 * of `LISTING_CHARACTERS` holds, so a connection with hundreds of tools cannot
 * crowd the others out: `reports (371 tools): run_report, …, and 340 more`.
 * A tool turned off is left out: it cannot be called.
 */
export function catalogListing(entries: readonly CatalogEntry[]): string {
	const connections = connectionsOf(entries);
	const share = Math.floor(LISTING_CHARACTERS / Math.max(1, connections.length));
	return connections
		.map(({ connection, tools }) => {
			const head = `- ${connection} (${tools} ${tools === 1 ? "tool" : "tools"})`;
			const names: string[] = [];
			let length = head.length + 2;
			for (const entry of entries) {
				if (!entry.callable || entry.handle !== connection) continue;
				length += entry.name.length + 2;
				if (length > share) break;
				names.push(entry.name);
			}
			const more = tools - names.length;
			if (names.length === 0) return head;
			return `${head}: ${names.join(", ")}${more > 0 ? `, and ${more} more` : ""}`;
		})
		.join("\n");
}
