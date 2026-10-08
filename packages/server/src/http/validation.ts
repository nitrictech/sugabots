import { BadRequest, PayloadTooLarge, ValidateRequest } from "@sugabots/contracts/http";
import { userText } from "@sugabots/errors";
import { ByteSize, Effect, SchemaIssue } from "effect";
import {
	HttpIncomingMessage,
	HttpServerRequest,
	type HttpServerResponse,
} from "effect/unstable/http";
import { HttpApiMiddleware } from "effect/unstable/httpapi";
import { failureResponse } from "./errors.ts";

export const MAX_JSON_BODY_BYTES = 64 * 1024;

const issues = SchemaIssue.makeFormatterStandardSchemaV1();

/**
 * A request that fails its endpoint's schemas answers `BadRequest`, naming
 * every field that was wrong. A response that fails its own schema is the
 * server's fault, so it stays a defect and answers 500.
 */
export const validateRequestLayer = HttpApiMiddleware.layerSchemaErrorTransform(
	ValidateRequest,
	(error) =>
		error.kind === "Body" || error.kind === "ResponseHeaders"
			? Effect.die(error)
			: Effect.fail(
					new BadRequest({
						message: userText`That is not a valid request`,
						details: issues(error.cause.issue).issues,
					}),
				),
);

/**
 * Refuses a JSON body over `MAX_JSON_BODY_BYTES` before any endpoint reads it.
 *
 * The body is read here, and the endpoint reads the same copy. `MaxBodySize`
 * makes the Node server stop reading at the limit too, rather than buffer
 * whatever a client sends.
 */
export const limitJsonBody = <E, R>(
	effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
): Effect.Effect<
	HttpServerResponse.HttpServerResponse,
	E,
	R | HttpServerRequest.HttpServerRequest
> =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest;
		if (!isJson(request.headers["content-type"])) {
			return yield* effect;
		}
		if (Number(request.headers["content-length"]) > MAX_JSON_BODY_BYTES) {
			return tooLarge();
		}
		const text = yield* request.text.pipe(Effect.option);
		if (
			text._tag === "None" ||
			new TextEncoder().encode(text.value).byteLength > MAX_JSON_BODY_BYTES
		) {
			return tooLarge();
		}
		return yield* effect;
	}).pipe(
		Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(MAX_JSON_BODY_BYTES)),
	);

function tooLarge() {
	return failureResponse(
		PayloadTooLarge,
		new PayloadTooLarge({ message: userText`JSON body exceeds the 64 KiB limit` }),
		413,
	);
}

function isJson(contentType: string | undefined): boolean {
	const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
	return mediaType === "application/json" || mediaType?.endsWith("+json") === true;
}
