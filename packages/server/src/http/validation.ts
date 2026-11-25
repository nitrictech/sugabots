import { IncomingMessage } from "node:http";
import {
	BadRequest,
	MaxBodyBytes,
	PayloadTooLarge,
	UnsupportedMediaType,
	ValidateRequest,
} from "@sugabots/contracts/http";
import { processLayer } from "@sugabots/core/tiers";
import { userText } from "@sugabots/errors";
import { ByteSize, Context, Effect, Layer, Option, SchemaIssue, Stream, type Types } from "effect";
import {
	HttpIncomingMessage,
	HttpServerRequest,
	type HttpServerResponse,
	UrlParams,
} from "effect/unstable/http";
import { type HttpApiEndpoint, HttpApiError } from "effect/unstable/httpapi";
import { failureResponse } from "./errors.ts";

export const MAX_JSON_BODY_BYTES = 64 * 1024;

const issues = SchemaIssue.makeFormatterStandardSchemaV1();

/**
 * The `ValidateRequest` middleware, around every endpoint.
 *
 * An endpoint that parses a JSON body has its body refused over
 * `MAX_JSON_BODY_BYTES` before it reads any of it. One that takes another kind
 * of body, such as a file's bytes, enforces its own limit while it streams.
 *
 * A request that fails its endpoint's schemas answers `BadRequest`, naming
 * every field that was wrong, and one whose body is of a type the endpoint
 * does not take answers `UnsupportedMediaType`. A response that fails its own
 * schema is the server's fault, so it stays a defect and answers 500.
 */
export const validateRequestLayer = processLayer(
	Layer.succeed(
		ValidateRequest,
		ValidateRequest.of((httpEffect, { endpoint }) => {
			const validated = httpEffect.pipe(
				Effect.catch(
					(error): Effect.Effect<never, Types.unhandled | BadRequest> =>
						HttpApiError.HttpApiSchemaError.is(error)
							? schemaErrorAsBadRequest(error)
							: Effect.fail(error),
				),
				Effect.flatMap(unsupportedMediaTypeAsFailure),
			);
			if (!parsesJsonBody(endpoint)) return validated;
			const maxBytes =
				Context.getOrUndefined(endpoint.annotations, MaxBodyBytes) ?? MAX_JSON_BODY_BYTES;
			return limitJsonBody(validated, maxBytes);
		}),
	),
);

function schemaErrorAsBadRequest(error: HttpApiError.HttpApiSchemaError) {
	return error.kind === "Body" || error.kind === "ResponseHeaders"
		? Effect.die(error)
		: Effect.fail(
				new BadRequest({
					message: userText`That is not a valid request`,
					details: issues(error.cause.issue).issues,
				}),
			);
}

/**
 * The endpoint's refusal of a body type it does not take, which the HttpApi
 * answers as plain text, as the API's own failure instead, so the client
 * decodes it. No handler answers 415 itself.
 */
function unsupportedMediaTypeAsFailure(response: HttpServerResponse.HttpServerResponse) {
	if (response.status !== UNSUPPORTED_MEDIA_TYPE) return Effect.succeed(response);
	return Effect.fail(
		new UnsupportedMediaType({
			message: userText`This request's body is not of a type it takes. Send it as JSON`,
		}),
	);
}

const UNSUPPORTED_MEDIA_TYPE = 415;

/** Whether `endpoint` reads its body as JSON, which is read whole before it is parsed. */
function parsesJsonBody(endpoint: HttpApiEndpoint.Top): boolean {
	return [...endpoint.payload.values()].some(({ encoding }) => encoding._tag === "Json");
}

/**
 * Refuses a body over `maxBytes`, `MAX_JSON_BODY_BYTES` unless the endpoint
 * says otherwise, for what reads its body whole as JSON: an endpoint that
 * parses one, and better-auth's routes.
 *
 * The body is read here, whatever its declared type, and what follows reads
 * the same copy. Reading stops keeping the body once it passes the limit, so
 * no client can make the server buffer more.
 */
export const limitJsonBody = <E, R>(
	effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
	maxBytes = MAX_JSON_BODY_BYTES,
): Effect.Effect<
	HttpServerResponse.HttpServerResponse,
	E,
	R | HttpServerRequest.HttpServerRequest
> =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest;
		if (Number(request.headers["content-length"]) > maxBytes) {
			return tooLarge(maxBytes);
		}
		const read = yield* readWithin(request, maxBytes);
		if (read === undefined) return tooLarge(maxBytes);
		return yield* Effect.provideService(effect, HttpServerRequest.HttpServerRequest, read);
	});

/**
 * `request` with its body read, or nothing when the body is over `maxBytes`
 * or never arrived whole.
 *
 * Node's own reader, given a limit, destroys the request once it is passed,
 * which resets its socket before any refusal is written. So a request
 * Node serves is read here: past the limit its bytes are no longer kept but
 * still read, so the refusal reaches the client while the rest of its body
 * drains. Any other request, as a test's web handler makes, is read by its
 * own reader within the limit.
 */
function readWithin(
	request: HttpServerRequest.HttpServerRequest,
	maxBytes: number,
): Effect.Effect<HttpServerRequest.HttpServerRequest | undefined> {
	if (request.source instanceof IncomingMessage) {
		return Effect.map(readNodeBody(request.source, maxBytes), (body) =>
			body === undefined ? undefined : withBody(request, body),
		);
	}
	return request.text.pipe(
		Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(maxBytes)),
		Effect.option,
		Effect.map((text) =>
			Option.isSome(text) && new TextEncoder().encode(text.value).byteLength <= maxBytes
				? request
				: undefined,
		),
	);
}

/** The body of a request Node serves, or nothing once it passes `maxBytes` or fails. */
function readNodeBody(
	source: IncomingMessage,
	maxBytes: number,
): Effect.Effect<Uint8Array | undefined> {
	return Effect.callback((resume) => {
		if (source.readableEnded) return resume(Effect.succeed(new Uint8Array()));
		const chunks: Buffer[] = [];
		let size = 0;
		const stopKeeping = () => {
			source.off("data", keep);
			source.off("end", finish);
			source.off("error", fail);
		};
		function keep(chunk: Buffer) {
			size += chunk.length;
			if (size <= maxBytes) return void chunks.push(chunk);
			// Still flowing with no listener, the rest is read and dropped.
			stopKeeping();
			resume(Effect.succeed(undefined));
		}
		function finish() {
			stopKeeping();
			resume(Effect.succeed(Buffer.concat(chunks)));
		}
		function fail() {
			stopKeeping();
			resume(Effect.succeed(undefined));
		}
		source.on("data", keep);
		source.once("end", finish);
		source.once("error", fail);
		return Effect.sync(stopKeeping);
	});
}

/**
 * `request` reading `body` as its body. Everything else, its source included,
 * is the request's own, so what is keyed by its source, such as the cookies a
 * response sets, still applies.
 */
function withBody(
	request: HttpServerRequest.HttpServerRequest,
	body: Uint8Array,
): HttpServerRequest.HttpServerRequest {
	const text = new TextDecoder().decode(body);
	const arrayBuffer = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
	return Object.create(request, {
		arrayBuffer: { value: Effect.succeed(arrayBuffer) },
		text: { value: Effect.succeed(text) },
		json: { value: Effect.sync(() => (text === "" ? null : JSON.parse(text))) },
		urlParamsBody: { value: Effect.sync(() => UrlParams.fromInput(new URLSearchParams(text))) },
		stream: { value: Stream.succeed(body) },
	});
}

const KIB = 1024;
const MIB = 1024 * KIB;

function tooLarge(maxBytes: number) {
	const [size, unit] =
		maxBytes >= MIB ? [maxBytes / MIB, "MiB" as const] : [maxBytes / KIB, "KiB" as const];
	return failureResponse(
		PayloadTooLarge,
		new PayloadTooLarge({ message: userText`The request body is over the ${size} ${unit} limit` }),
	);
}

/** Whether `contentType` names JSON: `application/json`, or any `+json` media type. */
export function isJson(contentType: string | undefined): boolean {
	const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
	return mediaType === "application/json" || mediaType?.endsWith("+json") === true;
}
