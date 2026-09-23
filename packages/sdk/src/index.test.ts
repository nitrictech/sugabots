import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ApiError,
	type ClientOptions,
	createClient,
	memoryTokenStore,
	unwrap,
	unwrapEmpty,
} from "./index.ts";

type FetchMock = ReturnType<typeof respondWith>;

afterEach(() => vi.unstubAllGlobals());

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

		await client.api.me.$get();
		tokens.set("second-token");
		await client.api.me.$get();

		const headers = fetch.mock.calls.map((call) =>
			new Request(...(call as [string, RequestInit])).headers.get("authorization"),
		);
		expect(headers).toEqual([null, "Bearer second-token"]);
	});

	it("uses cookies when a browser client selects cookie authentication", async () => {
		vi.stubGlobal("window", {});
		const fetch = respondWith({});
		const client = createClient({ baseUrl: "http://api.test", authMode: "cookie", fetch });

		await client.api.me.$get();

		expect(requests(fetch)[0]?.credentials).toBe("include");
		expect(requests(fetch)[0]?.headers.get("authorization")).toBeNull();
		expect(client.tokens).toBeUndefined();
	});

	it("defaults to bearer authentication in a window-bearing runtime", async () => {
		vi.stubGlobal("window", {});
		const fetch = respondWith({});
		const client = createClient({ baseUrl: "http://api.test", fetch });
		client.tokens?.set("renderer-token");

		await client.api.me.$get();

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

describe("unwrap", () => {
	it("returns the body of a successful response", async () => {
		const client = createClient({
			baseUrl: "http://api.test",
			fetch: respondWith({ status: "ok", version: "1.2.3" }),
		});

		expect(await unwrap(client.api.health.$get())).toEqual({ status: "ok", version: "1.2.3" });
	});

	it("throws the error envelope as an ApiError", async () => {
		const client = createClient({
			baseUrl: "http://api.test",
			fetch: respondWith(
				{ error: { code: "unauthorized", message: "Bearer token required" } },
				401,
			),
		});

		const failure = await unwrap(client.api.me.$get()).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(ApiError);
		expect(failure).toMatchObject({
			code: "unauthorized",
			status: 401,
			message: "Bearer token required",
		});
	});

	it("does not mistake a proxy's error page for an envelope", async () => {
		const client = createClient({
			baseUrl: "http://api.test",
			fetch: vi.fn(async () => new Response("<html>502</html>", { status: 502 })),
		});

		const failure = await unwrap(client.api.me.$get()).catch((error: unknown) => error);

		expect(failure).toMatchObject({ code: "internal", status: 502 });
	});

	it("throws when a successful JSON response is malformed", async () => {
		const response = new Response("not json", { status: 200 });

		await expect(unwrap(Promise.resolve(response))).rejects.toMatchObject({
			code: "internal",
			status: 200,
		});
	});

	it("does not accept an empty success as a JSON response", async () => {
		await expect(
			unwrap(Promise.resolve(new Response(null, { status: 204 }))),
		).rejects.toBeInstanceOf(ApiError);
	});
});

describe("unwrapEmpty", () => {
	it("accepts a successful response without decoding it", async () => {
		await expect(
			unwrapEmpty(Promise.resolve(new Response(null, { status: 204 }))),
		).resolves.toBeUndefined();
	});

	it("still decodes an error envelope", async () => {
		const response = Response.json(
			{ error: { code: "conflict", message: "Already complete" } },
			{ status: 409 },
		);

		await expect(unwrapEmpty(Promise.resolve(response))).rejects.toMatchObject({
			code: "conflict",
			status: 409,
		});
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

		await client.api.me.$get();
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
