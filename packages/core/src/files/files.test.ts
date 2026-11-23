import { MAX_FILE_CONTENT_CHARACTERS } from "@sugabots/contracts";
import { eq, like } from "drizzle-orm";
import { Effect, Layer, Stream } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { seedConversation } from "../conversations/seed.test-support.ts";
import { Credentials } from "../credentials/credentials.ts";
import {
	blobDeletion,
	bot,
	fileVersion,
	message,
	projectBot,
	projectMember,
	turn,
	user,
	workspace,
	workspaceMember,
} from "../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../database/testing.ts";
import { Installation } from "../installation/installation.ts";
import { defaultProjectOf } from "../workspaces/projects/project-reads.ts";
import { seedProject } from "../workspaces/projects/seed.test-support.ts";
import { servedOnPostgresAs } from "../workspaces/testing.ts";
import { ConversationFiles } from "./conversation-files.ts";
import { Files } from "./files.ts";
import { FilePages } from "./pages.ts";

/** Seals as the test infrastructure's credentials do, to forge tokens in a case. */
const testCredentials = Credentials.fromKey(Buffer.alloc(32).toString("base64"));

describe.skipIf(!process.env.DATABASE_URL)("files, against Postgres", () => {
	let by: Files.BotInConversation;
	let memberId: string;
	let outsiderId: string;
	let adminId: string;
	let projectId: string;
	/** A bot outside the project, working in a thread of its own. */
	let botElsewhere: Files.BotInConversation;
	/** The project's bot, asked by the bot outside it from that bot's thread. */
	let writerAskedFromThread: Files.BotInConversation;
	/** The bot outside the project, asked from one of the project's threads. */
	let strangerAskedFromProject: Files.BotInConversation;

	const authoring = async () => ({
		service: await runOnPostgres(Effect.provide(Files.Authoring, Files.authoringLayer)),
		/** Runs `effect`, which should fail, to its failure. */
		failureOf: <A, E>(effect: Effect.Effect<A, E>) => runOnPostgres(Effect.flip(effect)),
	});

	it("writes over a version in place, keeping its number and queueing its old content", async () => {
		const { service } = await authoring();
		const made = await runOnPostgres(
			service.create(by, { kind: "document", title: "Notes", content: "# One" }),
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
				.where(like(blobDeletion.prefix, `artifacts/${made.id}/%`)),
		);
		expect(queued).toHaveLength(1);
	});

	it("keeps both of two in-place edits made at once", async () => {
		const { service } = await authoring();
		const made = await runOnPostgres(
			service.create(by, { kind: "document", title: "Notes", content: "# One\n\nTwo" }),
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
		const pagesAt = (contentOrigin: string | undefined) =>
			servedOnPostgresAs(
				FilePages.Service,
				FilePages.layer.pipe(
					Layer.provide(
						Layer.succeed(
							Installation.Service,
							Installation.fromUrls({
								isProduction: false,
								publicUrl: "https://sugabots.example.com",
								...(contentOrigin ? { contentOrigin } : {}),
							}),
						),
					),
				),
			);
		const aPage = async () => {
			const { service } = await authoring();
			return runOnPostgres(
				service.create(by, { kind: "html", title: "Chart", content: "<p>chart</p>" }),
			);
		};

		it("gives the project's people an address on the content origin that opens the page", async () => {
			const made = await aPage();
			const pages = (await pagesAt("https://pages.example-content.com"))(memberId);

			const address = await pages.address({ fileId: made.id, version: 1 });

			expect(address).toMatch(/^https:\/\/pages\.example-content\.com\/pages\/.+/);
			const token = address?.split("/pages/")[1] ?? "";
			expect(await pages.open(token)).toEqual({ title: "Chart", html: "<p>chart</p>" });
		});

		it("gives no address without a content origin, nor for a document", async () => {
			const made = await aPage();
			const { service } = await authoring();
			const notes = await runOnPostgres(
				service.create(by, { kind: "document", title: "Notes", content: "# Notes" }),
			);

			const unset = (await pagesAt(undefined))(memberId);
			const set = (await pagesAt("https://pages.example-content.com"))(memberId);

			expect(await unset.address({ fileId: made.id, version: 1 })).toBeUndefined();
			expect(await set.address({ fileId: notes.id, version: 1 })).toBeUndefined();
		});

		it("gives no address for a version the page doesn't have", async () => {
			const made = await aPage();
			const pages = (await pagesAt("https://pages.example-content.com"))(memberId);

			await expect(pages.address({ fileId: made.id, version: 2 })).rejects.toMatchObject({
				_tag: "ResourceHidden",
			});
		});

		it("hides a page from people outside its project", async () => {
			const made = await aPage();
			const pages = (await pagesAt("https://pages.example-content.com"))(outsiderId);

			await expect(pages.address({ fileId: made.id, version: 1 })).rejects.toMatchObject({
				_tag: "ResourceHidden",
			});
		});

		it("refuses a tampered or expired token, and a value sealed for something else", async () => {
			const made = await aPage();
			const pages = (await pagesAt("https://pages.example-content.com"))(memberId);
			const sealed = (expiresAt: number, purpose?: string) =>
				testCredentials.encrypt(
					JSON.stringify({ fileId: made.id, version: 1, expiresAt }),
					purpose,
				);

			const good = sealed(Date.now() + 60_000, FilePages.SEALED_FOR);
			const flipped = `${good.slice(0, -4)}${good.at(-4) === "A" ? "B" : "A"}${good.slice(-3)}`;
			await expect(pages.open(flipped)).rejects.toMatchObject({
				_tag: "FilePageUnavailable",
			});
			await expect(pages.open(sealed(Date.now() - 1, FilePages.SEALED_FOR))).rejects.toMatchObject({
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

	/** A collaboration `askingBotId` asked of `collaboratorBotId` from its reply in `from`. */
	async function aCollaboration(asked: {
		workspaceId: string;
		from: string;
		askingBotId: string;
		collaboratorBotId: string;
		title: string;
	}) {
		const [reply] = await onDatabase((db) =>
			db
				.insert(message)
				.values({
					conversationId: asked.from,
					authorBotId: asked.askingBotId,
					kind: "text",
					status: "complete",
					parts: [],
					content: "",
				})
				.returning(),
		);
		if (!reply) throw new Error("fixture");
		const [asking] = await onDatabase((db) =>
			db
				.insert(turn)
				.values({
					conversationId: asked.from,
					botId: asked.askingBotId,
					triggerMessageId: reply.id,
					status: "done",
					model: "test/model",
					startedAt: new Date(),
				})
				.returning(),
		);
		if (!asking) throw new Error("fixture");
		return onDatabase((db) =>
			seedConversation(db, {
				workspaceId: asked.workspaceId,
				kind: "collaboration",
				title: asked.title,
				collaboration: {
					parentConversationId: asked.from,
					rootConversationId: asked.from,
					parentMessageId: reply.id,
					turnId: asking.id,
					collaboratorBotId: asked.collaboratorBotId,
					brief: "Help.",
					atOffset: 0,
				},
			}),
		);
	}

	beforeEach(async () => {
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: `Files ${stamp}`, slug: `files-${stamp}` })
				.returning(),
		);
		const [member, outsider, admin] = await onDatabase((db) =>
			db
				.insert(user)
				.values([
					{ name: "Kim", email: `kim-${stamp}@example.com` },
					{ name: "Ola", email: `ola-${stamp}@example.com` },
					{ name: "Ada", email: `ada-${stamp}@example.com` },
				])
				.returning(),
		);
		if (!space || !member || !outsider || !admin) throw new Error("fixture");
		const workspaceId = space.id;
		memberId = member.id;
		outsiderId = outsider.id;
		adminId = admin.id;
		await onDatabase((db) =>
			db.insert(workspaceMember).values([
				{ workspaceId, userId: memberId, role: "member" },
				{ workspaceId, userId: outsiderId, role: "member" },
				{ workspaceId, userId: adminId, role: "admin" },
			]),
		);
		const room = await onDatabase((db) =>
			seedProject(db, { workspaceId, name: "Planning", slug: `planning-${stamp}` }),
		);
		if (!room) throw new Error("fixture");
		projectId = room.id;
		await onDatabase((db) =>
			db.insert(projectMember).values({ workspaceId, projectId, userId: memberId }),
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
						face: "pill" as const,
						model: "claude-opus-4-1-20250805",
						createdById: memberId,
					})),
				)
				.returning(),
		);
		if (!writer || !stranger) throw new Error("fixture");
		await onDatabase((db) =>
			db.insert(projectBot).values({ workspaceId, projectId, botId: writer.id }),
		);
		const planning = await onDatabase((db) =>
			seedConversation(db, {
				workspaceId,
				kind: "project_thread",
				projectId,
				title: "Planning",
				startedById: memberId,
			}),
		);
		const strangersThread = await onDatabase((db) =>
			seedConversation(db, {
				workspaceId,
				kind: "project_thread",
				botId: stranger.id,
				title: "Elsewhere",
				startedById: memberId,
			}),
		);
		by = { botId: writer.id, conversationId: planning.id };
		botElsewhere = { botId: stranger.id, conversationId: strangersThread.id };
		// The project's bot asked from the other bot's thread, and the other bot from the project.
		const askedFromThread = await aCollaboration({
			workspaceId,
			from: strangersThread.id,
			askingBotId: stranger.id,
			collaboratorBotId: writer.id,
			title: "Asked from the thread",
		});
		const askedFromProject = await aCollaboration({
			workspaceId,
			from: planning.id,
			askingBotId: writer.id,
			collaboratorBotId: stranger.id,
			title: "Asked from the project",
		});
		writerAskedFromThread = { botId: writer.id, conversationId: askedFromThread.id };
		strangerAskedFromProject = { botId: stranger.id, conversationId: askedFromProject.id };
	});

	it("keeps every version of a document a bot writes, for people in its project to read", async () => {
		const { service } = await authoring();
		const made = await runOnPostgres(
			service.create(by, {
				kind: "document",
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

		const reader = (await servedOnPostgresAs(Files.Service, Files.layer))(memberId);
		const at = { fileId: made.id };
		expect(await reader.get(at)).toMatchObject({
			version: 2,
			createdBy: { name: "Writer" },
			content: "# Launch plan\n\n## Goals\n\nShip by Friday.\n\n## Risks\n\nNone yet.\n",
		});
		expect((await reader.versions(at)).map((version) => version.number)).toEqual([2, 1]);
		expect(await reader.getVersion({ ...at, version: 1 })).toMatchObject({
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
					kind: "document",
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
				kind: "document",
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

	it("hides a project's files from people outside it and from bots outside it", async () => {
		const { service, failureOf } = await authoring();
		const made = await runOnPostgres(
			service.create(by, { kind: "document", title: "Private", content: "# Private" }),
		);

		const outsider = (await servedOnPostgresAs(Files.Service, Files.layer))(outsiderId);
		await expect(outsider.get({ fileId: made.id })).rejects.toMatchObject({
			_tag: "ResourceHidden",
		});
		expect(await failureOf(service.read(botElsewhere, made.id))).toMatchObject({
			_tag: "FileNotFound",
		});
	});

	it("lets an admin delete a project's file with its versions, and refuses its members", async () => {
		const { service } = await authoring();
		const made = await runOnPostgres(
			service.create(by, { kind: "document", title: "Draft", content: "# One" }),
		);
		await runOnPostgres(service.replace(by, { fileId: made.id, baseVersion: 1, content: "# Two" }));
		const as = await servedOnPostgresAs(Files.Service, Files.layer);
		const at = { fileId: made.id };

		await expect(as(memberId).remove(at)).rejects.toMatchObject({ _tag: "ActionForbidden" });
		await as(adminId).remove(at);

		await expect(as(memberId).get(at)).rejects.toMatchObject({ _tag: "ResourceHidden" });
		expect(await as(memberId).listInProject({ projectId })).toEqual([]);
		const versionsLeft = await onDatabase((db) =>
			db.select().from(fileVersion).where(eq(fileVersion.fileId, made.id)),
		);
		expect(versionsLeft).toEqual([]);
	});

	it("shows the files a bot made in its threads to whoever reaches the bot, and to nobody else", async () => {
		const { service } = await authoring();
		await onDatabase((db) =>
			db.update(bot).set({ visibility: "private" }).where(eq(bot.id, botElsewhere.botId)),
		);
		const made = await runOnPostgres(
			service.create(botElsewhere, { kind: "document", title: "Diary", content: "# Diary" }),
		);
		const as = await servedOnPostgresAs(Files.Service, Files.layer);

		expect(await as(memberId).get({ fileId: made.id })).toMatchObject({ title: "Diary" });
		expect(
			(
				await as(memberId).listInProject({
					projectId: await runOnPostgres(defaultProjectOf(botElsewhere.botId)),
				})
			).map(({ id }) => id),
		).toEqual([made.id]);
		for (const somebodyElse of [outsiderId, adminId]) {
			await expect(as(somebodyElse).get({ fileId: made.id })).rejects.toMatchObject({
				_tag: "ResourceHidden",
			});
		}
		await expect(as(memberId).listInProject({ projectId })).resolves.toEqual([]);
	});

	it("lists the files sent on a project's messages beside those bots wrote, and only those sent", async () => {
		const { service } = await authoring();
		const written = await runOnPostgres(
			service.create(by, { kind: "document", title: "Plan", content: "# Plan" }),
		);
		const files = await runOnPostgres(
			Effect.provide(ConversationFiles.Service, ConversationFiles.layer),
		);
		const content = (text: string) => ({
			stream: Stream.succeed(new TextEncoder().encode(text)),
			contentType: "text/plain",
		});
		const messageIn = (
			conversationId: string,
			author: { authorUserId: string } | { authorBotId: string },
		) =>
			onDatabase((db) =>
				db
					.insert(message)
					.values({
						conversationId: conversationId,
						...author,
						kind: "text",
						status: "complete",
						parts: [],
						content: "",
					})
					.returning({ id: message.id }),
			).then(([row]) => row?.id ?? "");
		const upload = (name: string) =>
			runOnPostgres(
				files.upload({
					conversationId: by.conversationId,
					uploaderId: memberId,
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
				conversationId: by.conversationId,
				messageId: await messageIn(by.conversationId, { authorUserId: memberId }),
				uploaderId: memberId,
				fileIds: [sent.id],
			}),
		);
		await runOnPostgres(
			files.write({ conversationId: by.conversationId, content: content("a long result") }),
		);
		const attachTo = async (conversationId: string, botId: string, name: string) => {
			const messageId = await messageIn(conversationId, { authorBotId: botId });
			return runOnPostgres(
				files.withReplyFile(
					{
						conversationId,
						messageId,
						name,
						contentType: "text/csv",
						content: new Uint8Array([1]),
					},
					(stored) => files.attachToReply(stored),
				),
			);
		};
		const chart = await attachTo(by.conversationId, by.botId, "chart.csv");
		// Attached in a collaboration opened from the project, where only the bots read it.
		await attachTo(
			strangerAskedFromProject.conversationId,
			strangerAskedFromProject.botId,
			"aside.csv",
		);

		const as = await servedOnPostgresAs(Files.Service, Files.layer);
		const listed = await as(memberId).listInProject({ projectId });

		expect(listed.map(({ id }) => id).sort()).toEqual([written.id, sent.id, chart.id].sort());
		expect(listed.find(({ id }) => id === sent.id)).toMatchObject({
			kind: "upload",
			name: "brief.txt",
			sentBy: "Kim",
		});
		expect(listed.find(({ id }) => id === chart.id)).toMatchObject({
			kind: "attachment",
			name: "chart.csv",
			sentBy: "Writer",
		});
		// Only a written file is read here; a sent one is read through its conversation.
		await expect(as(memberId).get({ fileId: sent.id })).rejects.toMatchObject({
			_tag: "ResourceHidden",
		});
	});

	it("keeps a bot's files with the conversation it made them in, wherever else it works", async () => {
		const { service, failureOf } = await authoring();
		const inProject = await runOnPostgres(
			service.create(by, { kind: "document", title: "Project plan", content: "# Plan" }),
		);
		const forTheThread = await runOnPostgres(
			service.create(writerAskedFromThread, { kind: "document", title: "Answer", content: "# A" }),
		);
		const forTheProject = await runOnPostgres(
			service.create(strangerAskedFromProject, { kind: "document", title: "Help", content: "# H" }),
		);
		const ids = (summaries: { id: string }[]) => summaries.map(({ id }) => id).sort();

		// Asked from another bot's thread, the project's bot can't bring the project's files.
		expect(await failureOf(service.read(writerAskedFromThread, inProject.id))).toMatchObject({
			_tag: "FileNotFound",
		});
		expect(ids(await runOnPostgres(service.list(writerAskedFromThread)))).toEqual([
			forTheThread.id,
		]);
		// What it made there belongs to the thread that asked, and the project sees what it asked for.
		expect(ids(await runOnPostgres(service.list(botElsewhere)))).toEqual([forTheThread.id]);
		expect(ids(await runOnPostgres(service.list(by)))).toEqual(
			[inProject.id, forTheProject.id].sort(),
		);

		const as = await servedOnPostgresAs(Files.Service, Files.layer);
		expect(ids(await as(memberId).listInProject({ projectId }))).toEqual(
			[inProject.id, forTheProject.id].sort(),
		);
		const botsOwn = async (botId: string) =>
			ids(
				await as(memberId).listInProject({
					projectId: await runOnPostgres(defaultProjectOf(botId)),
				}),
			);
		expect(await botsOwn(by.botId)).toEqual([]);
		expect(await botsOwn(botElsewhere.botId)).toEqual([forTheThread.id]);
	});
});
