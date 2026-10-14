import { basename, dirname, join, sep } from "node:path";
import { Effect, FileSystem, type PlatformError, Sink, Stream } from "effect";
import { BlobStore } from "../blob-store.ts";

/**
 * Blobs as files under `root`, for a single server with a disk of its own.
 *
 * Each key is a directory: `threads/a/files/1` is `<root>/threads/a/files/1/`,
 * holding the bytes in `.bytes` and the media type in `.content-type`, so a key
 * can name a blob and hold others beneath it at once. Each segment is
 * percent-encoded with its dots too, so no segment can be `..` or start with
 * the `.` that marks the files the store itself keeps.
 *
 * `put` streams to temporary files and renames them into place, so a reader
 * never sees a blob half written, though one replaced while `get` reads it may
 * pair the old bytes with the new media type.
 */
export const fromFileSystem = (root: string) =>
	Effect.map(FileSystem.FileSystem, (fs): BlobStore.Interface => {
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

		return {
			put: (key, { stream, contentType }) => {
				const directory = directoryOf(root, key);
				const bytesTemporary = join(directory, temporaryName());
				const contentTypeTemporary = join(directory, temporaryName());
				const write = Effect.gen(function* () {
					yield* fs
						.makeDirectory(directory, { recursive: true })
						.pipe(Effect.mapError(failure("put")));
					yield* Stream.run(stream, fs.sink(bytesTemporary).pipe(Sink.mapError(failure("put"))));
					return yield* Effect.gen(function* () {
						yield* fs.writeFileString(contentTypeTemporary, contentType);
						const { size } = yield* fs.stat(bytesTemporary);
						yield* fs.rename(contentTypeTemporary, join(directory, CONTENT_TYPE_FILE));
						yield* fs.rename(bytesTemporary, join(directory, BYTES_FILE));
						return { size: Number(size) };
					}).pipe(Effect.mapError(failure("put")));
				});
				return write.pipe(
					Effect.onError(() =>
						Effect.ignore(
							Effect.all([
								fs.remove(bytesTemporary, { force: true }),
								fs.remove(contentTypeTemporary, { force: true }),
							]),
						),
					),
					Effect.withSpan("BlobStore.put"),
				);
			},
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
					Effect.asVoid,
					Effect.mapError(failure("delete")),
					Effect.withSpan("BlobStore.delete"),
				);
			},
			list: (prefix) =>
				Effect.gen(function* () {
					const paths = yield* fs
						.readDirectory(directoryOf(root, prefix), { recursive: true })
						.pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])));
					const keys = paths
						.filter((path) => basename(path) === BYTES_FILE && path !== BYTES_FILE)
						.map((path) => keyUnder(prefix, dirname(path)));
					const entries = yield* Effect.forEach(
						keys,
						(key) =>
							entryOf(key).pipe(
								Effect.map((entry): BlobStore.Entry | undefined => ({ key, ...entry })),
								// Deleted since the directory was read.
								Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined),
							),
						{ concurrency: LIST_CONCURRENCY },
					);
					return entries
						.filter((entry) => entry !== undefined)
						.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
				}).pipe(Effect.mapError(failure("list")), Effect.withSpan("BlobStore.list")),
			deletePrefix: (prefix) => {
				const directory = directoryOf(root, prefix);
				// Not the directory itself, which holds the blob stored under `prefix`, if any.
				return segmentsIn(directory).pipe(
					Effect.flatMap((segments) =>
						Effect.forEach(
							segments,
							(segment) => fs.remove(join(directory, segment), { recursive: true, force: true }),
							{ discard: true },
						),
					),
					Effect.mapError(failure("deletePrefix")),
					Effect.withSpan("BlobStore.deletePrefix"),
				);
			},
		};
	});

const BYTES_FILE = ".bytes";

const CONTENT_TYPE_FILE = ".content-type";

/** How many blobs `list` reads the details of at once. */
const LIST_CONCURRENCY = 16;

function directoryOf(root: string, key: BlobStore.Key): string {
	return join(root, ...key.split("/").map(encodeSegment));
}

/** The key of the blob in `relativeDirectory`, a directory below `prefix`'s. */
function keyUnder(prefix: BlobStore.Key, relativeDirectory: string): BlobStore.Key {
	const segments = relativeDirectory.split(sep).map((segment) => decodeURIComponent(segment));
	return `${prefix}/${segments.join("/")}` as BlobStore.Key;
}

function encodeSegment(segment: string): string {
	return encodeURIComponent(segment).replaceAll(".", "%2E");
}

/** Starts with `.`, so it is never taken for a key's segment. */
function temporaryName(): string {
	return `.${crypto.randomUUID()}.tmp`;
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
