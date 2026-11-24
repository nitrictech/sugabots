import { BadRequest } from "@sugabots/contracts/http";
import { BlobStore } from "@sugabots/core/blob-store/blob-store";
import { userText } from "@sugabots/errors";
import { Effect, Stream } from "effect";
import type { HttpServerRequest } from "effect/unstable/http";

/**
 * A raw upload's body as a stream, for a route that keeps it without reading
 * it into memory first, never more than `maxBytes` of it. Refused with
 * `tooLarge()` before any of it is read when the request says it is over
 * `maxBytes`; the stream fails with `tooLarge()` once more than that arrives,
 * as a request needn't say how large it is or may say less than it sends,
 * and with `BadRequest` when the body stops arriving.
 */
export const uploadedBody = <E>(
	request: HttpServerRequest.HttpServerRequest,
	maxBytes: number,
	tooLarge: () => E,
): Effect.Effect<Stream.Stream<Uint8Array, BadRequest | E>, E> =>
	Number(request.headers["content-length"]) > maxBytes
		? Effect.fail(tooLarge())
		: Effect.succeed(
				BlobStore.atMost(
					request.stream.pipe(
						Stream.mapError(
							() => new BadRequest({ message: userText`The upload was interrupted` }),
						),
					),
					maxBytes,
				).pipe(Stream.catchTag("BlobTooLarge", () => Stream.fail(tooLarge()))),
			);
