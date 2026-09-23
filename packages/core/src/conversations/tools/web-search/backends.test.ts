import { describe, expect, it, vi } from "vitest";
import type { SearchConnection } from "../../../providers/search-providers/store.ts";
import { parseExaText, searchBackend, searchEndpoint } from "./backends.ts";

type FakeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const at = new Date("2026-09-14T00:00:00.000Z");

function backend(connection: Omit<SearchConnection, "configurationUpdatedAt">, fetch: FakeFetch) {
	return searchBackend(
		{ ...connection, configurationUpdatedAt: at },
		fetch as typeof globalThis.fetch,
	);
}

describe("the Brave backend", () => {
	it("asks Brave with the key and maps its results", async () => {
		const fetch = vi.fn<FakeFetch>(async () =>
			Response.json({
				web: {
					results: [
						{
							title: "Sugabots",
							url: "https://example.com/sugabots",
							description: "A workspace for people and agents.",
							page_age: "2026-09-01T00:00:00",
						},
						{ title: "Bare", url: "https://example.com/bare" },
					],
				},
			}),
		);

		const outcome = await backend(
			{ preset: "brave", baseUrl: "https://api.search.brave.com/res/v1", apiKey: "brave-key" },
			fetch,
		)({ query: "open bots", count: 5 });

		expect(outcome).toEqual({
			ok: true,
			results: [
				{
					title: "Sugabots",
					url: "https://example.com/sugabots",
					snippet: "A workspace for people and agents.",
					published: "2026-09-01T00:00:00",
				},
				{ title: "Bare", url: "https://example.com/bare", snippet: "", published: null },
			],
		});
		const [url, init] = fetch.mock.calls[0] ?? [];
		expect(String(url)).toBe("https://api.search.brave.com/res/v1/web/search?q=open+bots&count=5");
		expect(init?.headers).toMatchObject({ "x-subscription-token": "brave-key" });
	});

	it("reports a refused key and a body it cannot read as reasons", async () => {
		const unauthorised = vi.fn<FakeFetch>(async () => new Response("no", { status: 401 }));
		expect(
			await backend(
				{ preset: "brave", baseUrl: "https://api.search.brave.com/res/v1", apiKey: "x" },
				unauthorised,
			)({ query: "q", count: 1 }),
		).toEqual({ ok: false, reason: "Brave Search answered HTTP 401" });

		const odd = vi.fn<FakeFetch>(async () => Response.json({ hello: "world" }));
		expect(
			await backend(
				{ preset: "brave", baseUrl: "https://api.search.brave.com/res/v1", apiKey: "x" },
				odd,
			)({
				query: "q",
				count: 1,
			}),
		).toEqual({ ok: true, results: [] });

		const broken = vi.fn<FakeFetch>(async () => Response.json({ web: { results: "nope" } }));
		expect(
			await backend(
				{ preset: "brave", baseUrl: "https://api.search.brave.com/res/v1", apiKey: "x" },
				broken,
			)({ query: "q", count: 1 }),
		).toEqual({
			ok: false,
			reason: "Brave Search answered with something that is not a result list",
		});
	});
});

describe("the Exa backend", () => {
	it("posts the query with the key and joins highlights into the snippet", async () => {
		const fetch = vi.fn<FakeFetch>(async () =>
			Response.json({
				results: [
					{
						title: "Sugabots",
						url: "https://example.com/sugabots",
						publishedDate: "2026-09-01T00:00:00.000Z",
						highlights: ["People and agents", "in shared pods."],
					},
					{ title: null, url: "https://example.com/untitled" },
				],
			}),
		);

		const outcome = await backend(
			{ preset: "exa", baseUrl: "https://api.exa.ai", apiKey: "exa-key" },
			fetch,
		)({
			query: "open bots",
			count: 2,
		});

		expect(outcome).toEqual({
			ok: true,
			results: [
				{
					title: "Sugabots",
					url: "https://example.com/sugabots",
					snippet: "People and agents in shared pods.",
					published: "2026-09-01T00:00:00.000Z",
				},
				{
					title: "https://example.com/untitled",
					url: "https://example.com/untitled",
					snippet: "",
					published: null,
				},
			],
		});
		const [url, init] = fetch.mock.calls[0] ?? [];
		expect(String(url)).toBe("https://api.exa.ai/search");
		expect(init).toMatchObject({ method: "POST", headers: { "x-api-key": "exa-key" } });
		expect(JSON.parse(String(init?.body))).toMatchObject({ query: "open bots", numResults: 2 });
	});
});

describe("the Tavily backend", () => {
	it("posts the query as a bearer and maps its results", async () => {
		const fetch = vi.fn<FakeFetch>(async () =>
			Response.json({
				results: [
					{
						title: "Sugabots",
						url: "https://example.com/sugabots",
						content: "A workspace.",
						published_date: "2026-09-01",
					},
				],
			}),
		);

		const outcome = await backend(
			{ preset: "tavily", baseUrl: "https://api.tavily.com", apiKey: "tvly-key" },
			fetch,
		)({ query: "open bots", count: 3 });

		expect(outcome).toEqual({
			ok: true,
			results: [
				{
					title: "Sugabots",
					url: "https://example.com/sugabots",
					snippet: "A workspace.",
					published: "2026-09-01",
				},
			],
		});
		const [url, init] = fetch.mock.calls[0] ?? [];
		expect(String(url)).toBe("https://api.tavily.com/search");
		expect(init).toMatchObject({ method: "POST", headers: { authorization: "Bearer tvly-key" } });
		expect(JSON.parse(String(init?.body))).toMatchObject({ query: "open bots", max_results: 3 });
	});

	it("reports a refused key", async () => {
		const fetch = vi.fn<FakeFetch>(async () => new Response("", { status: 401 }));

		expect(
			await backend(
				{ preset: "tavily", baseUrl: "https://api.tavily.com", apiKey: "x" },
				fetch,
			)({
				query: "q",
				count: 1,
			}),
		).toEqual({ ok: false, reason: "Tavily answered HTTP 401" });
	});
});

describe("the SearXNG backend", () => {
	it("asks for JSON and cuts the results to the count asked for", async () => {
		const fetch = vi.fn<FakeFetch>(async () =>
			Response.json({
				results: [
					{ title: "One", url: "https://one.example", content: "first", publishedDate: null },
					{ title: "Two", url: "https://two.example", content: null },
					{ title: "Three", url: "https://three.example" },
				],
			}),
		);

		const outcome = await backend(
			{ preset: "searxng", baseUrl: "http://searx.local:8080/" },
			fetch,
		)({
			query: "open bots",
			count: 2,
		});

		expect(outcome).toEqual({
			ok: true,
			results: [
				{ title: "One", url: "https://one.example", snippet: "first", published: null },
				{ title: "Two", url: "https://two.example", snippet: "", published: null },
			],
		});
		expect(String(fetch.mock.calls[0]?.[0])).toBe(
			"http://searx.local:8080/search?q=open+bots&format=json",
		);
	});

	it("explains a 403, which is what SearXNG says when its JSON format is off", async () => {
		const fetch = vi.fn<FakeFetch>(async () => new Response("", { status: 403 }));

		expect(
			await backend(
				{ preset: "searxng", baseUrl: "http://searx.local:8080" },
				fetch,
			)({
				query: "q",
				count: 1,
			}),
		).toEqual({
			ok: false,
			reason: "SearXNG refused the request; its JSON format may be off in settings.yml",
		});
	});

	it("turns a network failure into a reason", async () => {
		const fetch = vi.fn<FakeFetch>(async () => {
			throw new Error("Address is on a private or reserved network");
		});

		expect(
			await backend(
				{ preset: "searxng", baseUrl: "http://searx.local:8080" },
				fetch,
			)({
				query: "q",
				count: 1,
			}),
		).toEqual({ ok: false, reason: "Address is on a private or reserved network" });
	});
});

describe("where a search goes", () => {
	it("is the provider's address, except Exa without a key, which is the free endpoint", () => {
		const at = new Date();
		expect(
			searchEndpoint({ preset: "exa", baseUrl: "https://api.exa.ai", configurationUpdatedAt: at }),
		).toBe("https://mcp.exa.ai/mcp");
		expect(
			searchEndpoint({
				preset: "exa",
				baseUrl: "https://api.exa.ai",
				apiKey: "k",
				configurationUpdatedAt: at,
			}),
		).toBe("https://api.exa.ai");
		expect(
			searchEndpoint({
				preset: "brave",
				baseUrl: "https://api.search.brave.com/res/v1",
				configurationUpdatedAt: at,
			}),
		).toBe("https://api.search.brave.com/res/v1");
	});
});

describe("reading Exa's free endpoint", () => {
	it("turns its text blocks into results", () => {
		const text = [
			"Title: Nitric is a multi-language framework ...",
			"URL: https://github.com/nitrictech/nitric",
			"Published: N/A",
			"Author: N/A",
			"Highlights:",
			"Nitric is a multi-language framework for cloud applications.",
			"...",
			"Effortless backends with infrastructure from code.",
			"",
			"---",
			"",
			"Title: Open Source Backend Framework",
			"URL: https://nitric.io/framework",
			"Published: 2026-01-02T00:00:00.000Z",
			"Author: Nitric",
			"Highlights:",
			"An open source universal backend framework.",
		].join("\n");

		expect(parseExaText(text)).toEqual([
			{
				title: "Nitric is a multi-language framework ...",
				url: "https://github.com/nitrictech/nitric",
				snippet:
					"Nitric is a multi-language framework for cloud applications. Effortless backends with infrastructure from code.",
				published: null,
			},
			{
				title: "Open Source Backend Framework",
				url: "https://nitric.io/framework",
				snippet: "An open source universal backend framework.",
				published: "2026-01-02T00:00:00.000Z",
			},
		]);
		expect(parseExaText("")).toEqual([]);
	});
});
