import { healthResponseSchema, sessionUserSchema } from "@sugabots/contracts";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { SessionResolver } from "../auth/session.ts";
import { createTestApp } from "./app.test-support.ts";
import { MAX_JSON_BODY_BYTES } from "./validation.ts";

const user = {
	id: "0199a3a0-0000-7000-8000-0000000000ff",
	email: "sam@example.com",
	name: "Sam",
	image: null,
};

const resolveSession: SessionResolver = async (headers) =>
	headers.get("authorization") === "Bearer good-token" ? { user } : null;

const app = createTestApp({ resolveSession });

describe("GET /health", () => {
	it("answers without a token", async () => {
		const response = await app.request("/health");

		expect(response.status).toBe(200);
		expect(Schema.decodeUnknownSync(healthResponseSchema)(await response.json()).status).toBe("ok");
	});

	it("answers HEAD with the GET status and headers but no body", async () => {
		const get = await app.request("/health");
		const head = await app.request("/health", { method: "HEAD" });

		expect(head.status).toBe(get.status);
		expect(head.headers.get("content-type")).toBe(get.headers.get("content-type"));
		expect(head.body).toBeNull();
	});
});

describe("GET /me", () => {
	it("returns the user behind the token", async () => {
		const response = await app.request("/me", {
			headers: { authorization: "Bearer good-token" },
		});

		expect(response.status).toBe(200);
		expect(Schema.decodeUnknownSync(sessionUserSchema)(await response.json())).toEqual(user);
	});

	it("returns the user behind a Better Auth cookie when Authorization is absent", async () => {
		const cookieApp = createTestApp({
			resolveSession: async (headers) =>
				headers.get("cookie") === "better-auth.session_token=cookie-token" ? { user } : null,
		});

		const response = await cookieApp.request("/me", {
			headers: { cookie: "better-auth.session_token=cookie-token" },
		});

		expect(response.status).toBe(200);
		expect(Schema.decodeUnknownSync(sessionUserSchema)(await response.json())).toEqual(user);
	});

	it("does not fall back to a cookie when an invalid bearer token is present", async () => {
		const cookieApp = createTestApp({
			resolveSession: async (headers) =>
				headers.get("cookie") === "better-auth.session_token=cookie-token" ? { user } : null,
		});

		const response = await cookieApp.request("/me", {
			headers: {
				authorization: "Bearer stale-token",
				cookie: "better-auth.session_token=cookie-token",
			},
		});

		expect(response.status).toBe(401);
	});

	it("rejects a token no session matches", async () => {
		const response = await app.request("/me", {
			headers: { authorization: "Bearer stale-token" },
		});

		expect(response.status).toBe(401);
	});

	it("ignores an authorization header that is not a bearer token", async () => {
		const response = await app.request("/me", {
			headers: { authorization: "Basic good-token" },
		});

		expect(response.status).toBe(401);
	});
});

describe("unknown routes", () => {
	it("answer in the API's error shape, not an empty body", async () => {
		const response = await app.request("/nope");

		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({ _tag: "NotFound" });
	});
});

describe("JSON body limit", () => {
	it("rejects a declared oversized JSON body before routing or parsing it", async () => {
		const response = await app.request("/nope", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"content-length": String(MAX_JSON_BODY_BYTES + 1),
			},
			body: "{}",
		});

		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({
			_tag: "PayloadTooLarge",
			message: "JSON body exceeds the 64 KiB limit",
		});
	});

	it("rejects an oversized streamed JSON body without content-length", async () => {
		const response = await app.request("/nope", {
			method: "POST",
			headers: { "content-type": "application/problem+json" },
			body: JSON.stringify({ value: "x".repeat(MAX_JSON_BODY_BYTES) }),
		});

		expect(response.status).toBe(413);
	});

	it("does not apply the JSON limit to another media type", async () => {
		const response = await app.request("/nope", {
			method: "POST",
			headers: {
				"content-type": "text/plain",
				"content-length": String(MAX_JSON_BODY_BYTES + 1),
			},
			body: "small",
		});

		expect(response.status).toBe(404);
	});
});

describe("cors", () => {
	it("allows the web origin to authenticate and resume an event stream", async () => {
		const app = createTestApp({ resolveSession, webOrigins: ["http://localhost:5173"] });

		const response = await app.request("/workspaces/example/events", {
			method: "OPTIONS",
			headers: {
				origin: "http://localhost:5173",
				"access-control-request-method": "GET",
				"access-control-request-headers": "authorization,last-event-id",
			},
		});

		expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
		expect(response.headers.get("access-control-allow-headers")).toContain("authorization");
		expect(response.headers.get("access-control-allow-headers")).toContain("last-event-id");
		expect(response.headers.get("access-control-allow-credentials")).toBe("true");

		const health = await app.request("/health", {
			headers: { origin: "http://localhost:5173" },
		});
		expect(health.headers.get("access-control-expose-headers")).toBeNull();
	});
});

describe("cookie request origins", () => {
	const trustedOrigin = "https://app.example.com";
	const cookieApp = createTestApp({
		webOrigins: [trustedOrigin],
		resolveSession: async (headers) =>
			headers.get("cookie") === "better-auth.session_token=cookie-token" ||
			headers.get("authorization") === "Bearer good-token"
				? { user }
				: null,
		stores: { turns: { requestCancel: () => Effect.succeed(true) } },
	});

	it("accepts an unsafe cookie request from a trusted origin", async () => {
		const response = await cookieApp.request("/turns/turn-id/cancel", {
			method: "POST",
			headers: {
				cookie: "better-auth.session_token=cookie-token",
				origin: trustedOrigin,
			},
		});

		expect(response.status).toBe(202);
	});

	it.each([undefined, "https://attacker.example.com"])(
		"rejects an unsafe cookie request from origin %s",
		async (origin) => {
			const response = await cookieApp.request("/turns/turn-id/cancel", {
				method: "POST",
				headers: {
					cookie: "better-auth.session_token=cookie-token",
					...(origin ? { origin } : {}),
				},
			});

			expect(response.status).toBe(403);
			expect(await response.json()).toEqual({
				_tag: "Forbidden",
				message: "Untrusted request origin",
			});
		},
	);

	it("exempts a valid bearer-authenticated request from origin checks", async () => {
		const response = await cookieApp.request("/turns/turn-id/cancel", {
			method: "POST",
			headers: {
				authorization: "Bearer good-token",
				cookie: "better-auth.session_token=stale-cookie",
				origin: "https://attacker.example.com",
			},
		});

		expect(response.status).toBe(202);
	});
});
