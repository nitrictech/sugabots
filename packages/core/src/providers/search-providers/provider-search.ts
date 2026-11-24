import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
	StreamableHTTPClientTransport,
	StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { EXA_FREE_SEARCH_URL } from "@sugabots/contracts";
import { type UserText, userText } from "@sugabots/errors";
import { Data, Effect, Schema } from "effect";
import { VERSION } from "../../version.ts";
import { type EgressHttpClient, EgressRefused } from "../network/egress.ts";
import { upstreamErrorText } from "../upstream-error-text.ts";
import type { SearchProviderAccess } from "./search-provider-access.ts";

/**
 * The search services `web_search` knows how to call, one function each.
 *
 * Every provider's search takes the same request and answers the same shape,
 * so the tool and the settings test are written once. A failure is an answer with a
 * reason, never a throw: the bot, or the admin testing the provider,
 * reads it as a sentence, and the bot also gets what the service said.
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
	| {
			ok: false;
			reason: UserText;
			providerMessage?: string;
	  };

export interface SearchRequest {
	query: string;
	/** How many results to ask for; a provider may return fewer. */
	count: number;
	signal?: AbortSignal;
}

/** Never fails: what goes wrong is an outcome, and its details are logged. */
type ProviderSearch = (request: SearchRequest) => Effect.Effect<SearchOutcome>;

export const MAX_SEARCH_RESULTS = 10;
const SEARCH_TIMEOUT_MS = 10_000;

/**
 * Where a provider access's searches go, which is what its egress client is bound
 * to. Exa without a key is the one case where that is not the provider's
 * configured address.
 */
export function searchEndpoint(access: SearchProviderAccess): string {
	return access.builtIn === "exa" && !access.apiKey ? EXA_FREE_SEARCH_URL : access.baseUrl;
}

/** Searching with a workspace's provider access, through its bound egress client. */
export function providerSearch(
	access: SearchProviderAccess,
	fetch: EgressHttpClient,
): ProviderSearch {
	switch (access.builtIn) {
		case "brave":
			return braveSearch(access, fetch);
		case "exa":
			return access.apiKey ? exaSearch(access, fetch) : exaFreeSearch(fetch);
		case "tavily":
			return tavilySearch(access, fetch);
		case "searxng":
			return searxngSearch(access, fetch);
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

function braveSearch(access: SearchProviderAccess, fetch: EgressHttpClient): ProviderSearch {
	return jsonSearch(fetch, {
		service: "Brave Search",
		apiKey: access.apiKey,
		schema: braveResponse,
		request: ({ query, count }) => {
			const url = new URL(`${access.baseUrl.replace(/\/$/, "")}/web/search`);
			url.searchParams.set("q", query);
			url.searchParams.set("count", String(count));
			return {
				url,
				headers: { accept: "application/json", "x-subscription-token": access.apiKey ?? "" },
			};
		},
		toResults: (body) =>
			(body.web?.results ?? []).map((result) => ({
				title: result.title,
				url: result.url,
				snippet: result.description ?? "",
				published: result.page_age ?? result.age ?? null,
			})),
	});
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

function exaSearch(access: SearchProviderAccess, fetch: EgressHttpClient): ProviderSearch {
	return jsonSearch(fetch, {
		service: "Exa",
		apiKey: access.apiKey,
		schema: exaResponse,
		request: ({ query, count }) => ({
			url: `${access.baseUrl.replace(/\/$/, "")}/search`,
			method: "POST",
			headers: {
				accept: "application/json",
				"content-type": "application/json",
				"x-api-key": access.apiKey ?? "",
			},
			body: JSON.stringify({
				query,
				numResults: count,
				type: "auto",
				// A sentence or two per result is the snippet; the page itself is web_fetch's job.
				contents: { highlights: { maxCharacters: 300 } },
			}),
		}),
		toResults: (body) =>
			body.results.map((result) => ({
				title: result.title ?? result.url,
				url: result.url,
				snippet: (result.highlights ?? []).join(" "),
				published: result.publishedDate ?? null,
			})),
	});
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

function tavilySearch(access: SearchProviderAccess, fetch: EgressHttpClient): ProviderSearch {
	return jsonSearch(fetch, {
		service: "Tavily",
		apiKey: access.apiKey,
		schema: tavilyResponse,
		request: ({ query, count }) => ({
			url: `${access.baseUrl.replace(/\/$/, "")}/search`,
			method: "POST",
			headers: {
				accept: "application/json",
				"content-type": "application/json",
				authorization: `Bearer ${access.apiKey ?? ""}`,
			},
			body: JSON.stringify({ query, max_results: count, search_depth: "basic" }),
		}),
		toResults: (body) =>
			body.results.map((result) => ({
				title: result.title,
				url: result.url,
				snippet: result.content ?? "",
				published: result.published_date ?? null,
			})),
	});
}

/**
 * Exa without a key: its free MCP endpoint. Rate limited, and a text answer
 * rather than JSON, which `parseExaText` reads back into results. Each search
 * is one short MCP session.
 */
function exaFreeSearch(fetch: EgressHttpClient): ProviderSearch {
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
				if (result.isError) return refusedSaying(userText`Exa refused the search`, text, undefined);
				return { ok: true, results: parseExaText(text).slice(0, count) };
			} catch (cause) {
				// How the free endpoint answers a rate limit; a negative code is the SDK's own complaint.
				if (!(cause instanceof StreamableHTTPError) || !cause.code || cause.code < 400) throw cause;
				return refusedSaying(userText`Exa answered HTTP ${cause.code}`, cause.message, undefined);
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
function parseExaText(text: string): SearchResult[] {
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

function searxngSearch(access: SearchProviderAccess, fetch: EgressHttpClient): ProviderSearch {
	return jsonSearch(fetch, {
		service: "SearXNG",
		apiKey: access.apiKey,
		schema: searxngResponse,
		request: ({ query }) => {
			const url = new URL(`${access.baseUrl.replace(/\/$/, "")}/search`);
			url.searchParams.set("q", query);
			url.searchParams.set("format", "json");
			return {
				url,
				headers: {
					accept: "application/json",
					// A key is unusual for SearXNG itself; a proxy in front of it may check one.
					...(access.apiKey ? { authorization: `Bearer ${access.apiKey}` } : {}),
				},
			};
		},
		refusalOf: (response) =>
			response.status === 403
				? refused(userText`SearXNG refused the request; its JSON format may be off in settings.yml`)
				: undefined,
		toResults: (body, count) =>
			body.results.slice(0, count).map((result) => ({
				title: result.title,
				url: result.url,
				snippet: result.content ?? "",
				published: result.publishedDate ?? null,
			})),
	});
}

/** How one JSON request searches a provider. */
interface JsonSearch<S extends Schema.Decoder<unknown>> {
	readonly service: Service;
	/** Kept out of what the provider said, when that is passed on. */
	readonly apiKey: string | undefined;
	/** The answer's body. */
	readonly schema: S;
	readonly request: (request: SearchRequest) => RequestInit & { url: string | URL };
	/** A refusal the provider means something particular by, before any other is reported. */
	readonly refusalOf?: (response: Response) => SearchOutcome | undefined;
	readonly toResults: (body: S["Type"], count: number) => SearchResult[];
}

/**
 * A search one JSON request answers: the request is sent, a refusal becomes
 * a reason, and the body is decoded and turned into results.
 */
function jsonSearch<S extends Schema.Decoder<unknown>>(
	fetch: EgressHttpClient,
	search: JsonSearch<S>,
): ProviderSearch {
	return (request) =>
		answer(search.service, request.signal, async (stop) => {
			const { url, ...init } = search.request(request);
			const response = await fetch(url, { ...init, signal: stop });
			const refusal = search.refusalOf?.(response);
			if (refusal) return refusal;
			if (!response.ok) return httpRefusal(search.service, response, search.apiKey);
			const parsed = Schema.decodeUnknownResult(search.schema)(await response.json());
			if (parsed._tag === "Failure") {
				return refused(
					userText`${search.service} answered with something that is not a result list`,
				);
			}
			return { ok: true, results: search.toResults(parsed.success, request.count) };
		});
}

function refused(reason: UserText): SearchOutcome {
	return { ok: false, reason };
}

function refusedSaying(reason: UserText, said: string, apiKey: string | undefined): SearchOutcome {
	const providerMessage = upstreamErrorText(said, [apiKey]);
	return providerMessage ? { ok: false, reason, providerMessage } : refused(reason);
}

async function httpRefusal(
	service: Service,
	response: Response,
	apiKey: string | undefined,
): Promise<SearchOutcome> {
	const said = await response.text().catch(() => "");
	return refusedSaying(userText`${service} answered HTTP ${response.status}`, said, apiKey);
}

type Service = "Brave Search" | "Exa" | "Tavily" | "SearXNG";

/** Whatever a call threw, to be turned into a reason. */
class CallFailed extends Data.TaggedError("CallFailed")<{ readonly cause: unknown }> {}

/** Runs one call under the time budget, turning whatever goes wrong into a reason. */
function answer(
	service: Service,
	signal: AbortSignal | undefined,
	call: (stop: AbortSignal) => Promise<SearchOutcome>,
): Effect.Effect<SearchOutcome> {
	const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	const stop = signal ? AbortSignal.any([timeout, signal]) : timeout;
	return Effect.tryPromise({
		try: () => call(stop),
		catch: (cause) => new CallFailed({ cause }),
	}).pipe(
		Effect.tap((outcome) =>
			outcome.ok || !outcome.providerMessage
				? Effect.void
				: Effect.logWarning(`${service} refused a search`, outcome.providerMessage),
		),
		Effect.catch(({ cause }) => {
			if (signal?.aborted) {
				return Effect.succeed(refused(userText`The turn was stopped before the search answered`));
			}
			if (timeout.aborted) {
				return Effect.succeed(
					refused(userText`${service} did not answer within ${SEARCH_TIMEOUT_MS / 1000} seconds`),
				);
			}
			if (cause instanceof EgressRefused) return Effect.succeed(refused(cause.userMessage));
			// Anything else is a fault on our side or the service's: its details go to
			// the logs, and the model is told only that the search did not answer.
			return Effect.as(
				Effect.logError(`Searching with ${service} failed`, cause),
				refused(userText`${service} could not be searched`),
			);
		}),
	);
}
