import { Effect, Stream } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase, onPostgres, type Promised, runOnPostgres } from "../database/testing.ts";
import { BlobStore } from "./blob-store.ts";

describe.skipIf(!process.env.DATABASE_URL)("blob store, against Postgres", () => {
	let blobs: Promised<BlobStore.Interface>;

	beforeAll(async () => {
		blobs = onPostgres(await runOnPostgres(Effect.service(BlobStore.Service)));
	});
	afterAll(closeDatabase);

	/** A folder name no other case writes under. */
	const aFolder = () => crypto.randomUUID();
	const text = (value: string): BlobStore.Content => ({
		stream: Stream.succeed(new TextEncoder().encode(value)),
		contentType: "text/plain; charset=utf-8",
	});
	const bytesOf = async (key: BlobStore.Key) => {
		const { stream } = await blobs.get(key);
		const chunks = await Effect.runPromise(Stream.runCollect(stream));
		return Buffer.concat(chunks);
	};

	it("reads back what was put, with its size in bytes", async () => {
		const key = BlobStore.key("tests", aFolder(), "notes.md");

		const put = await blobs.put(key, text("héllo"));
		const found = await blobs.get(key);

		expect(put).toEqual({ size: 6 });
		expect(found).toMatchObject({ contentType: "text/plain; charset=utf-8", size: 6 });
		expect((await bytesOf(key)).toString("utf8")).toBe("héllo");
	});

	it("reads back a blob put in several chunks and read in several queries", async () => {
		const key = BlobStore.key("tests", aFolder(), "large.bin");
		const bytes = Buffer.alloc(9 * 1024 * 1024 + 1, 0);
		for (let index = 0; index < bytes.length; index += 4096) bytes[index] = index % 251;
		const chunks = [bytes.subarray(0, 1000), bytes.subarray(1000)];

		await blobs.put(key, { stream: Stream.fromIterable(chunks), contentType: "application/zip" });

		expect((await bytesOf(key)).equals(bytes)).toBe(true);
	});

	it("reads back an empty blob", async () => {
		const key = BlobStore.key("tests", aFolder(), "empty");

		await blobs.put(key, text(""));

		expect(await bytesOf(key)).toHaveLength(0);
	});

	it("replaces what was under the key", async () => {
		const key = BlobStore.key("tests", aFolder(), "notes.md");

		await blobs.put(key, text("first"));
		await blobs.put(key, {
			stream: Stream.succeed(new Uint8Array([1, 2])),
			contentType: "image/png",
		});

		expect(await blobs.get(key)).toMatchObject({ contentType: "image/png", size: 2 });
	});

	it("ends a read whose blob is replaced by a shorter one before it is read", async () => {
		const key = BlobStore.key("tests", aFolder(), "notes.md");
		await blobs.put(key, {
			stream: Stream.succeed(Buffer.alloc(9 * 1024 * 1024)),
			contentType: "application/zip",
		});

		const { stream } = await blobs.get(key);
		await blobs.put(key, text("short"));
		const chunks = await Effect.runPromise(Stream.runCollect(stream));

		expect(Buffer.concat(chunks).toString("utf8")).toBe("short");
	}, 10_000);

	it("finds nothing under a key never put or since deleted", async () => {
		const key = BlobStore.key("tests", aFolder(), "gone");
		await blobs.put(key, text("brief"));

		await blobs.delete(key);

		await expect(blobs.get(key)).rejects.toBeInstanceOf(BlobStore.NotFound);
		await expect(blobs.get(BlobStore.key("tests", aFolder(), "never"))).rejects.toBeInstanceOf(
			BlobStore.NotFound,
		);
	});

	it("lists and deletes a prefix's blobs at any depth, and no neighbour's", async () => {
		const folder = `${aFolder()}_x`;
		const prefix = BlobStore.key("tests", folder);
		const near = BlobStore.key("tests", folder, "a");
		const deep = BlobStore.key("tests", folder, "a", "b", "c");
		const extended = BlobStore.key("tests", `${folder}y`, "a");
		// Matched by the prefix if its `_` were left as a `LIKE` wildcard.
		const wildcard = BlobStore.key("tests", folder.replace("_", "z"), "a");
		for (const key of [deep, near, extended, wildcard]) await blobs.put(key, text(key));

		expect(await blobs.list(prefix)).toEqual([
			{ key: near, contentType: "text/plain; charset=utf-8", size: near.length },
			{ key: deep, contentType: "text/plain; charset=utf-8", size: deep.length },
		]);

		await blobs.deletePrefix(prefix);

		expect(await blobs.list(prefix)).toEqual([]);
		await expect(blobs.get(extended)).resolves.toBeDefined();
		await expect(blobs.get(wildcard)).resolves.toBeDefined();
	});
});

describe("a size limit on a stream", () => {
	it("fails once the stream passes it, and passes a stream within it", async () => {
		const chunks = [new Uint8Array(3), new Uint8Array(3)];
		const collect = (maxSize: number) =>
			Effect.runPromise(Stream.runCollect(BlobStore.atMost(Stream.fromIterable(chunks), maxSize)));

		await expect(collect(6)).resolves.toHaveLength(2);
		await expect(collect(5)).rejects.toEqual(new BlobStore.TooLarge({ maxSize: 5 }));
	});
});

describe("blob keys", () => {
	it("refuses a segment that would escape its place in the path", () => {
		expect(() => BlobStore.key("threads", "a/b")).toThrow();
		expect(() => BlobStore.key("threads", "")).toThrow();
	});
});
