import { Forbidden, Unauthorized, UnsupportedMediaType } from "@sugabots/contracts/http";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { createClient, isApiFailure } from "./index.ts";

type FetchMock = ReturnType<typeof respondWith>;

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

	it("sends the session cookie", async () => {
		const fetch = respondWith({});
		const client = createClient({ baseUrl: "http://api.test", fetch });

		await settle(client.api.me());

		expect(requests(fetch)[0]?.credentials).toBe("include");
	});
});

describe("api", () => {
	it("decodes a successful response", async () => {
		const client = createClient({
			baseUrl: "http://api.test",
			fetch: respondWith({ status: "ok", version: "1.2.3", commit: "a1b2c3d" }),
		});

		expect(await Effect.runPromise(client.api.health())).toEqual({
			status: "ok",
			version: "1.2.3",
			commit: "a1b2c3d",
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
			fetch: respondWith({ _tag: "Unauthorized", message: "Sign in first" }, 401),
		});

		const failure = await Effect.runPromise(Effect.flip(client.api.me()));

		expect(failure).toBeInstanceOf(Unauthorized);
		expect(failure).toMatchObject({ message: "Sign in first" });
		expect(isApiFailure(failure)).toBe(true);
	});

	it.each([
		[403, "Forbidden", Forbidden, "Untrusted request origin"],
		[
			415,
			"UnsupportedMediaType",
			UnsupportedMediaType,
			"This request's body is not of a type it takes. Send it as JSON",
		],
	])(
		"decodes a %s the server's middleware answers, on an endpoint that declares neither",
		async (status, _tag, Failure, message) => {
			const client = createClient({
				baseUrl: "http://api.test",
				fetch: respondWith({ _tag, message }, status),
			});

			const failure = await Effect.runPromise(Effect.flip(client.api.notifications.sendTest()));

			expect(failure).toBeInstanceOf(Failure);
			expect(failure).toMatchObject({ message });
		},
	);

	it("does not mistake a proxy's error page for the API answering", async () => {
		const client = createClient({
			baseUrl: "http://api.test",
			fetch: vi.fn(async () => new Response("<html>502</html>", { status: 502 })),
		});

		const failure = await Effect.runPromise(Effect.flip(client.api.me()));

		expect(failure).toMatchObject({ _tag: "HttpClientError", reason: { _tag: "DecodeError" } });
	});

	it("fails when a successful response does not match the endpoint's schema", async () => {
		const client = createClient({ baseUrl: "http://api.test", fetch: respondWith({ id: 1 }) });

		const failure = await Effect.runPromise(Effect.flip(client.api.me()));

		expect(failure).toMatchObject({ _tag: "SchemaError" });
	});
});
