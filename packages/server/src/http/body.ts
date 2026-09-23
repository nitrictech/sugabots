import { sValidator } from "@hono/standard-validator";
import { Schema } from "effect";
import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HttpError } from "./errors.ts";

export const MAX_JSON_BODY_BYTES = 64 * 1024;

const boundedBody = bodyLimit({
	maxSize: MAX_JSON_BODY_BYTES,
	onError: (c) =>
		c.json(
			{ error: { code: "bad_request" as const, message: "JSON body exceeds the 64 KiB limit" } },
			413,
		),
});

export const limitJsonBody: MiddlewareHandler = (c, next) => {
	const mediaType = c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
	return mediaType === "application/json" || mediaType?.endsWith("+json")
		? boundedBody(c, next)
		: next();
};

/** Validates the JSON body against `schema`, answering a bad one with the field issues in the error envelope. */
export function body<S extends Schema.ConstraintDecoder<unknown>>(schema: S) {
	return sValidator("json", Schema.toStandardSchemaV1(schema), (result) => {
		if (!result.success) {
			throw new HttpError("bad_request", "That is not a valid request", result.error);
		}
	});
}
