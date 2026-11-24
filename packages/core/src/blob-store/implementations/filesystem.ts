import { rmdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Effect, FileSystem, type PlatformError, Stream } from "effect";
import { Ids } from "../../ids/ids.ts";
import { BlobStore } from "../blob-store.ts";

/**
 * Blobs as files under `root`, for a single server with a disk of its own.
 *
 * Each key is a directory: `chats/a/files/1` is `<root>/chats/a/files/1/`,
 * holding the bytes in `.bytes` and the media type in `.content-type`, so a key
 * can name a blob and hold others beneath it at once. Each segment is
 * percent-encoded with its dots too, so no segment can be `..` or start with
 * the `.` that marks the files the store itself keeps. Deleting removes the
 * directories it leaves empty, so deleted chats leave nothing behind.
 *
 * `put` streams to temporary files, syncs them to disk and renames them into
 * place, so a reader never sees a blob half written and one that was put
 * survives a crash. A blob replaced while `get` reads it, or by two `put`s at
 * once, may pair one's bytes with the other's media type.
 */
export const fromFileSystem = (root: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const ids = yield* Ids.Service;
		/** Starts with `.`, so it is never taken for a key's segment. */
		const temporaryName = Effect.map(ids.random, (id) => `.${id}.tmp`);

		// A missing or read-only directory stops the server starting, rather than
		// failing whichever feature first keeps a file.
		yield* Effect.gen(function* () {
			yield* fs.makeDirectory(root, { recursive: true });
			const probe = join(root, yield* temporaryName);
			yield* fs.writeFileString(probe, "");
			yield* fs.remove(probe);
		}).pipe(
			Effect.mapError(
				(cause) => new Error(`BLOB_STORE_FILESYSTEM_ROOT ${root} can't be written`, { cause }),
			),
			Effect.orDie,
		);
		// A relative root depends on where the server was started, so say where it led.
		yield* Effect.logInfo(`Keeping files under ${resolve(root)}`);

		const entryOf = (key: BlobStore.Key) =>
			Effect.all({
				contentType: fs.readFileString(join(directoryOf(root, key), CONTENT_TYPE_FILE)),
				size: Effect.map(fs.stat(join(directoryOf(root, key), BYTES_FILE)), (info) =>
					Number(info.size),
				),
			});

		/** The names directly in `directory` that are segments of keys, not the store's own files. */
		const segmentsIn = (directory: string) =>
			fs.readDirectory(directory).pipe(
				Effect.map((names) => names.filter((name) => !name.startsWith("."))),
				Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])),
			);

		/**
		 * Writes `stream` to a new file at `path` and syncs it to disk, so a
		 * rename after it cannot leave an empty or partial file after a crash.
		 */
		const writeSynced = <E>(path: string, stream: Stream.Stream<Uint8Array, E>) =>
			Effect.scoped(
				Effect.gen(function* () {
					const file = yield* fs.open(path, { flag: "w" }).pipe(Effect.mapError(failure("put")));
					yield* Stream.runForEach(stream, (chunk) =>
						file.writeAll(chunk).pipe(Effect.mapError(failure("put"))),
					);
					yield* file.sync.pipe(Effect.mapError(failure("put")));
				}),
			);

		const syncDirectory = syncDirectoryWith(fs);
		const removeEmptyDirectories = (directory: string) =>
			removeEmptyDirectoriesUpTo(root, directory);

		return {
			put: (key, { stream, contentType }) =>
				Effect.gen(function* () {
					const directory = directoryOf(root, key);
					const bytesTemporary = join(directory, yield* temporaryName);
					const contentTypeTemporary = join(directory, yield* temporaryName);
					const write = Effect.gen(function* () {
						yield* fs
							.makeDirectory(directory, { recursive: true })
							.pipe(Effect.mapError(failure("put")));
						yield* writeSynced(bytesTemporary, stream);
						yield* writeSynced(
							contentTypeTemporary,
							Stream.succeed(new TextEncoder().encode(contentType)),
						);
						return yield* Effect.gen(function* () {
							const { size } = yield* fs.stat(bytesTemporary);
							yield* fs.rename(contentTypeTemporary, join(directory, CONTENT_TYPE_FILE));
							yield* fs.rename(bytesTemporary, join(directory, BYTES_FILE));
							yield* syncDirectory(directory);
							return { size: Number(size) };
						}).pipe(Effect.mapError(failure("put")));
					});
					return yield* write.pipe(
						Effect.onError(() =>
							Effect.all([
								fs.remove(bytesTemporary, { force: true }),
								fs.remove(contentTypeTemporary, { force: true }),
							]).pipe(Effect.ignore, Effect.andThen(removeEmptyDirectories(directory))),
						),
					);
				}).pipe(Effect.withSpan("BlobStore.put")),
			get: (key) =>
				Effect.gen(function* () {
					const entry = yield* entryOf(key).pipe(
						Effect.catchReason("PlatformError", "NotFound", () =>
							Effect.fail(new BlobStore.NotFound({ key })),
						),
						Effect.mapError((error) =>
							error._tag === "PlatformError" ? failure("get")(error) : error,
						),
					);
					const stream = fs
						.stream(join(directoryOf(root, key), BYTES_FILE))
						.pipe(
							Stream.mapError((error) =>
								error.reason._tag === "NotFound"
									? new BlobStore.NotFound({ key })
									: failure("get")(error),
							),
						);
					return { ...entry, stream };
				}).pipe(Effect.withSpan("BlobStore.get")),
			delete: (key) => {
				const directory = directoryOf(root, key);
				// The bytes go first, so a blob with only its media type left is gone to `get`.
				return Effect.all([
					fs.remove(join(directory, BYTES_FILE), { force: true }),
					fs.remove(join(directory, CONTENT_TYPE_FILE), { force: true }),
				]).pipe(
					Effect.mapError(failure("delete")),
					Effect.andThen(removeEmptyDirectories(directory)),
					Effect.withSpan("BlobStore.delete"),
				);
			},
			deletePrefix: (prefix) => {
				const directory = directoryOf(root, prefix);
				// Not the directory's own files, which hold the blob stored under `prefix`, if any.
				return segmentsIn(directory).pipe(
					Effect.flatMap((segments) =>
						Effect.forEach(
							segments,
							(segment) => fs.remove(join(directory, segment), { recursive: true, force: true }),
							{ discard: true },
						),
					),
					Effect.mapError(failure("deletePrefix")),
					Effect.andThen(removeEmptyDirectories(directory)),
					Effect.withSpan("BlobStore.deletePrefix"),
				);
			},
		} satisfies BlobStore.Interface;
	});

/**
 * Moves every blob under the key `from` to the same key under `to`, for
 * `BlobStore.make`: each entry is renamed to its place under `to`, merging
 * into a directory already there, and the directories this empties go. The
 * blob stored under `from` itself stays, as `deletePrefix` leaves it. A blob
 * already moved is no longer under `from`, so moving again after a crash
 * part-way finishes the job; one whose new key is taken is left where it is.
 */
export const moveFolderOnDisk = (root: string) => (from: BlobStore.Key, to: BlobStore.Key) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const syncDirectory = syncDirectoryWith(fs);
		const entriesIn = (directory: string) =>
			fs
				.readDirectory(directory)
				.pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])));
		/** Moves `names` from the directory `source` to the directory `target`. */
		const moveEntries = (
			source: string,
			target: string,
			names: readonly string[],
		): Effect.Effect<void, PlatformError.PlatformError> =>
			Effect.forEach(
				names,
				(name) =>
					Effect.gen(function* () {
						const moving = join(source, name);
						const destination = join(target, name);
						if (!(yield* fs.exists(destination))) {
							yield* fs.makeDirectory(target, { recursive: true });
							yield* fs.rename(moving, destination);
							yield* syncDirectory(target);
							return;
						}
						if (!name.startsWith(".")) yield* moveKey(moving, destination);
					}),
				{ discard: true },
			);
		/** Moves the blob under the key directory `source`, and every one beneath it, to `target`. */
		const moveKey = (
			source: string,
			target: string,
		): Effect.Effect<void, PlatformError.PlatformError> =>
			Effect.gen(function* () {
				const entries = yield* entriesIn(source);
				// Not a temporary file, which is part of a `put` that never finished.
				const kept = entries.filter(
					(name) => !name.startsWith(".") || name === BYTES_FILE || name === CONTENT_TYPE_FILE,
				);
				yield* moveEntries(source, target, kept);
				yield* syncDirectory(source);
				yield* Effect.tryPromise(() => rmdir(source)).pipe(Effect.ignore);
			});
		const source = directoryOf(root, from);
		const segments = (yield* entriesIn(source)).filter((name) => !name.startsWith("."));
		yield* moveEntries(source, directoryOf(root, to), segments);
		yield* syncDirectory(source);
		yield* removeEmptyDirectoriesUpTo(root, source);
	});

/**
 * Syncs `directory`'s entries to disk, so its renamed files survive a
 * crash. Windows cannot open a directory to sync it, so a failure here is
 * ignored.
 */
const syncDirectoryWith = (fs: FileSystem.FileSystem) => (directory: string) =>
	Effect.scoped(Effect.flatMap(fs.open(directory, { flag: "r" }), (handle) => handle.sync)).pipe(
		Effect.ignore,
	);

/**
 * Removes `directory` and then each directory above it, up to `root`,
 * while they are empty. `rmdir` refuses a directory that is not empty,
 * which `FileSystem.remove` cannot, so a blob put meanwhile is never
 * removed with it; that `put` may instead fail as `Unavailable`, and
 * succeed when tried again.
 */
const removeEmptyDirectoriesUpTo = (root: string, directory: string) =>
	Effect.gen(function* () {
		const top = join(root);
		let current = directory;
		while (current !== top && current.startsWith(top)) {
			const removed = yield* Effect.tryPromise(() => rmdir(current)).pipe(
				Effect.as(true),
				Effect.orElseSucceed(() => false),
			);
			if (!removed) return;
			current = dirname(current);
		}
	});

const BYTES_FILE = ".bytes";

const CONTENT_TYPE_FILE = ".content-type";

function directoryOf(root: string, key: BlobStore.Key): string {
	return join(root, ...key.split("/").map(encodeSegment));
}

function encodeSegment(segment: string): string {
	return encodeURIComponent(segment).replaceAll(".", "%2E");
}

/**
 * A permission error lasts until someone fixes the directory's permissions;
 * anything else, such as a full disk, may pass.
 */
const failure =
	(operation: keyof BlobStore.Interface) =>
	(cause: PlatformError.PlatformError): BlobStore.Failure =>
		cause.reason._tag === "PermissionDenied"
			? new BlobStore.Rejected({ operation, provider: "filesystem", cause })
			: new BlobStore.Unavailable({ operation, provider: "filesystem", cause });
