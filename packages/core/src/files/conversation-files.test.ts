import { MAX_ATTACHMENTS_PER_MESSAGE } from "@sugabots/contracts";
import { eq } from "drizzle-orm";
import { ConfigProvider, Duration, Effect, Layer, Stream } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BlobStore } from "../blob-store/blob-store.ts";
import { BlobDeletions } from "../blob-store/deletions.ts";
import { anAutomationOwner } from "../conversations/automations/testing.ts";
import { seedConversation } from "../conversations/seed.test-support.ts";
import { blobDeletion, bot, file, message, toolCall, turn } from "../database/schema.ts";
import {
	closeDatabase,
	onDatabase,
	type Promised,
	runOnPostgres,
	servedOnPostgres,
} from "../database/testing.ts";
import { ConversationFiles } from "./conversation-files.ts";

describe.skipIf(!process.env.DATABASE_URL)("conversation files, against Postgres", () => {
	let files: Promised<ConversationFiles.Interface>;

	beforeAll(async () => {
		files = await servedOnPostgres(
			ConversationFiles.Service,
			ConversationFiles.layer.pipe(Layer.orDie),
		);
	});
	afterAll(closeDatabase);

	/** A thread with a bot of its own. */
	async function aThread() {
		const owner = await anAutomationOwner();
		const created = await onDatabase((db) =>
			seedConversation(db, {
				workspaceId: owner.workspaceId,
				kind: "project_thread",
				botId: owner.botId,
				title: "Files",
			}),
		);
		return {
			conversationId: created.id,
			botId: owner.botId,
			userId: owner.userId,
		};
	}

	/** A finished call to a tool in a turn of `botId`'s in `conversationId`. */
	async function aToolCall(conversationId: string, botId: string) {
		return onDatabase((db) =>
			Effect.gen(function* () {
				const [reply] = yield* db
					.insert(message)
					.values({
						conversationId: conversationId,
						authorBotId: botId,
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
						conversationId: conversationId,
						botId,
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
						conversationId: conversationId,
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
		const { conversationId } = await aThread();

		const written = await files.write({ conversationId, content: text("héllo") });
		const read = await files.read({ conversationId, fileId: written.id });

		expect(written).toEqual({
			id: expect.any(String),
			contentType: "text/plain; charset=utf-8",
			size: 6,
		});
		expect(await textOf(read.stream)).toBe("héllo");
		expect(read).toMatchObject(written);
	});

	it("finds the files kept as tool calls' results by call", async () => {
		const { conversationId, botId } = await aThread();
		const toolCallId = await aToolCall(conversationId, botId);
		const result = await files.write({ conversationId, toolCallId, content: text("long result") });
		await files.write({ conversationId, content: text("not a result") });

		expect(await files.resultFiles(conversationId)).toEqual(new Map([[toolCallId, result.id]]));
	});

	it("reads a file only from its own conversation", async () => {
		const { conversationId } = await aThread();
		const other = await aThread();
		const written = await files.write({ conversationId, content: text("secret") });

		await expect(
			files.read({ conversationId: other.conversationId, fileId: written.id }),
		).rejects.toBeInstanceOf(ConversationFiles.FileNotFound);
	});

	it("finds nothing for an id that is not one", async () => {
		const { conversationId } = await aThread();

		await expect(files.read({ conversationId, fileId: "../etc/passwd" })).rejects.toBeInstanceOf(
			ConversationFiles.FileNotFound,
		);
	});

	it("refuses a file over THREAD_FILE_MAX_BYTES, keeping nothing", async () => {
		const capped = await servedOnPostgres(
			ConversationFiles.Service,
			ConversationFiles.layer.pipe(
				Layer.provide(
					ConfigProvider.layer(ConfigProvider.fromEnv({ env: { THREAD_FILE_MAX_BYTES: "5" } })),
				),
				Layer.orDie,
			),
		);
		const { conversationId } = await aThread();
		const content = {
			stream: Stream.fromIterable([new Uint8Array(3), new Uint8Array(3)]),
			contentType: "application/octet-stream",
		};

		await expect(capped.write({ conversationId, content })).rejects.toEqual(
			new ConversationFiles.FileTooLarge({ maxSize: 5 }),
		);
		expect(
			await onDatabase((db) =>
				db.select().from(file).where(eq(file.conversationId, conversationId)),
			),
		).toEqual([]);
	});

	/** A message from `userId` in `conversationId`, that files can be attached to. */
	async function aMessage(conversationId: string, userId: string) {
		const [sent] = await onDatabase((db) =>
			db
				.insert(message)
				.values({
					conversationId: conversationId,
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
	const send = async (conversationId: string, userId: string, fileIds: string[]) =>
		files.attach({
			conversationId,
			messageId: await aMessage(conversationId, userId),
			uploaderId: userId,
			fileIds,
		});

	it("attaches only the uploader's own unsent uploads, all of them or none", async () => {
		const { conversationId, userId } = await aThread();
		const other = await anAutomationOwner();
		const upload = (uploaderId: string, name: string) =>
			files.upload({
				conversationId,
				uploaderId,
				name,
				maxSize: 1024,
				maxUnsent: 20,
				content: text(name),
			});
		const mine = await upload(userId, "mine.txt");
		const theirs = await upload(other.userId, "theirs.txt");

		await expect(send(conversationId, userId, [mine.id, theirs.id])).rejects.toBeInstanceOf(
			ConversationFiles.UploadsNotFound,
		);
		// Refusing one attached none.
		await expect(files.read({ conversationId, fileId: mine.id })).rejects.toBeInstanceOf(
			ConversationFiles.FileNotFound,
		);

		await expect(send(conversationId, userId, [mine.id])).resolves.toEqual([mine]);
		// Sent once, it is no longer an upload to send.
		await expect(send(conversationId, userId, [mine.id])).rejects.toBeInstanceOf(
			ConversationFiles.UploadsNotFound,
		);
	});

	it("keeps an upload unreadable until it is attached to a message", async () => {
		const { conversationId, userId } = await aThread();
		const uploaded = await files.upload({
			conversationId,
			uploaderId: userId,
			name: "notes.txt",
			maxSize: 1024,
			maxUnsent: 20,
			content: text("draft"),
		});

		await expect(files.read({ conversationId, fileId: uploaded.id })).rejects.toBeInstanceOf(
			ConversationFiles.FileNotFound,
		);

		await send(conversationId, userId, [uploaded.id]);
		const read = await files.read({ conversationId, fileId: uploaded.id });

		expect(uploaded).toEqual({
			id: expect.any(String),
			name: "notes.txt",
			contentType: "text/plain; charset=utf-8",
			size: 5,
		});
		expect(read).toMatchObject({ name: "notes.txt", size: 5 });
		expect(await textOf(read.stream)).toBe("draft");
	});

	it("reads as a message's file only one attached to a message", async () => {
		const { conversationId, userId } = await aThread();
		const result = await files.write({ conversationId, content: text("long result") });
		const uploaded = await files.upload({
			conversationId,
			uploaderId: userId,
			name: "notes.txt",
			maxSize: 1024,
			maxUnsent: 20,
			content: text("draft"),
		});
		const readMessageFile = (fileId: string) => files.readMessageFile({ conversationId, fileId });

		await expect(readMessageFile(result.id)).rejects.toBeInstanceOf(ConversationFiles.FileNotFound);
		await expect(readMessageFile(uploaded.id)).rejects.toBeInstanceOf(
			ConversationFiles.FileNotFound,
		);

		await send(conversationId, userId, [uploaded.id]);

		expect(await textOf((await readMessageFile(uploaded.id)).stream)).toBe("draft");
	});

	it("refuses an upload over its own limit, keeping nothing", async () => {
		const { conversationId, userId } = await aThread();

		await expect(
			files.upload({
				conversationId,
				uploaderId: userId,
				name: "big.bin",
				maxSize: 4,
				maxUnsent: 20,
				content: text("too long"),
			}),
		).rejects.toEqual(new ConversationFiles.FileTooLarge({ maxSize: 4 }));
		expect(
			await onDatabase((db) =>
				db.select().from(file).where(eq(file.conversationId, conversationId)),
			),
		).toEqual([]);
	});

	it("refuses an upload past its uploader's unsent ones, counting only those", async () => {
		const { conversationId, userId } = await aThread();
		const other = await anAutomationOwner();
		const upload = (uploaderId: string, name: string) =>
			files.upload({
				conversationId,
				uploaderId,
				name,
				maxSize: 1024,
				maxUnsent: 2,
				content: text(name),
			});
		const first = await upload(userId, "one.txt");
		await upload(userId, "two.txt");

		await expect(upload(userId, "three.txt")).rejects.toEqual(
			new ConversationFiles.TooManyUnsentUploads({ maxUnsent: 2 }),
		);
		// Someone else's unsent uploads are theirs to count.
		await expect(upload(other.userId, "theirs.txt")).resolves.toMatchObject({ name: "theirs.txt" });
		// Sending one frees its place.
		await send(conversationId, userId, [first.id]);
		await expect(upload(userId, "three.txt")).resolves.toMatchObject({ name: "three.txt" });
	});

	it("removes an unsent upload for its uploader only, and never a sent one", async () => {
		const { conversationId, userId } = await aThread();
		const other = await anAutomationOwner();
		const upload = (name: string) =>
			files.upload({
				conversationId,
				uploaderId: userId,
				name,
				maxSize: 1024,
				maxUnsent: 20,
				content: text(name),
			});
		const removed = await upload("removed.txt");
		const kept = await upload("kept.txt");
		const sent = await upload("sent.txt");
		await send(conversationId, userId, [sent.id]);
		const rows = () =>
			onDatabase((db) =>
				db.select({ id: file.id }).from(file).where(eq(file.conversationId, conversationId)),
			);

		await files.removeUnsentUpload({ conversationId, uploaderId: other.userId, fileId: kept.id });
		await files.removeUnsentUpload({ conversationId, uploaderId: userId, fileId: sent.id });
		await files.removeUnsentUpload({ conversationId, uploaderId: userId, fileId: removed.id });
		// Again, once it is gone.
		await files.removeUnsentUpload({ conversationId, uploaderId: userId, fileId: removed.id });

		expect((await rows()).map(({ id }) => id).sort()).toEqual([kept.id, sent.id].sort());
	});

	it("removes uploads left unsent, with their blobs, and nothing else", async () => {
		const { conversationId, userId } = await aThread();
		const upload = (name: string) =>
			files.upload({
				conversationId,
				uploaderId: userId,
				name,
				maxSize: 1024,
				maxUnsent: 20,
				content: text(name),
			});
		await upload("abandoned.txt");
		const sent = await upload("sent.txt");
		await send(conversationId, userId, [sent.id]);
		const result = await files.write({ conversationId, content: text("a tool's result") });
		const blobsUnder = () =>
			runOnPostgres(
				Effect.flatMap(BlobStore.Service, (blobs) =>
					blobs.list(BlobStore.key("threads", conversationId)),
				),
			);

		await files.removeUnsentUploads(Duration.zero);

		const left = await onDatabase((db) =>
			db.select({ id: file.id }).from(file).where(eq(file.conversationId, conversationId)),
		);
		expect(left.map(({ id }) => id).sort()).toEqual([sent.id, result.id].sort());
		expect((await blobsUnder()).map(({ key }) => key).sort()).toEqual(
			[sent.id, result.id]
				.map((id) => BlobStore.key("threads", conversationId, "files", id))
				.sort(),
		);
	});

	it("attaches a bot's files to its reply in order, up to what a message carries, and removes them when it starts again", async () => {
		const { conversationId, botId } = await aThread();
		const [reply] = await onDatabase((db) =>
			db
				.insert(message)
				.values({
					conversationId: conversationId,
					authorBotId: botId,
					kind: "text",
					status: "streaming",
					parts: [],
					content: "",
				})
				.returning({ id: message.id }),
		);
		if (!reply) throw new Error("Could not create reply");
		const attach = (name: string) =>
			runOnPostgres(
				Effect.flatMap(ConversationFiles.Service, (service) =>
					service.withReplyFile(
						{
							conversationId,
							messageId: reply.id,
							name,
							contentType: "text/csv",
							content: new TextEncoder().encode(name),
						},
						service.attachToReply,
					),
				).pipe(Effect.provide(ConversationFiles.layer.pipe(Layer.orDie))),
			);

		const first = await attach("first.csv");
		const second = await attach("second.csv");
		expect(await files.replyAttachments(reply.id)).toEqual([first, second]);
		expect(await textOf((await files.read({ conversationId, fileId: second.id })).stream)).toBe(
			"second.csv",
		);

		for (let attached = 2; attached < MAX_ATTACHMENTS_PER_MESSAGE; attached++) {
			await attach(`more-${attached}.csv`);
		}
		await expect(attach("one-too-many.csv")).rejects.toBeInstanceOf(
			ConversationFiles.TooManyReplyFiles,
		);

		await files.removeReplyAttachments({ conversationId, messageId: reply.id });
		expect(await files.replyAttachments(reply.id)).toEqual([]);
		await expect(files.read({ conversationId, fileId: first.id })).rejects.toBeInstanceOf(
			ConversationFiles.FileNotFound,
		);
	});

	it("deletes a conversation's blobs once a cascade has deleted the conversation", async () => {
		const { conversationId, botId } = await aThread();
		const written = await files.write({ conversationId, content: text("kept until the bot goes") });
		const folder = BlobStore.key("threads", conversationId);
		const blobsUnder = () =>
			runOnPostgres(Effect.flatMap(BlobStore.Service, (blobs) => blobs.list(folder)));

		await onDatabase((db) => db.delete(bot).where(eq(bot.id, botId)));

		expect(await onDatabase((db) => db.select().from(file).where(eq(file.id, written.id)))).toEqual(
			[],
		);
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
