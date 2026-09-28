import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { EXA_FREE_SEARCH_URL } from "@sugabots/contracts";
import { Data, Effect, Schema } from "effect";
import { UserMessage } from "../../user-message.ts";
import { VERSION } from "../../version.ts";
import { type EgressHttpClient, EgressRefused } from "../network/egress.ts";
import type { SearchConnection } from "./search-connection.ts";

/**
 * The search services `web_search` knows how to call, one function each.
 *
 * Every backend takes the same request and answers the same shape, so the
 * tool and the settings test are written once. A failure is an answer with a
 * reason, never a throw: the agent, or the admin testing the connection,
 * reads it as a sentence, and what the service said goes only to the logs.
 */

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
	/** As the service reported it, when it did; not normalised. */
	published: string | null;
}

export type SearchOutcome =
	| { ok: true; results: SearchResult[] }
	| { ok: false; reason: UserMessage };

export interface SearchRequest {
	query: string;
	/** How many results to ask for; a backend may return fewer. */
	count: number;
	signal?: AbortSignal;
}

/** Never fails: what goes wrong is an outcome, and its details are logged. */
export type SearchBackend = (request: SearchRequest) => Effect.Effect<SearchOutcome>;

export const MAX_SEARCH_RESULTS = 10;
const SEARCH_TIMEOUT_MS = 10_000;

/**
 * Where a connection's searches go, which is what its egress client is bound
 * to. Exa without a key is the one case where that is not the provider's
 * configured address.
 */
export function searchEndpoint(connection: SearchConnection): string {
	return connection.preset === "exa" && !connection.apiKey
		? EXA_FREE_SEARCH_URL
		: connection.baseUrl;
}

/** The backend for a workspace's connection, calling through its bound egress client. */
export function searchBackend(
	connection: SearchConnection,
	fetch: EgressHttpClient,
): SearchBackend {
	switch (connection.preset) {
		case "brave":
			return braveSearch(connection, fetch);
		case "exa":
			return connection.apiKey ? exaSearch(connection, fetch) : exaFreeSearch(fetch);
		case "tavily":
			return tavilySearch(connection, fetch);
		case "searxng":
			return searxngSearch(connection, fetch);
	}
}

const braveResponse = Schema.Struct({
	web: Schema.optional(
		Schema.Struct({
			results: Schema.Array(
				Schema.Struct({
					title: Schema.String,
					url: Schema.String,
					description: Schema.optional(Schema.String),
					page_age: Schema.optional(Schema.String),
					age: Schema.optional(Schema.String),
				}),
			),
		}),
	),
});

function braveSearch(connection: SearchConnection, fetch: EgressHttpClient): SearchBackend {
	return ({ query, count, signal }) => {
		const url = new URL(`${connection.baseUrl.replace(/\/$/, "")}/web/search`);
		url.searchParams.set("q", query);
		url.searchParams.set("count", String(count));
		return answer("Brave Search", signal, async (stop) => {
			const response = await fetch(url, {
				signal: stop,
				headers: {
					accept: "application/json",
					"x-subscription-token": connection.apiKey ?? "",
				},
			});
			if (!response.ok) {
				return refused(UserMessage.of`Brave Search answered HTTP ${response.status}`);
			}
			const parsed = Schema.decodeUnknownResult(braveResponse)(await response.json());
			if (parsed._tag === "Failure") {
				return refused(
					UserMessage.of`Brave Search answered with something that is not a result list`,
				);
			}
			return {
				ok: true,
				results: (parsed.success.web?.results ?? []).map((result) => ({
					title: result.title,
					url: result.url,
					snippet: result.description ?? "",
					published: result.page_age ?? result.age ?? null,
				})),
			};
		});
	};
}

const exaResponse = Schema.Struct({
	results: Schema.Array(
		Schema.Struct({
			title: Schema.optional(Schema.NullOr(Schema.String)),
			url: Schema.String,
			publishedDate: Schema.optional(Schema.NullOr(Schema.String)),
			highlights: Schema.optional(Schema.Array(Schema.String)),
		}),
	),
});

function exaSearch(connection: SearchConnection, fetch: EgressHttpClient): SearchBackend {
	return ({ query, count, signal }) => {
		const url = `${connection.baseUrl.replace(/\/$/, "")}/search`;
		return answer("Exa", signal, async (stop) => {
			const response = await fetch(url, {
				method: "POST",
				signal: stop,
				headers: {
					accept: "application/json",
					"content-type": "application/json",
					"x-api-key": connection.apiKey ?? "",
				},
				body: JSON.stringify({
					query,
					numResults: count,
					type: "auto",
					// A sentence or two per result is the snippet; the page itself is web_fetch's job.
					contents: { highlights: { maxCharacters: 300 } },
				}),
			});
			if (!response.ok) {
				return refused(UserMessage.of`Exa answered HTTP ${response.status}`);
			}
			const parsed = Schema.decodeUnknownResult(exaResponse)(await response.json());
			if (parsed._tag === "Failure") {
				return refused(UserMessage.of`Exa answered with something that is not a result list`);
			}
			return {
				ok: true,
				results: parsed.success.results.map((result) => ({
					title: result.title ?? result.url,
					url: result.url,
					snippet: (result.highlights ?? []).join(" "),
					published: result.publishedDate ?? null,
				})),
			};
		});
	};
}

const tavilyResponse = Schema.Struct({
	results: Schema.Array(
		Schema.Struct({
			title: Schema.String,
			url: Schema.String,
			content: Schema.optional(Schema.NullOr(Schema.String)),
			published_date: Schema.optional(Schema.NullOr(Schema.String)),
		}),
	),
});

function tavilySearch(connection: SearchConnection, fetch: EgressHttpClient): SearchBackend {
	return ({ query, count, signal }) => {
		const url = `${connection.baseUrl.replace(/\/$/, "")}/search`;
		return answer("Tavily", signal, async (stop) => {
			const response = await fetch(url, {
				method: "POST",
				signal: stop,
				headers: {
					accept: "application/json",
					"content-type": "application/json",
					authorization: `Bearer ${connection.apiKey ?? ""}`,
				},
				body: JSON.stringify({ query, max_results: count, search_depth: "basic" }),
			});
			if (!response.ok) {
				return refused(UserMessage.of`Tavily answered HTTP ${response.status}`);
			}
			const parsed = Schema.decodeUnknownResult(tavilyResponse)(await response.json());
			if (parsed._tag === "Failure") {
				return refused(UserMessage.of`Tavily answered with something that is not a result list`);
			}
			return {
				ok: true,
				results: parsed.success.results.map((result) => ({
					title: result.title,
					url: result.url,
					snippet: result.content ?? "",
					published: result.published_date ?? null,
				})),
			};
		});
	};
}

/**
 * Exa without a key: its free MCP endpoint. Rate limited, and a text answer
 * rather than JSON, which `parseExaText` reads back into results. Each search
 * is one short MCP session.
 */
function exaFreeSearch(fetch: EgressHttpClient): SearchBackend {
	return ({ query, count, signal }) =>
		answer("Exa", signal, async (stop) => {
			const client = new Client({ name: "sugabots", version: VERSION });
			const transport = new StreamableHTTPClientTransport(new URL(EXA_FREE_SEARCH_URL), {
				fetch,
				requestInit: { signal: stop },
			});
			try {
				await client.connect(transport, { timeout: SEARCH_TIMEOUT_MS });
				const result = await client.callTool(
					{
						name: "web_search_exa",
						arguments: {
							query,
							numResults: count,
							objective: `Find pages that answer: ${query}`,
						},
					},
					undefined,
					{ timeout: SEARCH_TIMEOUT_MS, signal: stop },
				);
				const text = (result.content as Array<{ type: string; text?: string }>)
					.filter((part) => part.type === "text")
					.map((part) => part.text ?? "")
					.join("\n");
				if (result.isError) {
					// Exa's text is its own and may say anything, so it goes to the logs.
					throw new SearchRefused({
						userMessage: UserMessage.of`Exa refused the search`,
						detail: text,
					});
				}
				return { ok: true, results: parseExaText(text).slice(0, count) };
			} finally {
				await client.close().catch(() => undefined);
			}
		});
}

/**
 * Exa's MCP tool answers one text block per result: `Title:`, `URL:`,
 * `Published:`, `Author:`, then `Highlights:` and the passages, results
 * separated by a rule. "N/A" is how it says it does not know.
 */
export function parseExaText(text: string): SearchResult[] {
	return text
		.split(/\n---\n/)
		.map((block) => block.trim())
		.filter(Boolean)
		.flatMap((block) => {
			const field = (name: string) =>
				block.match(new RegExp(`^${name}:\\s*(.*)$`, "m"))?.[1]?.trim();
			const url = field("URL");
			if (!url) return [];
			const highlights = block.split(/^Highlights:\s*$/m)[1] ?? "";
			const published = field("Published");
			return [
				{
					title: field("Title") || url,
					url,
					snippet: highlights
						.split("\n")
						.map((line) => line.trim())
						.filter((line) => line && line !== "...")
						.join(" ")
						.slice(0, 500),
					published: published && published !== "N/A" ? published : null,
				},
			];
		});
}

const searxngResponse = Schema.Struct({
	results: Schema.Array(
		Schema.Struct({
			title: Schema.String,
			url: Schema.String,
			content: Schema.optional(Schema.NullOr(Schema.String)),
			publishedDate: Schema.optional(Schema.NullOr(Schema.String)),
		}),
	),
});

function searxngSearch(connection: SearchConnection, fetch: EgressHttpClient): SearchBackend {
	return ({ query, count, signal }) => {
		const url = new URL(`${connection.baseUrl.replace(/\/$/, "")}/search`);
		url.searchParams.set("q", query);
		url.searchParams.set("format", "json");
		return answer("SearXNG", signal, async (stop) => {
			const response = await fetch(url, {
				signal: stop,
				headers: {
					accept: "application/json",
					// A key is unusual for SearXNG itself; a proxy in front of it may check one.
					...(connection.apiKey ? { authorization: `Bearer ${connection.apiKey}` } : {}),
				},
			});
			if (response.status === 403) {
				return refused(
					UserMessage.of`SearXNG refused the request; its JSON format may be off in settings.yml`,
				);
			}
			if (!response.ok) {
				return refused(UserMessage.of`SearXNG answered HTTP ${response.status}`);
			}
			const parsed = Schema.decodeUnknownResult(searxngResponse)(await response.json());
			if (parsed._tag === "Failure") {
				return refused(UserMessage.of`SearXNG answered with something that is not a result list`);
			}
			return {
				ok: true,
				results: parsed.success.results.slice(0, count).map((result) => ({
					title: result.title,
					url: result.url,
					snippet: result.content ?? "",
					published: result.publishedDate ?? null,
				})),
			};
		});
	};
}

function refused(reason: UserMessage): SearchOutcome {
	return { ok: false, reason };
}

/**
 * A service's answer that it would not search, thrown from inside a call so
 * `answer` logs what it said and tells the caller only `userMessage`.
 */
class SearchRefused extends Data.TaggedError("SearchRefused")<{
	readonly userMessage: UserMessage;
	readonly detail: string;
}> {}

/** Whatever a call threw, to be turned into a reason. */
class CallFailed extends Data.TaggedError("CallFailed")<{ readonly cause: unknown }> {}

/** Runs one call under the time budget, turning whatever goes wrong into a reason. */
function answer(
	service: "Brave Search" | "Exa" | "Tavily" | "SearXNG",
	signal: AbortSignal | undefined,
	call: (stop: AbortSignal) => Promise<SearchOutcome>,
): Effect.Effect<SearchOutcome> {
	const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	const stop = signal ? AbortSignal.any([timeout, signal]) : timeout;
	return Effect.tryPromise({
		try: () => call(stop),
		catch: (cause) => new CallFailed({ cause }),
	}).pipe(
		Effect.catch(({ cause }) => {
			if (signal?.aborted) {
				return Effect.succeed(
					refused(UserMessage.of`The turn was stopped before the search answered`),
				);
			}
			if (timeout.aborted) {
				return Effect.succeed(
					refused(
						UserMessage.of`${service} did not answer within ${SEARCH_TIMEOUT_MS / 1000} seconds`,
					),
				);
			}
			if (cause instanceof EgressRefused) return Effect.succeed(refused(cause.userMessage));
			if (cause instanceof SearchRefused) {
				return Effect.as(
					Effect.logWarning(`${service} refused a search`, cause.detail),
					refused(cause.userMessage),
				);
			}
			// Anything else is a fault on our side or the service's: its details go to
			// the logs, and the model is told only that the search did not answer.
			return Effect.as(
				Effect.logError(`Searching with ${service} failed`, cause),
				refused(UserMessage.of`${service} could not be searched`),
			);
		}),
	);
}
