import { tool } from "ai";
import { Schema } from "effect";
import type { FetchPage } from "./fetch-page.ts";

export const WEB_FETCH_TOOL = "web_fetch";

/**
 * The `web_fetch` built-in tool: read one public web page.
 *
 * The outcome goes to the model as it is, refusals included, so the agent
 * can try another address or say what happened. The recording wrapper in
 * `tools/calls` writes the call down; this tool only fetches.
 */
export function webFetchTool({ fetchPage }: { fetchPage: FetchPage }) {
	return tool({
		description:
			"Read a public web page. Give it the full address of a page a person shared, one you know, or one from a search result, and you get the page's title and main content as Markdown to quote or summarise. Pages are fetched over HTTPS; it cannot sign in, run scripts, or reach private networks. When your reply relies on what a page says, name its URL.",
		inputSchema: Schema.Struct({
			url: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_048)).annotate({
				description: "The full http or https address of the page",
			}),
		}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
		execute: ({ url }, { abortSignal }) => fetchPage(url, abortSignal),
	});
}
