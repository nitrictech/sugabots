import { healthResponseSchema, meSchema } from "@sugabots/contracts";
import { SessionAuthentication } from "@sugabots/core/authentication/session";
import { noDatabase } from "@sugabots/core/database/testing";
import { Operations } from "@sugabots/core/operations/registry";
import { unimplemented } from "@sugabots/core/testing";
import { Effect, Layer, Logger, References, Schema } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { describe, expect, it } from "vitest";
import type { MemberResolver } from "./app.test-support.ts";
import {
	BASE_URL,
	createTestApp,
	identifiedBy,
	serverSettingsWithWebAppAt,
	sessionTokenIn,
	signedInWith,
	testRoutes,
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

describe("GET /me after the session was revoked", () => {
	it("answers signed out, though better-auth's cookie cache still holds the session", async () => {
		const revokedApp = createTestApp(
			Layer.merge(
				identifiedBy(resolveMember),
				Layer.effect(
					SessionAuthentication.Service,
					Effect.map(SessionAuthentication.make, (sessions) =>
						SessionAuthentication.Service.of({
							...sessions,
							// The session's row is gone; only the cache still names it.
							authenticateLongRunning: () =>
								Effect.fail(new SessionAuthentication.SessionInvalid()),
						}),
					),
				).pipe(Layer.provide(noDatabase)),
			),
		);

		const response = await revokedApp.request("/me", { headers: signedInWith("good-token") });

		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({ _tag: "Unauthorized" });
	});
});

describe("unknown routes", () => {
	it("answer in the API's error shape, not an empty body", async () => {
		const response = await app.request("/nope");

		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({ _tag: "NotFound" });
	});
});

describe("a defect", () => {
	it("answers a fixed message with a reference id, and logs the defect under the same id", async () => {
		const logged: { message: unknown; reference: unknown }[] = [];
		const capture = Logger.layer([
			Logger.make(({ message, fiber }) => {
				const annotations = fiber.getRef(References.CurrentLogAnnotations);
				logged.push({ message, reference: annotations.reference });
			}),
		]);
		const routes = testRoutes(
			Layer.merge(
				identifiedBy(resolveMember),
				unimplemented(Operations.Service, {
					"approvals.decide": () => Effect.die(new Error('relation "tool_call" does not exist')),
				}),
			),
		);
		const { handler, dispose } = HttpRouter.toWebHandler(routes, {
			disableLogger: true,
			middleware: (effect) => Effect.provide(effect, capture),
		});

		const response = await handler(
			new Request(new URL("/api/tool-calls/call-id/approval", BASE_URL), {
				method: "POST",
				headers: { ...signedInWith("good-token"), "content-type": "application/json" },
				body: JSON.stringify({ approvalId: "approval-1", decision: "allow_once" }),
			}),
		);
		await dispose();

		expect(response.status).toBe(500);
		const body = (await response.json()) as { reference?: string };
		expect(body).toMatchObject({ _tag: "InternalServerError", reference: expect.any(String) });
		expect(body).toMatchObject({
			message: `Something unexpected went wrong. Reference: ${body.reference}`,
		});
		expect(JSON.stringify(body)).not.toContain("tool_call");
		const entry = logged.find(({ reference }) => reference === body.reference);
		expect(entry?.message).toEqual([
			"Request failed",
			new Error('relation "tool_call" does not exist'),
		]);
	});
});

describe("JSON body limit", () => {
	let decided = false;
	const jsonApp = createTestApp(
		Layer.merge(
			identifiedBy(resolveMember),
			unimplemented(Operations.Service, {
				"approvals.decide": () =>
					Effect.sync(() => {
						decided = true;
					}),
			}),
		),
	);
	/** Decides an approval, an endpoint that parses a JSON body. */
	const decideApproval = (headers: Record<string, string>, body: string) =>
		jsonApp.request("/tool-calls/call-id/approval", {
			method: "POST",
			headers: { ...signedInWith("good-token"), ...headers },
			body,
		});

	it("rejects a declared oversized JSON body before parsing it", async () => {
		const response = await decideApproval(
			{ "content-type": "application/json", "content-length": String(MAX_JSON_BODY_BYTES + 1) },
			JSON.stringify({ approvalId: "approval-1", decision: "allow_once" }),
		);

		expect(response.status).toBe(413);
		expect(await response.json()).toMatchObject({ _tag: "PayloadTooLarge" });
		expect(decided).toBe(false);
	});

	it("rejects an oversized streamed body without content-length, whatever type it names", async () => {
		const response = await decideApproval(
			{ "content-type": "text/plain" },
			JSON.stringify({
				approvalId: "approval-1",
				decision: "allow_once",
				padding: "x".repeat(MAX_JSON_BODY_BYTES),
			}),
		);

		expect(response.status).toBe(413);
		expect(decided).toBe(false);
	});

	it("rejects an oversized body to better-auth's routes, which read it whole", async () => {
		const response = await app.request("/auth/sign-in/email", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ email: "x".repeat(MAX_JSON_BODY_BYTES) }),
		});

		expect(response.status).toBe(413);
	});

	it("refuses a body of a type the endpoint does not take in the API's error shape", async () => {
		const response = await decideApproval({ "content-type": "text/plain" }, "allow_once");

		expect(response.status).toBe(415);
		expect(await response.json()).toMatchObject({
			_tag: "UnsupportedMediaType",
			message: "This request's body is not of a type it takes. Send it as JSON",
		});
		expect(decided).toBe(false);
	});

	it("parses a JSON body under the limit", async () => {
		const response = await decideApproval(
			{ "content-type": "application/json" },
			JSON.stringify({ approvalId: "approval-1", decision: "allow_once" }),
		);

		expect(response.status).toBe(202);
		expect(decided).toBe(true);
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
			body: JSON.stringify({ approvalId: "approval-1", decision: "allow_once" }),
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
