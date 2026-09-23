import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { hc, type InferRequestType, type InferResponseType } from "hono/client";
import { describe, expect, expectTypeOf, it } from "vitest";
import { body, limitJsonBody, MAX_JSON_BODY_BYTES } from "./body.ts";
import { onError } from "./errors.ts";

const inputSchema = Schema.Struct({
	name: Schema.Trim.check(Schema.isMinLength(1)),
	count: Schema.FiniteFromString.pipe(Schema.withDecodingDefault(Effect.succeed("1"))),
	items: Schema.optional(Schema.Array(Schema.Struct({ label: Schema.NonEmptyString }))),
});

const app = new Hono()
	.onError(onError)
	.use("*", limitJsonBody)
	.post("/", body(inputSchema), (c) => {
		expectTypeOf(c.req.valid("json")).toEqualTypeOf<typeof inputSchema.Type>();
		return c.json(c.req.valid("json"));
	});

describe("Effect JSON body validation", () => {
	it("preserves encoded RPC inputs and decoded handler and response types", async () => {
		const client = hc<typeof app>("http://localhost", {
			fetch: (request: string | Request | URL, init?: RequestInit) =>
				app.request(request instanceof URL ? request.href : request, init),
		});
		expectTypeOf<InferRequestType<typeof client.index.$post>["json"]>().toEqualTypeOf<
			typeof inputSchema.Encoded
		>();
		expectTypeOf<InferResponseType<typeof client.index.$post>["count"]>().toEqualTypeOf<number>();
		const response = await client.index.$post({ json: { name: "  Ada  " } });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ name: "Ada", count: 1 });
	});

	it("returns all field paths and messages in the 400 envelope", async () => {
		const response = await app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: " ", count: "invalid", items: [{ label: "" }] }),
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: {
				code: "bad_request",
				message: "That is not a valid request",
				details: expect.arrayContaining([
					expect.objectContaining({ path: ["name"], message: expect.any(String) }),
					expect.objectContaining({ path: ["count"], message: expect.any(String) }),
					expect.objectContaining({ path: ["items", 0, "label"], message: expect.any(String) }),
				]),
			},
		});
	});

	it("keeps malformed JSON in the 400 envelope", async () => {
		const response = await app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{",
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: { code: "bad_request" } });
	});

	it.each(["application/json", "application/vnd.api+json"])(
		"enforces the 64 KiB boundary for %s",
		async (contentType) => {
			for (const extraBytes of [0, 1]) {
				const response = await app.request("/", {
					method: "POST",
					headers: { "content-type": contentType },
					body: JSON.stringify({ name: "a".repeat(MAX_JSON_BODY_BYTES - 11 + extraBytes) }),
				});
				expect(response.status).toBe(extraBytes === 0 ? 200 : 413);
				if (extraBytes > 0) {
					expect(await response.json()).toEqual({
						error: { code: "bad_request", message: "JSON body exceeds the 64 KiB limit" },
					});
				}
			}
		},
	);
});
