import { MAX_ATTACHMENTS_PER_MESSAGE } from "@sugabots/contracts";
import { and, eq, isNull, like } from "drizzle-orm";
import { ConfigProvider, Duration, Effect, Layer, Stream } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { askerColumns } from "../authentication/turn-facts.ts";
import { BlobStore } from "../blob-store/blob-store.ts";
import { BlobDeletions } from "../blob-store/deletions.ts";
import { anAutomationAdmin } from "../chats/automations/testing.ts";
import { seedChat } from "../chats/seed.test-support.ts";
import { transaction } from "../database/database.ts";
import {
	blob,
	blobDeletion,
	bot,
	file,
	message,
	project,
	toolCall,
	turn,
} from "../database/schema.ts";
import {
	closeDatabase,
	holdTransaction,
	onDatabase,
	type Promised,
	runOnPostgres,
	servedOnPostgres,
} from "../database/testing.ts";
import { ChatFileStore } from "./chat-file-store.ts";

describe.skipIf(!process.env.DATABASE_URL)("chat files, against Postgres", () => {
	let files: Promised<ChatFileStore.Interface>;

	beforeAll(async () => {
		files = await servedOnPostgres(ChatFileStore.Service, ChatFileStore.layer.pipe(Layer.orDie));
	});
	afterAll(closeDatabase);

	/** A chat with a bot of its own. */
	async function aChat() {
		const owner = await anAutomationAdmin();
		const created = await onDatabase((db) =>
			seedChat(db, {
				workspaceId: owner.workspaceId,
				kind: "project_chat",
				botId: owner.botId,
				title: "Files",
				startedById: owner.memberId,
			}),
		);
		return {
			chatId: created.id,
			botId: owner.botId,
			memberId: owner.memberId,
		};
	}

	/** A finished call to a tool in a turn of `botId`'s in `chatId`. */
	async function aToolCall(chatId: string, botId: string) {
		return onDatabase((db) =>
			Effect.gen(function* () {
				const [reply] = yield* db
					.insert(message)
					.values({
						chatId,
						authorBotId: botId,
						status: "complete",
						parts: [],
						content: "",
					})
					.returning({ id: message.id });
				if (!reply) throw new Error("Could not create message");
				const [ran] = yield* db
					.insert(turn)
					.values({
						chatId,
						botId,
						triggerMessageId: reply.id,
						status: "done",
						model: "test/model",
						startedAt: new Date(),
						...askerColumns({ chatId: chatId, botId: botId, triggerMessageId: reply.id }),
					})
					.returning({ id: turn.id });
				if (!ran) throw new Error("Could not create turn");
				const [call] = yield* db
					.insert(toolCall)
					.values({
						chatId,
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
		const { chatId, botId } = await aChat();

		const written = await files.write({
			chatId,
			toolCallId: await aToolCall(chatId, botId),
			content: text("héllo"),
		});
		const read = await files.read({ chatId, fileId: written.id });

		expect(written).toEqual({
			id: expect.any(String),
			contentType: "text/plain; charset=utf-8",
			size: 6,
		});
		expect(await textOf(read.stream)).toBe("héllo");
		expect(read).toMatchObject(written);
	});

	it("finds the files kept as tool calls' results by call", async () => {
		const { chatId, botId } = await aChat();
		const toolCallId = await aToolCall(chatId, botId);
		const result = await files.write({ chatId, toolCallId, content: text("long result") });

		expect(await files.resultFiles(chatId)).toEqual(new Map([[toolCallId, result.id]]));
	});

	it("reads a file only from its own chat", async () => {
		const { chatId, botId } = await aChat();
		const other = await aChat();
		const written = await files.write({
			chatId,
			toolCallId: await aToolCall(chatId, botId),
			content: text("secret"),
		});

		await expect(files.read({ chatId: other.chatId, fileId: written.id })).rejects.toBeInstanceOf(
			ChatFileStore.FileNotFound,
		);
	});

	it("finds nothing for an id that is not one", async () => {
		const { chatId } = await aChat();

		await expect(files.read({ chatId, fileId: "../etc/passwd" })).rejects.toBeInstanceOf(
			ChatFileStore.FileNotFound,
		);
	});

	it("refuses a file over CHAT_FILE_MAX_BYTES, keeping nothing", async () => {
		const capped = await servedOnPostgres(
			ChatFileStore.Service,
			ChatFileStore.layer.pipe(
				Layer.provide(
					ConfigProvider.layer(ConfigProvider.fromEnv({ env: { CHAT_FILE_MAX_BYTES: "5" } })),
				),
				Layer.orDie,
			),
		);
		const { chatId, botId } = await aChat();
		const content = {
			stream: Stream.fromIterable([new Uint8Array(3), new Uint8Array(3)]),
			contentType: "application/octet-stream",
		};

		await expect(
			capped.write({ chatId, toolCallId: await aToolCall(chatId, botId), content }),
		).rejects.toEqual(new ChatFileStore.FileTooLarge({ maxSize: 5 }));
		expect(await onDatabase((db) => db.select().from(file).where(eq(file.chatId, chatId)))).toEqual(
			[],
		);
	});

	/** A message from `memberId` in `chatId`, that files can be attached to. */
	async function aMessage(chatId: string, memberId: string) {
		const [sent] = await onDatabase((db) =>
			db
				.insert(message)
				.values({
					chatId,
					authorMemberId: memberId,
					status: "complete",
					parts: [],
					content: "",
				})
				.returning({ id: message.id }),
		);
		if (!sent) throw new Error("Could not create message");
		return sent.id;
	}

	/** Sends `fileIds`, uploaded by `memberId`, in a new message of theirs. */
	const send = async (chatId: string, memberId: string, fileIds: string[]) =>
		files.attach({
			chatId,
			messageId: await aMessage(chatId, memberId),
			uploaderId: memberId,
			fileIds,
		});

	it("attaches only the uploader's own unsent uploads, all of them or none", async () => {
		const { chatId, memberId } = await aChat();
		const other = await anAutomationAdmin();
		const upload = (uploaderId: string, name: string) =>
			files.upload({
				chatId,
				uploaderId,
				name,
				maxSize: 1024,
				maxUnsent: 20,
				content: text(name),
			});
		const mine = await upload(memberId, "mine.txt");
		const theirs = await upload(other.memberId, "theirs.txt");

		await expect(send(chatId, memberId, [mine.id, theirs.id])).rejects.toBeInstanceOf(
			ChatFileStore.UnsentAttachmentsNotFound,
		);
		// Refusing one attached none.
		await expect(files.read({ chatId, fileId: mine.id })).rejects.toBeInstanceOf(
			ChatFileStore.FileNotFound,
		);

		await expect(send(chatId, memberId, [mine.id])).resolves.toEqual([mine]);
		// Sent once, it is no longer an upload to send.
		await expect(send(chatId, memberId, [mine.id])).rejects.toBeInstanceOf(
			ChatFileStore.UnsentAttachmentsNotFound,
		);
	});

	it("keeps an upload unreadable until it is attached to a message", async () => {
		const { chatId, memberId } = await aChat();
		const uploaded = await files.upload({
			chatId,
			uploaderId: memberId,
			name: "notes.txt",
			maxSize: 1024,
			maxUnsent: 20,
			content: text("draft"),
		});

		await expect(files.read({ chatId, fileId: uploaded.id })).rejects.toBeInstanceOf(
			ChatFileStore.FileNotFound,
		);

		await send(chatId, memberId, [uploaded.id]);
		const read = await files.read({ chatId, fileId: uploaded.id });

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
		const { chatId, memberId, botId } = await aChat();
		const result = await files.write({
			chatId,
			toolCallId: await aToolCall(chatId, botId),
			content: text("long result"),
		});
		const uploaded = await files.upload({
			chatId,
			uploaderId: memberId,
			name: "notes.txt",
			maxSize: 1024,
			maxUnsent: 20,
			content: text("draft"),
		});
		const readMessageFile = (fileId: string) => files.readMessageFile({ chatId, fileId });

		await expect(readMessageFile(result.id)).rejects.toBeInstanceOf(ChatFileStore.FileNotFound);
		await expect(readMessageFile(uploaded.id)).rejects.toBeInstanceOf(ChatFileStore.FileNotFound);

		await send(chatId, memberId, [uploaded.id]);

		expect(await textOf((await readMessageFile(uploaded.id)).stream)).toBe("draft");
	});

	it("refuses an upload over its own limit, keeping nothing", async () => {
		const { chatId, memberId } = await aChat();

		await expect(
			files.upload({
				chatId,
				uploaderId: memberId,
				name: "big.bin",
				maxSize: 4,
				maxUnsent: 20,
				content: text("too long"),
			}),
		).rejects.toEqual(new ChatFileStore.FileTooLarge({ maxSize: 4 }));
		expect(await onDatabase((db) => db.select().from(file).where(eq(file.chatId, chatId)))).toEqual(
			[],
		);
	});

	it("refuses an upload past its uploader's unsent ones, counting only those", async () => {
		const { chatId, memberId } = await aChat();
		const other = await anAutomationAdmin();
		const upload = (uploaderId: string, name: string) =>
			files.upload({
				chatId,
				uploaderId,
				name,
				maxSize: 1024,
				maxUnsent: 2,
				content: text(name),
			});
		const first = await upload(memberId, "one.txt");
		await upload(memberId, "two.txt");

		await expect(upload(memberId, "three.txt")).rejects.toEqual(
			new ChatFileStore.TooManyUnsentAttachments({ maxUnsent: 2 }),
		);
		// Someone else's unsent uploads are theirs to count.
		await expect(upload(other.memberId, "theirs.txt")).resolves.toMatchObject({
			name: "theirs.txt",
		});
		// Sending one frees its place.
		await send(chatId, memberId, [first.id]);
		await expect(upload(memberId, "three.txt")).resolves.toMatchObject({ name: "three.txt" });
	});

	it("removes an unsent upload for its uploader only, and never a sent one", async () => {
		const { chatId, memberId } = await aChat();
		const other = await anAutomationAdmin();
		const upload = (name: string) =>
			files.upload({
				chatId,
				uploaderId: memberId,
				name,
				maxSize: 1024,
				maxUnsent: 20,
				content: text(name),
			});
		const removed = await upload("removed.txt");
		const kept = await upload("kept.txt");
		const sent = await upload("sent.txt");
		await send(chatId, memberId, [sent.id]);
		const rows = () =>
			onDatabase((db) => db.select({ id: file.id }).from(file).where(eq(file.chatId, chatId)));

		await files.removeUnsentAttachment({ chatId, uploaderId: other.memberId, fileId: kept.id });
		await files.removeUnsentAttachment({ chatId, uploaderId: memberId, fileId: sent.id });
		await files.removeUnsentAttachment({ chatId, uploaderId: memberId, fileId: removed.id });
		// Again, once it is gone.
		await files.removeUnsentAttachment({ chatId, uploaderId: memberId, fileId: removed.id });

		expect((await rows()).map(({ id }) => id).sort()).toEqual([kept.id, sent.id].sort());
	});

	it("deletes a removed upload's blob later when the store can't delete it at once", async () => {
		const { chatId, memberId } = await aChat();
		const deletesFailing = Layer.effect(
			BlobStore.Service,
			Effect.map(BlobStore.Service, (store) =>
				BlobStore.Service.of({
					...store,
					delete: () =>
						Effect.fail(
							new BlobStore.Unavailable({
								operation: "delete",
								provider: "postgres",
								cause: "down",
							}),
						),
				}),
			),
		);
		const flaky = await servedOnPostgres(
			ChatFileStore.Service,
			ChatFileStore.layer.pipe(Layer.provide(deletesFailing), Layer.orDie),
		);
		const upload = await flaky.upload({
			chatId,
			uploaderId: memberId,
			name: "draft.txt",
			maxSize: 1024,
			maxUnsent: 20,
			content: text("draft"),
		});

		await flaky.removeUnsentAttachment({ chatId, uploaderId: memberId, fileId: upload.id });
		const leftAtOnce = await blobKeysUnder(BlobStore.key("chats", chatId));
		await runOnPostgres(BlobDeletions.deleteQueued);

		expect(leftAtOnce).toEqual([BlobStore.key("chats", chatId, "files", upload.id)]);
		expect(await blobKeysUnder(BlobStore.key("chats", chatId))).toEqual([]);
	});

	it("deletes what a write stored when it never recorded it and the store couldn't take it back", async () => {
		const { chatId, botId } = await aChat();
		const deletesFailing = Layer.effect(
			BlobStore.Service,
			Effect.map(BlobStore.Service, (store) =>
				BlobStore.Service.of({
					...store,
					delete: () =>
						Effect.fail(
							new BlobStore.Unavailable({
								operation: "delete",
								provider: "postgres",
								cause: "down",
							}),
						),
				}),
			),
		);
		const toolCallId = await aToolCall(chatId, botId);

		const refused = await runOnPostgres(
			Effect.flatMap(ChatFileStore.Service, (service) =>
				service.write({
					chatId,
					toolCallId,
					content: text("never kept"),
					fence: Effect.fail("the turn ended"),
				}),
			).pipe(
				Effect.provide(ChatFileStore.layer.pipe(Layer.provide(deletesFailing), Layer.orDie)),
				Effect.exit,
			),
		);
		const folder = BlobStore.key("chats", chatId);
		const leftBehind = await blobKeysUnder(folder);
		await onDatabase((db) =>
			db
				.update(blobDeletion)
				.set({ dueAt: new Date(0) })
				.where(like(blobDeletion.prefix, `${folder}%`)),
		);
		await runOnPostgres(BlobDeletions.deleteQueued);

		expect(refused._tag).toBe("Failure");
		expect(leftBehind).toHaveLength(1);
		expect(await blobKeysUnder(folder)).toEqual([]);
	});

	it("forgets a removed file's queued deletion once its blob is gone, in a Postgres session of its own", async () => {
		const { chatId, memberId } = await aChat();
		let other: ReturnType<typeof holdTransaction> | undefined;
		const deletesWhileAnotherTransactionStarts = Layer.effect(
			BlobStore.Service,
			Effect.map(BlobStore.Service, (store) =>
				BlobStore.Service.of({
					...store,
					delete: (key) =>
						store.delete(key).pipe(
							// Another transaction takes the Postgres session the removing one let
							// go of, and is rolled back.
							Effect.andThen(
								Effect.promise(() => {
									other = holdTransaction(Effect.void, Effect.die("rolled back"));
									return other.held;
								}),
							),
						),
				}),
			),
		);
		const layer = ChatFileStore.layer.pipe(
			Layer.provide(deletesWhileAnotherTransactionStarts),
			Layer.orDie,
		);
		const removing = await servedOnPostgres(ChatFileStore.Service, layer);
		const upload = await removing.upload({
			chatId,
			uploaderId: memberId,
			name: "draft.txt",
			maxSize: 1024,
			maxUnsent: 20,
			content: text("draft"),
		});

		await runOnPostgres(
			Effect.flatMap(ChatFileStore.Service, (service) =>
				transaction(
					service.removeUnsentAttachment({ chatId, uploaderId: memberId, fileId: upload.id }),
				),
			).pipe(Effect.provide(layer)),
		);
		await other?.release().catch(() => undefined);

		expect(await blobKeysUnder(BlobStore.key("chats", chatId))).toEqual([]);
		expect(
			await onDatabase((db) =>
				db
					.select()
					.from(blobDeletion)
					.where(like(blobDeletion.prefix, `${BlobStore.key("chats", chatId)}%`)),
			),
		).toEqual([]);
	});

	it("removes uploads left unsent, with their blobs, and nothing else", async () => {
		const { chatId, memberId, botId } = await aChat();
		const upload = (name: string) =>
			files.upload({
				chatId,
				uploaderId: memberId,
				name,
				maxSize: 1024,
				maxUnsent: 20,
				content: text(name),
			});
		await upload("abandoned.txt");
		const sent = await upload("sent.txt");
		await send(chatId, memberId, [sent.id]);
		const result = await files.write({
			chatId,
			toolCallId: await aToolCall(chatId, botId),
			content: text("a tool's result"),
		});
		const blobsUnder = () => blobKeysUnder(BlobStore.key("chats", chatId));

		await files.removeUnsentAttachments(Duration.zero);

		const left = await onDatabase((db) =>
			db.select({ id: file.id }).from(file).where(eq(file.chatId, chatId)),
		);
		expect(left.map(({ id }) => id).sort()).toEqual([sent.id, result.id].sort());
		expect((await blobsUnder()).sort()).toEqual(
			[sent.id, result.id].map((id) => BlobStore.key("chats", chatId, "files", id)).sort(),
		);
	});

	it("attaches a bot's files to its reply in order, up to what a message carries, and removes them when it starts again", async () => {
		const { chatId, botId } = await aChat();
		const [reply] = await onDatabase((db) =>
			db
				.insert(message)
				.values({
					chatId,
					authorBotId: botId,
					status: "writing",
					parts: [],
					content: "",
				})
				.returning({ id: message.id }),
		);
		if (!reply) throw new Error("Could not create reply");
		const attach = (name: string) =>
			runOnPostgres(
				Effect.flatMap(ChatFileStore.Service, (service) =>
					service.withReplyFile(
						{
							chatId,
							messageId: reply.id,
							name,
							contentType: "text/csv",
							content: new TextEncoder().encode(name),
						},
						service.attachToReply,
					),
				).pipe(Effect.provide(ChatFileStore.layer.pipe(Layer.orDie))),
			);

		const first = await attach("first.csv");
		const second = await attach("second.csv");
		expect(await files.replyAttachments(reply.id)).toEqual([first, second]);
		expect(await textOf((await files.read({ chatId, fileId: second.id })).stream)).toBe(
			"second.csv",
		);

		for (let attached = 2; attached < MAX_ATTACHMENTS_PER_MESSAGE; attached++) {
			await attach(`more-${attached}.csv`);
		}
		await expect(attach("one-too-many.csv")).rejects.toBeInstanceOf(
			ChatFileStore.TooManyReplyFiles,
		);

		await files.removeReplyAttachments({ chatId, messageId: reply.id });
		expect(await files.replyAttachments(reply.id)).toEqual([]);
		await expect(files.read({ chatId, fileId: first.id })).rejects.toBeInstanceOf(
			ChatFileStore.FileNotFound,
		);
	});

	it("deletes a chat's blobs once a cascade has deleted the chat", async () => {
		const { chatId, botId } = await aChat();
		const written = await files.write({
			chatId,
			toolCallId: await aToolCall(chatId, botId),
			content: text("kept until the bot goes"),
		});
		const folder = BlobStore.key("chats", chatId);
		const blobsUnder = () => blobKeysUnder(folder);

		// It leads a project members made, which goes first, as the bot can't be deleted while it leads one.
		await onDatabase((db) =>
			db.delete(project).where(and(eq(project.leadBotId, botId), isNull(project.defaultOfBotId))),
		);
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

/** The keys of the blobs stored under `prefix`, read from the store's table. */
async function blobKeysUnder(prefix: BlobStore.Key) {
	const rows = await onDatabase((db) =>
		db
			.select({ key: blob.key })
			.from(blob)
			.where(like(blob.key, `${prefix}/%`)),
	);
	return rows.map(({ key }) => key);
}
