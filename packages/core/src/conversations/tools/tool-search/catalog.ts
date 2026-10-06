import type { JSONSchema7 } from "ai";
import type { OfferedTool } from "../connections.ts";

/** How many tools one search returns at most. */
const SEARCH_RESULT_LIMIT = 5;

/**
 * How many of a search's best matches carry their whole input schema, and
 * how long those schemas may be together: about 3,000 tokens. The rest carry
 * only what picks between them, so a search adds little to the turn.
 */
const SCHEMAS_PER_SEARCH = 2;
const SEARCH_SCHEMA_CHARACTERS = 12_000;

/** How much of the turn's note may list tools by name: about 2,000 tokens. */
export const LISTING_CHARACTERS = 8_000;

/** A connection tool the model can find and call, by the key it calls it by: `notes__list_notes`. */
export type CatalogEntry = Pick<
	OfferedTool,
	"handle" | "remoteToolName" | "description" | "inputSchema"
> & { key: string };

/**
 * The tools in `tools` the pod's bots may call, sorted by key so the listing
 * built from them is the same from turn to turn. A tool turned off is left
 * out: it cannot be called.
 */
export function catalogOf(tools: Readonly<Record<string, OfferedTool>>): CatalogEntry[] {
	return Object.entries(tools)
		.filter(([, offered]) => offered.access !== "off")
		.map(([key, offered]) => ({ ...offered, key }))
		.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** A tool a search found: the best carry their input schema, the rest the parameters they require. */
type FoundTool =
	| { tool: string; description: string; inputSchema: JSONSchema7 }
	| { tool: string; description: string; required: string[] };

/**
 * The entries that best match `query`, best first. A tool that matches more
 * of the query's words ranks above one that matches fewer; among those, a
 * word in its name counts most, then its connection, then its parameters and
 * description. Ties go by key, so a search is repeatable.
 */
export function searchCatalog(catalog: readonly CatalogEntry[], query: string): FoundTool[] {
	const terms = [...new Set(wordsOf(query))].filter((word) => !STOP_WORDS.has(word)).map(stem);
	const ranked = catalog
		.map((entry) => ({ entry, ...matchOf(entry, terms) }))
		.filter(({ matched }) => matched > 0)
		.sort(
			(a, b) =>
				b.matched - a.matched || b.weight - a.weight || (a.entry.key < b.entry.key ? -1 : 1),
		)
		.slice(0, SEARCH_RESULT_LIMIT);
	let schemaCharacters = 0;
	return ranked.map(({ entry }, rank) => {
		schemaCharacters += JSON.stringify(entry.inputSchema).length;
		if (rank < SCHEMAS_PER_SEARCH && schemaCharacters <= SEARCH_SCHEMA_CHARACTERS) {
			return { tool: entry.key, description: entry.description, inputSchema: entry.inputSchema };
		}
		return {
			tool: entry.key,
			description: firstSentenceOf(entry.description),
			required: entry.inputSchema.required ?? [],
		};
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
	const name = stemsOf(entry.remoteToolName);
	const handle = stemsOf(entry.handle);
	const parameters = stemsOf(Object.keys(entry.inputSchema.properties ?? {}).join(" "));
	const description = stemsOf(entry.description);
	let matched = 0;
	let weight = 0;
	for (const term of terms) {
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

function firstSentenceOf(text: string): string {
	const end = text.search(/[.!?](\s|$)/);
	return end < 0 ? text : text.slice(0, end + 1);
}

/**
 * One line per connection, naming as many of its tools, by the full name
 * `call_tool` takes, as its share of `LISTING_CHARACTERS` holds, so a
 * connection with hundreds of tools cannot crowd the others out:
 * `- reports (371 tools): reports__run_report, …, and 340 more`.
 */
export function catalogListing(catalog: readonly CatalogEntry[]): string {
	const byConnection = new Map<string, string[]>();
	for (const entry of catalog) {
		byConnection.set(entry.handle, [...(byConnection.get(entry.handle) ?? []), entry.key]);
	}
	const share = Math.floor(LISTING_CHARACTERS / Math.max(1, byConnection.size));
	return [...byConnection]
		.map(([connection, keys]) => {
			const head = `- ${connection} (${keys.length} ${keys.length === 1 ? "tool" : "tools"})`;
			const all = `${head}: ${keys.join(", ")}`;
			// One character of each share is the line's break.
			if (all.length < share) return all;
			const more = `, and ${keys.length} more`;
			const shown: string[] = [];
			let length = head.length + 2 + more.length;
			for (const key of keys) {
				length += key.length + 2;
				if (length >= share) break;
				shown.push(key);
			}
			if (shown.length === 0) return head;
			return `${head}: ${shown.join(", ")}, and ${keys.length - shown.length} more`;
		})
		.join("\n");
}
