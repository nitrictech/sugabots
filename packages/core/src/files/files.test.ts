import { MAX_FILE_CONTENT_CHARACTERS } from "@sugabots/contracts";
import { ApprovalRefused } from "@sugabots/contracts/errors/proofs";
import type { InputOf } from "@sugabots/contracts/operations";
import { eq, inArray, like } from "drizzle-orm";
import { Effect, Layer, Stream } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PageAuthentication } from "../authentication/page.ts";
import { seedMessage, seedTurnAnswering } from "../authentication/seed.test-support.ts";
import { TurnAuthentication } from "../authentication/turn.ts";
import { askerColumns } from "../authentication/turn-facts.ts";
import { BlobStore } from "../blob-store/blob-store.ts";
import { BlobDeletions } from "../blob-store/deletions.ts";
import { seedChat } from "../chats/seed.test-support.ts";
import { query } from "../database/database.ts";
import {
	blob,
	blobDeletion,
	bot,
	file,
	fileVersion,
	message,
	projectBot,
	projectMember,
	toolCall,
	turn,
	workspace,
} from "../database/schema.ts";
import {
	closeDatabase,
	holdTransaction,
	onDatabase,
	runOnPostgres,
	waitUntilWaitingOnLocks,
} from "../database/testing.ts";
import { createWorkspaceFixture } from "../database/workspace.test-support.ts";
import { asMember } from "../operations/chats/testing.ts";
import type { Operations } from "../operations/registry.ts";
import { type CallOperation, operationsForTests, servedOperations } from "../operations/testing.ts";
import { Secrets } from "../secrets/secrets.ts";
import { ServerSettings } from "../server-settings/server-settings.ts";
import { defaultProjectOf } from "../workspaces/projects/project-reads.ts";
import { ChatFileStore } from "./chat-file-store.ts";
import { Files } from "./files.ts";
import { FilePages } from "./pages.ts";

/** Seals as the test infrastructure's credentials do, to forge tokens in a case. */
const testCredentials = Secrets.fromKey(Buffer.alloc(32).toString("base64"));

describe.skipIf(!process.env.DATABASE_URL)("files, against Postgres", () => {
	let by: { chatId: string; botId: string };
	let editorId: string;
	let outsiderId: string;
	let adminId: string;
	let projectId: string;
	/** A bot outside the project, working in a chat of its own. */
	let botElsewhere: { chatId: string; botId: string };
	let call: CallOperation;
	let operations: Operations.Interface;
	let turnId: string;
	let replyId: string;

	beforeAll(async () => {
		call = await servedOperations();
		operations = await operationsForTests();
	});

	/** What `memberId`, signed in, reads and deletes of the files in chats. */
	const filesAs = (memberId: string) => asMember(call, memberId).files;

	const seed = (input: Parameters<typeof Files.seedWrittenFile>[1], writer = by) =>
		runOnPostgres(Files.seedWrittenFile(writer, input));

	const authenticate = (id: string) =>
		runOnPostgres(
			TurnAuthentication.Service.use((auth) => auth.authenticate(id)).pipe(
				Effect.provide(TurnAuthentication.layer),
			),
		);

	const allowedChange = async <Name extends "files.write" | "files.edit">(
		name: Name,
		input: InputOf<Name>,
	) => {
		const [row] = await onDatabase((db) =>
			db
				.insert(toolCall)
				.values({
					chatId: by.chatId,
					messageId: replyId,
					turnId,
					tool: name === "files.write" ? "file_write" : "file_edit",
					input,
					executionInput: input,
					status: "awaiting_approval",
					approvalStatus: "allowed",
					decidedById: editorId,
					atOffset: 0,
				})
				.returning({ id: toolCall.id }),
		);
		if (!row) throw new Error("Missing approved call");
		const principal = await authenticate(turnId);
		return (execution = principal) =>
			runOnPostgres(operations[name](execution, input, { kind: "toolCall", toolCall: row.id }));
	};

	it.each(["create", "replace", "edit"] as const)(
		"fences a %s in a superseded execution",
		async (change) => {
			const made = await seed({ kind: "markdown", title: "Notes", content: "# One" });
			const write = await (change === "edit"
				? allowedChange("files.edit", {
						fileId: made.id,
						baseVersion: 1,
						oldText: "One",
						newText: "Two",
					})
				: allowedChange(
						"files.write",
						change === "create"
							? { kind: "markdown", title: "New file", content: "# Two" }
							: { fileId: made.id, baseVersion: 1, content: "# Two" },
					));
			await authenticate(turnId);
			await expect(write()).rejects.toMatchObject({ _tag: "TurnExecutionSuperseded" });
			expect(await filesAs(editorId).listInProject(projectId)).toMatchObject([
				{ id: made.id, version: 1 },
			]);
			expect(await filesAs(editorId).versions(made.id)).toHaveLength(1);
		},
	);

	it.each(["create", "replace", "edit"] as const)(
		"returns the original receipt when an approved %s is replayed",
		async (change) => {
			const made =
				change === "create"
					? undefined
					: await seed({
							kind: "markdown",
							title: "Notes",
							content: "# One",
						});
			const write =
				made === undefined
					? await allowedChange("files.write", {
							kind: "markdown",
							title: "Notes",
							content: "# Two",
						})
					: change === "edit"
						? await allowedChange("files.edit", {
								fileId: made.id,
								baseVersion: 1,
								oldText: "One",
								newText: "Two",
							})
						: await allowedChange("files.write", {
								fileId: made.id,
								baseVersion: 1,
								content: "# Two",
							});
			const [first, duplicate] = await Promise.all([write(), write()]);
			expect(first).toMatchObject({ status: "written", title: "Notes", version: made ? 2 : 1 });
			expect(duplicate).toEqual(first);

			const later = await allowedChange("files.write", {
				fileId: first.fileId,
				baseVersion: first.version,
				title: "Renamed",
				content: "# Later",
			});
			await later();
			expect(await write(await authenticate(turnId))).toEqual(first);
			const files = filesAs(editorId);
			expect(await files.listInProject(projectId)).toMatchObject([
				{ id: first.fileId, title: "Renamed", version: first.version + 1 },
			]);
			expect(await files.versions(first.fileId)).toHaveLength(first.version + 1);
			expect(await files.getVersion(first.fileId, first.version)).toMatchObject({
				content: "# Two",
			});
		},
	);

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
				Effect.provide(PageAuthentication.Service, PageAuthentication.layer),
			);
			return (memberId: string) => ({
				address: async (at: { fileId: string; version: number }) =>
					(await asMember(served, memberId).files.pageAddress(at.fileId, at.version)).url ??
					undefined,
				open: async (token: string, fileId?: string) => {
					const principal = await runOnPostgres(pages.open(token));
					return served(principal, "files.servePage", { fileId: fileId ?? principal.file });
				},
			});
		};
		const aPage = () => seed({ kind: "html", title: "Chart", content: "<p>chart</p>" });

		it("gives the project's members an address on the content origin that opens the page", async () => {
			const made = await aPage();
			const pages = (await pagesAt("https://pages.example-content.com"))(editorId);

			const address = await pages.address({ fileId: made.id, version: 1 });

			expect(address).toMatch(/^https:\/\/pages\.example-content\.com\/pages\/.+/);
			const token = address?.split("/pages/")[1] ?? "";
			expect(await pages.open(token)).toEqual({ title: "Chart", html: "<p>chart</p>" });
			const another = await seed({ kind: "html", title: "Notes", content: "<p>notes</p>" });
			await expect(pages.open(token, another.id)).rejects.toMatchObject({
				_tag: "ResourceHidden",
				resource: "file",
			});
		});

		it("gives no address without a content origin, nor for a document", async () => {
			const made = await aPage();
			const notes = await seed({ kind: "markdown", title: "Notes", content: "# Notes" });

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
				_tag: "PageAddressUnavailable",
			});
			await expect(
				pages.open(sealed(Date.now() - 1, FilePages.SECRET_PURPOSE)),
			).rejects.toMatchObject({
				_tag: "PageAddressUnavailable",
			});
			await expect(pages.open(sealed(Date.now() + 60_000))).rejects.toMatchObject({
				_tag: "PageAddressUnavailable",
			});
			expect(await pages.open(good)).toMatchObject({ title: "Chart" });
		});
	});

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const {
			workspace: space,
			members: { editor, outsider, admin },
			project: room,
		} = await createWorkspaceFixture(
			{ name: `Files ${stamp}`, slug: `files-${stamp}` },
			{
				editor: { name: "Kim", email: `kim-${stamp}@example.com`, role: "editor" },
				outsider: { name: "Ola", email: `ola-${stamp}@example.com`, role: "editor" },
				admin: { name: "Ada", email: `ada-${stamp}@example.com`, role: "admin" },
			},
			() => ({ project: { name: "Planning", slug: `planning-${stamp}` } }),
		);
		const workspaceId = space.id;
		editorId = editor.id;
		outsiderId = outsider.id;
		adminId = admin.id;
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
		turnId = await seedTurnAnswering(by.chatId, by.botId, { member: editorId });
		replyId = await seedMessage(by.chatId, { bot: by.botId, turn: turnId });
	});

	it("keeps every version of a document a bot writes, for members in its project to read", async () => {
		const made = await seed({
			kind: "markdown",
			title: "Launch plan",
			content: "# Launch plan\n\n## Goals\n\nShip.\n\n## Risks\n\nNone yet.\n",
		});
		const edit = await allowedChange("files.edit", {
			fileId: made.id,
			baseVersion: 1,
			oldText: "Ship.",
			newText: "Ship by Friday.",
		});
		await edit();

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

	it("replaces, edits, and reads a file using its uppercase id", async () => {
		const made = await seed({ kind: "markdown", title: "Notes", content: "# One" });
		const fileId = made.id.toUpperCase();
		const replace = await allowedChange("files.write", {
			fileId,
			baseVersion: 1,
			content: "# Two",
		});
		expect(await replace()).toMatchObject({ fileId: made.id, version: 2 });

		const edit = await allowedChange("files.edit", {
			fileId,
			baseVersion: 2,
			oldText: "Two",
			newText: "Three",
		});
		expect(await edit()).toMatchObject({ fileId: made.id, version: 3 });

		const files = filesAs(editorId);
		expect(await files.get(fileId)).toMatchObject({ id: made.id, content: "# Three" });
		expect(await files.getVersion(fileId, 2)).toMatchObject({ content: "# Two" });
		const principal = await authenticate(turnId);
		expect(await call(principal, "files.readWritten", { fileId })).toMatchObject({
			fileId: made.id,
			content: "# Three",
			version: 3,
		});
	});

	/** Switches the writing bot's built-in tools `tools` off. */
	const switchOff = (...tools: string[]) =>
		query((db) => db.update(bot).set({ disabledTools: tools }).where(eq(bot.id, by.botId)));

	it("refuses its file tools to a bot once they are switched off, though the step offered them", async () => {
		const made = await seed({ kind: "markdown", title: "Notes", content: "# One" });
		const principal = await authenticate(turnId);
		const edit = await allowedChange("files.edit", {
			fileId: made.id,
			baseVersion: 1,
			oldText: "One",
			newText: "Two",
		});

		await runOnPostgres(switchOff("file_list", "file_read", "file_edit"));

		await expect(call(principal, "files.listWritten", {})).rejects.toBeInstanceOf(ApprovalRefused);
		await expect(call(principal, "files.readWritten", { fileId: made.id })).rejects.toBeInstanceOf(
			ApprovalRefused,
		);
		await expect(edit()).rejects.toBeInstanceOf(ApprovalRefused);
		expect(await filesAs(editorId).get(made.id)).toMatchObject({ version: 1, content: "# One" });
	});

	it("writes nothing for a call whose tool is switched off while it waits to write", async () => {
		const made = await seed({ kind: "markdown", title: "Notes", content: "# One" });
		const edit = await allowedChange("files.edit", {
			fileId: made.id,
			baseVersion: 1,
			oldText: "One",
			newText: "Two",
		});
		// Holds the workspace's lock, as a change to who reaches what does, so
		// the write waits at its fence, and switches the tool off meanwhile.
		const switching = holdTransaction(
			Effect.andThen(
				query((db) =>
					db
						.select({ id: workspace.id })
						.from(workspace)
						.innerJoin(bot, eq(bot.workspaceId, workspace.id))
						.where(eq(bot.id, by.botId))
						.for("no key update", { of: workspace }),
				),
				switchOff("file_edit"),
			),
		);
		await switching.held;

		const editing = edit();
		await waitUntilWaitingOnLocks(1);
		await switching.release();

		await expect(editing).rejects.toBeInstanceOf(ApprovalRefused);
		expect(await filesAs(editorId).get(made.id)).toMatchObject({ version: 1, content: "# One" });
	});

	it("refuses a change based on an older version, and keeps the newer one", async () => {
		const made = await seed({ kind: "html", title: "Chart", content: "<p>one</p>" });
		const replace = async (
			change: Pick<InputOf<"files.write">, "baseVersion" | "kind" | "content">,
		) => (await allowedChange("files.write", { fileId: made.id, ...change }))();

		await replace({ baseVersion: 1, content: "<p>two</p>" });
		await expect(replace({ baseVersion: 1, content: "<p>lost</p>" })).rejects.toMatchObject({
			_tag: "FileStale",
			currentVersion: 2,
		});
		await expect(
			replace({ baseVersion: 2, content: "# Doc", kind: "markdown" }),
		).rejects.toMatchObject({
			_tag: "FileKindFixed",
			kind: "html",
		});
		expect(await filesAs(editorId).get(made.id)).toMatchObject({
			version: 2,
			content: "<p>two</p>",
		});
	});

	it("refuses an edit whose text isn't in the file exactly once", async () => {
		const made = await seed({ kind: "html", title: "Tiles", content: "<b>a</b><b>a</b>" });
		const edit = async (oldText: string) =>
			(
				await allowedChange("files.edit", {
					fileId: made.id,
					baseVersion: 1,
					oldText,
					newText: "b",
				})
			)();

		await expect(edit("<b>a</b>")).rejects.toMatchObject({ _tag: "EditTextUnmatched", matches: 2 });
		await expect(edit("<i>")).rejects.toMatchObject({ _tag: "EditTextUnmatched", matches: 0 });
		expect(await filesAs(editorId).get(made.id)).toMatchObject({ version: 1 });
	});

	it("refuses an edit that would take a file over its size limit", async () => {
		const made = await seed({
			kind: "markdown",
			title: "Long",
			content: `${"x".repeat(MAX_FILE_CONTENT_CHARACTERS - 1)}!`,
		});
		const edit = await allowedChange("files.edit", {
			fileId: made.id,
			baseVersion: 1,
			oldText: "!",
			newText: "!!",
		});
		await expect(edit()).rejects.toMatchObject({
			_tag: "FileContentTooLarge",
			maxCharacters: MAX_FILE_CONTENT_CHARACTERS,
		});
	});

	it("hides a project's files from members outside it and from bots outside it", async () => {
		const made = await seed({ kind: "markdown", title: "Private", content: "# Private" });
		await expect(filesAs(outsiderId).get(made.id)).rejects.toMatchObject({
			_tag: "ResourceHidden",
		});
		const elsewhere = await seedTurnAnswering(botElsewhere.chatId, botElsewhere.botId, {
			member: editorId,
		});
		await expect(
			call(await authenticate(elsewhere), "files.readWritten", { fileId: made.id }),
		).rejects.toMatchObject({
			_tag: "ResourceHidden",
		});
	});

	it("lets an admin delete a project's file with its versions, and refuses its members", async () => {
		const made = await seed({ kind: "markdown", title: "Draft", content: "# One" });
		await (
			await allowedChange("files.write", { fileId: made.id, baseVersion: 1, content: "# Two" })
		)();
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
		await onDatabase((db) =>
			db.update(bot).set({ visibility: "personal" }).where(eq(bot.id, botElsewhere.botId)),
		);
		const made = await seed({ kind: "markdown", title: "Diary", content: "# Diary" }, botElsewhere);
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
		const written = await seed({ kind: "markdown", title: "Plan", content: "# Plan" });
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
						...askerColumns({ chatId: by.chatId, botId: by.botId, triggerMessageId: replyId }),
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

	it("records no version whose content was deleted while its writer was held up", async () => {
		const stored = Promise.withResolvers<BlobStore.Key>();
		const resume = Promise.withResolvers<void>();
		const heldAfterStoring = Layer.effect(
			BlobStore.Service,
			Effect.map(BlobStore.Service, (store) =>
				BlobStore.Service.of({
					...store,
					put: (key, content) =>
						store.put(key, content).pipe(
							Effect.tap(() =>
								Effect.promise(() => {
									stored.resolve(key);
									return resume.promise;
								}),
							),
						),
				}),
			),
		);
		const title = `Late ${crypto.randomUUID()}`;
		const writing = runOnPostgres(
			Effect.exit(
				Files.seedWrittenFile(by, { kind: "markdown", title, content: "# Late" }).pipe(
					Effect.provide(heldAfterStoring),
				),
			),
		);
		const key = await stored.promise;
		// Its grace runs out, and the queue deletes what it stored.
		await onDatabase((db) =>
			db
				.update(blobDeletion)
				.set({ dueAt: new Date(0) })
				.where(eq(blobDeletion.prefix, key)),
		);
		await runOnPostgres(BlobDeletions.deleteQueued);
		resume.resolve();
		const written = await writing;

		expect(written._tag).toBe("Failure");
		expect(
			await onDatabase((db) => db.select({ id: file.id }).from(file).where(eq(file.name, title))),
		).toEqual([]);
	});

	it("deletes what a write stored when it never recorded it and the store couldn't take it back", async () => {
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
		const writtenKeys = async () =>
			(
				await onDatabase((db) =>
					db.select({ key: blob.key }).from(blob).where(like(blob.key, "files/%")),
				)
			).map(({ key }) => key);
		const before = new Set(await writtenKeys());

		// Its chat is gone, so the version can't be recorded.
		const refused = await runOnPostgres(
			Effect.exit(
				Files.seedWrittenFile(
					{ ...by, chatId: crypto.randomUUID() },
					{ kind: "markdown", title: "Lost", content: "# Lost" },
				).pipe(Effect.provide(deletesFailing)),
			),
		);
		const orphaned = (await writtenKeys()).filter((key) => !before.has(key));
		await onDatabase((db) =>
			db
				.update(blobDeletion)
				.set({ dueAt: new Date(0) })
				.where(inArray(blobDeletion.prefix, orphaned as BlobStore.Key[])),
		);
		await runOnPostgres(BlobDeletions.deleteQueued);

		expect(refused._tag).toBe("Failure");
		expect(orphaned).toHaveLength(1);
		expect((await writtenKeys()).filter((key) => !before.has(key))).toEqual([]);
	});
});
