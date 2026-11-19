import {
	type ChatMessageItem,
	conversationStream,
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
	conversationParticipant,
	event,
	laneRequest,
	message,
	messageReaction,
	placedConversation,
	project,
	projectBot,
	projectMember,
	toolCall,
	turn,
	user,
	workspace,
	workspaceMember,
} from "../../database/schema.ts";
import {
	closeDatabase,
	onDatabase,
	onPostgres,
	type Promised,
	runOnPostgres,
} from "../../database/testing.ts";
import { ConversationFiles } from "../../files/conversation-files.ts";
import { INTERVIEW_PROMPT } from "../../workspaces/bots/interview-prompt.ts";
import { onPostgresAs } from "../../workspaces/testing.ts";
import { Automations } from "../automations/automations.ts";
import { ConversationView } from "../conversation-view.ts";
import { Reactions } from "../reactions/reactions.ts";
import { ConversationRepository } from "../repository/repository.ts";
import { seedConversation } from "../seed.test-support.ts";
import { conversationsForTests } from "../testing.ts";
import {
	modelPrompt,
	prepareRunnable,
	queueTurnForTests,
	runningTurns,
	TurnExecution,
} from "../turns/testing.ts";
import { Turns } from "../turns/turns.ts";
import { BotThreads } from "./bot-threads.ts";
import { ChatFiles } from "./chat-files.ts";
import { ChatView } from "./chat-view.ts";
import { Chats } from "./chats.ts";

const eventStore = await runOnPostgres(EventStore.make);

describe.skipIf(!process.env.DATABASE_URL)("chats, against Postgres", async () => {
	const conversations = await conversationsForTests(EventBus.inProcess({ store: eventStore }));
	/** As the member the chats are with. */
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
	let userId: string;
	let administratorId: string;

	afterAll(async () => {
		await closeDatabase();
	});

	/**
	 * A thread the member started with `threadBotId`, written straight to the
	 * database, so it holds no message and nobody has been asked to answer.
	 */
	const aThread = async (threadBotId = botId) => {
		const { id } = await onDatabase((db) =>
			seedConversation(db, {
				workspaceId,
				kind: "project_thread",
				botId: threadBotId,
				title: "Thread",
				startedById: userId,
			}),
		);
		await onDatabase((db) =>
			db.insert(conversationParticipant).values([
				{ conversationId: id, userId },
				{ conversationId: id, botId: threadBotId },
			]),
		);
		return { id };
	};

	/** The bot's thread `conversationId` as the member's list of the bot's threads shows it. */
	const listedThread = async (conversationId: string, threadBotId = botId) =>
		(await view.botThreads(threadBotId)).threads.find(
			(item) => item.conversation.id === conversationId,
		);

	beforeEach(async () => {
		const suffix = crypto.randomUUID();
		const [person, administrator] = await onDatabase((db) =>
			db
				.insert(user)
				.values([
					{ name: "Chat member", email: `chat-${suffix}@example.com` },
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
		if (!person || !administrator || !space) throw new Error("Could not create chat test identity");
		userId = person.id;
		administratorId = administrator.id;
		workspaceId = space.id;
		await onDatabase((db) =>
			db.insert(workspaceMember).values([
				{ workspaceId, userId },
				{ workspaceId, userId: administrator.id, role: "admin" },
			]),
		);
		chats = onPostgresAs(userId)(Context.get(conversations, Chats.Service));
		view = onPostgresAs(userId)(Context.get(conversations, ChatView.Service));
		automations = onPostgresAs(administrator.id)(Context.get(conversations, Automations.Service));
		const [room] = await onDatabase((db) =>
			db
				.insert(project)
				.values({
					workspaceId,
					name: "Chat project",
					slug: `chat-${suffix}`,
					createdById: userId,
				})
				.returning(),
		);
		if (!room) throw new Error("Could not create chat test project");
		projectId = room.id;
		await onDatabase((db) => db.insert(projectMember).values({ workspaceId, projectId, userId }));
		const [host, recipient] = await onDatabase((db) =>
			db
				.insert(bot)
				.values([
					{
						workspaceId,
						name: "Personal Bot",
						handle: handleFromName(`Personal Bot ${suffix}`),
						color: "green",
						face: "pill",
						model: "test/model",
						createdById: userId,
					},
					{
						workspaceId,
						name: "Impersonal Bot",
						handle: handleFromName(`Impersonal Bot ${suffix}`),
						color: "sky",
						face: "square",
						model: "test/model",
						createdById: userId,
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
		// Both bots are in the project, so either may be asked in its chats.
		await onDatabase((db) =>
			db.insert(projectBot).values([
				{ workspaceId, projectId, botId },
				{ workspaceId, projectId, botId: recipientBotId },
			]),
		);
	});

	it("shows a private bot's thread to its creator, and to nobody else", async () => {
		await onDatabase((db) =>
			db.update(bot).set({ visibility: "private" }).where(eq(bot.id, botId)),
		);
		const opened = await aThread();
		const [otherMember, stranger] = await onDatabase((db) =>
			db
				.insert(user)
				.values([
					{ name: "Another member", email: `member-${crypto.randomUUID()}@example.com` },
					{ name: "Outside the workspace", email: `stranger-${crypto.randomUUID()}@example.com` },
				])
				.returning(),
		);
		if (!otherMember || !stranger) throw new Error("Could not create the people");
		await onDatabase((db) =>
			db.insert(workspaceMember).values({ workspaceId, userId: otherMember.id, role: "member" }),
		);
		const visibility = await runOnPostgres(Effect.provide(Visibility.Service, Visibility.layer));
		const visibilityAs = (personId: string) =>
			onPostgresAs(personId)({ conversation: visibility.conversation });

		expect(await visibilityAs(userId).conversation(opened.id)).toMatchObject({ id: opened.id });
		for (const personId of [otherMember.id, stranger.id]) {
			await expect(visibilityAs(personId).conversation(opened.id)).rejects.toMatchObject({
				_tag: "ResourceHidden",
				resource: "conversation",
			});
		}
		await expect(visibilityAs(userId).conversation("not-a-uuid")).rejects.toMatchObject({
			_tag: "ResourceHidden",
		});
	});

	it("refuses a thread with a private bot to anyone but its creator", async () => {
		await onDatabase((db) =>
			db
				.update(bot)
				.set({ visibility: "private", createdById: administratorId })
				.where(eq(bot.id, botId)),
		);

		await expect(
			chats.startThread({ botId, messageId: crypto.randomUUID(), content: "Hello?" }),
		).rejects.toMatchObject({ _tag: "ResourceHidden" });
		await expect(view.botThreads(botId)).rejects.toMatchObject({ _tag: "ResourceHidden" });
	});

	it("starts a thread with the bot from its first message, which the bot answers, once", async () => {
		const messageId = crypto.randomUUID();
		const input = {
			botId,
			messageId,
			content: "\n  Budget   review is Friday\nand bring the numbers",
		};

		const started = await chats.startThread(input);

		expect(started.conversation).toMatchObject({
			botId,
			title: "Budget review is Friday and bring the numbers",
		});
		expect(started.message).toMatchObject({
			id: messageId,
			conversationId: started.conversation.id,
		});
		expect(await runOnPostgres(runningTurns(started.conversation.id))).toHaveLength(1);
		expect((await chats.startThread(input)).conversation.id).toBe(started.conversation.id);
		expect((await view.messages(started.conversation.id))?.items.map((item) => item.kind)).toEqual([
			"message",
		]);
		expect((await view.history(started.conversation.id))?.items).toHaveLength(0);
		const listed = await view.botThreads(botId);
		expect(listed.bot).toMatchObject({ id: botId });
		expect(listed.threads).toEqual([
			{
				conversation: expect.objectContaining({ id: started.conversation.id }),
				lastMessage: expect.objectContaining({ authorUserId: userId }),
				participants: expect.any(Array),
				messageCount: 1,
				waitingOn: null,
				unreadMessages: 0,
				needsApproval: false,
				mentionsYou: false,
			},
		]);
	});

	it("returns the one thread to sends of its first message made at once", async () => {
		const input = { botId, messageId: crypto.randomUUID(), content: "Plan the offsite" };

		const [first, retry] = await Promise.all([chats.startThread(input), chats.startThread(input)]);

		expect(retry.conversation.id).toBe(first.conversation.id);
		expect((await view.botThreads(botId)).threads).toHaveLength(1);
	});

	it("gives the thread's bot the message the thread was started with", async () => {
		const messageId = crypto.randomUUID();
		const started = await chats.startThread({
			botId,
			messageId,
			content: "Can you check the renewal numbers?",
		});
		const [run] = await runOnPostgres(runningTurns(started.conversation.id));
		if (!run) throw new Error("The thread's bot was not asked");

		const prepared = await prepareRunnable(
			onPostgres({ prepare: Context.get(conversations, TurnExecution.Service).prepare }),
			run,
		);

		expect(prepared.context.messages).toEqual([
			expect.objectContaining({ id: messageId, conversationId: started.conversation.id }),
		]);
		expect(prepared.context.askedBy).toBe(userId);
	});

	describe("threads a bot starts for the person it is answering", () => {
		const botThreads = () => onPostgres(Context.get(conversations, BotThreads.Service));
		const handleOf = async (id: string) => {
			const [row] = await onDatabase((db) =>
				db.select({ handle: bot.handle }).from(bot).where(eq(bot.id, id)),
			);
			if (!row) throw new Error("fixture");
			return row.handle;
		};

		it("starts it with the bot asked for, briefed by the starting bot, and asks that bot to work", async () => {
			const started = await botThreads().start(
				{ botId, workspaceId, askedBy: userId },
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
					.select({ userId: conversationParticipant.userId, botId: conversationParticipant.botId })
					.from(conversationParticipant)
					.where(eq(conversationParticipant.conversationId, started.id)),
			);
			expect(participants).toEqual(
				expect.arrayContaining([
					{ userId, botId: null },
					{ userId: null, botId: recipientBotId },
				]),
			);
			expect(participants).toHaveLength(2);
			const [run] = await runOnPostgres(runningTurns(started.id));
			if (!run) throw new Error("The thread's bot was not asked");

			const prepared = await prepareRunnable(
				onPostgres({ prepare: Context.get(conversations, TurnExecution.Service).prepare }),
				run,
			);

			expect(prepared.context.bot.id).toBe(recipientBotId);
			// A bot wrote its brief, so it acts for the person only to mark the thread done.
			expect(prepared.context.askedBy).toBeNull();
			expect(prepared.context.startedFor).toBe(userId);
			expect(prepared.context.messages).toEqual([
				expect.objectContaining({
					content: "Pull the refunds issued in March.",
					author: expect.objectContaining({ kind: "bot", id: botId }),
				}),
			]);
		});

		it("starts it with the starting bot itself when no other bot is named", async () => {
			const started = await botThreads().start(
				{ botId, workspaceId, askedBy: userId },
				{ title: "Follow-up", brief: "Draft the follow-up email." },
			);
			expect(started).toEqual({ id: expect.any(String), title: "Follow-up" });
			const [run] = await runOnPostgres(runningTurns(started.id));
			if (!run) throw new Error("The thread's bot was not asked");

			const prepared = await prepareRunnable(
				onPostgres({ prepare: Context.get(conversations, TurnExecution.Service).prepare }),
				run,
			);

			expect(prepared.context.bot.id).toBe(botId);
			expect(prepared.context.askedBy).toBeNull();
			expect(prepared.context.startedFor).toBe(userId);
		});

		it("marks the thread it is in done for the person who asked, a project's thread too", async () => {
			const projectThread = await chats.startNamedThread({ projectId, name: "General" });
			const { conversation: opened } = await chats.startThread({
				botId,
				messageId: crypto.randomUUID(),
				content: "Can you check the renewal numbers?",
			});
			const bot = { botId, workspaceId, askedBy: userId };
			const doneAt = async (conversationId: string) => {
				const [row] = await onDatabase((db) =>
					db
						.select({ doneAt: placedConversation.doneAt })
						.from(placedConversation)
						.where(eq(placedConversation.id, conversationId)),
				);
				return row?.doneAt ?? null;
			};

			await botThreads().markDone(bot, opened.id);
			await botThreads().markDone(bot, projectThread.id);

			expect(await doneAt(opened.id)).toBeInstanceOf(Date);
			expect(await doneAt(projectThread.id)).toBeInstanceOf(Date);
			await expect(
				botThreads().markDone({ ...bot, askedBy: null }, opened.id),
			).rejects.toMatchObject({ _tag: "NobodyAsked" });
		});

		it("refuses when nobody asked, no bot has the handle, or the person can't reach the bot or thread", async () => {
			const [otherMember] = await onDatabase((db) =>
				db
					.insert(user)
					.values({ name: "Another member", email: `member-${crypto.randomUUID()}@example.com` })
					.returning(),
			);
			if (!otherMember) throw new Error("fixture");
			await onDatabase((db) =>
				db.insert(workspaceMember).values({ workspaceId, userId: otherMember.id, role: "member" }),
			);
			// Private to the member the chats are with, so the other member reaches neither it nor its threads.
			await onDatabase((db) =>
				db.update(bot).set({ visibility: "private" }).where(eq(bot.id, recipientBotId)),
			);
			const brief = { title: "Elsewhere", brief: "Do it." };

			await expect(
				botThreads().start({ botId, workspaceId, askedBy: null }, brief),
			).rejects.toMatchObject({ _tag: "NobodyAsked" });
			await expect(
				botThreads().start(
					{ botId, workspaceId, askedBy: userId },
					{ ...brief, withHandle: "@nobody-here" },
				),
			).rejects.toMatchObject({ _tag: "NoBotWithHandle" });
			await expect(
				botThreads().start(
					{ botId, workspaceId, askedBy: otherMember.id },
					{ ...brief, withHandle: `@${await handleOf(recipientBotId)}` },
				),
			).rejects.toMatchObject({ _tag: "HostUnavailable" });
			const { conversation: opened } = await chats.startThread({
				botId: recipientBotId,
				messageId: crypto.randomUUID(),
				content: "Can you check the renewal numbers?",
			});
			await expect(
				botThreads().markDone(
					{ botId: recipientBotId, workspaceId, askedBy: otherMember.id },
					opened.id,
				),
			).rejects.toMatchObject({ _tag: "ThreadHiddenFromAsker" });
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

		const listed = (await view.botThreads(botId)).automations;

		expect(listed).toEqual([
			expect.objectContaining({
				automation: expect.objectContaining({ id: ran.automation.id, name: "Overnight review" }),
				conversation: expect.objectContaining({ title: "Overnight review" }),
			}),
			expect.objectContaining({
				automation: expect.objectContaining({ id: quiet.automation.id }),
				conversation: null,
			}),
		]);
		const feed = listed?.[0]?.conversation;
		if (!feed) throw new Error("The automation has no feed");
		expect((await view.messages(feed.id))?.items).toEqual([
			expect.objectContaining({ kind: "run", conversationId: accepted.conversationId }),
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

	it("marks an automation whose run failed until the person opens it after the run ends", async () => {
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
		const failed = async () => ({
			listed: (await view.botThreads(botId)).automations[0]?.automation.failed,
			counted: (await view.projectMarkers(workspaceId)).bots[botId]?.failedAutomations ?? 0,
		});

		expect(await failed()).toEqual({ listed: true, counted: 1 });
		await chats.markRead(feed.id);
		expect(await failed()).toEqual({ listed: false, counted: 0 });
	});

	it("marks a thread done, and reopens it when somebody writes in it", async () => {
		const { conversation: current } = await chats.startThread({
			botId,
			messageId: crypto.randomUUID(),
			content: "Can you check the renewal numbers?",
		});
		const doneAt = async () => (await listedThread(current.id))?.conversation.doneAt;

		await chats.setDone({ conversationId: current.id, done: true });
		expect(await doneAt()).toEqual(expect.any(String));

		await chats.post({
			conversationId: current.id,
			messageId: crypto.randomUUID(),
			content: "One more thing",
		});
		expect(await doneAt()).toBeNull();
	});

	it("says when a message the person has not read mentions them", async () => {
		const current = await aThread();
		const mentioned = async () => (await listedThread(current.id))?.mentionsYou;
		expect(await mentioned()).toBe(false);

		await onDatabase((db) =>
			db.insert(message).values({
				conversationId: current.id,
				authorUserId: administratorId,
				kind: "text",
				status: "complete",
				parts: [{ type: "text", text: "@chat-member can you look?" }],
				content: "@chat-member can you look?",
			}),
		);
		expect(await mentioned()).toBe(true);

		await chats.markRead(current.id);
		expect(await mentioned()).toBe(false);
	});

	it("says when a message the person has not read mentions everyone", async () => {
		const current = await aThread();

		await onDatabase((db) =>
			db.insert(message).values({
				conversationId: current.id,
				authorUserId: administratorId,
				kind: "text",
				status: "complete",
				parts: [{ type: "text", text: "@here standup is starting" }],
				content: "@here standup is starting",
			}),
		);

		expect((await listedThread(current.id))?.mentionsYou).toBe(true);
	});

	it("does not say a bot's @channel mentions the person", async () => {
		const current = await aThread();

		await onDatabase((db) =>
			db.insert(message).values({
				conversationId: current.id,
				authorBotId: botId,
				kind: "text",
				status: "complete",
				parts: [{ type: "text", text: "@channel the report is done" }],
				content: "@channel the report is done",
			}),
		);

		expect((await listedThread(current.id))?.mentionsYou).toBe(false);
	});

	it("marks a project's thread done, and reopens it", async () => {
		const projectThread = await chats.startNamedThread({ projectId, name: "General" });
		const doneAt = async () =>
			(
				await onDatabase((db) =>
					db
						.select({ doneAt: placedConversation.doneAt })
						.from(placedConversation)
						.where(eq(placedConversation.id, projectThread.id)),
				)
			)[0]?.doneAt ?? null;

		await chats.setDone({ conversationId: projectThread.id, done: true });
		expect(await doneAt()).toBeInstanceOf(Date);
		await chats.setDone({ conversationId: projectThread.id, done: false });
		expect(await doneAt()).toBeNull();
	});

	it("lists a project by its slug as by its id, as an address names it", async () => {
		const byId = await view.list({ workspace: workspaceId, project: projectId });
		const [room] = await onDatabase((db) =>
			db.select({ slug: project.slug }).from(project).where(eq(project.id, projectId)),
		);

		expect(await view.list({ workspace: workspaceId, project: room?.slug ?? "" })).toEqual(byId);
	});

	it("lists a bot's default project by its id, but never by its placeholder slug", async () => {
		const [defaultProject] = await onDatabase((db) =>
			db.select({ slug: project.slug }).from(project).where(eq(project.id, botProjectId)),
		);

		await expect(
			view.list({ workspace: workspaceId, project: botProjectId }),
		).resolves.toBeDefined();
		await expect(
			view.list({ workspace: workspaceId, project: defaultProject?.slug ?? "" }),
		).rejects.toMatchObject({ _tag: "ResourceHidden" });
	});

	it("previews a bot's reply as the list of its threads shows it, without the words before a tool call", async () => {
		const { conversation: current } = await chats.startThread({
			botId,
			messageId: crypto.randomUUID(),
			content: "Can you try again?",
		});
		await onDatabase((db) =>
			db.insert(message).values({
				conversationId: current.id,
				authorBotId: botId,
				kind: "text",
				status: "complete",
				parts: [
					{ type: "text", text: "Let me try again:" },
					{ type: "tool_call", toolCallId: crypto.randomUUID() },
					{ type: "text", text: "I'm still getting denied." },
				],
				content: "Let me try again:I'm still getting denied.",
				createdAt: new Date(Date.now() + 1000),
			}),
		);

		expect((await listedThread(current.id))?.lastMessage?.preview).toBe(
			"I'm still getting denied.",
		);
	});

	describe("unread and waiting chats", () => {
		/** The host writes `content` in its chat, `secondsLater` after now, and returns the message. */
		const botWrites = async (conversationId: string, content: string, secondsLater = 0) => {
			const [written] = await onDatabase((db) =>
				db
					.insert(message)
					.values({
						conversationId,
						authorBotId: botId,
						kind: "text",
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
		/** The host's one thread, as the list of its threads shows it. */
		const hostRow = async () => (await view.botThreads(botId)).threads[0];

		it("counts what a bot writes after the person last read the chat", async () => {
			const current = await aThread();
			await chats.post({
				conversationId: current.id,
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

		it("stops counting what came before the person's own reply", async () => {
			const current = await aThread();
			await botWrites(current.id, "Hello!", -2);
			await botWrites(current.id, "Anything else?", -1);
			expect(await hostRow()).toMatchObject({ unreadMessages: 2 });

			await chats.post({
				conversationId: current.id,
				messageId: crypto.randomUUID(),
				content: "All good",
			});
			expect(await hostRow()).toMatchObject({ unreadMessages: 0 });
		});

		it("keeps a reply that finishes after the chat was read unread", async () => {
			const current = await aThread();
			await chats.post({
				conversationId: current.id,
				messageId: crypto.randomUUID(),
				content: "Hey",
			});
			const [reply] = await onDatabase((db) =>
				db
					.insert(message)
					.values({
						conversationId: current.id,
						authorBotId: botId,
						kind: "text",
						status: "streaming",
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

		it("keeps a reply unread that began before something the person read while it was written", async () => {
			const current = await aThread();
			await chats.post({
				conversationId: current.id,
				messageId: crypto.randomUUID(),
				content: "Hey",
			});
			const [reply] = await onDatabase((db) =>
				db
					.insert(message)
					.values({
						conversationId: current.id,
						authorBotId: botId,
						kind: "text",
						status: "streaming",
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

		it("shows how far the person has read, and announces it only when they read further", async () => {
			const conversationView = onPostgresAs(userId)(
				Context.get(conversations, ConversationView.Service),
			);
			const current = await aThread();
			const reply = await botWrites(current.id, "Hello!", 1);
			const readsAnnounced = async () =>
				(
					await onDatabase((db) =>
						db
							.select({ type: event.type })
							.from(event)
							.where(eq(event.stream, conversationStream(current.id))),
					)
				).filter(({ type }) => type === "conversation.read").length;

			await chats.markRead(current.id);
			await chats.markRead(current.id);

			const [read] = (await conversationView.get(current.id)).reads;
			expect(read).toEqual({
				person: expect.objectContaining({ kind: "person", id: userId }),
				readThrough: reply.createdAt.toISOString(),
				readAt: expect.any(String),
			});
			expect(await readsAnnounced()).toBe(1);
			// When they read it, not when it was sent: the reply is stamped a second from now.
			expect(Date.parse(read?.readAt ?? "")).toBeLessThan(reply.createdAt.getTime());

			await botWrites(current.id, "One more thing", 2);
			await chats.markRead(current.id);
			const [readAgain] = (await conversationView.get(current.id)).reads;
			expect(Date.parse(readAgain?.readAt ?? "")).toBeGreaterThan(Date.parse(read?.readAt ?? ""));
		});

		it("adds up each bot's unread messages for the rail", async () => {
			const current = await aThread();
			const other = await aThread(recipientBotId);
			expect(await view.projectMarkers(workspaceId)).toEqual({ projects: {}, bots: {} });

			await botWrites(current.id, "Hello!");
			await botWrites(current.id, "Are you there?", 1);
			await onDatabase((db) =>
				db.insert(message).values({
					conversationId: other.id,
					authorBotId: recipientBotId,
					kind: "text",
					status: "complete",
					parts: [{ type: "text", text: "Morning" }],
					content: "Morning",
				}),
			);

			expect(await view.projectMarkers(workspaceId)).toEqual({
				projects: {},
				bots: {
					[botId]: { unreadMessages: 2, needsApproval: false, failedAutomations: 0 },
					[recipientBotId]: { unreadMessages: 1, needsApproval: false, failedAutomations: 0 },
				},
			});
		});

		it("marks a chat waiting on a tool call the person may decide", async () => {
			const current = await aThread();
			await chats.post({
				conversationId: current.id,
				messageId: crypto.randomUUID(),
				content: "File it",
			});
			// A reply that called a tool without writing a word first.
			const trigger = await botWrites(current.id, "", 1);
			const [asked] = await onDatabase((db) =>
				db
					.insert(turn)
					.values({
						conversationId: current.id,
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
					conversationId: current.id,
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
			expect((await view.projectMarkers(workspaceId)).bots[botId]).toEqual({
				unreadMessages: 0,
				needsApproval: true,
				failedAutomations: 0,
			});
		});
	});

	it("lists a project the person is in, and hides one they are not", async () => {
		const [unjoined] = await onDatabase((db) =>
			db
				.insert(project)
				.values({
					workspaceId,
					name: "Elsewhere",
					slug: `elsewhere-${crypto.randomUUID()}`,
					visibility: "private",
					createdById: administratorId,
				})
				.returning(),
		);
		if (!unjoined) throw new Error("Could not create the project");

		await expect(view.list({ workspace: workspaceId, project: unjoined.id })).rejects.toMatchObject(
			{
				_tag: "ResourceHidden",
			},
		);
		expect(await view.list({ workspace: workspaceId, project: projectId })).toEqual({ chats: [] });
	});

	describe("the interview a new bot starts with its creator", () => {
		const interviewDue = (changes: Partial<typeof bot.$inferInsert> = {}) =>
			onDatabase((db) =>
				db
					.update(bot)
					.set({ prompt: INTERVIEW_PROMPT, ...changes })
					.where(eq(bot.id, botId)),
			);

		it("starts once, in a thread named for the bot, without posting a message for the creator", async () => {
			await interviewDue();
			const opened = await chats.startInterview(botId);
			if (!opened) throw new Error("The interview did not start");
			expect(opened).toMatchObject({ botId, title: "Setting up Personal Bot" });
			expect(await chats.startInterview(botId)).toBeNull();
			expect((await view.messages(opened.id)).items).toEqual([]);
			const runs = await runOnPostgres(runningTurns(opened.id));
			expect(runs).toHaveLength(1);
			const run = runs[0];
			if (!run) throw new Error("The interview did not start");
			const execution = onPostgres({
				prepare: Context.get(conversations, TurnExecution.Service).prepare,
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
			const creator = onPostgresAs(administratorId)(Context.get(conversations, Chats.Service));
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

		it("does not start for a bot that already has a thread", async () => {
			await aThread();
			await interviewDue();

			expect(await chats.startInterview(botId)).toBeNull();
		});

		it.each(["", "Help with releases"])(
			"does not start for a bot with written instructions %j",
			async (prompt) => {
				await onDatabase((db) => db.update(bot).set({ prompt }).where(eq(bot.id, botId)));

				expect(await chats.startInterview(botId)).toBeNull();
			},
		);
	});

	it("starts a thread in a project, where a bot named in a message answers in it, and no bot otherwise", async () => {
		const first = await chats.startNamedThread({ projectId, name: "Pricing" });
		expect(first).toMatchObject({ kind: "project_thread", projectId, title: "Pricing" });
		const [host] = await onDatabase((db) =>
			db.select({ handle: bot.handle }).from(bot).where(eq(bot.id, botId)),
		);

		await chats.post({
			conversationId: first.id,
			messageId: crypto.randomUUID(),
			content: "Morning, all.",
		});

		expect(await runOnPostgres(runningTurns(first.id))).toHaveLength(0);

		await chats.post({
			conversationId: first.id,
			messageId: crypto.randomUUID(),
			content: `@${host?.handle} can you look at this?`,
		});

		expect(await runOnPostgres(runningTurns(first.id))).toEqual([
			expect.objectContaining({ request: expect.objectContaining({ botId, reason: "mention" }) }),
		]);
	});

	it("lets those who manage a project, and nobody else in it, decide its computer's requests, whichever bot asks", async () => {
		const chat = await chats.startNamedThread({ projectId, name: "General" });
		await onDatabase((db) =>
			db.insert(conversationParticipant).values([
				{ conversationId: chat.id, botId },
				{ conversationId: chat.id, botId: recipientBotId },
			]),
		);
		const deciders = (personId: string) =>
			onPostgresAs(personId)(Context.get(conversations, ConversationView.Service))
				.get(chat.id)
				.then((details) => details.capabilities?.approveComputerRequestsOf);

		// The member made the bot, but the computer is the project's.
		expect(await deciders(userId)).toEqual([]);
		expect(await deciders(administratorId)).toEqual([botId, recipientBotId]);
	});

	it("asks the bot a message in a project's thread replies to, though it names nobody", async () => {
		const projectThread = await chats.startNamedThread({ projectId, name: "General" });
		const [answer] = await onDatabase((db) =>
			db
				.insert(message)
				.values({
					conversationId: projectThread.id,
					authorBotId: botId,
					kind: "text",
					status: "complete",
					parts: [{ type: "text", text: "Nothing logged for yesterday." }],
					content: "Nothing logged for yesterday.",
				})
				.returning({ id: message.id }),
		);
		if (!answer) throw new Error("The bot's message was not written");

		await chats.post({
			conversationId: projectThread.id,
			messageId: crypto.randomUUID(),
			content: "Do you have saved automations?",
			replyTo: answer.id,
		});

		expect(await runOnPostgres(runningTurns(projectThread.id))).toEqual([
			expect.objectContaining({ request: expect.objectContaining({ botId, reason: "reply" }) }),
		]);
	});

	it("lets a bot decline a message in its thread to a person in it, but answer a handle that is nobody's", async () => {
		const thread = await aThread();

		await chats.post({
			conversationId: thread.id,
			messageId: crypto.randomUUID(),
			content: "@chat-member can you look at this?",
		});

		expect(await runOnPostgres(runningTurns(thread.id))).toEqual([
			expect.objectContaining({ request: expect.objectContaining({ botId, reason: "optional" }) }),
		]);

		const another = await aThread();
		await chats.post({
			conversationId: another.id,
			messageId: crypto.randomUUID(),
			content: "Please raise this with @Backlog Manager, high priority.",
		});

		expect(await runOnPostgres(runningTurns(another.id))).toEqual([
			expect.objectContaining({ request: expect.objectContaining({ botId, reason: "default" }) }),
		]);
	});

	it("lets a bot decline a message in its thread to someone who left the workspace but is still in the thread", async () => {
		const thread = await aThread();
		const [former] = await onDatabase((db) =>
			db
				.insert(user)
				.values({ name: "Former member", email: `former-${crypto.randomUUID()}@example.com` })
				.returning(),
		);
		if (!former) throw new Error("Could not create the former member");
		await onDatabase((db) =>
			db.insert(conversationParticipant).values({ conversationId: thread.id, userId: former.id }),
		);

		await chats.post({
			conversationId: thread.id,
			messageId: crypto.randomUUID(),
			content: "@former-member are you still around?",
		});

		expect(await runOnPostgres(runningTurns(thread.id))).toEqual([
			expect.objectContaining({ request: expect.objectContaining({ botId, reason: "optional" }) }),
		]);
	});

	it("starts a thread in a project from its first message, which its lead bot answers, once", async () => {
		await onDatabase((db) =>
			db.update(project).set({ leadBotId: botId }).where(eq(project.id, projectId)),
		);
		const input = {
			projectId,
			messageId: crypto.randomUUID(),
			content: "Plan the launch\nby Friday",
		};

		const started = await chats.startProjectThread(input);

		expect(started.conversation).toMatchObject({
			projectId,
			botId: null,
			title: "Plan the launch by Friday",
		});
		expect(started.message).toMatchObject({ id: input.messageId });
		expect(await runOnPostgres(runningTurns(started.conversation.id))).toEqual([
			expect.objectContaining({ request: expect.objectContaining({ botId }) }),
		]);
		expect((await chats.startProjectThread(input)).conversation.id).toBe(started.conversation.id);
		await expect(chats.startThread({ botId, ...input })).rejects.toMatchObject({
			_tag: "MessageIdConflict",
		});
	});

	it("starts a thread in a bot's default project with the bot in it, from the bot or the project", async () => {
		const participantsOf = (conversationId: string) =>
			onDatabase((db) =>
				db
					.select({ userId: conversationParticipant.userId, botId: conversationParticipant.botId })
					.from(conversationParticipant)
					.where(eq(conversationParticipant.conversationId, conversationId)),
			);
		const fromBot = await chats.startThread({
			botId,
			messageId: crypto.randomUUID(),
			content: "From the bot",
		});
		const fromProject = await chats.startProjectThread({
			projectId: botProjectId,
			messageId: crypto.randomUUID(),
			content: "From its project",
		});
		const named = await chats.startNamedThread({ projectId: botProjectId, name: "Named" });

		const expected = [
			{ userId, botId: null },
			{ userId: null, botId },
		];
		expect(await participantsOf(fromBot.conversation.id)).toEqual(expect.arrayContaining(expected));
		expect(await participantsOf(fromProject.conversation.id)).toEqual(
			expect.arrayContaining(expected),
		);
		expect(await participantsOf(named.id)).toEqual(expect.arrayContaining(expected));
	});

	it("lists a project's thread with what the person has not read in it, and counts that on the rail", async () => {
		const projectThread = await chats.startNamedThread({ projectId, name: "General" });
		await onDatabase((db) =>
			db.insert(message).values({
				conversationId: projectThread.id,
				authorUserId: administratorId,
				kind: "text",
				status: "complete",
				parts: [{ type: "text", text: "Lunch?" }],
				content: "Lunch?",
			}),
		);

		expect((await view.list({ workspace: workspaceId, project: projectId }))?.chats).toEqual([
			{
				conversation: expect.objectContaining({ id: projectThread.id }),
				lastMessage: expect.objectContaining({ preview: "Lunch?", authorUserId: administratorId }),
				participants: [expect.objectContaining({ kind: "person", id: administratorId })],
				messageCount: 1,
				waitingOn: null,
				unreadMessages: 1,
				needsApproval: false,
				mentionsYou: false,
			},
		]);
		expect(await view.projectMarkers(workspaceId)).toEqual({
			projects: { [projectId]: { unreadMessages: 1, needsApproval: false } },
			bots: {},
		});
	});

	it("lists the project's threads, the most recent activity first, and hides any thread once archived", async () => {
		const general = await chats.startNamedThread({ projectId, name: "General" });
		const pricing = await chats.startNamedThread({ projectId, name: "Pricing" });
		const launch = await chats.startNamedThread({ projectId, name: "Launch" });

		const listed = async () =>
			(await view.list({ workspace: workspaceId, project: projectId }))?.chats.map(
				({ conversation }) => conversation.title,
			);
		expect(await listed()).toEqual(["Launch", "Pricing", "General"]);

		await chats.post({
			conversationId: general.id,
			messageId: crypto.randomUUID(),
			content: "Morning, all.",
		});
		expect(await listed()).toEqual(["General", "Launch", "Pricing"]);

		// Changing a thread is for whoever may change the project.
		const administering = onPostgresAs(administratorId)(Context.get(conversations, Chats.Service));
		await administering.changeThread({ conversationId: pricing.id, change: { name: "Prices" } });
		await administering.changeThread({ conversationId: launch.id, change: { archived: true } });
		await administering.changeThread({ conversationId: general.id, change: { archived: true } });

		expect(await listed()).toEqual(["Prices"]);
	});

	it("leaves renaming and archiving a project's thread to whoever may change the project", async () => {
		const pricing = await chats.startNamedThread({ projectId, name: "Pricing" });

		// The member the chats are with may start one, but not change the project.
		await expect(
			chats.changeThread({ conversationId: pricing.id, change: { archived: true } }),
		).rejects.toMatchObject({ _tag: "ActionForbidden" });
	});

	it("refuses a message to a bot with no model, and saves nothing", async () => {
		await onDatabase((db) => db.update(bot).set({ model: null }).where(eq(bot.id, botId)));
		const current = await aThread();
		const messageId = crypto.randomUUID();

		await expect(
			chats.post({
				conversationId: current.id,
				messageId,
				content: "Anyone there?",
			}),
		).rejects.toMatchObject({ _tag: "HostHasNoModel" });
		expect(
			await onDatabase((db) => db.select().from(message).where(eq(message.id, messageId))),
		).toHaveLength(0);
		expect(await runOnPostgres(runningTurns(current.id))).toHaveLength(0);
	});

	it("retries the same message without creating another message or turn", async () => {
		const current = await aThread();
		const send = {
			conversationId: current.id,
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
		const current = await aThread();
		const elsewhere = await aThread(recipientBotId);
		const asked = await chats.post({
			conversationId: current.id,
			messageId: crypto.randomUUID(),
			content: "Ship the **release** today\nand tell the team",
		});
		const other = await chats.post({
			conversationId: elsewhere.id,
			messageId: crypto.randomUUID(),
			content: "Something else",
		});

		const reply = await chats.post({
			conversationId: current.id,
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
				conversationId: current.id,
				messageId: crypto.randomUUID(),
				content: "About that",
				replyTo: other.id,
			}),
		).rejects.toMatchObject({ _tag: "ReplyTargetNotFound" });
	});

	it("lets people react to a message once per emoji, announcing each change", async () => {
		const reactions = onPostgresAs(userId)(Context.get(conversations, Reactions.Service));
		const current = await aThread();
		const asked = await chats.post({
			conversationId: current.id,
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
							eq(event.stream, conversationStream(current.id)),
							eq(event.type, "message.reactions_changed"),
						),
					)
					.orderBy(event.seq),
			);

		const added = await reactions.add(asked.id, "👍🏽");
		expect(added).toEqual([
			{ emoji: "👍🏽", people: [{ id: userId, name: "Chat member", at: expect.any(String) }] },
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
				.insert(user)
				.values({ name: "Stranger", email: `stranger-${crypto.randomUUID()}@example.com` })
				.returning(),
		);
		if (!stranger) throw new Error("Could not create a stranger");
		const strangers = onPostgresAs(stranger.id)(Context.get(conversations, Reactions.Service));
		await expect(strangers.add(asked.id, "👍🏽")).rejects.toMatchObject({ _tag: "ResourceHidden" });
	});

	it("refuses a reaction to a reply still being written, and a new emoji past the limit", async () => {
		const reactions = onPostgresAs(userId)(Context.get(conversations, Reactions.Service));
		const current = await aThread();
		const asked = await chats.post({
			conversationId: current.id,
			messageId: crypto.randomUUID(),
			content: "Ship it?",
		});
		const [writing] = await onDatabase((db) =>
			db
				.insert(message)
				.values({
					conversationId: current.id,
					authorBotId: botId,
					kind: "text",
					status: "streaming",
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
				.values(used.map((emoji) => ({ messageId: asked.id, userId: administratorId, emoji }))),
		);
		await expect(reactions.add(asked.id, "🎉")).rejects.toMatchObject({
			_tag: "TooManyReactionEmoji",
		});
		const joined = await reactions.add(asked.id, "😀");
		expect(joined[0]?.people.map((person) => person.id)).toEqual([administratorId, userId]);
	});

	it("says which messages wait for the bot's next turn, and announces when one starts waiting", async () => {
		const conversationView = onPostgresAs(userId)(
			Context.get(conversations, ConversationView.Service),
		);
		const current = await aThread();
		const post = (content: string) =>
			chats.post({ conversationId: current.id, messageId: crypto.randomUUID(), content });
		const changesAnnounced = async () =>
			(
				await onDatabase((db) =>
					db
						.select({ type: event.type })
						.from(event)
						.where(eq(event.stream, conversationStream(current.id))),
				)
			).filter(({ type }) => type === "conversation.changed").length;

		await post("Is checkout timing out?");
		expect((await conversationView.get(current.id)).queuedSince).toBeNull();
		const changedBefore = await changesAnnounced();

		const followUp = await post("The Stripe webhook too?");
		await post("Started around 9.");

		expect((await conversationView.get(current.id)).queuedSince).toBe(followUp.createdAt);
		// Once, when the turn started waiting; the next message joins it.
		expect((await changesAnnounced()) - changedBefore).toBe(1);
	});

	it("queues nothing posted before a turn resumed from an earlier reply starts waiting", async () => {
		const conversationView = onPostgresAs(userId)(
			Context.get(conversations, ConversationView.Service),
		);
		const turns = Context.get(conversations, Turns.Service);
		const current = await aThread();
		const asked = await chats.post({
			conversationId: current.id,
			messageId: crypto.randomUUID(),
			content: "Who owns checkout?",
		});

		// A collaboration answered after the bot moved on resumes it from the
		// reply that opened it, which is long since answered.
		await runOnPostgres(
			turns.ask({
				conversationId: current.id,
				botId,
				triggerMessageId: asked.id,
				reason: "resume",
			}),
		);
		const later = await chats.post({
			conversationId: current.id,
			messageId: crypto.randomUUID(),
			content: "And billing?",
		});

		const { queuedSince } = await conversationView.get(current.id);
		expect(Date.parse(queuedSince ?? "")).toBeGreaterThan(Date.parse(asked.createdAt));
		expect(Date.parse(queuedSince ?? "")).toBeLessThanOrEqual(Date.parse(later.createdAt));
	});

	it("announces a person's message before the bot it brings into the thread", async () => {
		const current = await aThread();
		// The thread's bot has not joined it yet, so the message brings it in.
		await onDatabase((db) =>
			db
				.delete(conversationParticipant)
				.where(
					and(
						eq(conversationParticipant.conversationId, current.id),
						eq(conversationParticipant.botId, botId),
					),
				),
		);

		await chats.post({
			conversationId: current.id,
			messageId: crypto.randomUUID(),
			content: "Are you there?",
		});

		const announced = await onDatabase((db) =>
			db
				.select({ type: event.type })
				.from(event)
				.where(eq(event.stream, conversationStream(current.id)))
				.orderBy(event.seq),
		);
		expect(announced.slice(0, 2).map(({ type }) => type)).toEqual([
			"message.created",
			"conversation.changed",
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
				conversationId: accepted.conversationId,
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
					conversationId: current.id,
					authorUserId: userId,
					kind: "text",
					status: "complete",
					parts: [{ type: "text", text: "Older message" }],
					content: "Older message",
					createdAt: new Date("2026-09-18T09:00:00.000Z"),
				},
				{
					id: newerMessageId,
					conversationId: current.id,
					authorUserId: userId,
					kind: "text",
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

	it("shows a collaboration in the asking thread", async () => {
		const initiatorChat = await aThread();
		const trigger = await chats.post({
			conversationId: initiatorChat.id,
			messageId: crypto.randomUUID(),
			content: "Ask Impersonal Bot",
		});
		if (!trigger) throw new Error("Could not create collaboration trigger");
		const collaborationId = crypto.randomUUID();
		const [askingTurn] = await onDatabase((db) =>
			db
				.insert(turn)
				.values({
					conversationId: initiatorChat.id,
					botId,
					triggerMessageId: trigger.id,
					status: "done",
					model: "test/model",
					startedAt: new Date(),
					finishedAt: new Date(),
					reason: "default",
				})
				.returning(),
		);
		if (!askingTurn) throw new Error("Could not create asking turn");
		const [parentMessage] = await onDatabase((db) =>
			db
				.insert(message)
				.values({
					conversationId: initiatorChat.id,
					authorBotId: botId,
					kind: "text",
					status: "complete",
					parts: [{ type: "collaboration", collaborationId }],
					content: "",
					turnId: askingTurn.id,
				})
				.returning(),
		);
		if (!parentMessage) throw new Error("Could not create the asking message");
		const child = await onDatabase((db) =>
			seedConversation(db, {
				workspaceId,
				kind: "collaboration",
				title: "Compare the launch plans",
				collaboration: {
					id: collaborationId,
					parentConversationId: initiatorChat.id,
					rootConversationId: initiatorChat.id,
					parentMessageId: parentMessage.id,
					turnId: askingTurn.id,
					collaboratorBotId: recipientBotId,
					brief: "Compare the launch plans",
					status: "waiting",
					atOffset: 0,
				},
			}),
		);
		await onDatabase((db) =>
			db.insert(conversationParticipant).values([
				{ conversationId: child.id, botId },
				{ conversationId: child.id, botId: recipientBotId },
			]),
		);

		const outbound = await view.messages(initiatorChat.id);
		expect(outbound?.items.at(-1)).toMatchObject({
			kind: "message",
			message: { parts: [{ type: "collaboration", conversationId: child.id }] },
		});
	});

	it("reports each history conversation's own status, participants, and automation run", async () => {
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
		const [asking] = await onDatabase((db) =>
			db
				.insert(message)
				.values({
					conversationId: current.id,
					authorBotId: botId,
					kind: "text",
					status: "complete",
					parts: [],
					content: "",
				})
				.returning(),
		);
		if (!asking) throw new Error("Could not create the asking message");
		const [askingTurn] = await onDatabase((db) =>
			db
				.insert(turn)
				.values({
					conversationId: current.id,
					botId,
					triggerMessageId: asking.id,
					status: "done",
					model: "test/model",
					startedAt: new Date(),
					finishedAt: new Date(),
					reason: "default",
				})
				.returning(),
		);
		if (!askingTurn) throw new Error("Could not create the asking turn");
		const aCollaboration = (title: string) =>
			onDatabase((db) =>
				seedConversation(db, {
					workspaceId,
					kind: "collaboration",
					title,
					collaboration: {
						parentConversationId: current.id,
						rootConversationId: current.id,
						parentMessageId: asking.id,
						turnId: askingTurn.id,
						collaboratorBotId: botId,
						brief: title,
						atOffset: 0,
					},
				}),
			);
		const failed = await aCollaboration("Failed collaboration");
		const running = await aCollaboration("Running collaboration");
		await onDatabase((db) =>
			db.insert(conversationParticipant).values([
				{ conversationId: failed.id, botId },
				{ conversationId: running.id, userId },
				{ conversationId: running.id, botId: recipientBotId },
			]),
		);
		const [failedTrigger] = await onDatabase((db) =>
			db
				.insert(message)
				.values({
					conversationId: failed.id,
					authorUserId: userId,
					kind: "text",
					status: "complete",
					parts: [{ type: "text", text: "Try this" }],
					content: "Try this",
				})
				.returning(),
		);
		if (!failedTrigger) throw new Error("Could not create failed turn trigger");
		await onDatabase((db) =>
			db.insert(turn).values({
				conversationId: failed.id,
				botId,
				triggerMessageId: failedTrigger.id,
				status: "failed",
				model: "test/model",
				startedAt: new Date(),
				finishedAt: new Date(),
				reason: "default",
			}),
		);
		await runOnPostgres(
			queueTurnForTests({
				conversationId: running.id,
				botId: recipientBotId,
				triggerMessageId: crypto.randomUUID(),
				reason: "collaboration",
			}),
		);

		const items = (await view.history(current.id))?.items ?? [];
		const entry = (conversationId: string) =>
			items.find((item) => item.conversationId === conversationId);
		expect(items).toHaveLength(3);
		expect(entry(failed.id)).toMatchObject({
			status: "failed",
			participants: [expect.objectContaining({ id: botId })],
			automationRun: null,
		});
		expect(entry(running.id)).toMatchObject({
			status: "running",
			participants: [
				expect.objectContaining({ id: userId }),
				expect.objectContaining({ id: recipientBotId }),
			],
			automationRun: null,
		});
		expect(entry(accepted.conversationId)).toMatchObject({
			kind: "run",
			status: "queued",
			automationRun: {
				runId: accepted.runId,
				automationId: created.automation.id,
				automationName: "Overnight review",
				triggerKind: "manual",
				triggeredAt: expect.any(String),
			},
		});
	});

	describe("the approvals and inbox across a workspace", () => {
		/** The host writes `content` in `conversationId`, `secondsLater` after now, and returns the message. */
		const botWrites = async (conversationId: string, content: string, secondsLater = 0) => {
			const [written] = await onDatabase((db) =>
				db
					.insert(message)
					.values({
						conversationId,
						authorBotId: botId,
						kind: "text",
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
		const runPosts = async (run: { runId: string; conversationId: string }, content: string) => {
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
			const [runConversation] = await onDatabase((db) =>
				db
					.select({ rootConversationId: placedConversation.rootConversationId })
					.from(placedConversation)
					.where(eq(placedConversation.id, run.conversationId)),
			);
			const feedId = runConversation?.rootConversationId;
			if (!feedId) throw new Error("fixture");
			await onDatabase((db) =>
				db.insert(message).values({
					conversationId: feedId,
					authorBotId: botId,
					runId: run.runId,
					kind: "text",
					status: "complete",
					parts: [{ type: "text", text: content }],
					content,
				}),
			);
		};

		/** A reply in the chat that called `tool` and stopped for someone to approve it. */
		const askForApproval = async (
			conversationId: string,
			tool = "linear__create_issue",
			askingBotId = botId,
		) => {
			const reply = await botWrites(conversationId, "", 1);
			const [asked] = await onDatabase((db) =>
				db
					.insert(turn)
					.values({
						conversationId,
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
						conversationId,
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

		/**
		 * The host asks the other bot in `parentConversationId`, under
		 * `rootConversationId`, to compare the launch plans, and returns the
		 * collaboration's conversation.
		 */
		const collaborate = async (parentConversationId: string, rootConversationId: string) => {
			const trigger = await botWrites(parentConversationId, "", 0);
			const [askingTurn] = await onDatabase((db) =>
				db
					.insert(turn)
					.values({
						conversationId: parentConversationId,
						botId,
						triggerMessageId: trigger.id,
						status: "done",
						model: "test/model",
						startedAt: new Date(),
						finishedAt: new Date(),
						reason: "default",
					})
					.returning(),
			);
			if (!askingTurn) throw new Error("fixture");
			const collaborationId = crypto.randomUUID();
			const [asking] = await onDatabase((db) =>
				db
					.insert(message)
					.values({
						conversationId: parentConversationId,
						authorBotId: botId,
						kind: "text",
						status: "complete",
						parts: [{ type: "collaboration", collaborationId }],
						content: "",
						turnId: askingTurn.id,
					})
					.returning(),
			);
			if (!asking) throw new Error("fixture");
			const child = await onDatabase((db) =>
				seedConversation(db, {
					workspaceId,
					kind: "collaboration",
					title: "Compare the launch plans",
					collaboration: {
						id: collaborationId,
						parentConversationId,
						rootConversationId,
						parentMessageId: asking.id,
						turnId: askingTurn.id,
						collaboratorBotId: recipientBotId,
						brief: "Compare the launch plans",
						status: "waiting",
						atOffset: 0,
					},
				}),
			);
			return child.id;
		};

		it("lists a call waiting on the person's decision, then among the answered once decided", async () => {
			const current = await aThread();
			const callId = await askForApproval(current.id);

			expect(await view.approvals(workspaceId)).toEqual({
				waiting: [
					expect.objectContaining({
						call: expect.objectContaining({ id: callId, tool: "linear__create_issue" }),
						bot: expect.objectContaining({ id: botId }),
						projectId: null,
						conversationId: current.id,
						rootConversationId: current.id,
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

			const inbox = await view.approvals(workspaceId);
			expect(inbox.waiting).toEqual([]);
			expect(inbox.answered).toEqual([
				expect.objectContaining({
					call: expect.objectContaining({ id: callId }),
					answer: expect.objectContaining({ status: "denied", decidedByName: "Chat admin" }),
				}),
			]);
			// Nor is it listed in another workspace the person is in.
			const [elsewhere] = await onDatabase((db) =>
				db
					.insert(workspace)
					.values({ name: "Elsewhere", slug: `elsewhere-${crypto.randomUUID()}` })
					.returning(),
			);
			if (!elsewhere) throw new Error("fixture");
			await onDatabase((db) =>
				db.insert(workspaceMember).values({ workspaceId: elsewhere.id, userId }),
			);
			expect((await view.approvals(elsewhere.id)).answered).toEqual([]);
		});

		it("lists a call waiting on the person's decision behind many they may not decide", async () => {
			// Made by the administrator, so the member uses it but does not manage it.
			await onDatabase((db) =>
				db.update(bot).set({ createdById: administratorId }).where(eq(bot.id, botId)),
			);
			const current = await aThread();
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
			// every call the inbox would list, so they would fill it first.
			const reply = await botWrites(run.conversationId, "", 1);
			const [asked] = await onDatabase((db) =>
				db
					.insert(turn)
					.values({
						conversationId: run.conversationId,
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
						conversationId: run.conversationId,
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
			// Made by the administrator, so the member uses it but does not manage it.
			await onDatabase((db) =>
				db.update(bot).set({ createdById: administratorId }).where(eq(bot.id, botId)),
			);
			const current = await aThread();
			await askForApproval(current.id, "request_network_access");
			const callId = await askForApproval(current.id);

			expect((await view.approvals(workspaceId)).waiting).toEqual([
				expect.objectContaining({ call: expect.objectContaining({ id: callId }) }),
			]);
		});

		it("lists what the person has not read, and keeps what mentions them once read", async () => {
			const current = await aThread();
			const news = await botWrites(current.id, "The deploy finished.", 1);
			const mention = await botWrites(current.id, "@chat-member can you check it?", 2);

			expect((await view.inbox(workspaceId)).items).toEqual([
				expect.objectContaining({ kind: "mention", messageId: mention.id, unread: true }),
				expect.objectContaining({
					kind: "message",
					messageId: news.id,
					unread: true,
					preview: "The deploy finished.",
					rootConversationId: current.id,
				}),
			]);

			await chats.markRead(current.id);

			expect((await view.inbox(workspaceId)).items).toEqual([
				expect.objectContaining({ kind: "mention", messageId: mention.id, unread: false }),
			]);
		});

		it("does not take an email address for a mention", async () => {
			const current = await aThread();
			await chats.markRead(current.id);
			await botWrites(current.id, "Mail it to ops@chat-member.example", 1);

			expect((await view.inbox(workspaceId)).items).toEqual([
				expect.objectContaining({ kind: "message" }),
			]);
		});

		it("lists an automation run in the person's chats, with the start of what it said", async () => {
			const created = await automations.create(
				{ projectId: botProjectId },
				{ name: "Overnight review", instructions: "Review it.", triggers: [{ kind: "webhook" }] },
			);
			const accepted = await automations.run({
				projectId: botProjectId,
				automationId: created.automation.id,
				requestId: crypto.randomUUID(),
			});
			await botWrites(accepted.conversationId, "Two PRs merged.\nThe release branch is green.", 1);
			await runPosts(accepted, "Two PRs merged.\nThe release branch is green.");

			expect((await view.inbox(workspaceId)).items).toContainEqual(
				expect.objectContaining({
					kind: "run",
					conversationId: accepted.conversationId,
					automationName: "Overnight review",
					triggerKind: "manual",
					bot: expect.objectContaining({ id: botId }),
					preview: "Two PRs merged. The release branch is green.",
					rootConversationId: (await view.botThreads(botId)).automations[0]?.conversation?.id,
					mentionsYou: false,
					unread: true,
				}),
			);
		});

		it("counts an automation run unread only once it posted a result or failed", async () => {
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
			const running = await runAutomation();
			const quiet = await runAutomation();
			await onDatabase((db) =>
				db
					.update(automationRun)
					.set({ state: "completed", startedAt: new Date(), finishedAt: new Date() })
					.where(eq(automationRun.id, quiet.runId)),
			);
			const asking = await runAutomation();
			await runPosts(asking, "@chat-member the deploy needs your sign-off.");

			const runs = (await view.inbox(workspaceId)).items.flatMap((item) =>
				item.kind === "run"
					? [
							{
								conversationId: item.conversationId,
								unread: item.unread,
								mentionsYou: item.mentionsYou,
							},
						]
					: [],
			);
			expect(runs).toEqual([
				{ conversationId: asking.conversationId, unread: true, mentionsYou: true },
				{ conversationId: running.conversationId, unread: false, mentionsYou: false },
			]);
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
			await botWrites(accepted.conversationId, "Two PRs merged.\nThe release branch is green.", 1);
			const feed = (await view.botThreads(botId)).automations[0]?.conversation;

			expect((await view.messages(feed?.id ?? ""))?.items).toEqual([
				expect.objectContaining({
					kind: "run",
					conversationId: accepted.conversationId,
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
			await chats.markItemRead(run.conversationId);

			await runPosts(run, "@chat-member the deploy needs your sign-off.");

			expect((await view.inbox(workspaceId)).items).toContainEqual(
				expect.objectContaining({
					conversationId: run.conversationId,
					unread: true,
					mentionsYou: true,
				}),
			);
		});

		it("leaves a result posted in a project's thread as well to mention the person there", async () => {
			const created = await automations.create(
				{ projectId: botProjectId },
				{ name: "Overnight review", instructions: "Review it.", triggers: [{ kind: "webhook" }] },
			);
			const run = await automations.run({
				projectId: botProjectId,
				automationId: created.automation.id,
				requestId: crypto.randomUUID(),
			});
			const content = "@chat-member the deploy needs your sign-off.";
			await runPosts(run, content);
			const projectThread = await chats.startNamedThread({ projectId, name: "General" });
			const [inChat] = await onDatabase((db) =>
				db
					.insert(message)
					.values({
						conversationId: projectThread.id,
						authorBotId: botId,
						runId: run.runId,
						kind: "text",
						status: "complete",
						parts: [{ type: "text", text: content }],
						content,
					})
					.returning(),
			);

			const { items } = await view.inbox(workspaceId);
			expect(items).toContainEqual(
				expect.objectContaining({ kind: "mention", messageId: inChat?.id }),
			);
			expect(items).toContainEqual(
				expect.objectContaining({ conversationId: run.conversationId, mentionsYou: false }),
			);
		});

		it("lists a collaboration in the person's chats", async () => {
			const current = await aThread();
			const asked = await collaborate(current.id, current.id);

			expect((await view.inbox(workspaceId)).items).toContainEqual(
				expect.objectContaining({
					kind: "collaboration",
					conversationId: asked,
					initiator: expect.objectContaining({ id: botId }),
					recipient: expect.objectContaining({ id: recipientBotId }),
					status: "waiting",
					brief: "Compare the launch plans",
					rootConversationId: current.id,
					unread: true,
				}),
			);
		});

		it("shows a private bot's collaboration to the people of the conversation that asked it, and nobody else", async () => {
			// The member's private bot asks the administrator's private bot.
			await onDatabase((db) =>
				db.update(bot).set({ visibility: "private" }).where(eq(bot.id, botId)),
			);
			await onDatabase((db) =>
				db
					.update(bot)
					.set({ visibility: "private", createdById: administratorId })
					.where(eq(bot.id, recipientBotId)),
			);
			const current = await aThread();
			const asked = await collaborate(current.id, current.id);
			const callId = await askForApproval(asked, "linear__create_issue", recipientBotId);
			const adminView = onPostgresAs(administratorId)(Context.get(conversations, ChatView.Service));

			expect((await view.inbox(workspaceId)).items).toContainEqual(
				expect.objectContaining({
					kind: "collaboration",
					conversationId: asked,
					recipient: expect.objectContaining({ id: recipientBotId }),
				}),
			);
			expect((await view.history(current.id)).items).toContainEqual(
				expect.objectContaining({ conversationId: asked }),
			);
			// The member decides what the asked bot needs approved, though they don't reach it.
			expect((await view.approvals(workspaceId)).waiting).toEqual([
				expect.objectContaining({
					call: expect.objectContaining({ id: callId }),
					rootConversationId: current.id,
				}),
			]);

			// The administrator made the asked bot, but does not reach the member's thread.
			expect((await adminView.inbox(workspaceId)).items).not.toContainEqual(
				expect.objectContaining({ conversationId: asked }),
			);
			expect((await adminView.approvals(workspaceId)).waiting).toEqual([]);
		});

		it("reads a collaboration with the conversation it was asked in", async () => {
			const current = await aThread();
			const asked = await collaborate(current.id, current.id);

			await chats.markRead(current.id);

			expect((await view.inbox(workspaceId)).items).toContainEqual(
				expect.objectContaining({ kind: "collaboration", conversationId: asked, unread: false }),
			);
		});

		/** Whether each automation run and collaboration in the inbox is unread, by its conversation. */
		const itemsUnread = async () =>
			new Map(
				(await view.inbox(workspaceId)).items.flatMap((item) =>
					item.kind === "run" || item.kind === "collaboration"
						? [[item.conversationId, item.unread] as const]
						: [],
				),
			);

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
			for (const run of [earlier, opened, later]) await runPosts(run, "All green.");

			await chats.markItemRead(opened.conversationId);

			const unread = await itemsUnread();
			expect(unread.get(earlier.conversationId)).toBe(true);
			expect(unread.get(opened.conversationId)).toBe(false);
			expect(unread.get(later.conversationId)).toBe(true);
		});

		it("reads only the collaboration opened, leaving the conversation's others unread", async () => {
			const current = await aThread();
			const earlier = await collaborate(current.id, current.id);
			const opened = await collaborate(current.id, current.id);
			const later = await collaborate(current.id, current.id);

			await chats.markItemRead(opened);

			const unread = await itemsUnread();
			expect(unread.get(earlier)).toBe(true);
			expect(unread.get(opened)).toBe(false);
			expect(unread.get(later)).toBe(true);
		});

		it("leaves what was written in the conversation before the item unread", async () => {
			const current = await aThread();
			const before = await botWrites(current.id, "The launch plan is ready", -60);
			const opened = await collaborate(current.id, current.id);

			await chats.markItemRead(opened);

			const { items } = await view.inbox(workspaceId);
			expect(items).toContainEqual(
				expect.objectContaining({ kind: "message", messageId: before.id, unread: true }),
			);
		});

		it("refuses a conversation that is not an automation run or collaboration", async () => {
			const current = await aThread();

			await expect(chats.markItemRead(current.id)).rejects.toMatchObject({
				_tag: "ResourceHidden",
			});
		});

		it("counts an automation run and a collaboration caught up with once the person writes after them", async () => {
			const current = await aThread();
			const created = await automations.create(
				{ projectId: botProjectId },
				{ name: "Overnight review", instructions: "Review it.", triggers: [{ kind: "webhook" }] },
			);
			const run = await automations.run({
				projectId: botProjectId,
				automationId: created.automation.id,
				requestId: crypto.randomUUID(),
			});
			await runPosts(run, "All green.");
			const asked = await collaborate(current.id, current.id);
			const unreadOf = async () =>
				(await view.inbox(workspaceId)).items.flatMap((item) =>
					item.kind === "run" || item.kind === "collaboration"
						? [{ conversationId: item.conversationId, unread: item.unread }]
						: [],
				);
			expect(await unreadOf()).toEqual(
				expect.arrayContaining([
					{ conversationId: run.conversationId, unread: true },
					{ conversationId: asked, unread: true },
				]),
			);

			await chats.post({
				conversationId: current.id,
				messageId: crypto.randomUUID(),
				content: "Seen both",
			});
			// The run is listed in the automation's feed, read there.
			await chats.markRead(
				(
					await chats.openAutomationFeed({
						workspace: workspaceId,
						automationId: created.automation.id,
					})
				).id,
			);

			expect(await unreadOf()).toEqual(
				expect.arrayContaining([
					{ conversationId: run.conversationId, unread: false },
					{ conversationId: asked, unread: false },
				]),
			);
		});
	});

	describe("sending files", () => {
		/** The chat, with the member's uploads to it. */
		async function aChatWithFiles() {
			const { id: conversationId } = await aThread();
			const files = onPostgresAs(userId)(Context.get(conversations, ChatFiles.Service));
			const upload = (name: string) =>
				files.upload({
					conversationId,
					name,
					type: "text/plain",
					stream: Stream.succeed(new TextEncoder().encode(name)),
				});
			return { conversationId, files, upload };
		}
		const asPart = ({ id, name, contentType, size }: ConversationFiles.Upload): FilePart => ({
			type: "file",
			id,
			name,
			contentType,
			size,
		});
		const shownMessage = async (conversationId: string, messageId: string) =>
			(await view.messages(conversationId)).items.find(
				(item) => item.kind === "message" && item.message.id === messageId,
			);

		it("sends the files with the message, in the order listed, for its readers to open", async () => {
			const { conversationId, files, upload } = await aChatWithFiles();
			const first = await upload("a.txt");
			const second = await upload("b.txt");

			const sent = await chats.post({
				conversationId,
				messageId: crypto.randomUUID(),
				content: "",
				attachments: [second.id, first.id],
			});

			expect(sent).toMatchObject({ content: "", parts: [asPart(second), asPart(first)] });
			expect(await shownMessage(conversationId, sent.id)).toMatchObject({
				message: { parts: [asPart(second), asPart(first)] },
			});
			// Watching clients add the announced message as it is, so it must carry its files.
			const [announced] = await onDatabase((db) =>
				db
					.select({ payload: event.payload })
					.from(event)
					.where(
						and(
							eq(event.stream, conversationStream(sent.conversationId)),
							eq(event.type, "message.created"),
						),
					)
					.orderBy(desc(event.seq))
					.limit(1),
			);
			expect(announced?.payload).toMatchObject({
				message: { id: sent.id, parts: [asPart(second), asPart(first)] },
			});
			expect(await files.read({ conversationId, fileId: first.id })).toMatchObject({
				name: "a.txt",
			});
		});

		it("posts nothing when a file is not one of the sender's unsent uploads", async () => {
			const { conversationId, upload } = await aChatWithFiles();
			const sentBefore = await upload("sent.txt");
			await chats.post({
				conversationId,
				messageId: crypto.randomUUID(),
				content: "first",
				attachments: [sentBefore.id],
			});
			const fresh = await upload("fresh.txt");
			const messageId = crypto.randomUUID();

			await expect(
				chats.post({
					conversationId,
					messageId,
					content: "again",
					attachments: [fresh.id, sentBefore.id],
				}),
			).rejects.toBeInstanceOf(ConversationFiles.UploadsNotFound);
			expect(await shownMessage(conversationId, messageId)).toBeUndefined();
			// The fresh upload is still the sender's to send.
			await expect(
				chats.post({ conversationId, messageId, content: "again", attachments: [fresh.id] }),
			).resolves.toMatchObject({ parts: [{ type: "text" }, asPart(fresh)] });
		});

		it("returns a message sent again with its files, and refuses its id for other files", async () => {
			const { conversationId, upload } = await aChatWithFiles();
			const attached = await upload("a.txt");
			const other = await upload("b.txt");
			const messageId = crypto.randomUUID();
			const send = (attachments: string[]) =>
				chats.post({ conversationId, messageId, content: "files", attachments });
			const sent = await send([attached.id]);

			await expect(send([attached.id])).resolves.toEqual(sent);
			await expect(send([other.id])).rejects.toBeInstanceOf(
				ConversationRepository.MessageIdConflict,
			);
		});
	});

	it("keeps an uploaded file as the type it was given, or else the type its name suggests", async () => {
		const { id: conversationId } = await aThread();
		const files = onPostgresAs(userId)(Context.get(conversations, ChatFiles.Service));
		const upload = (name: string, type: string | undefined) =>
			files.upload({
				conversationId,
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
