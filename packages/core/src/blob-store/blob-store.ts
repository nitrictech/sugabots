export * as BlobStore from "./blob-store.ts";

import { Config, Context, Data, Effect, Layer, Stream } from "effect";
import { fromPostgres } from "./implementations/postgres.ts";

/**
 * Bytes kept under path-like keys, such as `threads/<threadId>/files/<fileId>`,
 * for any feature that stores files. The store knows nothing of who owns a
 * blob: each feature keeps its own records, points at blobs by key, and
 * deletes its blobs itself when what owns them goes, usually with
 * `deletePrefix`.
 *
 * Bytes go in and come out as streams, so an implementation that can holds
 * only part of a blob in memory at once. A caller with the bytes in hand
 * passes `Stream.succeed(bytes)`.
 *
 * Every method fails with a `Failure`: `Unavailable` when the store cannot be
 * reached for now, which trying again later may fix, or `Rejected` when it
 * refuses until someone changes its configuration. Every method is safe to
 * try again: `put` replaces, and removing what is already gone does nothing.
 */
export interface Interface {
	/**
	 * Stores `content` under `key`, replacing whatever was there, and returns
	 * its size in bytes. Fails with `TooLarge`, storing nothing, when the
	 * content is over what the store keeps, and with whatever `content.stream`
	 * fails with.
	 */
	readonly put: <E>(
		key: Key,
		content: Content<E>,
	) => Effect.Effect<{ size: number }, E | TooLarge | Failure>;
	/**
	 * What is stored under `key`. Fails with `NotFound` if nothing is. The
	 * stream fails with `NotFound` if the blob is deleted while it is read, and
	 * one replaced meanwhile may yield parts of both.
	 */
	readonly get: (key: Key) => Effect.Effect<Blob, NotFound | Failure>;
	/** Removes what is stored under `key`, if anything is. */
	readonly delete: (key: Key) => Effect.Effect<void, Failure>;
	/**
	 * Every blob under `prefix`, at any depth, ordered by key. `threads/a`
	 * covers `threads/a/files/1` but not `threads/ab`.
	 */
	readonly list: (prefix: Key) => Effect.Effect<readonly Entry[], Failure>;
	/** Removes every blob under `prefix`, matched as `list` matches it. */
	readonly deletePrefix: (prefix: Key) => Effect.Effect<void, Failure>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/BlobStore") {}

/** Select the implementation using `BLOB_STORE_PROVIDER`, defaults to the application database. */
export const make = Effect.gen(function* () {
	const provider = yield* Config.Literals(PROVIDERS, "BLOB_STORE_PROVIDER").pipe(
		Config.withDefault("postgres"),
	);
	switch (provider) {
		case "postgres":
			return yield* fromPostgres;
	}
});

export const layerNoDeps = Layer.effect(Service, make);

/** Every implementation's dependencies are infrastructure the entry point provides. */
export const layer = layerNoDeps;

/** A blob's path, made by `key`. */
export type Key = string & { readonly [keyBrand]: true };

declare const keyBrand: unique symbol;

/** What `put` stores: bytes from a stream that fails with `E`. */
export interface Content<E = never> {
	stream: Stream.Stream<Uint8Array, E>;
	/** A media type, such as `text/plain; charset=utf-8`. */
	contentType: string;
}

/** What `get` reads back. */
export interface Blob {
	stream: Stream.Stream<Uint8Array, NotFound | Failure>;
	contentType: string;
	/** In bytes. */
	size: number;
}

/** Nothing is stored under `key`. */
export class NotFound extends Data.TaggedError("BlobNotFound")<{
	key: Key;
}> {}

/** The content is over `maxSize` bytes, the most that is kept. */
export class TooLarge extends Data.TaggedError("BlobTooLarge")<{
	maxSize: number;
}> {}

/**
 * The store could not be reached, such as over a dropped connection or when
 * throttled; trying again later may succeed. `operation` may still have
 * happened, wholly or in part: a `put` whose reply was lost, or a
 * `deletePrefix` that failed partway.
 */
export class Unavailable extends Data.TaggedError("BlobStoreUnavailable")<{
	operation: keyof Interface;
	provider: Provider;
	cause: unknown;
}> {}

/**
 * The store refused `operation` and will go on refusing it until someone
 * changes its configuration, such as without permission to its bucket, with
 * the bucket missing, or over its quota. Trying again does not help, so a
 * caller gives up on what needed the store and reports it.
 */
export class Rejected extends Data.TaggedError("BlobStoreRejected")<{
	operation: keyof Interface;
	provider: Provider;
	cause: unknown;
}> {}

/** How any method can fail other than with `NotFound`. */
export type Failure = Unavailable | Rejected;

export interface Entry {
	key: Key;
	contentType: string;
	size: number;
}

/**
 * The key naming `segments` as a path. A segment must be non-empty and contain
 * no `/`, so that a prefix cannot reach into a neighbour's path; one that
 * breaks this is a bug in the caller, and throws.
 */
export function key(...segments: [string, ...string[]]): Key {
	const invalid = segments.find((segment) => segment === "" || segment.includes("/"));
	if (invalid !== undefined) {
		throw new Error(`Invalid blob key segment ${JSON.stringify(invalid)} in ${segments.join("/")}`);
	}
	return segments.join("/") as Key;
}

/**
 * `stream`, failing with `TooLarge` as soon as it passes `maxSize` bytes, so a
 * reader holds no more than that.
 */
export function atMost<E>(
	stream: Stream.Stream<Uint8Array, E>,
	maxSize: number,
): Stream.Stream<Uint8Array, E | TooLarge> {
	return stream.pipe(
		Stream.mapAccumEffect(
			() => 0,
			(size, chunk: Uint8Array) => {
				const total = size + chunk.byteLength;
				return total > maxSize
					? Effect.fail(new TooLarge({ maxSize }))
					: Effect.succeed([total, [chunk]] as const);
			},
		),
	);
}

const PROVIDERS = ["postgres"] as const;

type Provider = (typeof PROVIDERS)[number];
