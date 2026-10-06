import type { JSONSchema7 } from "ai";
import MiniSearch from "minisearch";
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

/** searchCatalog returns any tool `query` names first, then MiniSearch's best matches. */
export function searchCatalog(catalog: readonly CatalogEntry[], query: string): FoundTool[] {
	const name = query.trim();
	const named = catalog.filter((entry) => entry.key === name || entry.remoteToolName === name);
	const index = new MiniSearch<CatalogEntry>({
		idField: "key",
		fields: ["remoteToolName", "handle", "description", "parameters"],
		extractField: (entry, field) =>
			field === "parameters"
				? Object.keys(entry.inputSchema.properties ?? {}).join(" ")
				: entry[field as keyof CatalogEntry],
		tokenize: splitWords,
		processTerm: (term) => (STOP_WORDS.has(term) ? null : term),
		searchOptions: { boost: { remoteToolName: 3, handle: 2 }, prefix: true, fuzzy: 0.2 },
	});
	index.addAll(catalog);
	const byKey = new Map(catalog.map((entry) => [entry.key, entry]));
	const ranked = [
		...named,
		...index
			.search(query)
			.flatMap((result) => byKey.get(result.id) ?? [])
			.filter((entry) => !named.includes(entry)),
	].slice(0, SEARCH_RESULT_LIMIT);
	let schemaCharacters = 0;
	return ranked.map((entry, rank) => {
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

/** splitWords also splits `snake_case` and `camelCase`, which tool names use. */
function splitWords(text: string): string[] {
	return text
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((word) => word.length > 0);
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
