import { errorResponseSchema } from "@sugabots/contracts";
import { Schema } from "effect";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it, vi } from "vitest";
import { HttpError, onError } from "./errors.ts";

function appThatThrows(error: unknown) {
	const app = new Hono();
	app.onError(onError);
	return app.get("/", () => {
		throw error;
	});
}

describe("onError", () => {
	it("returns the envelope for an HttpError, with its details", async () => {
		const app = appThatThrows(new HttpError("bad_request", "Name is required", { field: "name" }));

		const response = await app.request("/");

		expect(response.status).toBe(400);
		expect(Schema.decodeUnknownSync(errorResponseSchema)(await response.json())).toEqual({
			error: { code: "bad_request", message: "Name is required", details: { field: "name" } },
		});
	});

	it("maps Hono's own failures onto a code", async () => {
		const app = appThatThrows(new HTTPException(403, { message: "Not your pod" }));

		const response = await app.request("/");

		expect(response.status).toBe(403);
		expect(Schema.decodeUnknownSync(errorResponseSchema)(await response.json()).error.code).toBe(
			"forbidden",
		);
	});

	it("logs an unexpected error but tells the caller nothing about it", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const app = appThatThrows(new Error("connection to postgres://user:pw@host failed"));

		const response = await app.request("/");

		expect(response.status).toBe(500);
		expect(Schema.decodeUnknownSync(errorResponseSchema)(await response.json())).toEqual({
			error: { code: "internal", message: "Internal server error" },
		});
		expect(logged).toHaveBeenCalled();
		logged.mockRestore();
	});
});
