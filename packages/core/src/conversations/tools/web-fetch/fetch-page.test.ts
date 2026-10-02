import { afterEach, describe, expect, it, vi } from "vitest";
import { createEgressHttpClient, type EgressDispatch } from "../../../providers/network/egress.ts";
import { type FetchPage, MAX_REDIRECTS, pageFetcher } from "./fetch-page.ts";

/**
 * The fetcher against a fake `fetch`: what it follows, what it refuses, and
 * what it hands back. One case runs it through the real egress client to show
 * the network policy reaches the agent as a reason rather than an error.
 */

type FakeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function html(body: string, init: ResponseInit = {}): Response {
	return new Response(body, {
		status: 200,
		...init,
		headers: { "content-type": "text/html; charset=utf-8", ...init.headers },
	});
}

function redirect(location: string, status = 302): Response {
	return new Response(null, { status, headers: { location } });
}

function fetcher(
	fetch: FakeFetch,
	options: Partial<Parameters<typeof pageFetcher>[0]> = {},
): FetchPage {
	return pageFetcher({ fetch: fetch as typeof globalThis.fetch, ...options });
}

const page = `<html><head><title>Example Domain</title></head><body>
	<p>This domain is for use in illustrative examples in documents. You may use this domain
	in literature without prior coordination or asking for permission. It exists so that
	examples have somewhere harmless to point.</p>
	<p><a href="/more">More information...</a></p></body></html>`;

afterEach(() => {
	vi.useRealTimers();
});

describe("fetching a page", () => {
	it("reads an HTML page as its title and Markdown, and says where it ended up", async () => {
		const fetch = vi.fn<FakeFetch>(async (input) =>
			String(input) === "https://example.com/" ? redirect("https://www.example.com/") : html(page),
		);

		const outcome = await fetcher(fetch)("https://example.com/");

		expect(outcome).toMatchObject({
			ok: true,
			page: {
				url: "https://example.com/",
				finalUrl: "https://www.example.com/",
				title: "Example Domain",
				contentType: "text/html",
				truncated: false,
			},
		});
		if (!outcome.ok) throw new Error(outcome.reason);
		expect(outcome.page.text).toContain("illustrative examples");
		expect(outcome.page.text).toContain("[More information...](https://www.example.com/more)");
		expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
			"https://example.com/",
			"https://www.example.com/",
		]);
		// Every hop asks the client not to follow on, so each is checked in turn.
		expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
	});

	it("fetches a plain http address over https", async () => {
		const fetch = vi.fn<FakeFetch>(async () => html(page));

		const outcome = await fetcher(fetch)("http://example.com/page");

		expect(outcome).toMatchObject({
			ok: true,
			page: { url: "http://example.com/page", finalUrl: "https://example.com/page" },
		});
		expect(String(fetch.mock.calls[0]?.[0])).toBe("https://example.com/page");
	});

	it("passes plain text and JSON through, cut to the character limit", async () => {
		const fetch = vi.fn<FakeFetch>(
			async () =>
				new Response(`{"items":[${"1,".repeat(200)}1]}`, {
					headers: { "content-type": "application/json" },
				}),
		);

		const outcome = await fetcher(fetch, { maxCharacters: 50 })("https://api.example.com/items");

		expect(outcome).toMatchObject({
			ok: true,
			page: { contentType: "application/json", title: null, truncated: true },
		});
		if (!outcome.ok) throw new Error(outcome.reason);
		expect(outcome.page.text).toHaveLength(50);
	});

	it("decodes the charset the server names", async () => {
		const fetch = vi.fn<FakeFetch>(
			async () =>
				new Response(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), {
					headers: { "content-type": "text/plain; charset=iso-8859-1" },
				}),
		);

		const outcome = await fetcher(fetch)("https://example.com/menu.txt");

		expect(outcome).toMatchObject({ ok: true, page: { text: "café" } });
	});

	it.each([
		["a relative or malformed address", "example.com/page", "The URL is not valid"],
		[
			"a scheme it cannot fetch",
			"ftp://example.com/file",
			"Only http and https addresses can be fetched",
		],
	])("refuses %s before fetching", async (_label, url, reason) => {
		const fetch = vi.fn<FakeFetch>();

		expect(await fetcher(fetch)(url)).toEqual({ ok: false, reason });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("refuses a redirect off the web, and gives up after too many", async () => {
		const offTheWeb = vi.fn<FakeFetch>(async () => redirect("file:///etc/passwd"));
		expect(await fetcher(offTheWeb)("https://example.com/")).toEqual({
			ok: false,
			reason: "Only http and https addresses can be fetched",
		});

		const forever = vi.fn<FakeFetch>(async () => redirect("/again"));
		expect(await fetcher(forever)("https://example.com/")).toEqual({
			ok: false,
			reason: `Gave up after ${MAX_REDIRECTS} redirects`,
		});
		expect(forever).toHaveBeenCalledTimes(MAX_REDIRECTS + 1);
	});

	it("reports the status of a page the server would not give", async () => {
		const fetch = vi.fn<FakeFetch>(async () => new Response("gone", { status: 404 }));

		expect(await fetcher(fetch)("https://example.com/missing")).toEqual({
			ok: false,
			reason: "The server answered HTTP 404",
		});
	});

	it("refuses a body it cannot read as text", async () => {
		const fetch = vi.fn<FakeFetch>(
			async () =>
				new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
					headers: { "content-type": "application/pdf" },
				}),
		);

		expect(await fetcher(fetch)("https://example.com/report.pdf")).toEqual({
			ok: false,
			reason: "The page is of a type that cannot be read as text",
		});
	});

	it("refuses a page larger than the byte cap", async () => {
		const fetch = vi.fn<FakeFetch>(async () => html(`<p>${"x".repeat(2048)}</p>`));

		expect(await fetcher(fetch, { maxBytes: 1024 * 1024 })("https://example.com/")).toMatchObject({
			ok: true,
		});
		expect(await fetcher(fetch, { maxBytes: 1024 })("https://example.com/")).toEqual({
			ok: false,
			reason: "The page is larger than 0 MB",
		});
	});

	it("gives up when the server does not answer in time, and when the turn stops", async () => {
		const hang = vi.fn<FakeFetch>(
			(_input, init) =>
				new Promise<Response>((_, reject) => {
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
						once: true,
					});
				}),
		);

		expect(await fetcher(hang, { timeoutMs: 20 })("https://slow.example.com/")).toEqual({
			ok: false,
			reason: "No answer within 0.02 seconds",
		});

		const turn = new AbortController();
		const stopped = fetcher(hang, { timeoutMs: 10_000 })("https://slow.example.com/", turn.signal);
		turn.abort();
		expect(await stopped).toEqual({
			ok: false,
			reason: "The turn was stopped before the page arrived",
		});
	});

	it("tells the agent when the network policy refuses an address", async () => {
		const dispatch = vi.fn<EgressDispatch>();
		const client = createEgressHttpClient({
			lookup: async () => [{ address: "10.0.0.8", family: 4 }],
			fetch: dispatch,
		});
		try {
			expect(await pageFetcher({ fetch: client })("https://intranet.example/")).toEqual({
				ok: false,
				reason:
					"That address is on a local or private network, which this installation doesn't connect to, so other services on the network stay out of reach. Use a public address, or ask whoever runs Sugabots to allow local network addresses.",
			});
			expect(dispatch).not.toHaveBeenCalled();
		} finally {
			await client.close();
		}
	});
});
