import { MAX_FILE_CONTENT_CHARACTERS } from "@sugabots/contracts";
import { eq, like } from "drizzle-orm";
import { Effect, Layer, Stream } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedChat } from "../chats/seed.test-support.ts";
import {
	blobDeletion,
	bot,
	fileVersion,
	member,
	membership,
	message,
	projectBot,
	projectMember,
	toolCall,
	turn,
	workspace,
} from "../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../database/testing.ts";
import { asMember } from "../operations/chats/testing.ts";
import { type CallOperation, servedOperations } from "../operations/testing.ts";
import { Secrets } from "../secrets/secrets.ts";
import { ServerSettings } from "../server-settings/server-settings.ts";
import { defaultProjectOf } from "../workspaces/projects/project-reads.ts";
import { seedProject } from "../workspaces/projects/seed.test-support.ts";
import { ChatFileStore } from "./chat-file-store.ts";
import { Files } from "./files.ts";
import { FilePages } from "./pages.ts";

/** Seals as the test infrastructure's credentials do, to forge tokens in a case. */
const testCredentials = Secrets.fromKey(Buffer.alloc(32).toString("base64"));

describe.skipIf(!process.env.DATABASE_URL)("files, against Postgres", () => {
	let by: Files.BotInChat;
	let editorId: string;
	let outsiderId: string;
	let adminId: string;
	let projectId: string;
	/** A bot outside the project, working in a chat of its own. */
	let botElsewhere: Files.BotInChat;
	let call: CallOperation;

	beforeAll(async () => {
		call = await servedOperations();
	});

	/** What `memberId`, signed in, reads and deletes of the files in chats. */
	const filesAs = (memberId: string) => asMember(call, memberId).files;

	const authoring = async () => ({
		service: await runOnPostgres(Effect.provide(Files.Authoring, Files.authoringLayer)),
		/** Runs `effect`, which should fail, to its failure. */
		failureOf: <A, E>(effect: Effect.Effect<A, E>) => runOnPostgres(Effect.flip(effect)),
	});

	it("writes over a version in place, keeping its number and queueing its old content", async () => {
		const { service } = await authoring();
		const made = await runOnPostgres(
			service.create(by, { kind: "markdown", title: "Notes", content: "# One" }),
		);

		const over = await runOnPostgres(
			service.edit(by, {
				fileId: made.id,
				baseVersion: 1,
				oldText: "One",
				newText: "Two",
				inPlace: true,
			}),
		);

		expect(over).toMatchObject({ version: 1, content: "# Two" });
		expect(await runOnPostgres(service.read(by, made.id))).toMatchObject({
			version: 1,
			content: "# Two",
		});
		const queued = await onDatabase((db) =>
			db
				.select()
				.from(blobDeletion)
				.where(like(blobDeletion.prefix, `files/${made.id}/%`)),
		);
		expect(queued).toHaveLength(1);
	});

	it("keeps both of two in-place edits made at once", async () => {
		const { service } = await authoring();
		const made = await runOnPostgres(
			service.create(by, { kind: "markdown", title: "Notes", content: "# One\n\nTwo" }),
		);
		const inPlaceEdit = (oldText: string, newText: string) =>
			service.edit(by, { fileId: made.id, baseVersion: 1, oldText, newText, inPlace: true });

		await runOnPostgres(
			Effect.all([inPlaceEdit("One", "Uno"), inPlaceEdit("Two", "Dos")], { concurrency: 2 }),
		);

		expect(await runOnPostgres(service.read(by, made.id))).toMatchObject({
			version: 1,
			content: "# Uno\n\nDos",
		});
	});

	describe("pages on the content origin", () => {
		/**
		 * A server with its content origin at `contentOrigin`: what a member,
		 * signed in, is given of its pages' addresses, and what an address opens.
		 */
		const pagesAt = async (contentOrigin: string | undefined) => {
			const settings = ServerSettings.fromUrls({
				isProduction: false,
				publicUrl: "https://sugabots.example.com",
				...(contentOrigin ? { contentOrigin } : {}),
			});
			const served = await servedOperations({ serverSettings: settings });
			const pages = await runOnPostgres(
				Effect.provide(
					FilePages.Service,
					FilePages.layer.pipe(Layer.provide(Layer.succeed(ServerSettings.Service, settings))),
				),
			);
			return (memberId: string) => ({
				address: async (at: { fileId: string; version: number }) =>
					(await asMember(served, memberId).files.pageAddress(at.fileId, at.version)).url ??
					undefined,
				open: (token: string) => runOnPostgres(pages.open(token)),
			});
		};
		const aPage = async () => {
			const { service } = await authoring();
			return runOnPostgres(
				service.create(by, { kind: "html", title: "Chart", content: "<p>chart</p>" }),
			);
		};

		it("gives the project's members an address on the content origin that opens the page", async () => {
			const made = await aPage();
			const pages = (await pagesAt("https://pages.example-content.com"))(editorId);

			const address = await pages.address({ fileId: made.id, version: 1 });

			expect(address).toMatch(/^https:\/\/pages\.example-content\.com\/pages\/.+/);
			const token = address?.split("/pages/")[1] ?? "";
			expect(await pages.open(token)).toEqual({ title: "Chart", html: "<p>chart</p>" });
		});

		it("gives no address without a content origin, nor for a document", async () => {
			const made = await aPage();
			const { service } = await authoring();
			const notes = await runOnPostgres(
				service.create(by, { kind: "markdown", title: "Notes", content: "# Notes" }),
			);

			const unset = (await pagesAt(undefined))(editorId);
			const set = (await pagesAt("https://pages.example-content.com"))(editorId);

			expect(await unset.address({ fileId: made.id, version: 1 })).toBeUndefined();
			expect(await set.address({ fileId: notes.id, version: 1 })).toBeUndefined();
		});

		it("gives no address for a version the page doesn't have", async () => {
			const made = await aPage();
			const pages = (await pagesAt("https://pages.example-content.com"))(editorId);

			await expect(pages.address({ fileId: made.id, version: 2 })).rejects.toMatchObject({
				_tag: "ResourceHidden",
			});
		});

		it("hides a page from members outside its project", async () => {
			const made = await aPage();
			const pages = (await pagesAt("https://pages.example-content.com"))(outsiderId);

			await expect(pages.address({ fileId: made.id, version: 1 })).rejects.toMatchObject({
				_tag: "ResourceHidden",
			});
		});

		it("refuses a tampered or expired token, and a value sealed for something else", async () => {
			const made = await aPage();
			const pages = (await pagesAt("https://pages.example-content.com"))(editorId);
			const sealed = (expiresAt: number, purpose?: string) =>
				testCredentials.encrypt(
					JSON.stringify({ fileId: made.id, version: 1, expiresAt }),
					purpose,
				);

			const good = sealed(Date.now() + 60_000, FilePages.SECRET_PURPOSE);
			const flipped = `${good.slice(0, -4)}${good.at(-4) === "A" ? "B" : "A"}${good.slice(-3)}`;
			await expect(pages.open(flipped)).rejects.toMatchObject({
				_tag: "FilePageUnavailable",
			});
			await expect(
				pages.open(sealed(Date.now() - 1, FilePages.SECRET_PURPOSE)),
			).rejects.toMatchObject({
				_tag: "FilePageUnavailable",
			});
			await expect(pages.open(sealed(Date.now() + 60_000))).rejects.toMatchObject({
				_tag: "FilePageUnavailable",
			});
			expect(await pages.open(good)).toMatchObject({ title: "Chart" });
		});
	});

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: `Files ${stamp}`, slug: `files-${stamp}` })
				.returning(),
		);
		const [editor, outsider, admin] = await onDatabase((db) =>
			db
				.insert(member)
				.values([
					{ name: "Kim", email: `kim-${stamp}@example.com` },
					{ name: "Ola", email: `ola-${stamp}@example.com` },
					{ name: "Ada", email: `ada-${stamp}@example.com` },
				])
				.returning(),
		);
		if (!space || !editor || !outsider || !admin) throw new Error("fixture");
		const workspaceId = space.id;
		editorId = editor.id;
		outsiderId = outsider.id;
		adminId = admin.id;
		await onDatabase((db) =>
			db.insert(membership).values([
				{ workspaceId, memberId: editorId, role: "editor" },
				{ workspaceId, memberId: outsiderId, role: "editor" },
				{ workspaceId, memberId: adminId, role: "admin" },
			]),
		);
		const room = await onDatabase((db) =>
			seedProject(db, { workspaceId, name: "Planning", slug: `planning-${stamp}` }),
		);
		if (!room) throw new Error("fixture");
		projectId = room.id;
		await onDatabase((db) =>
			db.insert(projectMember).values({ workspaceId, projectId, memberId: editorId }),
		);
		const [writer, stranger] = await onDatabase((db) =>
			db
				.insert(bot)
				.values(
					["Writer", "Stranger"].map((name) => ({
						workspaceId,
						name,
						handle: `${name.toLowerCase()}-${stamp}`,
						color: "green" as const,
						eyes: "pill" as const,
						model: "claude-opus-4-1-20250805",
						createdById: editorId,
					})),
				)
				.returning(),
		);
		if (!writer || !stranger) throw new Error("fixture");
		await onDatabase((db) =>
			db.insert(projectBot).values({ workspaceId, projectId, botId: writer.id }),
		);
		const planning = await onDatabase((db) =>
			seedChat(db, {
				workspaceId,
				kind: "project_chat",
				projectId,
				title: "Planning",
				startedById: editorId,
			}),
		);
		const strangersChat = await onDatabase((db) =>
			seedChat(db, {
				workspaceId,
				kind: "project_chat",
				botId: stranger.id,
				title: "Elsewhere",
				startedById: editorId,
			}),
		);
		by = { botId: writer.id, chatId: planning.id };
		botElsewhere = { botId: stranger.id, chatId: strangersChat.id };
	});

	it("keeps every version of a document a bot writes, for members in its project to read", async () => {
		const { service } = await authoring();
		const made = await runOnPostgres(
			service.create(by, {
				kind: "markdown",
				title: "Launch plan",
				content: "# Launch plan\n\n## Goals\n\nShip.\n\n## Risks\n\nNone yet.\n",
			}),
		);
		await runOnPostgres(
			service.edit(by, {
				fileId: made.id,
				baseVersion: 1,
				oldText: "Ship.",
				newText: "Ship by Friday.",
			}),
		);

		const reader = filesAs(editorId);
		expect(await reader.get(made.id)).toMatchObject({
			version: 2,
			createdBy: { name: "Writer" },
			content: "# Launch plan\n\n## Goals\n\nShip by Friday.\n\n## Risks\n\nNone yet.\n",
		});
		expect((await reader.versions(made.id)).map((version) => version.number)).toEqual([2, 1]);
		expect(await reader.getVersion(made.id, 1)).toMatchObject({
			version: 2,
			shownVersion: { number: 1 },
			content: expect.stringContaining("Ship.\n"),
		});
	});

	it("refuses a change based on an older version, and keeps the newer one", async () => {
		const { service, failureOf } = await authoring();
		const made = await runOnPostgres(
			service.create(by, { kind: "html", title: "Chart", content: "<p>one</p>" }),
		);
		await runOnPostgres(
			service.replace(by, { fileId: made.id, baseVersion: 1, content: "<p>two</p>" }),
		);

		const stale = await failureOf(
			service.replace(by, { fileId: made.id, baseVersion: 1, content: "<p>lost</p>" }),
		);

		expect(stale).toMatchObject({ _tag: "FileStale", currentVersion: 2 });
		expect(
			await failureOf(
				service.replace(by, {
					fileId: made.id,
					baseVersion: 2,
					content: "# Doc",
					kind: "markdown",
				}),
			),
		).toMatchObject({ _tag: "FileKindFixed", kind: "html" });
		expect(await runOnPostgres(service.read(by, made.id))).toMatchObject({
			version: 2,
			content: "<p>two</p>",
		});
	});

	it("refuses an edit whose text isn't in the file exactly once", async () => {
		const { service, failureOf } = await authoring();
		const made = await runOnPostgres(
			service.create(by, { kind: "html", title: "Tiles", content: "<b>a</b><b>a</b>" }),
		);

		const edit = (oldText: string) =>
			failureOf(service.edit(by, { fileId: made.id, baseVersion: 1, oldText, newText: "b" }));

		expect(await edit("<b>a</b>")).toMatchObject({ _tag: "EditTextUnmatched", matches: 2 });
		expect(await edit("<i>")).toMatchObject({ _tag: "EditTextUnmatched", matches: 0 });
		expect(await runOnPostgres(service.read(by, made.id))).toMatchObject({ version: 1 });
	});

	it("refuses an edit that would take a file over its size limit", async () => {
		const { service, failureOf } = await authoring();
		const made = await runOnPostgres(
			service.create(by, {
				kind: "markdown",
				title: "Long",
				content: `${"x".repeat(MAX_FILE_CONTENT_CHARACTERS - 1)}!`,
			}),
		);

		expect(
			await failureOf(
				service.edit(by, { fileId: made.id, baseVersion: 1, oldText: "!", newText: "!!" }),
			),
		).toMatchObject({ _tag: "FileContentTooLarge", maxCharacters: MAX_FILE_CONTENT_CHARACTERS });
	});

	it("hides a project's files from members outside it and from bots outside it", async () => {
		const { service, failureOf } = await authoring();
		const made = await runOnPostgres(
			service.create(by, { kind: "markdown", title: "Private", content: "# Private" }),
		);

		await expect(filesAs(outsiderId).get(made.id)).rejects.toMatchObject({
			_tag: "ResourceHidden",
		});
		expect(await failureOf(service.read(botElsewhere, made.id))).toMatchObject({
			_tag: "FileNotFound",
		});
	});

	it("lets an admin delete a project's file with its versions, and refuses its members", async () => {
		const { service } = await authoring();
		const made = await runOnPostgres(
			service.create(by, { kind: "markdown", title: "Draft", content: "# One" }),
		);
		await runOnPostgres(service.replace(by, { fileId: made.id, baseVersion: 1, content: "# Two" }));
		await expect(filesAs(editorId).remove(made.id)).rejects.toMatchObject({
			_tag: "ActionForbidden",
		});
		await filesAs(adminId).remove(made.id);

		await expect(filesAs(editorId).get(made.id)).rejects.toMatchObject({
			_tag: "ResourceHidden",
		});
		expect(await filesAs(editorId).listInProject(projectId)).toEqual([]);
		const versionsLeft = await onDatabase((db) =>
			db.select().from(fileVersion).where(eq(fileVersion.fileId, made.id)),
		);
		expect(versionsLeft).toEqual([]);
	});

	it("shows the files a bot made in its chats to whoever reaches the bot, and to nobody else", async () => {
		const { service } = await authoring();
		await onDatabase((db) =>
			db.update(bot).set({ visibility: "personal" }).where(eq(bot.id, botElsewhere.botId)),
		);
		const made = await runOnPostgres(
			service.create(botElsewhere, { kind: "markdown", title: "Diary", content: "# Diary" }),
		);
		expect(await filesAs(editorId).get(made.id)).toMatchObject({ title: "Diary" });
		expect(
			(
				await filesAs(editorId).listInProject(
					await runOnPostgres(defaultProjectOf(botElsewhere.botId)),
				)
			).map(({ id }) => id),
		).toEqual([made.id]);
		for (const somebodyElse of [outsiderId, adminId]) {
			await expect(filesAs(somebodyElse).get(made.id)).rejects.toMatchObject({
				_tag: "ResourceHidden",
			});
		}
		await expect(filesAs(editorId).listInProject(projectId)).resolves.toEqual([]);
	});

	it("lists the files sent on a project's messages beside those bots wrote, and only those sent", async () => {
		const { service } = await authoring();
		const written = await runOnPostgres(
			service.create(by, { kind: "markdown", title: "Plan", content: "# Plan" }),
		);
		const files = await runOnPostgres(Effect.provide(ChatFileStore.Service, ChatFileStore.layer));
		const content = (text: string) => ({
			stream: Stream.succeed(new TextEncoder().encode(text)),
			contentType: "text/plain",
		});
		const messageIn = (
			chatId: string,
			author: { authorMemberId: string } | { authorBotId: string },
		) =>
			onDatabase((db) =>
				db
					.insert(message)
					.values({
						chatId,
						...author,
						status: "complete",
						parts: [],
						content: "",
					})
					.returning({ id: message.id }),
			).then(([row]) => row?.id ?? "");
		const upload = (name: string) =>
			runOnPostgres(
				files.upload({
					chatId: by.chatId,
					uploaderId: editorId,
					name,
					maxSize: 1024,
					maxUnsent: 5,
					content: content(name),
				}),
			);
		const sent = await upload("brief.txt");
		await upload("never-sent.txt");
		await runOnPostgres(
			files.attach({
				chatId: by.chatId,
				messageId: await messageIn(by.chatId, { authorMemberId: editorId }),
				uploaderId: editorId,
				fileIds: [sent.id],
			}),
		);
		const replyId = await messageIn(by.chatId, { authorBotId: by.botId });
		const [call] = await onDatabase((db) =>
			Effect.gen(function* () {
				const [ran] = yield* db
					.insert(turn)
					.values({
						chatId: by.chatId,
						botId: by.botId,
						triggerMessageId: replyId,
						status: "done",
						model: "test/model",
						startedAt: new Date(),
					})
					.returning({ id: turn.id });
				if (!ran) throw new Error("fixture");
				return yield* db
					.insert(toolCall)
					.values({
						chatId: by.chatId,
						messageId: replyId,
						turnId: ran.id,
						tool: "web_fetch",
						status: "completed",
						input: {},
						atOffset: 0,
					})
					.returning({ id: toolCall.id });
			}),
		);
		if (!call) throw new Error("fixture");
		await runOnPostgres(
			files.write({ chatId: by.chatId, toolCallId: call.id, content: content("a long result") }),
		);
		const attachTo = async (chatId: string, botId: string, name: string) => {
			const messageId = await messageIn(chatId, { authorBotId: botId });
			return runOnPostgres(
				files.withReplyFile(
					{
						chatId,
						messageId,
						name,
						contentType: "text/csv",
						content: new Uint8Array([1]),
					},
					(stored) => files.attachToReply(stored),
				),
			);
		};
		const chart = await attachTo(by.chatId, by.botId, "chart.csv");

		const listed = await filesAs(editorId).listInProject(projectId);

		expect(listed.map(({ id }) => id).sort()).toEqual([written.id, sent.id, chart.id].sort());
		expect(listed.find(({ id }) => id === sent.id)).toMatchObject({
			kind: "attachment",
			name: "brief.txt",
			author: "Kim",
		});
		expect(listed.find(({ id }) => id === chart.id)).toMatchObject({
			kind: "bot_attachment",
			name: "chart.csv",
			author: "Writer",
		});
		// Only a written file is read here; a sent one is read through its chat.
		await expect(filesAs(editorId).get(sent.id)).rejects.toMatchObject({
			_tag: "ResourceHidden",
		});
	});
});
