import { MAX_ATTACHMENTS_PER_MESSAGE } from "@sugabots/contracts";
import { and, eq, isNull } from "drizzle-orm";
import { ConfigProvider, Duration, Effect, Layer, Stream } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BlobStore } from "../blob-store/blob-store.ts";
import { BlobDeletions } from "../blob-store/deletions.ts";
import { anAutomationOwner } from "../chats/automations/testing.ts";
import { seedChat } from "../chats/seed.test-support.ts";
import { blobDeletion, bot, file, message, project, toolCall, turn } from "../database/schema.ts";
import {
	closeDatabase,
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
		const owner = await anAutomationOwner();
		const created = await onDatabase((db) =>
			seedChat(db, {
				workspaceId: owner.workspaceId,
				kind: "project_chat",
				botId: owner.botId,
				title: "Files",
				startedById: owner.personId,
			}),
		);
		return {
			chatId: created.id,
			botId: owner.botId,
			personId: owner.personId,
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
						chatId,
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
		const { chatId } = await aChat();

		const written = await files.write({ chatId, content: text("héllo") });
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
		await files.write({ chatId, content: text("not a result") });

		expect(await files.resultFiles(chatId)).toEqual(new Map([[toolCallId, result.id]]));
	});

	it("reads a file only from its own chat", async () => {
		const { chatId } = await aChat();
		const other = await aChat();
		const written = await files.write({ chatId, content: text("secret") });

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
		const { chatId } = await aChat();
		const content = {
			stream: Stream.fromIterable([new Uint8Array(3), new Uint8Array(3)]),
			contentType: "application/octet-stream",
		};

		await expect(capped.write({ chatId, content })).rejects.toEqual(
			new ChatFileStore.FileTooLarge({ maxSize: 5 }),
		);
		expect(await onDatabase((db) => db.select().from(file).where(eq(file.chatId, chatId)))).toEqual(
			[],
		);
	});

	/** A message from `personId` in `chatId`, that files can be attached to. */
	async function aMessage(chatId: string, personId: string) {
		const [sent] = await onDatabase((db) =>
			db
				.insert(message)
				.values({
					chatId,
					authorPersonId: personId,
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

	/** Sends `fileIds`, uploaded by `personId`, in a new message of theirs. */
	const send = async (chatId: string, personId: string, fileIds: string[]) =>
		files.attach({
			chatId,
			messageId: await aMessage(chatId, personId),
			uploaderId: personId,
			fileIds,
		});

	it("attaches only the uploader's own unsent uploads, all of them or none", async () => {
		const { chatId, personId } = await aChat();
		const other = await anAutomationOwner();
		const upload = (uploaderId: string, name: string) =>
			files.upload({
				chatId,
				uploaderId,
				name,
				maxSize: 1024,
				maxUnsent: 20,
				content: text(name),
			});
		const mine = await upload(personId, "mine.txt");
		const theirs = await upload(other.personId, "theirs.txt");

		await expect(send(chatId, personId, [mine.id, theirs.id])).rejects.toBeInstanceOf(
			ChatFileStore.UploadsNotFound,
		);
		// Refusing one attached none.
		await expect(files.read({ chatId, fileId: mine.id })).rejects.toBeInstanceOf(
			ChatFileStore.FileNotFound,
		);

		await expect(send(chatId, personId, [mine.id])).resolves.toEqual([mine]);
		// Sent once, it is no longer an upload to send.
		await expect(send(chatId, personId, [mine.id])).rejects.toBeInstanceOf(
			ChatFileStore.UploadsNotFound,
		);
	});

	it("keeps an upload unreadable until it is attached to a message", async () => {
		const { chatId, personId } = await aChat();
		const uploaded = await files.upload({
			chatId,
			uploaderId: personId,
			name: "notes.txt",
			maxSize: 1024,
			maxUnsent: 20,
			content: text("draft"),
		});

		await expect(files.read({ chatId, fileId: uploaded.id })).rejects.toBeInstanceOf(
			ChatFileStore.FileNotFound,
		);

		await send(chatId, personId, [uploaded.id]);
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
		const { chatId, personId } = await aChat();
		const result = await files.write({ chatId, content: text("long result") });
		const uploaded = await files.upload({
			chatId,
			uploaderId: personId,
			name: "notes.txt",
			maxSize: 1024,
			maxUnsent: 20,
			content: text("draft"),
		});
		const readMessageFile = (fileId: string) => files.readMessageFile({ chatId, fileId });

		await expect(readMessageFile(result.id)).rejects.toBeInstanceOf(ChatFileStore.FileNotFound);
		await expect(readMessageFile(uploaded.id)).rejects.toBeInstanceOf(ChatFileStore.FileNotFound);

		await send(chatId, personId, [uploaded.id]);

		expect(await textOf((await readMessageFile(uploaded.id)).stream)).toBe("draft");
	});

	it("refuses an upload over its own limit, keeping nothing", async () => {
		const { chatId, personId } = await aChat();

		await expect(
			files.upload({
				chatId,
				uploaderId: personId,
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
		const { chatId, personId } = await aChat();
		const other = await anAutomationOwner();
		const upload = (uploaderId: string, name: string) =>
			files.upload({
				chatId,
				uploaderId,
				name,
				maxSize: 1024,
				maxUnsent: 2,
				content: text(name),
			});
		const first = await upload(personId, "one.txt");
		await upload(personId, "two.txt");

		await expect(upload(personId, "three.txt")).rejects.toEqual(
			new ChatFileStore.TooManyUnsentUploads({ maxUnsent: 2 }),
		);
		// Someone else's unsent uploads are theirs to count.
		await expect(upload(other.personId, "theirs.txt")).resolves.toMatchObject({
			name: "theirs.txt",
		});
		// Sending one frees its place.
		await send(chatId, personId, [first.id]);
		await expect(upload(personId, "three.txt")).resolves.toMatchObject({ name: "three.txt" });
	});

	it("removes an unsent upload for its uploader only, and never a sent one", async () => {
		const { chatId, personId } = await aChat();
		const other = await anAutomationOwner();
		const upload = (name: string) =>
			files.upload({
				chatId,
				uploaderId: personId,
				name,
				maxSize: 1024,
				maxUnsent: 20,
				content: text(name),
			});
		const removed = await upload("removed.txt");
		const kept = await upload("kept.txt");
		const sent = await upload("sent.txt");
		await send(chatId, personId, [sent.id]);
		const rows = () =>
			onDatabase((db) => db.select({ id: file.id }).from(file).where(eq(file.chatId, chatId)));

		await files.removeUnsentUpload({ chatId, uploaderId: other.personId, fileId: kept.id });
		await files.removeUnsentUpload({ chatId, uploaderId: personId, fileId: sent.id });
		await files.removeUnsentUpload({ chatId, uploaderId: personId, fileId: removed.id });
		// Again, once it is gone.
		await files.removeUnsentUpload({ chatId, uploaderId: personId, fileId: removed.id });

		expect((await rows()).map(({ id }) => id).sort()).toEqual([kept.id, sent.id].sort());
	});

	it("removes uploads left unsent, with their blobs, and nothing else", async () => {
		const { chatId, personId } = await aChat();
		const upload = (name: string) =>
			files.upload({
				chatId,
				uploaderId: personId,
				name,
				maxSize: 1024,
				maxUnsent: 20,
				content: text(name),
			});
		await upload("abandoned.txt");
		const sent = await upload("sent.txt");
		await send(chatId, personId, [sent.id]);
		const result = await files.write({ chatId, content: text("a tool's result") });
		const blobsUnder = () =>
			runOnPostgres(
				Effect.flatMap(BlobStore.Service, (blobs) => blobs.list(BlobStore.key("chats", chatId))),
			);

		await files.removeUnsentUploads(Duration.zero);

		const left = await onDatabase((db) =>
			db.select({ id: file.id }).from(file).where(eq(file.chatId, chatId)),
		);
		expect(left.map(({ id }) => id).sort()).toEqual([sent.id, result.id].sort());
		expect((await blobsUnder()).map(({ key }) => key).sort()).toEqual(
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
					kind: "text",
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
		const written = await files.write({ chatId, content: text("kept until the bot goes") });
		const folder = BlobStore.key("chats", chatId);
		const blobsUnder = () =>
			runOnPostgres(Effect.flatMap(BlobStore.Service, (blobs) => blobs.list(folder)));

		// It leads a project people made, which goes first, as the bot can't be deleted while it leads one.
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
