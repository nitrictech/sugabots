import { healthResponseSchema, meSchema } from "@sugabots/contracts";
import { Operations } from "@sugabots/core/operations/registry";
import { unimplemented } from "@sugabots/core/testing";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { MemberResolver } from "./app.test-support.ts";
import {
	createTestApp,
	identifiedBy,
	serverSettingsWithWebAppAt,
	sessionTokenIn,
	signedInWith,
} from "./app.test-support.ts";
import { MAX_JSON_BODY_BYTES } from "./validation.ts";

const signedIn = {
	id: "0199a3a0-0000-7000-8000-0000000000ff",
	email: "sam@example.com",
	name: "Sam",
	image: null,
};

const resolveMember: MemberResolver = async (headers) =>
	sessionTokenIn(headers) === "good-token" ? signedIn : null;

const app = createTestApp(identifiedBy(resolveMember));

describe("GET /health", () => {
	it("answers without a session", async () => {
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
	it("returns the current user behind the session cookie", async () => {
		const response = await app.request("/me", { headers: signedInWith("good-token") });

		expect(response.status).toBe(200);
		expect(Schema.decodeUnknownSync(meSchema)(await response.json()).member).toEqual(signedIn);
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
		expect(await response.json()).toMatchObject({
			_tag: "PayloadTooLarge",
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
	it("allows the web origin to send its cookie and resume an event stream", async () => {
		const app = createTestApp(identifiedBy(resolveMember));

		const response = await app.request("/workspaces/example/events", {
			method: "OPTIONS",
			headers: {
				origin: "http://localhost:5173",
				"access-control-request-method": "GET",
				"access-control-request-headers": "last-event-id",
			},
		});

		expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
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
	const cookieApp = createTestApp(
		Layer.mergeAll(
			serverSettingsWithWebAppAt(trustedOrigin),
			identifiedBy(async (headers) =>
				headers.get("cookie") === "better-auth.session_token=cookie-token" ? signedIn : null,
			),
			unimplemented(Operations.Service, { "approvals.decide": () => Effect.void }),
		),
	);

	/** Decides a tool approval: a POST, so an unsafe request. */
	const decideApproval = (headers: Record<string, string>) =>
		cookieApp.request("/tool-calls/call-id/approval", {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: JSON.stringify({ decision: "allow_once" }),
		});

	it("accepts an unsafe cookie request from a trusted origin", async () => {
		const response = await decideApproval({
			cookie: "better-auth.session_token=cookie-token",
			origin: trustedOrigin,
		});

		expect(response.status).toBe(202);
	});

	it.each([undefined, "https://attacker.example.com"])(
		"rejects an unsafe cookie request from origin %s",
		async (origin) => {
			const response = await decideApproval({
				cookie: "better-auth.session_token=cookie-token",
				...(origin ? { origin } : {}),
			});

			expect(response.status).toBe(403);
			expect(await response.json()).toMatchObject({
				_tag: "Forbidden",
			});
		},
	);
});
