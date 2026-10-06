import { tool } from "ai";
import { Effect, Schema } from "effect";
import {
	MAX_SEARCH_RESULTS,
	type SearchOutcome,
	type SearchRequest,
} from "../../../providers/search-providers/backends.ts";

export const WEB_SEARCH_TOOL = "web_search";
const MAX_QUERY_LENGTH = 400;

/**
 * The `web_search` built-in tool: ask the workspace's search provider.
 *
 * Results are titles, addresses and snippets; reading a result is `web_fetch`'s
 * job, so a search never costs more than the one call.
 */
export function webSearchTool({
	search,
}: {
	search: (request: SearchRequest) => Promise<SearchOutcome>;
}) {
	return tool({
		description:
			"Search the web. Returns titles, addresses and short snippets for a query; use web_fetch to read any result in full. Good for finding a page you do not have the address of, and for anything recent. When your reply relies on a result, name its URL.",
		inputSchema: Schema.Struct({
			query: Schema.String.check(
				Schema.makeFilter(
					(query) => {
						const length = query.trim().length;
						return length >= 1 && length <= MAX_QUERY_LENGTH;
					},
					{
						expected: `a query with 1 to ${MAX_QUERY_LENGTH} characters after trimming`,
						toJsonSchema: () => ({ minLength: 1, maxLength: MAX_QUERY_LENGTH }),
					},
				),
			)
				.annotate({ description: "What to search for, as you would type it" })
				.pipe(Schema.decodeTo(Schema.Trim)),
			count: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_SEARCH_RESULTS }))
				.annotate({ description: "How many results to return", default: 5 })
				.pipe(Schema.withDecodingDefaultKey(Effect.succeed(5))),
		}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
		execute: ({ query, count }, { abortSignal }) => search({ query, count, signal: abortSignal }),
	});
}
