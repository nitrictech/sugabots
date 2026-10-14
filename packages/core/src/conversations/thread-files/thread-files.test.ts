import { eq } from "drizzle-orm";
import { ConfigProvider, Duration, Effect, Layer, Stream } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BlobStore } from "../../blob-store/blob-store.ts";
import { BlobDeletions } from "../../blob-store/deletions.ts";
import {
	blobDeletion,
	message,
	pod,
	thread,
	threadFile,
	toolCall,
	turn,
} from "../../database/schema.ts";
import {
	closeDatabase,
	onDatabase,
	type Promised,
	runOnPostgres,
	servedOnPostgres,
} from "../../database/testing.ts";
import { aRoutineOwner } from "../routines/testing.ts";
import { ThreadFiles } from "./thread-files.ts";

describe.skipIf(!process.env.DATABASE_URL)("thread files, against Postgres", () => {
	let files: Promised<ThreadFiles.Interface>;

	beforeAll(async () => {
		files = await servedOnPostgres(ThreadFiles.Service, ThreadFiles.layer.pipe(Layer.orDie));
	});
	afterAll(closeDatabase);

	/** A thread in a pod of its own. */
	async function aThread() {
		const owner = await aRoutineOwner();
		const [created] = await onDatabase((db) =>
			db
				.insert(thread)
				.values({
					workspaceId: owner.workspaceId,
					podId: owner.podId,
					hostAgentId: owner.agentId,
					type: "chat",
					title: "Files",
				})
				.returning(),
		);
		if (!created) throw new Error("Could not create thread");
		return {
			threadId: created.id,
			podId: owner.podId,
			agentId: owner.agentId,
			userId: owner.userId,
		};
	}

	/** A finished call to a tool in a turn of `agentId`'s in `threadId`. */
	async function aToolCall(threadId: string, agentId: string) {
		return onDatabase((db) =>
			Effect.gen(function* () {
				const [reply] = yield* db
					.insert(message)
					.values({
						threadId,
						authorAgentId: agentId,
						kind: "text",
						status: "complete",
						parts: [],
						content: "",
					})
					.returning({ id: message.id });
				if (!reply) throw new Error("Could not create message");
				const [ran] = yield* db
					.insert(turn)
					.values({
						threadId,
						agentId,
						triggerMessageId: reply.id,
						status: "done",
						model: "test/model",
						startedAt: new Date(),
					})
					.returning({ id: turn.id });
				if (!ran) throw new Error("Could not create turn");
				const [call] = yield* db
					.insert(toolCall)
					.values({
						threadId,
						messageId: reply.id,
						turnId: ran.id,
						tool: "web_fetch",
						status: "completed",
						input: {},
						atOffset: 0,
					})
					.returning({ id: toolCall.id });
				if (!call) throw new Error("Could not create tool call");
				return call.id;
			}),
		);
	}

	const text = (value: string): BlobStore.Content => ({
		stream: Stream.succeed(new TextEncoder().encode(value)),
		contentType: "text/plain; charset=utf-8",
	});
	const textOf = async (stream: Stream.Stream<Uint8Array, unknown>) =>
		Buffer.concat(await Effect.runPromise(Stream.runCollect(stream))).toString("utf8");

	it("reads back what was written", async () => {
		const { threadId } = await aThread();

		const written = await files.write({ threadId, content: text("héllo") });
		const read = await files.read({ threadId, fileId: written.id });

		expect(written).toEqual({
			id: expect.any(String),
			contentType: "text/plain; charset=utf-8",
			size: 6,
		});
		expect(await textOf(read.stream)).toBe("héllo");
		expect(read).toMatchObject(written);
	});

	it("finds the files kept as tool calls' results by call", async () => {
		const { threadId, agentId } = await aThread();
		const toolCallId = await aToolCall(threadId, agentId);
		const result = await files.write({ threadId, toolCallId, content: text("long result") });
		await files.write({ threadId, content: text("not a result") });

		expect(await files.resultFiles(threadId)).toEqual(new Map([[toolCallId, result.id]]));
	});

	it("reads a file only from its own thread", async () => {
		const { threadId } = await aThread();
		const other = await aThread();
		const written = await files.write({ threadId, content: text("secret") });

		await expect(
			files.read({ threadId: other.threadId, fileId: written.id }),
		).rejects.toBeInstanceOf(ThreadFiles.FileNotFound);
	});

	it("finds nothing for an id that is not one", async () => {
		const { threadId } = await aThread();

		await expect(files.read({ threadId, fileId: "../etc/passwd" })).rejects.toBeInstanceOf(
			ThreadFiles.FileNotFound,
		);
	});

	it("refuses a file over THREAD_FILE_MAX_BYTES, keeping nothing", async () => {
		const capped = await servedOnPostgres(
			ThreadFiles.Service,
			ThreadFiles.layer.pipe(
				Layer.provide(
					ConfigProvider.layer(ConfigProvider.fromEnv({ env: { THREAD_FILE_MAX_BYTES: "5" } })),
				),
				Layer.orDie,
			),
		);
		const { threadId } = await aThread();
		const content = {
			stream: Stream.fromIterable([new Uint8Array(3), new Uint8Array(3)]),
			contentType: "application/octet-stream",
		};

		await expect(capped.write({ threadId, content })).rejects.toEqual(
			new ThreadFiles.FileTooLarge({ maxSize: 5 }),
		);
		expect(
			await onDatabase((db) =>
				db.select().from(threadFile).where(eq(threadFile.threadId, threadId)),
			),
		).toEqual([]);
	});

	/** A message from `userId` in `threadId`, that files can be attached to. */
	async function aMessage(threadId: string, userId: string) {
		const [sent] = await onDatabase((db) =>
			db
				.insert(message)
				.values({
					threadId,
					authorUserId: userId,
					kind: "text",
					status: "complete",
					parts: [],
					content: "",
				})
				.returning({ id: message.id }),
		);
		if (!sent) throw new Error("Could not create message");
		return sent.id;
	}

	/** Sends `fileIds`, uploaded by `userId`, in a new message of theirs. */
	const send = async (threadId: string, userId: string, fileIds: string[]) =>
		files.attach({
			threadId,
			messageId: await aMessage(threadId, userId),
			uploaderId: userId,
			fileIds,
		});

	it("attaches only the uploader's own unsent uploads, all of them or none", async () => {
		const { threadId, userId } = await aThread();
		const other = await aRoutineOwner();
		const upload = (uploaderId: string, name: string) =>
			files.upload({
				threadId,
				uploaderId,
				name,
				maxSize: 1024,
				maxUnsent: 20,
				content: text(name),
			});
		const mine = await upload(userId, "mine.txt");
		const theirs = await upload(other.userId, "theirs.txt");

		await expect(send(threadId, userId, [mine.id, theirs.id])).rejects.toBeInstanceOf(
			ThreadFiles.UploadsNotFound,
		);
		// Refusing one attached none.
		await expect(files.read({ threadId, fileId: mine.id })).rejects.toBeInstanceOf(
			ThreadFiles.FileNotFound,
		);

		await expect(send(threadId, userId, [mine.id])).resolves.toEqual([mine]);
		// Sent once, it is no longer an upload to send.
		await expect(send(threadId, userId, [mine.id])).rejects.toBeInstanceOf(
			ThreadFiles.UploadsNotFound,
		);
	});

	it("keeps an upload unreadable until it is attached to a message", async () => {
		const { threadId, userId } = await aThread();
		const uploaded = await files.upload({
			threadId,
			uploaderId: userId,
			name: "notes.txt",
			maxSize: 1024,
			maxUnsent: 20,
			content: text("draft"),
		});

		await expect(files.read({ threadId, fileId: uploaded.id })).rejects.toBeInstanceOf(
			ThreadFiles.FileNotFound,
		);

		await send(threadId, userId, [uploaded.id]);
		const read = await files.read({ threadId, fileId: uploaded.id });

		expect(uploaded).toEqual({
			id: expect.any(String),
			name: "notes.txt",
			contentType: "text/plain; charset=utf-8",
			size: 5,
		});
		expect(read).toMatchObject({ name: "notes.txt", size: 5 });
		expect(await textOf(read.stream)).toBe("draft");
	});

	it("refuses an upload over its own limit, keeping nothing", async () => {
		const { threadId, userId } = await aThread();

		await expect(
			files.upload({
				threadId,
				uploaderId: userId,
				name: "big.bin",
				maxSize: 4,
				maxUnsent: 20,
				content: text("too long"),
			}),
		).rejects.toEqual(new ThreadFiles.FileTooLarge({ maxSize: 4 }));
		expect(
			await onDatabase((db) =>
				db.select().from(threadFile).where(eq(threadFile.threadId, threadId)),
			),
		).toEqual([]);
	});

	it("refuses an upload past its uploader's unsent ones, counting only those", async () => {
		const { threadId, userId } = await aThread();
		const other = await aRoutineOwner();
		const upload = (uploaderId: string, name: string) =>
			files.upload({
				threadId,
				uploaderId,
				name,
				maxSize: 1024,
				maxUnsent: 2,
				content: text(name),
			});
		const first = await upload(userId, "one.txt");
		await upload(userId, "two.txt");

		await expect(upload(userId, "three.txt")).rejects.toEqual(
			new ThreadFiles.TooManyUnsentUploads({ maxUnsent: 2 }),
		);
		// Someone else's unsent uploads are theirs to count.
		await expect(upload(other.userId, "theirs.txt")).resolves.toMatchObject({ name: "theirs.txt" });
		// Sending one frees its place.
		await send(threadId, userId, [first.id]);
		await expect(upload(userId, "three.txt")).resolves.toMatchObject({ name: "three.txt" });
	});

	it("removes an unsent upload for its uploader only, and never a sent one", async () => {
		const { threadId, userId } = await aThread();
		const other = await aRoutineOwner();
		const upload = (name: string) =>
			files.upload({
				threadId,
				uploaderId: userId,
				name,
				maxSize: 1024,
				maxUnsent: 20,
				content: text(name),
			});
		const removed = await upload("removed.txt");
		const kept = await upload("kept.txt");
		const sent = await upload("sent.txt");
		await send(threadId, userId, [sent.id]);
		const rows = () =>
			onDatabase((db) =>
				db.select({ id: threadFile.id }).from(threadFile).where(eq(threadFile.threadId, threadId)),
			);

		await files.removeUnsentUpload({ threadId, uploaderId: other.userId, fileId: kept.id });
		await files.removeUnsentUpload({ threadId, uploaderId: userId, fileId: sent.id });
		await files.removeUnsentUpload({ threadId, uploaderId: userId, fileId: removed.id });
		// Again, once it is gone.
		await files.removeUnsentUpload({ threadId, uploaderId: userId, fileId: removed.id });

		expect((await rows()).map(({ id }) => id).sort()).toEqual([kept.id, sent.id].sort());
	});

	it("removes uploads left unsent, with their blobs, and nothing else", async () => {
		const { threadId, userId } = await aThread();
		const upload = (name: string) =>
			files.upload({
				threadId,
				uploaderId: userId,
				name,
				maxSize: 1024,
				maxUnsent: 20,
				content: text(name),
			});
		await upload("abandoned.txt");
		const sent = await upload("sent.txt");
		await send(threadId, userId, [sent.id]);
		const result = await files.write({ threadId, content: text("a tool's result") });
		const blobsUnder = () =>
			runOnPostgres(
				Effect.flatMap(BlobStore.Service, (blobs) =>
					blobs.list(BlobStore.key("threads", threadId)),
				),
			);

		await files.removeUnsentUploads(Duration.zero);

		const left = await onDatabase((db) =>
			db.select({ id: threadFile.id }).from(threadFile).where(eq(threadFile.threadId, threadId)),
		);
		expect(left.map(({ id }) => id).sort()).toEqual([sent.id, result.id].sort());
		expect((await blobsUnder()).map(({ key }) => key).sort()).toEqual(
			[sent.id, result.id].map((id) => BlobStore.key("threads", threadId, "files", id)).sort(),
		);
	});

	it("deletes a thread's blobs once a cascade has deleted the thread", async () => {
		const { threadId, podId } = await aThread();
		const written = await files.write({ threadId, content: text("kept until the pod goes") });
		const folder = BlobStore.key("threads", threadId);
		const blobsUnder = () =>
			runOnPostgres(Effect.flatMap(BlobStore.Service, (blobs) => blobs.list(folder)));

		await onDatabase((db) => db.delete(pod).where(eq(pod.id, podId)));

		expect(
			await onDatabase((db) => db.select().from(threadFile).where(eq(threadFile.id, written.id))),
		).toEqual([]);
		expect(
			await onDatabase((db) =>
				db.select().from(blobDeletion).where(eq(blobDeletion.prefix, folder)),
			),
		).toHaveLength(1);
		expect(await blobsUnder()).toHaveLength(1);

		await runOnPostgres(BlobDeletions.deleteQueued);

		expect(await blobsUnder()).toEqual([]);
		expect(
			await onDatabase((db) =>
				db.select().from(blobDeletion).where(eq(blobDeletion.prefix, folder)),
			),
		).toEqual([]);
	});
});
