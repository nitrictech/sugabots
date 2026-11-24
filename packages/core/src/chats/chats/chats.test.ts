import {
	type ChatMessageItem,
	chatStream,
	type FilePart,
	handleFromName,
} from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { and, desc, eq, like, sql } from "drizzle-orm";
import { Context, Effect, Stream } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Visibility } from "../../authorization/visibility.ts";
import { EventBus } from "../../database/events/bus.ts";
import { EventStore } from "../../database/events/store.ts";
import {
	automationRun,
	bot,
	chatParticipant,
	event,
	laneRequest,
	member,
	membership,
	message,
	messageReaction,
	placedChat,
	project,
	projectBot,
	projectMember,
	type TurnStatus,
	toolCall,
	turn,
	workspace,
} from "../../database/schema.ts";
import {
	closeDatabase,
	onDatabase,
	onPostgres,
	type Promised,
	runOnPostgres,
} from "../../database/testing.ts";
import { ChatFileStore } from "../../files/chat-file-store.ts";
import { INTERVIEW_PROMPT } from "../../workspaces/bots/interview-prompt.ts";
import { defaultProjectOf } from "../../workspaces/projects/project-reads.ts";
import { seedProject } from "../../workspaces/projects/seed.test-support.ts";
import { onPostgresAs } from "../../workspaces/testing.ts";
import { Automations } from "../automations/automations.ts";
import { ChatDetailsView } from "../chat-details-view.ts";
import { Reactions } from "../reactions/reactions.ts";
import { seedChat } from "../seed.test-support.ts";
import { ChatStore } from "../store/store.ts";
import { chatServicesForTests } from "../testing.ts";
import { modelPrompt, prepareRunnable, runningTurns, TurnExecution } from "../turns/testing.ts";
import { Turns } from "../turns/turns.ts";
import { BotChats } from "./bot-chats.ts";
import { ChatFiles } from "./chat-files.ts";
import { ChatView } from "./chat-view.ts";
import { Chats } from "./chats.ts";
import { startBotChat } from "./testing.ts";

const eventStore = await runOnPostgres(EventStore.make);

describe.skipIf(!process.env.DATABASE_URL)("chats, against Postgres", async () => {
	const services = await chatServicesForTests(EventBus.inProcess({ store: eventStore }));
	/** As the editor the chats are with. */
	let chats: Promised<Chats.Interface>;
	let view: Promised<ChatView.Interface>;
	/** As an administrator, who may define and run the bots' automations. */
	let automations: Promised<Automations.Interface>;
	let workspaceId: string;
	let projectId: string;
	let botId: string;
	/** The host bot's default project, which holds its automations. */
	let botProjectId: string;
	let recipientBotId: string;
	let memberId: string;
	let administratorId: string;

	afterAll(async () => {
		await closeDatabase();
	});

	/**
	 * A chat the editor started with `chatBotId`, written straight to the
	 * database, so it holds no message and nobody has been asked to answer.
	 */
	const aChat = async (chatBotId = botId) => {
		const { id } = await onDatabase((db) =>
			seedChat(db, {
				workspaceId,
				kind: "project_chat",
				botId: chatBotId,
				title: "Chat",
				startedById: memberId,
			}),
		);
		await onDatabase((db) =>
			db.insert(chatParticipant).values([
				{ chatId: id, memberId },
				{ chatId: id, botId: chatBotId },
			]),
		);
		return { id };
	};

	/** The bot's chat `chatId` as the editor's list of the bot's chats shows it. */
	const listedChat = async (chatId: string, chatBotId = botId) =>
		(await view.chats(await runOnPostgres(defaultProjectOf(chatBotId)))).chats.find(
			(item) => item.chat.id === chatId,
		);

	/**
	 * A chat the editor started in `inProjectId`, called `name`, written
	 * straight to the database, so it holds no message and nobody has been
	 * asked to answer.
	 */
	const namedChat = async (inProjectId: string, name: string) => {
		const { id } = await onDatabase((db) =>
			seedChat(db, {
				workspaceId,
				kind: "project_chat",
				projectId: inProjectId,
				title: name,
				startedById: memberId,
			}),
		);
		await onDatabase((db) => db.insert(chatParticipant).values({ chatId: id, memberId }));
		return { id };
	};

	beforeEach(async () => {
		const suffix = crypto.randomUUID();
		const [somebody, administrator] = await onDatabase((db) =>
			db
				.insert(member)
				.values([
					{ name: "Chat editor", email: `chat-${suffix}@example.com` },
					{ name: "Chat admin", email: `chat-admin-${suffix}@example.com` },
				])
				.returning(),
		);
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: "Chat workspace", slug: `chat-${suffix}` })
				.returning(),
		);
		if (!somebody || !administrator || !space)
			throw new Error("Could not create chat test identity");
		memberId = somebody.id;
		administratorId = administrator.id;
		workspaceId = space.id;
		await onDatabase((db) =>
			db.insert(membership).values([
				{ workspaceId, memberId },
				{ workspaceId, memberId: administrator.id, role: "admin" },
			]),
		);
		chats = onPostgresAs(memberId)(Context.get(services, Chats.Service));
		view = onPostgresAs(memberId)(Context.get(services, ChatView.Service));
		automations = onPostgresAs(administrator.id)(Context.get(services, Automations.Service));
		const room = await onDatabase((db) =>
			seedProject(db, {
				workspaceId,
				name: "Chat project",
				slug: `chat-${suffix}`,
				createdById: memberId,
			}),
		);
		if (!room) throw new Error("Could not create chat test project");
		projectId = room.id;
		await onDatabase((db) => db.insert(projectMember).values({ workspaceId, projectId, memberId }));
		const [host, recipient] = await onDatabase((db) =>
			db
				.insert(bot)
				.values([
					{
						workspaceId,
						name: "Own Bot",
						handle: handleFromName(`Own Bot ${suffix}`),
						color: "green",
						eyes: "pill",
						model: "test/model",
						createdById: memberId,
					},
					{
						workspaceId,
						name: "Impersonal Bot",
						handle: handleFromName(`Impersonal Bot ${suffix}`),
						color: "sky",
						eyes: "square",
						model: "test/model",
						createdById: memberId,
					},
				])
				.returning(),
		);
		if (!host || !recipient) throw new Error("Could not create chat test bots");
		botId = host.id;
		recipientBotId = recipient.id;
		const [own] = await onDatabase((db) =>
			db.select({ id: project.id }).from(project).where(eq(project.defaultOfBotId, botId)),
		);
		if (!own) throw new Error("The host bot has no default project");
		botProjectId = own.id;
		// Both bots are in the project, so either may be asked in its chats; the host leads it.
		await onDatabase((db) =>
			db.insert(projectBot).values([
				{ workspaceId, projectId, botId },
				{ workspaceId, projectId, botId: recipientBotId },
			]),
		);
		await onDatabase((db) =>
			db.update(project).set({ leadBotId: botId }).where(eq(project.id, projectId)),
		);
	});

	it("shows a personal bot's chat to its creator, and to nobody else", async () => {
		await onDatabase((db) =>
			db.update(bot).set({ visibility: "personal" }).where(eq(bot.id, botId)),
		);
		const opened = await aChat();
		const [otherEditor, stranger] = await onDatabase((db) =>
			db
				.insert(member)
				.values([
					{ name: "Another editor", email: `editor-${crypto.randomUUID()}@example.com` },
					{ name: "Outside the workspace", email: `stranger-${crypto.randomUUID()}@example.com` },
				])
				.returning(),
		);
		if (!otherEditor || !stranger) throw new Error("Could not create the members");
		await onDatabase((db) =>
			db.insert(membership).values({ workspaceId, memberId: otherEditor.id, role: "editor" }),
		);
		const visibility = await runOnPostgres(Effect.provide(Visibility.Service, Visibility.layer));
		const visibilityAs = (memberId: string) => onPostgresAs(memberId)({ chat: visibility.chat });

		expect(await visibilityAs(memberId).chat(opened.id)).toMatchObject({ id: opened.id });
		for (const memberId of [otherEditor.id, stranger.id]) {
			await expect(visibilityAs(memberId).chat(opened.id)).rejects.toMatchObject({
				_tag: "ResourceHidden",
				resource: "chat",
			});
		}
	});

	it("refuses a chat with a personal bot to anyone but its creator", async () => {
		await onDatabase((db) =>
			db
				.update(bot)
				.set({ visibility: "personal", createdById: administratorId })
				.where(eq(bot.id, botId)),
		);

		await expect(
			startBotChat(chats, { botId, messageId: crypto.randomUUID(), content: "Hello?" }),
		).rejects.toMatchObject({ _tag: "ResourceHidden" });
		await expect(view.chats(botProjectId)).rejects.toMatchObject({ _tag: "ResourceHidden" });
	});

	it("starts a chat with the bot from its first message, which the bot answers, once", async () => {
		const messageId = crypto.randomUUID();
		const input = {
			botId,
			messageId,
			content: "\n  Budget   review is Friday\nand bring the numbers",
		};

		const started = await startBotChat(chats, input);

		expect(started.chat).toMatchObject({
			botId,
			title: "Budget review is Friday and bring the numbers",
		});
		expect(started.message).toMatchObject({
			id: messageId,
			chatId: started.chat.id,
		});
		expect(await runOnPostgres(runningTurns(started.chat.id))).toHaveLength(1);
		expect((await startBotChat(chats, input)).chat.id).toBe(started.chat.id);
		expect((await view.messages(started.chat.id))?.items.map((item) => item.kind)).toEqual([
			"message",
		]);
		expect((await view.history(started.chat.id))?.items).toHaveLength(0);
		const listed = await view.chats(botProjectId);
		expect(listed.chats).toEqual([
			{
				chat: expect.objectContaining({ id: started.chat.id }),
				lastMessageAt: expect.any(String),
				participants: expect.any(Array),
				messageCount: 1,
				unreadMessages: 0,
				needsApproval: false,
				mentionsYou: false,
				status: null,
			},
		]);
	});

	it("returns the one chat to sends of its first message made at once", async () => {
		const input = { botId, messageId: crypto.randomUUID(), content: "Plan the offsite" };

		const [first, retry] = await Promise.all([
			startBotChat(chats, input),
			startBotChat(chats, input),
		]);

		expect(retry.chat.id).toBe(first.chat.id);
		expect((await view.chats(botProjectId)).chats).toHaveLength(1);
	});

	it("gives the chat's bot the message the chat was started with", async () => {
		const messageId = crypto.randomUUID();
		const started = await startBotChat(chats, {
			botId,
			messageId,
			content: "Can you check the renewal numbers?",
		});
		const [run] = await runOnPostgres(runningTurns(started.chat.id));
		if (!run) throw new Error("The chat's bot was not asked");

		const prepared = await prepareRunnable(
			onPostgres({ prepare: Context.get(services, TurnExecution.Service).prepare }),
			run,
		);

		expect(prepared.context.messages).toEqual([
			expect.objectContaining({ id: messageId, chatId: started.chat.id }),
		]);
		expect(prepared.context.askerId).toBe(memberId);
	});

	describe("chats a bot starts for the member it is answering", () => {
		const botChats = () => onPostgres(Context.get(services, BotChats.Service));
		const handleOf = async (id: string) => {
			const [row] = await onDatabase((db) =>
				db.select({ handle: bot.handle }).from(bot).where(eq(bot.id, id)),
			);
			if (!row) throw new Error("fixture");
			return row.handle;
		};

		it("starts it with the bot asked for, briefed by the starting bot, and asks that bot to work", async () => {
			const started = await botChats().start(
				{ botId, workspaceId, askerId: memberId },
				{
					title: "March refunds",
					brief: "Pull the refunds issued in March.",
					withHandle: `@${await handleOf(recipientBotId)}`,
				},
			);
			expect(started).toEqual({
				id: expect.any(String),
				title: "March refunds",
				with: "Impersonal Bot",
				withBotId: recipientBotId,
			});
			const participants = await onDatabase((db) =>
				db
					.select({ memberId: chatParticipant.memberId, botId: chatParticipant.botId })
					.from(chatParticipant)
					.where(eq(chatParticipant.chatId, started.id)),
			);
			expect(participants).toEqual(
				expect.arrayContaining([
					{ memberId, botId: null },
					{ memberId: null, botId: recipientBotId },
				]),
			);
			expect(participants).toHaveLength(2);
			const [run] = await runOnPostgres(runningTurns(started.id));
			if (!run) throw new Error("The chat's bot was not asked");

			const prepared = await prepareRunnable(
				onPostgres({ prepare: Context.get(services, TurnExecution.Service).prepare }),
				run,
			);

			expect(prepared.context.bot.id).toBe(recipientBotId);
			// A bot wrote its brief, so it acts for the member only to mark the chat resolved.
			expect(prepared.context.askerId).toBeNull();
			expect(prepared.context.startedFor).toBe(memberId);
			expect(prepared.context.messages).toEqual([
				expect.objectContaining({
					content: "Pull the refunds issued in March.",
					author: expect.objectContaining({ kind: "bot", id: botId }),
				}),
			]);
		});

		it("starts it with the starting bot itself when no other bot is named", async () => {
			const started = await botChats().start(
				{ botId, workspaceId, askerId: memberId },
				{ title: "Follow-up", brief: "Draft the follow-up email." },
			);
			expect(started).toEqual({ id: expect.any(String), title: "Follow-up" });
			const [run] = await runOnPostgres(runningTurns(started.id));
			if (!run) throw new Error("The chat's bot was not asked");

			const prepared = await prepareRunnable(
				onPostgres({ prepare: Context.get(services, TurnExecution.Service).prepare }),
				run,
			);

			expect(prepared.context.bot.id).toBe(botId);
			expect(prepared.context.askerId).toBeNull();
			expect(prepared.context.startedFor).toBe(memberId);
		});

		it("marks the chat it is in resolved for the member who asked, a project's chat too", async () => {
			const projectChat = await namedChat(projectId, "General");
			const { chat: opened } = await startBotChat(chats, {
				botId,
				messageId: crypto.randomUUID(),
				content: "Can you check the renewal numbers?",
			});
			const bot = { botId, workspaceId, askerId: memberId };
			const resolvedAt = async (chatId: string) => {
				const [row] = await onDatabase((db) =>
					db
						.select({ resolvedAt: placedChat.resolvedAt })
						.from(placedChat)
						.where(eq(placedChat.id, chatId)),
				);
				return row?.resolvedAt ?? null;
			};

			await botChats().markResolved(bot, opened.id);
			await botChats().markResolved(bot, projectChat.id);

			expect(await resolvedAt(opened.id)).toBeInstanceOf(Date);
			expect(await resolvedAt(projectChat.id)).toBeInstanceOf(Date);
			await expect(
				botChats().markResolved({ ...bot, askerId: null }, opened.id),
			).rejects.toMatchObject({ _tag: "NobodyAsked" });
		});

		it("refuses when nobody asked, no bot has the handle, or the member can't reach the bot or chat", async () => {
			const [otherEditor] = await onDatabase((db) =>
				db
					.insert(member)
					.values({ name: "Another editor", email: `editor-${crypto.randomUUID()}@example.com` })
					.returning(),
			);
			if (!otherEditor) throw new Error("fixture");
			await onDatabase((db) =>
				db.insert(membership).values({ workspaceId, memberId: otherEditor.id, role: "editor" }),
			);
			// Personal to the editor the chats are with, so the other editor reaches neither it nor its chats.
			await onDatabase((db) =>
				db.update(bot).set({ visibility: "personal" }).where(eq(bot.id, recipientBotId)),
			);
			const brief = { title: "Elsewhere", brief: "Do it." };

			await expect(
				botChats().start({ botId, workspaceId, askerId: null }, brief),
			).rejects.toMatchObject({ _tag: "NobodyAsked" });
			await expect(
				botChats().start(
					{ botId, workspaceId, askerId: memberId },
					{ ...brief, withHandle: "@nobody-here" },
				),
			).rejects.toMatchObject({ _tag: "NoBotWithHandle" });
			await expect(
				botChats().start(
					{ botId, workspaceId, askerId: otherEditor.id },
					{ ...brief, withHandle: `@${await handleOf(recipientBotId)}` },
				),
			).rejects.toMatchObject({ _tag: "BotUnavailable" });
			const { chat: opened } = await startBotChat(chats, {
				botId: recipientBotId,
				messageId: crypto.randomUUID(),
				content: "Can you check the renewal numbers?",
			});
			await expect(
				botChats().markResolved(
					{ botId: recipientBotId, workspaceId, askerId: otherEditor.id },
					opened.id,
				),
			).rejects.toMatchObject({ _tag: "ChatHiddenFromAsker" });
		});
	});

	it("lists a bot's automations by name, each with its feed once it has run", async () => {
		const [quiet, ran] = await Promise.all(
			["Weekly digest", "Overnight review"].map((name) =>
				automations.create(
					{ projectId: botProjectId },
					{ name, instructions: "Review it.", triggers: [{ kind: "webhook" }] },
				),
			),
		);
		if (!quiet || !ran) throw new Error("Could not create the automations");
		const accepted = await automations.run({
			projectId: botProjectId,
			automationId: ran.automation.id,
			requestId: crypto.randomUUID(),
		});

		const listed = (await view.chats(botProjectId)).automations;

		expect(listed).toEqual([
			expect.objectContaining({
				automation: expect.objectContaining({ id: ran.automation.id, name: "Overnight review" }),
				chat: expect.objectContaining({ title: "Overnight review" }),
			}),
			expect.objectContaining({
				automation: expect.objectContaining({ id: quiet.automation.id }),
				chat: null,
			}),
		]);
		const feed = listed?.[0]?.chat;
		if (!feed) throw new Error("The automation has no feed");
		expect((await view.messages(feed.id))?.items).toEqual([
			expect.objectContaining({ kind: "run", chatId: accepted.chatId }),
		]);
		expect(
			(
				await chats.openAutomationFeed({
					workspace: workspaceId,
					automationId: quiet.automation.id,
				})
			).title,
		).toBe("Weekly digest");
	});

	it("marks an automation whose run failed until the member opens it after the run ends", async () => {
		const created = await automations.create(
			{ projectId: botProjectId },
			{ name: "Overnight review", instructions: "Review it.", triggers: [{ kind: "webhook" }] },
		);
		const accepted = await automations.run({
			projectId: botProjectId,
			automationId: created.automation.id,
			requestId: crypto.randomUUID(),
		});
		const feed = await chats.openAutomationFeed({
			workspace: workspaceId,
			automationId: created.automation.id,
		});
		// Opened while the run was still going, so before it failed.
		await chats.markRead(feed.id);
		await onDatabase((db) =>
			db
				.update(automationRun)
				.set({
					state: "failed",
					startedAt: sql`${automationRun.acceptedAt}`,
					finishedAt: sql`${automationRun.acceptedAt} + interval '1 minute'`,
					error: userText`The reply took too long and was stopped.`,
				})
				.where(eq(automationRun.id, accepted.runId)),
		);
		const failed = async () =>
			(await view.attentionMarks(workspaceId)).projects[botProjectId]?.failedAutomations ?? 0;

		expect(await failed()).toBe(1);
		await chats.markRead(feed.id);
		expect(await failed()).toBe(0);
		// Seen, it is still failing until a run goes well.
		expect((await view.chats(botProjectId)).automations[0]?.status).toEqual({
			failing: true,
			latestRun: {
				id: expect.any(String),
				state: "failed",
				posted: false,
				acceptedAt: expect.any(String),
				error: "The reply took too long and was stopped.",
			},
		});
	});

	it("marks a chat resolved, and reopens it by hand or when somebody writes in it", async () => {
		const { chat: current } = await startBotChat(chats, {
			botId,
			messageId: crypto.randomUUID(),
			content: "Can you check the renewal numbers?",
		});
		const resolvedAt = async () => (await listedChat(current.id))?.chat.resolvedAt;

		await chats.setResolved({ chatId: current.id, resolved: true });
		expect(await resolvedAt()).toEqual(expect.any(String));
		await chats.setResolved({ chatId: current.id, resolved: false });
		expect(await resolvedAt()).toBeNull();

		await chats.setResolved({ chatId: current.id, resolved: true });
		await chats.post({
			chatId: current.id,
			messageId: crypto.randomUUID(),
			content: "One more thing",
		});
		expect(await resolvedAt()).toBeNull();
	});

	it("says when a message the member has not read mentions them", async () => {
		const current = await aChat();
		const mentioned = async () => (await listedChat(current.id))?.mentionsYou;
		expect(await mentioned()).toBe(false);

		await onDatabase((db) =>
			db.insert(message).values({
				chatId: current.id,
				authorMemberId: administratorId,
				status: "complete",
				parts: [{ type: "text", text: "@chat-editor can you look?" }],
				content: "@chat-editor can you look?",
			}),
		);
		expect(await mentioned()).toBe(true);

		await chats.markRead(current.id);
		expect(await mentioned()).toBe(false);
	});

	it("says when a message the member has not read mentions everyone", async () => {
		const current = await aChat();

		await onDatabase((db) =>
			db.insert(message).values({
				chatId: current.id,
				authorMemberId: administratorId,
				status: "complete",
				parts: [{ type: "text", text: "@here standup is starting" }],
				content: "@here standup is starting",
			}),
		);

		expect((await listedChat(current.id))?.mentionsYou).toBe(true);
	});

	it("does not say a bot's @channel mentions the member", async () => {
		const current = await aChat();

		await onDatabase((db) =>
			db.insert(message).values({
				chatId: current.id,
				authorBotId: botId,
				status: "complete",
				parts: [{ type: "text", text: "@channel the report is done" }],
				content: "@channel the report is done",
			}),
		);

		expect((await listedChat(current.id))?.mentionsYou).toBe(false);
	});

	describe("unread and waiting chats", () => {
		/** The host writes `content` in `chatId`, `secondsLater` after now, and returns the message. */
		const botWrites = async (chatId: string, content: string, secondsLater = 0) => {
			const [written] = await onDatabase((db) =>
				db
					.insert(message)
					.values({
						chatId,
						authorBotId: botId,
						status: "complete",
						parts: content ? [{ type: "text", text: content }] : [],
						content,
						createdAt: new Date(Date.now() + secondsLater * 1000),
					})
					.returning(),
			);
			if (!written) throw new Error("fixture");
			return written;
		};
		/** The host's one chat, as the list of its chats shows it. */
		const hostRow = async () => (await view.chats(botProjectId)).chats[0];

		it("counts what a bot writes after the member last read the chat", async () => {
			const current = await aChat();
			await chats.post({
				chatId: current.id,
				messageId: crypto.randomUUID(),
				content: "Hi",
			});
			expect(await hostRow()).toMatchObject({ unreadMessages: 0 });

			await botWrites(current.id, "Hello!", 1);
			await botWrites(current.id, "", 2);
			await botWrites(current.id, "How can I help?", 3);
			expect(await hostRow()).toMatchObject({ unreadMessages: 2 });

			await chats.markRead(current.id);
			expect(await hostRow()).toMatchObject({ unreadMessages: 0 });

			await botWrites(current.id, "One more thing", 4);
			expect(await hostRow()).toMatchObject({ unreadMessages: 1 });
		});

		it("stops counting what came before the member's own reply", async () => {
			const current = await aChat();
			await botWrites(current.id, "Hello!", -2);
			await botWrites(current.id, "Anything else?", -1);
			expect(await hostRow()).toMatchObject({ unreadMessages: 2 });

			await chats.post({
				chatId: current.id,
				messageId: crypto.randomUUID(),
				content: "All good",
			});
			expect(await hostRow()).toMatchObject({ unreadMessages: 0 });
		});

		it("keeps a reply that finishes after the chat was read unread", async () => {
			const current = await aChat();
			await chats.post({
				chatId: current.id,
				messageId: crypto.randomUUID(),
				content: "Hey",
			});
			const [reply] = await onDatabase((db) =>
				db
					.insert(message)
					.values({
						chatId: current.id,
						authorBotId: botId,
						status: "writing",
						parts: [],
						content: "",
						createdAt: new Date(Date.now() + 1000),
					})
					.returning({ id: message.id }),
			);
			if (!reply) throw new Error("fixture");

			await chats.markRead(current.id);
			await onDatabase((db) =>
				db
					.update(message)
					.set({
						status: "complete",
						content: "Hi there",
						parts: [{ type: "text", text: "Hi there" }],
					})
					.where(eq(message.id, reply.id)),
			);

			expect(await hostRow()).toMatchObject({ unreadMessages: 1 });
		});

		it("keeps a reply unread that began before something the member read while it was written", async () => {
			const current = await aChat();
			await chats.post({
				chatId: current.id,
				messageId: crypto.randomUUID(),
				content: "Hey",
			});
			const [reply] = await onDatabase((db) =>
				db
					.insert(message)
					.values({
						chatId: current.id,
						authorBotId: botId,
						status: "writing",
						parts: [],
						content: "",
						createdAt: new Date(Date.now() + 1000),
					})
					.returning({ id: message.id }),
			);
			if (!reply) throw new Error("fixture");
			await botWrites(current.id, "Meanwhile, the deploy finished.", 2);

			await chats.markRead(current.id);
			await onDatabase((db) =>
				db
					.update(message)
					.set({
						status: "complete",
						content: "Hi there",
						parts: [{ type: "text", text: "Hi there" }],
					})
					.where(eq(message.id, reply.id)),
			);

			expect(await hostRow()).toMatchObject({ unreadMessages: 2 });
		});

		it("shows how far the member has read, and announces it only when they read further", async () => {
			const chatDetailsView = onPostgresAs(memberId)(
				Context.get(services, ChatDetailsView.Service),
			);
			const current = await aChat();
			const reply = await botWrites(current.id, "Hello!", 1);
			const readsAnnounced = async () =>
				(
					await onDatabase((db) =>
						db
							.select({ type: event.type })
							.from(event)
							.where(eq(event.stream, chatStream(current.id))),
					)
				).filter(({ type }) => type === "chat.read").length;

			await chats.markRead(current.id);
			await chats.markRead(current.id);

			const [read] = (await chatDetailsView.get(current.id)).reads;
			expect(read).toEqual({
				member: expect.objectContaining({ kind: "member", id: memberId }),
				readThrough: reply.createdAt.toISOString(),
				readAt: expect.any(String),
			});
			expect(await readsAnnounced()).toBe(1);
			// When they read it, not when it was sent: the reply is stamped a second from now.
			expect(Date.parse(read?.readAt ?? "")).toBeLessThan(reply.createdAt.getTime());

			await botWrites(current.id, "One more thing", 2);
			await chats.markRead(current.id);
			const [readAgain] = (await chatDetailsView.get(current.id)).reads;
			expect(Date.parse(readAgain?.readAt ?? "")).toBeGreaterThan(Date.parse(read?.readAt ?? ""));
		});

		it("adds up each bot's unread messages for the sidebar, under its default project", async () => {
			const current = await aChat();
			const other = await aChat(recipientBotId);
			const recipientProjectId = await runOnPostgres(defaultProjectOf(recipientBotId));
			expect(await view.attentionMarks(workspaceId)).toEqual({ projects: {} });

			await botWrites(current.id, "Hello!");
			await botWrites(current.id, "Are you there?", 1);
			await onDatabase((db) =>
				db.insert(message).values({
					chatId: other.id,
					authorBotId: recipientBotId,
					status: "complete",
					parts: [{ type: "text", text: "Morning" }],
					content: "Morning",
				}),
			);

			expect(await view.attentionMarks(workspaceId)).toEqual({
				projects: {
					[botProjectId]: { unreadMessages: 2, needsApproval: false, failedAutomations: 0 },
					[recipientProjectId]: { unreadMessages: 1, needsApproval: false, failedAutomations: 0 },
				},
			});
		});

		it("marks a project members made by its automation feeds and failing automations, as it does a bot", async () => {
			const created = await automations.create(
				{ projectId },
				{ name: "Nightly", instructions: "Check the build.", triggers: [{ kind: "webhook" }] },
			);
			const feed = await chats.openAutomationFeed({
				workspace: workspaceId,
				automationId: created.automation.id,
			});
			await chats.markRead(feed.id);
			await botWrites(feed.id, "The build is red.", 1);
			const accepted = await automations.run({
				projectId,
				automationId: created.automation.id,
				requestId: crypto.randomUUID(),
			});
			await onDatabase((db) =>
				db
					.update(automationRun)
					.set({
						state: "failed",
						startedAt: sql`${automationRun.acceptedAt}`,
						finishedAt: sql`${automationRun.acceptedAt} + interval '1 minute'`,
						error: userText`The reply took too long and was stopped.`,
					})
					.where(eq(automationRun.id, accepted.runId)),
			);

			expect((await view.attentionMarks(workspaceId)).projects[projectId]).toEqual({
				unreadMessages: 1,
				needsApproval: false,
				failedAutomations: 1,
			});
		});

		it("marks a chat waiting on a tool call the member may decide", async () => {
			const current = await aChat();
			await chats.post({
				chatId: current.id,
				messageId: crypto.randomUUID(),
				content: "File it",
			});
			// A reply that called a tool without writing a word first.
			const trigger = await botWrites(current.id, "", 1);
			const [asked] = await onDatabase((db) =>
				db
					.insert(turn)
					.values({
						chatId: current.id,
						botId,
						triggerMessageId: trigger.id,
						status: "waiting",
						model: "test/model",
						startedAt: new Date(),
					})
					.returning({ id: turn.id }),
			);
			if (!asked) throw new Error("fixture");
			await onDatabase((db) =>
				db.insert(toolCall).values({
					chatId: current.id,
					messageId: trigger.id,
					turnId: asked.id,
					tool: "linear__create_issue",
					approvalId: `approval-${crypto.randomUUID()}`,
					approvalStatus: "pending",
					status: "awaiting_approval",
					input: {},
					atOffset: 0,
				}),
			);

			// An automation run elsewhere, so an approval outside any run must not be taken for one.
			const [recipientProject] = await onDatabase((db) =>
				db
					.select({ id: project.id })
					.from(project)
					.where(eq(project.defaultOfBotId, recipientBotId)),
			);
			if (!recipientProject) throw new Error("The recipient bot has no default project");
			const elsewhere = await automations.create(
				{ projectId: recipientProject.id },
				{ name: "Elsewhere", instructions: "Run somewhere else.", triggers: [{ kind: "webhook" }] },
			);
			await automations.run({
				projectId: recipientProject.id,
				automationId: elsewhere.automation.id,
				requestId: crypto.randomUUID(),
			});

			expect(await hostRow()).toMatchObject({ needsApproval: true });
			expect((await view.attentionMarks(workspaceId)).projects[botProjectId]).toEqual({
				unreadMessages: 0,
				needsApproval: true,
				failedAutomations: 0,
			});
		});

		describe("what the bot is doing in a chat", () => {
			const startedAt = new Date("2026-11-20T09:00:00.000Z");
			const askedAt = new Date("2026-11-20T09:05:00.000Z");
			const finishedAt = new Date("2026-11-20T09:10:00.000Z");

			/** The host's turn in `chatId`, answering a message of the member's, with its reply. */
			const aTurn = async (chatId: string, status: TurnStatus) => {
				const [asking] = await onDatabase((db) =>
					db
						.insert(message)
						.values({
							chatId,
							authorMemberId: memberId,
							status: "complete",
							parts: [{ type: "text", text: "Deploy it" }],
							content: "Deploy it",
							createdAt: new Date(startedAt.getTime() - 1000),
						})
						.returning(),
				);
				if (!asking) throw new Error("fixture");
				const ended = status !== "running" && status !== "waiting";
				const [started] = await onDatabase((db) =>
					db
						.insert(turn)
						.values({
							chatId,
							botId,
							triggerMessageId: asking.id,
							status,
							model: "test/model",
							startedAt,
							finishedAt: ended ? finishedAt : null,
							error: status === "failed" ? userText`The model could not be reached.` : null,
						})
						.returning({ id: turn.id }),
				);
				if (!started) throw new Error("fixture");
				const [reply] = await onDatabase((db) =>
					db
						.insert(message)
						.values({
							chatId,
							authorBotId: botId,
							turnId: started.id,
							status: ended ? "complete" : "writing",
							parts: ended ? [{ type: "text", text: "Deployed." }] : [],
							content: ended ? "Deployed." : "",
							createdAt: startedAt,
						})
						.returning(),
				);
				if (!reply) throw new Error("fixture");
				return { turnId: started.id, reply };
			};

			it("says a bot is working since its turn started", async () => {
				const current = await aChat();
				await aTurn(current.id, "running");

				expect(await hostRow()).toMatchObject({
					status: { kind: "working", since: startedAt.toISOString() },
				});
			});

			it("says a bot is waiting since its tool call asked for an approval", async () => {
				const current = await aChat();
				const { turnId, reply } = await aTurn(current.id, "waiting");
				await onDatabase((db) =>
					db.insert(toolCall).values({
						chatId: current.id,
						messageId: reply.id,
						turnId,
						tool: "linear__create_issue",
						approvalId: `approval-${crypto.randomUUID()}`,
						approvalStatus: "pending",
						status: "awaiting_approval",
						input: {},
						atOffset: 0,
						startedAt: askedAt,
					}),
				);

				expect(await hostRow()).toMatchObject({
					status: { kind: "waiting", since: askedAt.toISOString() },
				});
			});

			it("says a bot finished its reply until the member reads it", async () => {
				const current = await aChat();
				await aTurn(current.id, "done");

				expect(await hostRow()).toMatchObject({
					status: { kind: "replied", at: finishedAt.toISOString() },
				});

				await chats.markRead(current.id);
				expect(await hostRow()).toMatchObject({ status: null });
			});

			it("says nothing of a turn that failed", async () => {
				const current = await aChat();
				await aTurn(current.id, "failed");

				expect(await hostRow()).toMatchObject({ status: null });
			});
		});
	});

	it("lists a project the member is in, and hides one they are not", async () => {
		const unjoined = await onDatabase((db) =>
			seedProject(db, {
				workspaceId,
				name: "Elsewhere",
				slug: `elsewhere-${crypto.randomUUID()}`,
				visibility: "private",
				createdById: administratorId,
			}),
		);
		if (!unjoined) throw new Error("Could not create the project");

		await expect(view.chats(unjoined.id)).rejects.toMatchObject({ _tag: "ResourceHidden" });
		expect(await view.chats(projectId)).toEqual({ chats: [], automations: [] });
	});

	describe("the interview a new bot starts with its creator", () => {
		const interviewDue = (changes: Partial<typeof bot.$inferInsert> = {}) =>
			onDatabase((db) =>
				db
					.update(bot)
					.set({ instructions: INTERVIEW_PROMPT, ...changes })
					.where(eq(bot.id, botId)),
			);

		it("starts once, in a chat named for the bot, without posting a message for the creator", async () => {
			await interviewDue();
			const opened = await chats.startInterview(botId);
			if (!opened) throw new Error("The interview did not start");
			expect(opened).toMatchObject({ botId, title: "Setting up Own Bot" });
			expect(await chats.startInterview(botId)).toBeNull();
			expect((await view.messages(opened.id)).items).toEqual([]);
			const runs = await runOnPostgres(runningTurns(opened.id));
			expect(runs).toHaveLength(1);
			const run = runs[0];
			if (!run) throw new Error("The interview did not start");
			const execution = onPostgres({
				prepare: Context.get(services, TurnExecution.Service).prepare,
			});
			const prepared = await prepareRunnable(execution, run);
			expect(prepared.responseMessage.id).toBe(run.request.triggerMessageId);
			const prompt = modelPrompt(prepared.context, {
				now: new Date("2026-10-26T00:00:00Z"),
				builtInTools: [],
				toolCatalog: undefined,
				computer: undefined,
			});
			expect(prompt.messages).toHaveLength(1);
			expect(prompt.messages[0]?.content).toContain("Start the interview now");
			expect(prompt.messages[0]?.content).toContain("They have not sent a message yet");
			const resumed = await prepareRunnable(execution, run);
			expect(resumed.responseMessage.id).toBe(prepared.responseMessage.id);
			expect(await runOnPostgres(runningTurns(opened.id))).toHaveLength(1);
			expect(
				await onDatabase((db) =>
					db
						.select()
						.from(laneRequest)
						.where(eq(laneRequest.laneKey, `turn:${opened.id}:${botId}`)),
				),
			).toEqual([]);
			const messages = (await view.messages(opened.id)).items;
			expect(messages).toHaveLength(1);
			expect(messages[0]).toMatchObject({
				kind: "message",
				message: { author: { kind: "bot", id: botId } },
			});
		});

		it("starts only for the bot's creator", async () => {
			await interviewDue({ createdById: administratorId });

			await expect(chats.startInterview(botId)).rejects.toMatchObject({
				_tag: "ActionForbidden",
			});
			const creator = onPostgresAs(administratorId)(Context.get(services, Chats.Service));
			const opened = await creator.startInterview(botId);
			if (!opened) throw new Error("The interview did not start");
			expect(await runOnPostgres(runningTurns(opened.id))).toHaveLength(1);
		});

		it("starts once a missing model is configured", async () => {
			await interviewDue({ model: null });
			expect(await chats.startInterview(botId)).toBeNull();

			await onDatabase((db) =>
				db.update(bot).set({ model: "test/model" }).where(eq(bot.id, botId)),
			);

			const opened = await chats.startInterview(botId);
			if (!opened) throw new Error("The interview did not start");
			expect(await runOnPostgres(runningTurns(opened.id))).toHaveLength(1);
		});

		it("does not start for a bot that already has a chat", async () => {
			await aChat();
			await interviewDue();

			expect(await chats.startInterview(botId)).toBeNull();
		});

		it.each(["", "Help with releases"])(
			"does not start for a bot with written instructions %j",
			async (instructions) => {
				await onDatabase((db) => db.update(bot).set({ instructions }).where(eq(bot.id, botId)));

				expect(await chats.startInterview(botId)).toBeNull();
			},
		);
	});

	it("starts a chat in a project, where its lead answers a message that names no bot, and a bot it names answers otherwise", async () => {
		const { chat: first } = await chats.startProjectChat({
			projectId,
			messageId: crypto.randomUUID(),
			content: "Morning, all.",
		});
		expect(first).toMatchObject({ kind: "project_chat", projectId, title: "Morning, all." });
		const [recipient] = await onDatabase((db) =>
			db.select({ handle: bot.handle }).from(bot).where(eq(bot.id, recipientBotId)),
		);

		expect(await runOnPostgres(runningTurns(first.id))).toEqual([
			expect.objectContaining({ request: expect.objectContaining({ botId, reason: "default" }) }),
		]);

		await chats.post({
			chatId: first.id,
			messageId: crypto.randomUUID(),
			content: `@${recipient?.handle} can you look at this?`,
		});

		expect(await runOnPostgres(runningTurns(first.id))).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					request: expect.objectContaining({ botId: recipientBotId, reason: "mention" }),
				}),
			]),
		);
	});

	it("lets those who manage a project, and nobody else in it, decide its computer's requests, whichever bot asks", async () => {
		const chat = await namedChat(projectId, "General");
		await onDatabase((db) =>
			db.insert(chatParticipant).values([
				{ chatId: chat.id, botId },
				{ chatId: chat.id, botId: recipientBotId },
			]),
		);
		const approves = (memberId: string) =>
			onPostgresAs(memberId)(Context.get(services, ChatDetailsView.Service))
				.get(chat.id)
				.then((details) => details.permissions?.approveComputerRequests);

		// The editor made the bot, but the computer is the project's.
		expect(await approves(memberId)).toBe(false);
		expect(await approves(administratorId)).toBe(true);
	});

	it("asks the bot a message in a project's chat replies to, though it names nobody", async () => {
		const projectChat = await namedChat(projectId, "General");
		const [answer] = await onDatabase((db) =>
			db
				.insert(message)
				.values({
					chatId: projectChat.id,
					authorBotId: botId,
					status: "complete",
					parts: [{ type: "text", text: "Nothing logged for yesterday." }],
					content: "Nothing logged for yesterday.",
				})
				.returning({ id: message.id }),
		);
		if (!answer) throw new Error("The bot's message was not written");

		await chats.post({
			chatId: projectChat.id,
			messageId: crypto.randomUUID(),
			content: "Do you have saved automations?",
			replyTo: answer.id,
		});

		expect(await runOnPostgres(runningTurns(projectChat.id))).toEqual([
			expect.objectContaining({ request: expect.objectContaining({ botId, reason: "reply" }) }),
		]);
	});

	it("lets a bot decline a message in its chat to a member in it, but answer a handle that is nobody's", async () => {
		const chat = await aChat();

		await chats.post({
			chatId: chat.id,
			messageId: crypto.randomUUID(),
			content: "@chat-editor can you look at this?",
		});

		expect(await runOnPostgres(runningTurns(chat.id))).toEqual([
			expect.objectContaining({ request: expect.objectContaining({ botId, reason: "optional" }) }),
		]);

		const another = await aChat();
		await chats.post({
			chatId: another.id,
			messageId: crypto.randomUUID(),
			content: "Please raise this with @Backlog Manager, high priority.",
		});

		expect(await runOnPostgres(runningTurns(another.id))).toEqual([
			expect.objectContaining({ request: expect.objectContaining({ botId, reason: "default" }) }),
		]);
	});

	it("lets a public bot decline a message in its chat to a member who reaches it but has never taken part", async () => {
		const chat = await aChat();

		await chats.post({
			chatId: chat.id,
			messageId: crypto.randomUUID(),
			content: "@chat-admin can you look at this?",
		});

		expect(await runOnPostgres(runningTurns(chat.id))).toEqual([
			expect.objectContaining({ request: expect.objectContaining({ botId, reason: "optional" }) }),
		]);
	});

	it("offers for mention in a public bot's chat everyone who reaches the bot, as the floor reads them", async () => {
		const chat = await aChat();

		const details = await onPostgresAs(memberId)(
			Context.get(services, ChatDetailsView.Service),
		).get(chat.id);

		// The bot's default project has no members; the admin reaches it through the bot.
		expect(details.membersReachingProject.map(({ id }) => id)).toEqual(
			expect.arrayContaining([memberId, administratorId]),
		);
	});

	it("answers a mention in a personal bot's chat of a member who does not reach the bot", async () => {
		await onDatabase((db) =>
			db.update(bot).set({ visibility: "personal" }).where(eq(bot.id, botId)),
		);
		const chat = await aChat();

		await chats.post({
			chatId: chat.id,
			messageId: crypto.randomUUID(),
			content: "@chat-admin can you look at this?",
		});

		expect(await runOnPostgres(runningTurns(chat.id))).toEqual([
			expect.objectContaining({ request: expect.objectContaining({ botId, reason: "default" }) }),
		]);
	});

	it("lets a bot decline a message in its chat to someone who left the workspace but is still in the chat", async () => {
		const chat = await aChat();
		const [former] = await onDatabase((db) =>
			db
				.insert(member)
				.values({ name: "Former teammate", email: `former-${crypto.randomUUID()}@example.com` })
				.returning(),
		);
		if (!former) throw new Error("Could not create the former teammate");
		await onDatabase((db) =>
			db.insert(chatParticipant).values({ chatId: chat.id, memberId: former.id }),
		);

		await chats.post({
			chatId: chat.id,
			messageId: crypto.randomUUID(),
			content: "@former-teammate are you still around?",
		});

		expect(await runOnPostgres(runningTurns(chat.id))).toEqual([
			expect.objectContaining({ request: expect.objectContaining({ botId, reason: "optional" }) }),
		]);
	});

	it("starts a chat in a project from its first message, which its lead bot answers, once", async () => {
		await onDatabase((db) =>
			db.update(project).set({ leadBotId: botId }).where(eq(project.id, projectId)),
		);
		const input = {
			projectId,
			messageId: crypto.randomUUID(),
			content: "Plan the launch\nby Friday",
		};

		const started = await chats.startProjectChat(input);

		expect(started.chat).toMatchObject({
			projectId,
			botId: null,
			title: "Plan the launch by Friday",
		});
		expect(started.message).toMatchObject({ id: input.messageId });
		expect(await runOnPostgres(runningTurns(started.chat.id))).toEqual([
			expect.objectContaining({ request: expect.objectContaining({ botId }) }),
		]);
		expect((await chats.startProjectChat(input)).chat.id).toBe(started.chat.id);
		await expect(startBotChat(chats, { botId, ...input })).rejects.toMatchObject({
			_tag: "MessageIdConflict",
		});
	});

	it("starts a chat in a project members made with its lead in it, though the first message asks another bot", async () => {
		await onDatabase((db) =>
			db.update(project).set({ leadBotId: recipientBotId }).where(eq(project.id, projectId)),
		);
		const [host] = await onDatabase((db) =>
			db.select({ handle: bot.handle }).from(bot).where(eq(bot.id, botId)),
		);
		// Asking another bot, so the lead is not brought in by being asked.
		const started = await chats.startProjectChat({
			projectId,
			messageId: crypto.randomUUID(),
			content: `@${host?.handle} can you look?`,
		});

		const details = await onPostgresAs(memberId)(
			Context.get(services, ChatDetailsView.Service),
		).get(started.chat.id);
		expect(details.participants.map(({ kind, id }) => ({ kind, id }))).toEqual(
			expect.arrayContaining([
				{ kind: "member", id: memberId },
				{ kind: "bot", id: recipientBotId },
			]),
		);
	});

	it("lists a project's chat with what the member has not read in it, and counts that in the sidebar", async () => {
		const projectChat = await namedChat(projectId, "General");
		await onDatabase((db) =>
			db.insert(message).values({
				chatId: projectChat.id,
				authorMemberId: administratorId,
				status: "complete",
				parts: [{ type: "text", text: "Lunch?" }],
				content: "Lunch?",
			}),
		);

		expect((await view.chats(projectId)).chats).toEqual([
			{
				chat: expect.objectContaining({ id: projectChat.id }),
				lastMessageAt: expect.any(String),
				participants: [expect.objectContaining({ kind: "member", id: administratorId })],
				messageCount: 1,
				unreadMessages: 1,
				needsApproval: false,
				mentionsYou: false,
				status: null,
			},
		]);
		expect(await view.attentionMarks(workspaceId)).toEqual({
			projects: { [projectId]: { unreadMessages: 1, needsApproval: false, failedAutomations: 0 } },
		});
	});

	it("lists the project's chats, the newest message first, by their names", async () => {
		const general = await namedChat(projectId, "General");
		const pricing = await namedChat(projectId, "Pricing");
		await namedChat(projectId, "Launch");

		const listed = async () => (await view.chats(projectId)).chats.map(({ chat }) => chat.title);
		expect(await listed()).toEqual(["Launch", "Pricing", "General"]);

		await chats.post({
			chatId: general.id,
			messageId: crypto.randomUUID(),
			content: "Morning, all.",
		});
		expect(await listed()).toEqual(["General", "Launch", "Pricing"]);

		// Renaming a chat is for whoever may change the project.
		const administering = onPostgresAs(administratorId)(Context.get(services, Chats.Service));
		await administering.renameChat({ chatId: pricing.id, name: "Prices" });

		expect(await listed()).toEqual(["General", "Launch", "Prices"]);
	});

	it("leaves renaming a project's chat to whoever may change the project", async () => {
		const pricing = await namedChat(projectId, "Pricing");

		// The editor the chats are with may start one, but not change the project.
		await expect(chats.renameChat({ chatId: pricing.id, name: "Prices" })).rejects.toMatchObject({
			_tag: "ActionForbidden",
		});
	});

	it.each([
		{ placement: "the bot's own chat", chat: () => aChat() },
		// The project's lead, the host, would answer.
		{ placement: "a project members made", chat: () => namedChat(projectId, "General") },
	])(
		"refuses a message in $placement when the bot that would answer has no model, and saves nothing",
		async ({ chat }) => {
			await onDatabase((db) => db.update(bot).set({ model: null }).where(eq(bot.id, botId)));
			const current = await chat();
			const messageId = crypto.randomUUID();

			await expect(
				chats.post({ chatId: current.id, messageId, content: "Anyone there?" }),
			).rejects.toMatchObject({ _tag: "BotHasNoModel" });
			expect(
				await onDatabase((db) => db.select().from(message).where(eq(message.id, messageId))),
			).toHaveLength(0);
			expect(await runOnPostgres(runningTurns(current.id))).toHaveLength(0);
		},
	);

	it("delivers a message for members only in a project members made, though its lead has no model", async () => {
		await onDatabase((db) => db.update(bot).set({ model: null }).where(eq(bot.id, botId)));
		const chat = await namedChat(projectId, "General");
		const messageId = crypto.randomUUID();

		// It offers the lead a turn it may decline, which it can't take.
		await chats.post({ chatId: chat.id, messageId, content: "@chat-editor over to you" });
		expect(
			await onDatabase((db) => db.select().from(message).where(eq(message.id, messageId))),
		).toHaveLength(1);
		expect(await runOnPostgres(runningTurns(chat.id))).toHaveLength(0);
	});

	it("retries the same message without creating another message or turn", async () => {
		const current = await aChat();
		const send = {
			chatId: current.id,
			messageId: crypto.randomUUID(),
			content: "A simple question",
		};
		const messageId = send.messageId;
		const [first, retried] = await Promise.all([chats.post(send), chats.post(send)]);
		expect(retried).toEqual(first);
		await expect(chats.post({ ...send, content: "Another question" })).rejects.toMatchObject({
			_tag: "MessageIdConflict",
		});
		expect(
			await onDatabase((db) => db.select().from(message).where(eq(message.id, messageId))),
		).toHaveLength(1);
		expect(await runOnPostgres(runningTurns(current.id))).toHaveLength(1);
		expect(
			await onDatabase((db) =>
				db
					.select()
					.from(laneRequest)
					.where(like(laneRequest.laneKey, `turn:${current.id}:%`)),
			),
		).toHaveLength(0);
	});

	it("quotes the message a reply answers, but only one in the same chat", async () => {
		const current = await aChat();
		const elsewhere = await aChat(recipientBotId);
		const asked = await chats.post({
			chatId: current.id,
			messageId: crypto.randomUUID(),
			content: "Ship the **release** today\nand tell the team",
		});
		const other = await chats.post({
			chatId: elsewhere.id,
			messageId: crypto.randomUUID(),
			content: "Something else",
		});

		const reply = await chats.post({
			chatId: current.id,
			messageId: crypto.randomUUID(),
			content: "Actually, tomorrow",
			replyTo: asked.id,
		});

		const quoted = { id: asked.id, author: asked.author, preview: "Ship the release today" };
		expect(reply.replyTo).toEqual(quoted);
		const page = await view.messages(current.id);
		expect(page.items).toContainEqual(
			expect.objectContaining({
				message: expect.objectContaining({ id: reply.id, replyTo: quoted }),
			}),
		);
		await expect(
			chats.post({
				chatId: current.id,
				messageId: crypto.randomUUID(),
				content: "About that",
				replyTo: other.id,
			}),
		).rejects.toMatchObject({ _tag: "ReplyTargetNotFound" });
	});

	it("lets members react to a message once per emoji, announcing each change", async () => {
		const reactions = onPostgresAs(memberId)(Context.get(services, Reactions.Service));
		const current = await aChat();
		const asked = await chats.post({
			chatId: current.id,
			messageId: crypto.randomUUID(),
			content: "Ship it?",
		});
		const announced = () =>
			onDatabase((db) =>
				db
					.select({ payload: event.payload })
					.from(event)
					.where(
						and(
							eq(event.stream, chatStream(current.id)),
							eq(event.type, "message.reactions_changed"),
						),
					)
					.orderBy(event.seq),
			);

		const added = await reactions.add(asked.id, "👍🏽");
		expect(added).toEqual([
			{ emoji: "👍🏽", members: [{ id: memberId, name: "Chat editor", at: expect.any(String) }] },
		]);
		expect(await reactions.add(asked.id, "👍🏽")).toEqual(added);
		const page = await view.messages(current.id);
		expect(page.items).toContainEqual(
			expect.objectContaining({
				message: expect.objectContaining({ id: asked.id, reactions: added }),
			}),
		);
		expect(await reactions.remove(asked.id, "👍🏽")).toEqual([]);
		expect(await reactions.remove(asked.id, "👍🏽")).toEqual([]);
		expect((await announced()).map(({ payload }) => payload)).toEqual([
			expect.objectContaining({ messageId: asked.id, reactions: added }),
			expect.objectContaining({ messageId: asked.id, reactions: [] }),
		]);

		const [stranger] = await onDatabase((db) =>
			db
				.insert(member)
				.values({ name: "Stranger", email: `stranger-${crypto.randomUUID()}@example.com` })
				.returning(),
		);
		if (!stranger) throw new Error("Could not create a stranger");
		const strangers = onPostgresAs(stranger.id)(Context.get(services, Reactions.Service));
		await expect(strangers.add(asked.id, "👍🏽")).rejects.toMatchObject({ _tag: "ResourceHidden" });
	});

	it("refuses a reaction to a reply still being written, and a new emoji past the limit", async () => {
		const reactions = onPostgresAs(memberId)(Context.get(services, Reactions.Service));
		const current = await aChat();
		const asked = await chats.post({
			chatId: current.id,
			messageId: crypto.randomUUID(),
			content: "Ship it?",
		});
		const [writing] = await onDatabase((db) =>
			db
				.insert(message)
				.values({
					chatId: current.id,
					authorBotId: botId,
					status: "writing",
					parts: [],
					content: "",
				})
				.returning(),
		);
		if (!writing) throw new Error("Could not start a reply");
		await expect(reactions.add(writing.id, "👍")).rejects.toMatchObject({
			_tag: "MessageNotFinished",
		});

		const used = Array.from("😀😃😄😁😆😅😂🤣😊😇🙂🙃😉😌😍🥰😘😗😙😚");
		await onDatabase((db) =>
			db
				.insert(messageReaction)
				.values(used.map((emoji) => ({ messageId: asked.id, memberId: administratorId, emoji }))),
		);
		await expect(reactions.add(asked.id, "🎉")).rejects.toMatchObject({
			_tag: "TooManyReactionEmoji",
		});
		const joined = await reactions.add(asked.id, "😀");
		expect(joined[0]?.members.map((somebody) => somebody.id)).toEqual([administratorId, memberId]);
	});

	it("says which messages wait for the bot's next turn, and announces when one starts waiting", async () => {
		const chatDetailsView = onPostgresAs(memberId)(Context.get(services, ChatDetailsView.Service));
		const current = await aChat();
		const post = (content: string) =>
			chats.post({ chatId: current.id, messageId: crypto.randomUUID(), content });
		const changesAnnounced = async () =>
			(
				await onDatabase((db) =>
					db
						.select({ type: event.type })
						.from(event)
						.where(eq(event.stream, chatStream(current.id))),
				)
			).filter(({ type }) => type === "chat.changed").length;

		await post("Is checkout timing out?");
		expect((await chatDetailsView.get(current.id)).queuedSince).toBeNull();
		const changedBefore = await changesAnnounced();

		const followUp = await post("The Stripe webhook too?");
		await post("Started around 9.");

		expect((await chatDetailsView.get(current.id)).queuedSince).toBe(followUp.createdAt);
		// Once, when the turn started waiting; the next message joins it.
		expect((await changesAnnounced()) - changedBefore).toBe(1);
	});

	it("queues nothing posted before a hand-back on an earlier reply starts waiting", async () => {
		const chatDetailsView = onPostgresAs(memberId)(Context.get(services, ChatDetailsView.Service));
		const turns = Context.get(services, Turns.Service);
		const current = await aChat();
		const asked = await chats.post({
			chatId: current.id,
			messageId: crypto.randomUUID(),
			content: "Who owns checkout?",
		});

		// A hand-back answers an earlier message, which is long since answered.
		await runOnPostgres(
			turns.ask({
				chatId: current.id,
				botId,
				triggerMessageId: asked.id,
				reason: "hand_back",
			}),
		);
		const later = await chats.post({
			chatId: current.id,
			messageId: crypto.randomUUID(),
			content: "And billing?",
		});

		const { queuedSince } = await chatDetailsView.get(current.id);
		expect(Date.parse(queuedSince ?? "")).toBeGreaterThan(Date.parse(asked.createdAt));
		expect(Date.parse(queuedSince ?? "")).toBeLessThanOrEqual(Date.parse(later.createdAt));
	});

	it("announces a member's message before the bot it brings into the chat", async () => {
		const current = await aChat();
		// The chat's bot has not joined it yet, so the message brings it in.
		await onDatabase((db) =>
			db
				.delete(chatParticipant)
				.where(and(eq(chatParticipant.chatId, current.id), eq(chatParticipant.botId, botId))),
		);

		await chats.post({
			chatId: current.id,
			messageId: crypto.randomUUID(),
			content: "Are you there?",
		});

		const announced = await onDatabase((db) =>
			db
				.select({ type: event.type })
				.from(event)
				.where(eq(event.stream, chatStream(current.id)))
				.orderBy(event.seq),
		);
		expect(announced.slice(0, 2).map(({ type }) => type)).toEqual([
			"message.created",
			"chat.changed",
		]);
	});

	it("lists automation runs in the automation's feed", async () => {
		const created = await automations.create(
			{ projectId: botProjectId },
			{
				name: "Overnight review",
				instructions: "Review overnight changes.",
				triggers: [{ kind: "webhook" }],
			},
		);
		const requestId = crypto.randomUUID();
		const accepted = await automations.run({
			projectId: botProjectId,
			automationId: created.automation.id,
			requestId,
		});
		// The automation's feed, where its runs are listed.
		const current = await chats.openAutomationFeed({
			workspace: workspaceId,
			automationId: created.automation.id,
		});

		expect((await view.messages(current.id))?.items).toEqual([
			expect.objectContaining({
				kind: "run",
				id: accepted.runId,
				chatId: accepted.chatId,
				automationName: "Overnight review",
				triggerKind: "manual",
			}),
		]);
	});

	it("paginates interleaved messages and automation runs in an automation's feed without gaps", async () => {
		const created = await automations.create(
			{ projectId: botProjectId },
			{
				name: "Overnight review",
				instructions: "Review overnight changes.",
				triggers: [{ kind: "webhook" }],
			},
		);
		const requestId = crypto.randomUUID();
		const accepted = await automations.run({
			projectId: botProjectId,
			automationId: created.automation.id,
			requestId,
		});
		// The automation's feed, where its runs are listed.
		const current = await chats.openAutomationFeed({
			workspace: workspaceId,
			automationId: created.automation.id,
		});
		const olderMessageId = crypto.randomUUID();
		const newerMessageId = crypto.randomUUID();
		await onDatabase((db) =>
			db.insert(message).values([
				{
					id: olderMessageId,
					chatId: current.id,
					authorMemberId: memberId,
					status: "complete",
					parts: [{ type: "text", text: "Older message" }],
					content: "Older message",
					createdAt: new Date("2026-09-18T09:00:00.000Z"),
				},
				{
					id: newerMessageId,
					chatId: current.id,
					authorMemberId: memberId,
					status: "complete",
					parts: [{ type: "text", text: "Newer message" }],
					content: "Newer message",
					createdAt: new Date("2026-09-18T11:00:00.000Z"),
				},
			]),
		);
		await onDatabase((db) =>
			db
				.update(automationRun)
				.set({ acceptedAt: new Date("2026-09-18T10:00:00.000Z") })
				.where(eq(automationRun.id, accepted.runId)),
		);

		const firstPage = await view.messages(current.id, { limit: 2 });
		expect(firstPage?.items.map(timelineItemId)).toEqual([accepted.runId, newerMessageId]);
		expect(firstPage?.nextCursor).toBeTypeOf("string");
		if (!firstPage?.nextCursor) throw new Error("Expected another Chat timeline page");

		const secondPage = await view.messages(current.id, {
			limit: 2,
			cursor: firstPage.nextCursor,
		});
		expect(secondPage?.items.map(timelineItemId)).toEqual([olderMessageId]);
		expect(secondPage?.nextCursor).toBeNull();
	});

	it("reports each run the chat lists with its own status and automation", async () => {
		const created = await automations.create(
			{ projectId: botProjectId },
			{
				name: "Overnight review",
				instructions: "Review overnight changes.",
				triggers: [{ kind: "webhook" }],
			},
		);
		const requestId = crypto.randomUUID();
		const accepted = await automations.run({
			projectId: botProjectId,
			automationId: created.automation.id,
			requestId,
		});
		// The automation's feed, where its runs are listed.
		const current = await chats.openAutomationFeed({
			workspace: workspaceId,
			automationId: created.automation.id,
		});
		const items = (await view.history(current.id))?.items ?? [];
		const entry = (chatId: string) => items.find((item) => item.chatId === chatId);
		expect(items).toHaveLength(1);
		expect(entry(accepted.chatId)).toMatchObject({
			kind: "run",
			status: "queued",
			automationRun: {
				runId: accepted.runId,
				automationId: created.automation.id,
				automationName: "Overnight review",
				triggerKind: "manual",
			},
		});
	});

	describe("the approvals and mentions waiting for a member across a workspace", () => {
		/** The host writes `content` in `chatId`, `secondsLater` after now, and returns the message. */
		const botWrites = async (chatId: string, content: string, secondsLater = 0) => {
			const [written] = await onDatabase((db) =>
				db
					.insert(message)
					.values({
						chatId,
						authorBotId: botId,
						status: "complete",
						parts: content ? [{ type: "text", text: content }] : [],
						content,
						createdAt: new Date(Date.now() + secondsLater * 1000),
					})
					.returning(),
			);
			if (!written) throw new Error("fixture");
			return written;
		};

		/** The run completes, posting `content` as its result in the automation's feed. */
		const runPosts = async (run: { runId: string; chatId: string }, content: string) => {
			await onDatabase((db) =>
				db
					.update(automationRun)
					.set({
						state: "completed",
						startedAt: sql`${automationRun.acceptedAt}`,
						finishedAt: sql`${automationRun.acceptedAt} + interval '1 minute'`,
					})
					.where(eq(automationRun.id, run.runId)),
			);
			const [runChat] = await onDatabase((db) =>
				db
					.select({ rootChatId: placedChat.rootChatId })
					.from(placedChat)
					.where(eq(placedChat.id, run.chatId)),
			);
			const feedId = runChat?.rootChatId;
			if (!feedId) throw new Error("fixture");
			await onDatabase((db) =>
				db.insert(message).values({
					chatId: feedId,
					authorBotId: botId,
					runId: run.runId,
					status: "complete",
					parts: [{ type: "text", text: content }],
					content,
				}),
			);
		};

		/** A reply in the chat that called `tool` and stopped for someone to approve it. */
		const askForApproval = async (
			chatId: string,
			tool = "linear__create_issue",
			askingBotId = botId,
		) => {
			const reply = await botWrites(chatId, "", 1);
			const [asked] = await onDatabase((db) =>
				db
					.insert(turn)
					.values({
						chatId,
						botId: askingBotId,
						triggerMessageId: reply.id,
						status: "waiting",
						model: "test/model",
						startedAt: new Date(),
					})
					.returning({ id: turn.id }),
			);
			if (!asked) throw new Error("fixture");
			const [call] = await onDatabase((db) =>
				db
					.insert(toolCall)
					.values({
						chatId,
						messageId: reply.id,
						turnId: asked.id,
						tool,
						approvalId: `approval-${crypto.randomUUID()}`,
						approvalStatus: "pending",
						status: "awaiting_approval",
						input: { title: "Checkout times out" },
						atOffset: 0,
					})
					.returning({ id: toolCall.id }),
			);
			if (!call) throw new Error("fixture");
			return call.id;
		};

		it("lists a call waiting on the member's decision, then among the answered once decided", async () => {
			const current = await aChat();
			const callId = await askForApproval(current.id);

			expect(await view.approvals(workspaceId)).toEqual({
				waiting: [
					expect.objectContaining({
						call: expect.objectContaining({ id: callId, tool: "linear__create_issue" }),
						bot: expect.objectContaining({ id: botId }),
						projectId: null,
						chatId: current.id,
						rootChatId: current.id,
					}),
				],
				answered: [],
			});

			await onDatabase((db) =>
				db
					.update(toolCall)
					.set({ approvalStatus: "denied", decidedById: administratorId, decidedAt: new Date() })
					.where(eq(toolCall.id, callId)),
			);

			const approvals = await view.approvals(workspaceId);
			expect(approvals.waiting).toEqual([]);
			expect(approvals.answered).toEqual([
				expect.objectContaining({
					call: expect.objectContaining({ id: callId }),
					answer: expect.objectContaining({ status: "denied", decidedByName: "Chat admin" }),
				}),
			]);
			// Nor is it listed in another workspace the member is in.
			const [elsewhere] = await onDatabase((db) =>
				db
					.insert(workspace)
					.values({ name: "Elsewhere", slug: `elsewhere-${crypto.randomUUID()}` })
					.returning(),
			);
			if (!elsewhere) throw new Error("fixture");
			await onDatabase((db) =>
				db.insert(membership).values({ workspaceId: elsewhere.id, memberId }),
			);
			expect((await view.approvals(elsewhere.id)).answered).toEqual([]);
		});

		it("lists a call waiting on the member's decision behind many they may not decide", async () => {
			// Made by the administrator, so the editor uses it but does not manage it.
			await onDatabase((db) =>
				db.update(bot).set({ createdById: administratorId }).where(eq(bot.id, botId)),
			);
			const current = await aChat();
			const created = await automations.create(
				{ projectId: botProjectId },
				{ name: "Overnight filing", instructions: "File it.", triggers: [{ kind: "webhook" }] },
			);
			const run = await automations.run({
				projectId: botProjectId,
				automationId: created.automation.id,
				requestId: crypto.randomUUID(),
			});
			// Only the bot's managers decide what an automation asks, and these are older than
			// every call the approvals page would list, so they would fill it first.
			const reply = await botWrites(run.chatId, "", 1);
			const [asked] = await onDatabase((db) =>
				db
					.insert(turn)
					.values({
						chatId: run.chatId,
						botId,
						triggerMessageId: reply.id,
						status: "waiting",
						model: "test/model",
						startedAt: new Date(),
					})
					.returning({ id: turn.id }),
			);
			if (!asked) throw new Error("fixture");
			const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
			await onDatabase((db) =>
				db.insert(toolCall).values(
					Array.from({ length: 101 }, () => ({
						chatId: run.chatId,
						messageId: reply.id,
						turnId: asked.id,
						tool: "linear__create_issue",
						approvalId: `approval-${crypto.randomUUID()}`,
						approvalStatus: "pending" as const,
						status: "awaiting_approval" as const,
						input: {},
						atOffset: 0,
						startedAt: hourAgo,
					})),
				),
			);
			const callId = await askForApproval(current.id);

			expect((await view.approvals(workspaceId)).waiting).toEqual([
				expect.objectContaining({ call: expect.objectContaining({ id: callId }) }),
			]);
		});

		it("leaves out a request to change the bot's computer, which only its managers decide", async () => {
			// Made by the administrator, so the editor uses it but does not manage it.
			await onDatabase((db) =>
				db.update(bot).set({ createdById: administratorId }).where(eq(bot.id, botId)),
			);
			const current = await aChat();
			await askForApproval(current.id, "request_host");
			const callId = await askForApproval(current.id);

			expect((await view.approvals(workspaceId)).waiting).toEqual([
				expect.objectContaining({ call: expect.objectContaining({ id: callId }) }),
			]);
		});

		/** How many unread messages and automation results mention the member. */
		const unreadForYou = async () => (await view.attention(workspaceId)).unreadForYou;

		it("lists and counts a message that mentions the member until they read it", async () => {
			const current = await aChat();
			await botWrites(current.id, "The deploy finished.", 1);
			const mention = await botWrites(current.id, "@chat-editor can you check it?", 2);

			expect(await view.unreadMentions(workspaceId, 10)).toEqual([
				expect.objectContaining({
					messageId: mention.id,
					preview: "@chat-editor can you check it?",
					chatId: current.id,
					projectSlug: null,
				}),
			]);
			expect(await unreadForYou()).toBe(1);

			await chats.markRead(current.id);

			expect(await view.unreadMentions(workspaceId, 10)).toEqual([]);
			expect(await unreadForYou()).toBe(0);
		});

		it("does not take an email address for a mention", async () => {
			const current = await aChat();
			await botWrites(current.id, "Mail it to ops@chat-editor.example", 1);

			expect(await unreadForYou()).toBe(0);
		});

		it("counts an automation run's result that mentions the member only once it is posted", async () => {
			const created = await automations.create(
				{ projectId: botProjectId },
				{ name: "Overnight review", instructions: "Review it.", triggers: [{ kind: "webhook" }] },
			);
			const runAutomation = () =>
				automations.run({
					projectId: botProjectId,
					automationId: created.automation.id,
					requestId: crypto.randomUUID(),
				});
			const asking = await runAutomation();
			await botWrites(asking.chatId, "@chat-editor the deploy needs your sign-off.", 1);

			expect(await unreadForYou()).toBe(0);

			await runPosts(asking, "@chat-editor the deploy needs your sign-off.");

			expect(await unreadForYou()).toBe(1);
		});

		it("shows what an automation run said in the automation's feed", async () => {
			const created = await automations.create(
				{ projectId: botProjectId },
				{ name: "Overnight review", instructions: "Review it.", triggers: [{ kind: "webhook" }] },
			);
			const accepted = await automations.run({
				projectId: botProjectId,
				automationId: created.automation.id,
				requestId: crypto.randomUUID(),
			});
			await botWrites(accepted.chatId, "Two PRs merged.\nThe release branch is green.", 1);
			const feed = (await view.chats(botProjectId)).automations[0]?.chat;

			expect((await view.messages(feed?.id ?? ""))?.items).toEqual([
				expect.objectContaining({
					kind: "run",
					chatId: accepted.chatId,
					report: "Two PRs merged.\nThe release branch is green.",
				}),
			]);
		});

		it("makes a run opened while it ran news again once it posts its result", async () => {
			const created = await automations.create(
				{ projectId: botProjectId },
				{ name: "Overnight review", instructions: "Review it.", triggers: [{ kind: "webhook" }] },
			);
			const run = await automations.run({
				projectId: botProjectId,
				automationId: created.automation.id,
				requestId: crypto.randomUUID(),
			});
			await chats.markNestedChatRead(run.chatId);

			await runPosts(run, "@chat-editor the deploy needs your sign-off.");

			expect(await unreadForYou()).toBe(1);
		});

		it("reads only the automation run opened, leaving the automation's other runs unread", async () => {
			const created = await automations.create(
				{ projectId: botProjectId },
				{ name: "Overnight review", instructions: "Review it.", triggers: [{ kind: "webhook" }] },
			);
			const runAutomation = () =>
				automations.run({
					projectId: botProjectId,
					automationId: created.automation.id,
					requestId: crypto.randomUUID(),
				});
			const earlier = await runAutomation();
			const opened = await runAutomation();
			const later = await runAutomation();
			for (const run of [earlier, opened, later]) await runPosts(run, "@chat-editor all green.");

			await chats.markNestedChatRead(opened.chatId);

			expect(await unreadForYou()).toBe(2);
		});

		it("refuses a chat that is not an automation run", async () => {
			const current = await aChat();

			await expect(chats.markNestedChatRead(current.id)).rejects.toMatchObject({
				_tag: "ResourceHidden",
			});
		});

		it("counts an automation run read with the automation's feed it is listed in", async () => {
			const created = await automations.create(
				{ projectId: botProjectId },
				{ name: "Overnight review", instructions: "Review it.", triggers: [{ kind: "webhook" }] },
			);
			const run = await automations.run({
				projectId: botProjectId,
				automationId: created.automation.id,
				requestId: crypto.randomUUID(),
			});
			await runPosts(run, "@chat-editor all green.");
			expect(await unreadForYou()).toBe(1);

			await chats.markRead(
				(
					await chats.openAutomationFeed({
						workspace: workspaceId,
						automationId: created.automation.id,
					})
				).id,
			);

			expect(await unreadForYou()).toBe(0);
		});
	});

	describe("sending files", () => {
		/** The chat, with the editor's uploads to it. */
		async function aChatWithFiles() {
			const { id: chatId } = await aChat();
			const files = onPostgresAs(memberId)(Context.get(services, ChatFiles.Service));
			const upload = (name: string) =>
				files.upload({
					chatId,
					name,
					type: "text/plain",
					stream: Stream.succeed(new TextEncoder().encode(name)),
				});
			return { chatId, files, upload };
		}
		const asPart = ({ id, name, contentType, size }: ChatFileStore.UnsentAttachment): FilePart => ({
			type: "file",
			id,
			name,
			contentType,
			size,
		});
		const shownMessage = async (chatId: string, messageId: string) =>
			(await view.messages(chatId)).items.find(
				(item) => item.kind === "message" && item.message.id === messageId,
			);

		it("sends the files with the message, in the order listed, for its readers to open", async () => {
			const { chatId, files, upload } = await aChatWithFiles();
			const first = await upload("a.txt");
			const second = await upload("b.txt");

			const sent = await chats.post({
				chatId,
				messageId: crypto.randomUUID(),
				content: "",
				attachments: [second.id, first.id],
			});

			expect(sent).toMatchObject({ content: "", parts: [asPart(second), asPart(first)] });
			expect(await shownMessage(chatId, sent.id)).toMatchObject({
				message: { parts: [asPart(second), asPart(first)] },
			});
			// Watching clients add the announced message as it is, so it must carry its files.
			const [announced] = await onDatabase((db) =>
				db
					.select({ payload: event.payload })
					.from(event)
					.where(and(eq(event.stream, chatStream(sent.chatId)), eq(event.type, "message.created")))
					.orderBy(desc(event.seq))
					.limit(1),
			);
			expect(announced?.payload).toMatchObject({
				message: { id: sent.id, parts: [asPart(second), asPart(first)] },
			});
			expect(await files.read({ chatId, fileId: first.id })).toMatchObject({
				name: "a.txt",
			});
		});

		it("posts nothing when a file is not one of the author's unsent uploads", async () => {
			const { chatId, upload } = await aChatWithFiles();
			const sentBefore = await upload("sent.txt");
			await chats.post({
				chatId,
				messageId: crypto.randomUUID(),
				content: "first",
				attachments: [sentBefore.id],
			});
			const fresh = await upload("fresh.txt");
			const messageId = crypto.randomUUID();

			await expect(
				chats.post({
					chatId,
					messageId,
					content: "again",
					attachments: [fresh.id, sentBefore.id],
				}),
			).rejects.toBeInstanceOf(ChatFileStore.UnsentAttachmentsNotFound);
			expect(await shownMessage(chatId, messageId)).toBeUndefined();
			// The fresh upload is still the author's to send.
			await expect(
				chats.post({ chatId, messageId, content: "again", attachments: [fresh.id] }),
			).resolves.toMatchObject({ parts: [{ type: "text" }, asPart(fresh)] });
		});

		it("returns a message sent again with its files, and refuses its id for other files", async () => {
			const { chatId, upload } = await aChatWithFiles();
			const attached = await upload("a.txt");
			const other = await upload("b.txt");
			const messageId = crypto.randomUUID();
			const send = (attachments: string[]) =>
				chats.post({ chatId, messageId, content: "files", attachments });
			const sent = await send([attached.id]);

			await expect(send([attached.id])).resolves.toEqual(sent);
			await expect(send([other.id])).rejects.toBeInstanceOf(ChatStore.MessageIdConflict);
		});
	});

	it("keeps an uploaded file as the type it was given, or else the type its name suggests", async () => {
		const { id: chatId } = await aChat();
		const files = onPostgresAs(memberId)(Context.get(services, ChatFiles.Service));
		const upload = (name: string, type: string | undefined) =>
			files.upload({
				chatId,
				name,
				type,
				stream: Stream.succeed(new TextEncoder().encode("x")),
			});

		// Browsers give no type for many text files, which bots must still read as text.
		expect(await upload("notes.md", undefined)).toMatchObject({
			contentType: "text/markdown; charset=utf-8",
		});
		expect(await upload("report.csv", "application/octet-stream")).toMatchObject({
			contentType: "text/csv; charset=utf-8",
		});
		expect(await upload("chart", "image/png")).toMatchObject({ contentType: "image/png" });
		expect(await upload("data", undefined)).toMatchObject({
			contentType: "application/octet-stream",
		});
	});
});

function timelineItemId(item: ChatMessageItem) {
	return item.kind === "message" ? item.message.id : item.id;
}
