import { Unauthorized } from "@sugabots/contracts/http";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ClientOptions, createClient, isApiFailure, memoryTokenStore } from "./index.ts";

type FetchMock = ReturnType<typeof respondWith>;

afterEach(() => vi.unstubAllGlobals());

const ME = {
	id: "0199a3a0-0000-7000-8000-000000000001",
	email: "sam@example.com",
	name: "Sam",
	image: null,
};

/** Runs a call, settling either way, so a test about the request need not care about the answer. */
function settle<A, E>(call: Effect.Effect<A, E>) {
	return Effect.runPromise(Effect.result(call));
}

function respondWith(body: unknown, status = 200) {
	return vi.fn(async (..._args: Parameters<typeof fetch>) => Response.json(body, { status }));
}

/** What the client actually put on the wire. */
function requests(fetch: FetchMock): Request[] {
	return fetch.mock.calls.map((call) => new Request(...call));
}

describe("createClient", () => {
	it("strips a trailing slash from the base url", () => {
		expect(createClient({ baseUrl: "http://localhost:3000/" }).baseUrl).toBe(
			"http://localhost:3000",
		);
	});

	it("reaches auth under a base url that already carries the api's mount path", async () => {
		const fetch = respondWith({});
		const client = createClient({ baseUrl: "http://api.test/api", fetch });

		await client.auth.signIn({ email: "sam@example.com", password: "correct-horse-battery" });

		expect(requests(fetch)[0]?.url).toBe("http://api.test/api/auth/sign-in/email");
	});

	it("sends the token as a bearer header, reading the store at each request", async () => {
		const fetch = respondWith({});
		const tokens = memoryTokenStore();
		const client = createClient({ baseUrl: "http://api.test", tokens, fetch });

		await settle(client.api.me());
		tokens.set("second-token");
		await settle(client.api.me());

		const headers = fetch.mock.calls.map((call) =>
			new Request(...(call as [string, RequestInit])).headers.get("authorization"),
		);
		expect(headers).toEqual([null, "Bearer second-token"]);
	});

	it("uses cookies when a browser client selects cookie authentication", async () => {
		vi.stubGlobal("window", {});
		const fetch = respondWith({});
		const client = createClient({ baseUrl: "http://api.test", authMode: "cookie", fetch });

		await settle(client.api.me());

		expect(requests(fetch)[0]?.credentials).toBe("include");
		expect(requests(fetch)[0]?.headers.get("authorization")).toBeNull();
		expect(client.tokens).toBeUndefined();
	});

	it("defaults to bearer authentication in a window-bearing runtime", async () => {
		vi.stubGlobal("window", {});
		const fetch = respondWith({});
		const client = createClient({ baseUrl: "http://api.test", fetch });
		client.tokens?.set("renderer-token");

		await settle(client.api.me());

		expect(client.authMode).toBe("bearer");
		expect(requests(fetch)[0]?.credentials).toBe("omit");
		expect(requests(fetch)[0]?.headers.get("authorization")).toBe("Bearer renderer-token");
	});

	it("rejects cookie authentication with a bearer token store", () => {
		const invalid = {
			baseUrl: "http://api.test",
			authMode: "cookie",
			tokens: memoryTokenStore(),
		} as unknown as ClientOptions;

		expect(() => createClient(invalid)).toThrow("cannot use a bearer token store");
	});

	it("rejects an unknown authentication mode", () => {
		const invalid = {
			baseUrl: "http://api.test",
			authMode: "session",
		} as unknown as ClientOptions;

		expect(() => createClient(invalid)).toThrow("Unsupported authentication mode");
	});
});

describe("api", () => {
	it("decodes a successful response", async () => {
		const client = createClient({
			baseUrl: "http://api.test",
			fetch: respondWith({ status: "ok", version: "1.2.3" }),
		});

		expect(await Effect.runPromise(client.api.health())).toEqual({
			status: "ok",
			version: "1.2.3",
		});
	});

	it("reaches the endpoint's path under the base url", async () => {
		const fetch = respondWith(ME);
		const client = createClient({ baseUrl: "http://api.test/api", fetch });

		await settle(client.api.me());

		expect(requests(fetch)[0]?.url).toBe("http://api.test/api/me");
	});

	it("fails with the declared error class the API answered with", async () => {
		const client = createClient({
			baseUrl: "http://api.test",
			fetch: respondWith({ _tag: "Unauthorized", message: "Bearer token required" }, 401),
		});

		const failure = await Effect.runPromise(Effect.flip(client.api.me()));

		expect(failure).toBeInstanceOf(Unauthorized);
		expect(failure).toMatchObject({ message: "Bearer token required" });
		expect(isApiFailure(failure)).toBe(true);
	});

	it("does not mistake a proxy's error page for the API answering", async () => {
		const client = createClient({
			baseUrl: "http://api.test",
			fetch: vi.fn(async () => new Response("<html>502</html>", { status: 502 })),
		});

		const failure = await Effect.runPromise(Effect.flip(client.api.me()));

		expect(isApiFailure(failure)).toBe(false);
	});

	it("fails when a successful response does not match the endpoint's schema", async () => {
		const client = createClient({ baseUrl: "http://api.test", fetch: respondWith({ id: 1 }) });

		const failure = await Effect.runPromise(Effect.flip(client.api.me()));

		expect(isApiFailure(failure)).toBe(false);
	});
});

describe("auth", () => {
	it("keeps the token a sign-in issues, and sends it on every later request", async () => {
		const seen: Request[] = [];
		const fetch = vi.fn(async (...args: Parameters<typeof globalThis.fetch>) => {
			const request = new Request(...args);
			seen.push(request);

			return request.url.endsWith("/sign-in/email")
				? Response.json({ user: { id: "u1" } }, { headers: { "set-auth-token": "issued" } })
				: Response.json({});
		});

		const client = createClient({
			baseUrl: "http://api.test",
			tokens: memoryTokenStore(),
			fetch,
		});

		await client.auth.signIn({ email: "sam@example.com", password: "correct-horse-battery" });
		expect(client.tokens?.get()).toBe("issued");
		expect(seen[0]?.credentials).toBe("omit");

		await settle(client.api.me());
		expect(seen.at(-1)?.headers.get("authorization")).toBe("Bearer issued");
	});

	it("does not capture a browser sign-in token or write it to localStorage", async () => {
		const localStorage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() };
		vi.stubGlobal("window", { localStorage });
		vi.stubGlobal("localStorage", localStorage);
		const seen: Request[] = [];
		const fetch = vi.fn(async (...args: Parameters<typeof globalThis.fetch>) => {
			seen.push(new Request(...args));
			return Response.json(
				{ user: { id: "u1" } },
				{ headers: { "set-auth-token": "must-not-be-readable" } },
			);
		});
		const client = createClient({ baseUrl: "http://api.test", authMode: "cookie", fetch });

		await client.auth.signIn({ email: "sam@example.com", password: "correct-horse-battery" });

		expect(seen[0]?.credentials).toBe("include");
		expect(client.tokens).toBeUndefined();
		expect(localStorage.setItem).not.toHaveBeenCalled();
	});
});
