import type { JSONSchema7 } from "ai";
import type { OfferedTool } from "../connections.ts";

const SEARCH_RESULT_LIMIT = 5;

/** Only the best matches carry whole schemas, so a search adds about 3,000 tokens at most. */
const SCHEMAS_PER_SEARCH = 2;
const SEARCH_SCHEMA_CHARACTERS = 12_000;

/** About 2,000 tokens of the turn's note. */
export const LISTING_CHARACTERS = 8_000;

export type CatalogEntry = Pick<
	OfferedTool,
	"handle" | "remoteToolName" | "description" | "inputSchema"
> & { key: string };

/** buildCatalog returns the tools that may be called, sorted so the listing is stable across turns. */
export function buildCatalog(tools: Readonly<Record<string, OfferedTool>>): CatalogEntry[] {
	return Object.entries(tools)
		.filter(([, offered]) => offered.access !== "off")
		.map(([key, offered]) => ({ ...offered, key }))
		.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

type FoundTool =
	| { tool: string; description: string; inputSchema: JSONSchema7 }
	| { tool: string; description: string; required: string[] };

/**
 * searchCatalog returns the entries that match most of `query`'s words, a
 * match in the tool's name weighing most. Ties go by key, so it is repeatable.
 */
export function searchCatalog(catalog: readonly CatalogEntry[], query: string): FoundTool[] {
	const terms = [...new Set(splitWords(query))].filter((word) => !STOP_WORDS.has(word)).map(stem);
	const ranked = catalog
		.map((entry) => ({ entry, ...scoreMatch(entry, terms) }))
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
			description: firstSentence(entry.description),
			required: entry.inputSchema.required ?? [],
		};
	});
}

const STOP_WORDS = new Set(
	"a an and are as at be by can do for from get i in is it me my of on or our that the this to we what when with you your".split(
		" ",
	),
);

function scoreMatch(
	entry: CatalogEntry,
	terms: readonly string[],
): { matched: number; weight: number } {
	const name = stemWords(entry.remoteToolName);
	const handle = stemWords(entry.handle);
	const parameters = stemWords(Object.keys(entry.inputSchema.properties ?? {}).join(" "));
	const description = stemWords(entry.description);
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

function stemWords(text: string): Set<string> {
	return new Set(splitWords(text).map(stem));
}

function splitWords(text: string): string[] {
	return text
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((word) => word.length > 0);
}

/** stem drops a plural ending, so `issues` finds `list_issue`. */
function stem(word: string): string {
	if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
	if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
	return word;
}

function firstSentence(text: string): string {
	const end = text.search(/[.!?](\s|$)/);
	return end < 0 ? text : text.slice(0, end + 1);
}

/**
 * catalogListing names each connection's tools within an equal share of
 * `LISTING_CHARACTERS`, so one with hundreds of tools cannot crowd out the rest.
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
