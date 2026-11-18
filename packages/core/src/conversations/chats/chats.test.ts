import {
	type ChatMessageItem,
	type FilePart,
	handleFromName,
	threadChannel,
} from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { and, desc, eq, like, sql } from "drizzle-orm";
import { Context, Effect, Stream } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Visibility } from "../../authorization/visibility.ts";
import { EventBus } from "../../database/events/bus.ts";
import { EventStore } from "../../database/events/store.ts";
import {
	agent,
	collaboration,
	event,
	laneRequest,
	message,
	messageReaction,
	pod,
	podAgent,
	podMember,
	routineExecution,
	thread,
	threadParticipant,
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
import { INTERVIEW_PROMPT } from "../../workspaces/agents/interview-prompt.ts";
import { onPostgresAs } from "../../workspaces/testing.ts";
import { Reactions } from "../reactions/reactions.ts";
import { Routines } from "../routines/routines.ts";
import { conversationsForTests } from "../testing.ts";
import { ThreadFiles } from "../thread-files/thread-files.ts";
import { ThreadView } from "../thread-view.ts";
import { ThreadRepository } from "../threads/repository.ts";
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
	/** As an administrator, who may define and run the agents' routines. */
	let routines: Promised<Routines.Interface>;
	let workspaceId: string;
	let podId: string;
	let agentId: string;
	let recipientAgentId: string;
	let userId: string;
	let administratorId: string;

	afterAll(async () => {
		await closeDatabase();
	});

	/**
	 * A task the member started with `hostAgentId`, written straight to the
	 * database, so it holds no message and nobody has been asked to answer.
	 */
	const aTask = async (hostAgentId = agentId) => {
		const id = crypto.randomUUID();
		await onDatabase((db) =>
			db.insert(thread).values({
				id,
				workspaceId,
				hostAgentId,
				conversationId: id,
				type: "conversation",
				title: "Task",
				initiatorUserId: userId,
			}),
		);
		await onDatabase((db) =>
			db.insert(threadParticipant).values([
				{ threadId: id, userId },
				{ threadId: id, agentId: hostAgentId },
			]),
		);
		return { id };
	};

	/** The bot's task `conversationId` as the member's list of the bot's tasks shows it. */
	const listedTask = async (conversationId: string, hostAgentId = agentId) =>
		(await view.botTasks(hostAgentId)).tasks.find(
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
		routines = onPostgresAs(administrator.id)(Context.get(conversations, Routines.Service));
		const [room] = await onDatabase((db) =>
			db
				.insert(pod)
				.values({
					workspaceId,
					name: "Chat pod",
					slug: `chat-${suffix}`,
					createdById: userId,
				})
				.returning(),
		);
		if (!room) throw new Error("Could not create chat test pod");
		podId = room.id;
		await onDatabase((db) => db.insert(podMember).values({ workspaceId, podId, userId }));
		const [host, recipient] = await onDatabase((db) =>
			db
				.insert(agent)
				.values([
					{
						workspaceId,
						name: "Personal Agent",
						handle: handleFromName(`Personal Agent ${suffix}`),
						color: "green",
						face: "pill",
						model: "test/model",
						createdById: userId,
					},
					{
						workspaceId,
						name: "Impersonal Agent",
						handle: handleFromName(`Impersonal Agent ${suffix}`),
						color: "sky",
						face: "square",
						model: "test/model",
						createdById: userId,
					},
				])
				.returning(),
		);
		if (!host || !recipient) throw new Error("Could not create chat test agents");
		agentId = host.id;
		recipientAgentId = recipient.id;
		// Both bots are in the channel, so either may be asked in its chats.
		await onDatabase((db) =>
			db.insert(podAgent).values([
				{ workspaceId, podId, agentId },
				{ workspaceId, podId, agentId: recipientAgentId },
			]),
		);
	});

	it("shows a private bot's task to its creator, and to nobody else", async () => {
		await onDatabase((db) =>
			db.update(agent).set({ visibility: "private" }).where(eq(agent.id, agentId)),
		);
		const opened = await aTask();
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

	it("refuses a task with a private bot to anyone but its creator", async () => {
		await onDatabase((db) =>
			db
				.update(agent)
				.set({ visibility: "private", createdById: administratorId })
				.where(eq(agent.id, agentId)),
		);

		await expect(
			chats.startTask({ agentId, messageId: crypto.randomUUID(), content: "Hello?" }),
		).rejects.toMatchObject({ _tag: "ResourceHidden" });
		await expect(view.botTasks(agentId)).rejects.toMatchObject({ _tag: "ResourceHidden" });
	});

	it("starts a task with the bot from its first message, which the bot answers, once", async () => {
		const messageId = crypto.randomUUID();
		const input = {
			agentId,
			messageId,
			content: "\n  Budget   review is Friday\nand bring the numbers",
		};

		const started = await chats.startTask(input);

		expect(started.conversation).toMatchObject({
			hostAgentId: agentId,
			title: "Budget review is Friday and bring the number…",
		});
		expect(started.message).toMatchObject({ id: messageId, threadId: started.conversation.id });
		expect(await runOnPostgres(runningTurns(started.conversation.id))).toHaveLength(1);
		expect((await chats.startTask(input)).conversation.id).toBe(started.conversation.id);
		expect((await view.messages(started.conversation.id))?.items.map((item) => item.kind)).toEqual([
			"message",
		]);
		expect((await view.history(started.conversation.id))?.items).toHaveLength(0);
		expect((await view.botTasks(agentId)).tasks).toEqual([
			{
				agent: expect.objectContaining({ id: agentId }),
				conversation: expect.objectContaining({ id: started.conversation.id }),
				lastMessage: expect.objectContaining({ authorUserId: userId }),
				participants: expect.any(Array),
				waitingOn: null,
				unreadMessages: 0,
				needsApproval: false,
				mentionsYou: false,
			},
		]);
	});

	it("returns the one task to sends of its first message made at once", async () => {
		const input = { agentId, messageId: crypto.randomUUID(), content: "Plan the offsite" };

		const [first, retry] = await Promise.all([chats.startTask(input), chats.startTask(input)]);

		expect(retry.conversation.id).toBe(first.conversation.id);
		expect((await view.botTasks(agentId)).tasks).toHaveLength(1);
	});

	it("gives the task's bot the message the task was started with", async () => {
		const messageId = crypto.randomUUID();
		const started = await chats.startTask({
			agentId,
			messageId,
			content: "Can you check the renewal numbers?",
		});
		const [run] = await runOnPostgres(runningTurns(started.conversation.id));
		if (!run) throw new Error("The task's bot was not asked");

		const prepared = await prepareRunnable(
			onPostgres({ prepare: Context.get(conversations, TurnExecution.Service).prepare }),
			run,
		);

		expect(prepared.context.messages).toEqual([
			expect.objectContaining({ id: messageId, threadId: started.conversation.id }),
		]);
		expect(prepared.context.askedBy).toBe(userId);
	});

	describe("tasks a bot starts for the person it is answering", () => {
		const botThreads = () => onPostgres(Context.get(conversations, BotThreads.Service));
		const handleOf = async (id: string) => {
			const [row] = await onDatabase((db) =>
				db.select({ handle: agent.handle }).from(agent).where(eq(agent.id, id)),
			);
			if (!row) throw new Error("fixture");
			return row.handle;
		};

		it("starts it with the bot asked for, briefed by the starting bot, and asks that bot to work", async () => {
			const started = await botThreads().start(
				{ agentId, workspaceId, askedBy: userId },
				{
					title: "March refunds",
					brief: "Pull the refunds issued in March.",
					withHandle: `@${await handleOf(recipientAgentId)}`,
				},
			);
			expect(started).toEqual({
				id: expect.any(String),
				title: "March refunds",
				with: "Impersonal Agent",
				withBotId: recipientAgentId,
			});
			const participants = await onDatabase((db) =>
				db
					.select({ userId: threadParticipant.userId, agentId: threadParticipant.agentId })
					.from(threadParticipant)
					.where(eq(threadParticipant.threadId, started.id)),
			);
			expect(participants).toEqual(
				expect.arrayContaining([
					{ userId, agentId: null },
					{ userId: null, agentId: recipientAgentId },
				]),
			);
			expect(participants).toHaveLength(2);
			const [run] = await runOnPostgres(runningTurns(started.id));
			if (!run) throw new Error("The thread's bot was not asked");

			const prepared = await prepareRunnable(
				onPostgres({ prepare: Context.get(conversations, TurnExecution.Service).prepare }),
				run,
			);

			expect(prepared.context.agent.id).toBe(recipientAgentId);
			// A bot wrote its brief, so it acts for the person only to mark the thread done.
			expect(prepared.context.askedBy).toBeNull();
			expect(prepared.context.startedFor).toBe(userId);
			expect(prepared.context.messages).toEqual([
				expect.objectContaining({
					content: "Pull the refunds issued in March.",
					author: expect.objectContaining({ kind: "agent", id: agentId }),
				}),
			]);
		});

		it("starts it with the starting bot itself when no other bot is named", async () => {
			const started = await botThreads().start(
				{ agentId, workspaceId, askedBy: userId },
				{ title: "Follow-up", brief: "Draft the follow-up email." },
			);
			expect(started).toEqual({ id: expect.any(String), title: "Follow-up" });
			const [run] = await runOnPostgres(runningTurns(started.id));
			if (!run) throw new Error("The thread's bot was not asked");

			const prepared = await prepareRunnable(
				onPostgres({ prepare: Context.get(conversations, TurnExecution.Service).prepare }),
				run,
			);

			expect(prepared.context.agent.id).toBe(agentId);
			expect(prepared.context.askedBy).toBeNull();
			expect(prepared.context.startedFor).toBe(userId);
		});

		it("marks the task it is in done for the person who asked, but never a channel's chat", async () => {
			const podChat = await chats.openPodChat({ workspace: workspaceId, podId });
			const { conversation: opened } = await chats.startTask({
				agentId,
				messageId: crypto.randomUUID(),
				content: "Can you check the renewal numbers?",
			});
			const bot = { agentId, workspaceId, askedBy: userId };
			const doneAt = async (threadId: string) => {
				const [row] = await onDatabase((db) =>
					db.select({ doneAt: thread.doneAt }).from(thread).where(eq(thread.id, threadId)),
				);
				return row?.doneAt ?? null;
			};

			await botThreads().markDone(bot, opened.id);

			expect(await doneAt(opened.id)).toBeInstanceOf(Date);
			await expect(botThreads().markDone(bot, podChat.id)).rejects.toMatchObject({
				_tag: "NotAThread",
			});
			await expect(
				botThreads().markDone({ ...bot, askedBy: null }, opened.id),
			).rejects.toMatchObject({ _tag: "NobodyAsked" });
		});

		it("refuses when nobody asked, no bot has the handle, or the person can't reach the bot or task", async () => {
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
			// Private to the member the chats are with, so the other member reaches neither it nor its tasks.
			await onDatabase((db) =>
				db.update(agent).set({ visibility: "private" }).where(eq(agent.id, recipientAgentId)),
			);
			const brief = { title: "Elsewhere", brief: "Do it." };

			await expect(
				botThreads().start({ agentId, workspaceId, askedBy: null }, brief),
			).rejects.toMatchObject({ _tag: "NobodyAsked" });
			await expect(
				botThreads().start(
					{ agentId, workspaceId, askedBy: userId },
					{ ...brief, withHandle: "@nobody-here" },
				),
			).rejects.toMatchObject({ _tag: "NoBotWithHandle" });
			await expect(
				botThreads().start(
					{ agentId, workspaceId, askedBy: otherMember.id },
					{ ...brief, withHandle: `@${await handleOf(recipientAgentId)}` },
				),
			).rejects.toMatchObject({ _tag: "HostNotCrew" });
			const { conversation: opened } = await chats.startTask({
				agentId: recipientAgentId,
				messageId: crypto.randomUUID(),
				content: "Can you check the renewal numbers?",
			});
			await expect(
				botThreads().markDone(
					{ agentId: recipientAgentId, workspaceId, askedBy: otherMember.id },
					opened.id,
				),
			).rejects.toMatchObject({ _tag: "ThreadHiddenFromAsker" });
		});
	});

	it("lists a bot's automations by name, each with its thread once it has run", async () => {
		const [quiet, ran] = await Promise.all(
			["Weekly digest", "Overnight review"].map((name) =>
				routines.create(
					{ agentId },
					{ name, instructions: "Review it.", triggers: [{ kind: "webhook" }] },
				),
			),
		);
		if (!quiet || !ran) throw new Error("Could not create the routines");
		const accepted = await routines.run({
			agentId,
			routineId: ran.routine.id,
			requestId: crypto.randomUUID(),
		});

		const listed = (await view.botTasks(agentId)).routines;

		expect(listed).toEqual([
			expect.objectContaining({
				routine: expect.objectContaining({ id: ran.routine.id, name: "Overnight review" }),
				agent: expect.objectContaining({ id: agentId }),
				conversation: expect.objectContaining({ title: "Overnight review" }),
			}),
			expect.objectContaining({
				routine: expect.objectContaining({ id: quiet.routine.id }),
				conversation: null,
			}),
		]);
		const feed = listed?.[0]?.conversation;
		if (!feed) throw new Error("The routine has no thread");
		expect((await view.messages(feed.id))?.items).toEqual([
			expect.objectContaining({ kind: "routine", threadId: accepted.threadId }),
		]);
		expect(
			(await chats.openRoutineFeed({ workspace: workspaceId, routineId: quiet.routine.id })).title,
		).toBe("Weekly digest");
	});

	it("marks a routine whose run failed until the person opens it after the run ends", async () => {
		const created = await routines.create(
			{ agentId },
			{ name: "Overnight review", instructions: "Review it.", triggers: [{ kind: "webhook" }] },
		);
		const accepted = await routines.run({
			agentId,
			routineId: created.routine.id,
			requestId: crypto.randomUUID(),
		});
		const feed = await chats.openRoutineFeed({
			workspace: workspaceId,
			routineId: created.routine.id,
		});
		// Opened while the run was still going, so before it failed.
		await chats.markRead(feed.id);
		await onDatabase((db) =>
			db
				.update(routineExecution)
				.set({
					state: "failed",
					startedAt: sql`${routineExecution.acceptedAt}`,
					finishedAt: sql`${routineExecution.acceptedAt} + interval '1 minute'`,
					error: userText`The reply took too long and was stopped.`,
				})
				.where(eq(routineExecution.id, accepted.executionId)),
		);
		const failed = async () => ({
			listed: (await view.botTasks(agentId)).routines[0]?.routine.failed,
			counted: (await view.podMarkers(workspaceId)).agents[agentId]?.failedRoutines ?? 0,
		});

		expect(await failed()).toEqual({ listed: true, counted: 1 });
		await chats.markRead(feed.id);
		expect(await failed()).toEqual({ listed: false, counted: 0 });
	});

	it("marks a task done, and reopens it when somebody writes in it", async () => {
		const { conversation: current } = await chats.startTask({
			agentId,
			messageId: crypto.randomUUID(),
			content: "Can you check the renewal numbers?",
		});
		const doneAt = async () => (await listedTask(current.id))?.conversation.doneAt;

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
		const current = await aTask();
		const mentioned = async () => (await listedTask(current.id))?.mentionsYou;
		expect(await mentioned()).toBe(false);

		await onDatabase((db) =>
			db.insert(message).values({
				threadId: current.id,
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
		const current = await aTask();

		await onDatabase((db) =>
			db.insert(message).values({
				threadId: current.id,
				authorUserId: administratorId,
				kind: "text",
				status: "complete",
				parts: [{ type: "text", text: "@here standup is starting" }],
				content: "@here standup is starting",
			}),
		);

		expect((await listedTask(current.id))?.mentionsYou).toBe(true);
	});

	it("does not say a bot's @channel mentions the person", async () => {
		const current = await aTask();

		await onDatabase((db) =>
			db.insert(message).values({
				threadId: current.id,
				authorAgentId: agentId,
				kind: "text",
				status: "complete",
				parts: [{ type: "text", text: "@channel the report is done" }],
				content: "@channel the report is done",
			}),
		);

		expect((await listedTask(current.id))?.mentionsYou).toBe(false);
	});

	it("refuses to mark a channel's main chat done", async () => {
		const podChat = await chats.openPodChat({ workspace: workspaceId, podId });

		await expect(chats.setDone({ conversationId: podChat.id, done: true })).rejects.toMatchObject({
			_tag: "ResourceHidden",
		});
	});

	it("lists a channel by its slug as by its id, as an address names it", async () => {
		const byId = await view.list({ workspace: workspaceId, pod: podId });
		const [room] = await onDatabase((db) =>
			db.select({ slug: pod.slug }).from(pod).where(eq(pod.id, podId)),
		);

		expect(await view.list({ workspace: workspaceId, pod: room?.slug ?? "" })).toEqual(byId);
	});

	it("previews a bot's reply as the list of its tasks shows it, without the words before a tool call", async () => {
		const { conversation: current } = await chats.startTask({
			agentId,
			messageId: crypto.randomUUID(),
			content: "Can you try again?",
		});
		await onDatabase((db) =>
			db.insert(message).values({
				threadId: current.id,
				authorAgentId: agentId,
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

		expect((await listedTask(current.id))?.lastMessage?.preview).toBe("I'm still getting denied.");
	});

	describe("unread and waiting chats", () => {
		/** The host writes `content` in its chat, `secondsLater` after now, and returns the message. */
		const botWrites = async (threadId: string, content: string, secondsLater = 0) => {
			const [written] = await onDatabase((db) =>
				db
					.insert(message)
					.values({
						threadId,
						authorAgentId: agentId,
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
		/** The host's one task, as the list of its tasks shows it. */
		const hostRow = async () => (await view.botTasks(agentId)).tasks[0];

		it("counts what a bot writes after the person last read the chat", async () => {
			const current = await aTask();
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
			const current = await aTask();
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
			const current = await aTask();
			await chats.post({
				conversationId: current.id,
				messageId: crypto.randomUUID(),
				content: "Hey",
			});
			const [reply] = await onDatabase((db) =>
				db
					.insert(message)
					.values({
						threadId: current.id,
						authorAgentId: agentId,
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
			const current = await aTask();
			await chats.post({
				conversationId: current.id,
				messageId: crypto.randomUUID(),
				content: "Hey",
			});
			const [reply] = await onDatabase((db) =>
				db
					.insert(message)
					.values({
						threadId: current.id,
						authorAgentId: agentId,
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
			const threads = onPostgresAs(userId)(Context.get(conversations, ThreadView.Service));
			const current = await aTask();
			const reply = await botWrites(current.id, "Hello!", 1);
			const readsAnnounced = async () =>
				(
					await onDatabase((db) =>
						db
							.select({ type: event.type })
							.from(event)
							.where(eq(event.channel, threadChannel(current.id))),
					)
				).filter(({ type }) => type === "thread.read").length;

			await chats.markRead(current.id);
			await chats.markRead(current.id);

			const [read] = (await threads.get(current.id)).reads;
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
			const [readAgain] = (await threads.get(current.id)).reads;
			expect(Date.parse(readAgain?.readAt ?? "")).toBeGreaterThan(Date.parse(read?.readAt ?? ""));
		});

		it("adds up each bot's unread messages for the rail", async () => {
			const current = await aTask();
			const other = await aTask(recipientAgentId);
			expect(await view.podMarkers(workspaceId)).toEqual({ pods: {}, agents: {} });

			await botWrites(current.id, "Hello!");
			await botWrites(current.id, "Are you there?", 1);
			await onDatabase((db) =>
				db.insert(message).values({
					threadId: other.id,
					authorAgentId: recipientAgentId,
					kind: "text",
					status: "complete",
					parts: [{ type: "text", text: "Morning" }],
					content: "Morning",
				}),
			);

			expect(await view.podMarkers(workspaceId)).toEqual({
				pods: {},
				agents: {
					[agentId]: { unreadMessages: 2, needsApproval: false, failedRoutines: 0 },
					[recipientAgentId]: { unreadMessages: 1, needsApproval: false, failedRoutines: 0 },
				},
			});
		});

		it("marks a chat waiting on a tool call the person may decide", async () => {
			const current = await aTask();
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
						threadId: current.id,
						agentId,
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
					threadId: current.id,
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

			// A routine run elsewhere, so an approval outside any run must not be taken for one.
			const elsewhere = await routines.create(
				{ agentId: recipientAgentId },
				{ name: "Elsewhere", instructions: "Run somewhere else.", triggers: [{ kind: "webhook" }] },
			);
			await routines.run({
				agentId: recipientAgentId,
				routineId: elsewhere.routine.id,
				requestId: crypto.randomUUID(),
			});

			expect(await hostRow()).toMatchObject({ needsApproval: true });
			expect((await view.podMarkers(workspaceId)).agents[agentId]).toEqual({
				unreadMessages: 0,
				needsApproval: true,
				failedRoutines: 0,
			});
		});
	});

	it("lists a channel the person is in, and hides one they are not", async () => {
		const [unjoined] = await onDatabase((db) =>
			db
				.insert(pod)
				.values({
					workspaceId,
					name: "Elsewhere",
					slug: `elsewhere-${crypto.randomUUID()}`,
					visibility: "private",
					createdById: administratorId,
				})
				.returning(),
		);
		if (!unjoined) throw new Error("Could not create the channel");

		await expect(view.list({ workspace: workspaceId, pod: unjoined.id })).rejects.toMatchObject({
			_tag: "ResourceHidden",
		});
		expect(await view.list({ workspace: workspaceId, pod: podId })).toEqual({ chats: [] });
	});

	describe("the interview a new bot starts with its creator", () => {
		const interviewDue = (changes: Partial<typeof agent.$inferInsert> = {}) =>
			onDatabase((db) =>
				db
					.update(agent)
					.set({ prompt: INTERVIEW_PROMPT, ...changes })
					.where(eq(agent.id, agentId)),
			);

		it("starts once, in a task named for the bot, without posting a message for the creator", async () => {
			await interviewDue();
			const opened = await chats.startInterview(agentId);
			if (!opened) throw new Error("The interview did not start");
			expect(opened).toMatchObject({ hostAgentId: agentId, title: "Setting up Personal Agent" });
			expect(await chats.startInterview(agentId)).toBeNull();
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
				sandbox: undefined,
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
						.where(eq(laneRequest.laneKey, `turn:${opened.id}:${agentId}`)),
				),
			).toEqual([]);
			const messages = (await view.messages(opened.id)).items;
			expect(messages).toHaveLength(1);
			expect(messages[0]).toMatchObject({
				kind: "message",
				message: { author: { kind: "agent", id: agentId } },
			});
		});

		it("starts only for the bot's creator", async () => {
			await interviewDue({ createdById: administratorId });

			await expect(chats.startInterview(agentId)).rejects.toMatchObject({
				_tag: "ActionForbidden",
			});
			const creator = onPostgresAs(administratorId)(Context.get(conversations, Chats.Service));
			const opened = await creator.startInterview(agentId);
			if (!opened) throw new Error("The interview did not start");
			expect(await runOnPostgres(runningTurns(opened.id))).toHaveLength(1);
		});

		it("starts once a missing model is configured", async () => {
			await interviewDue({ model: null });
			expect(await chats.startInterview(agentId)).toBeNull();

			await onDatabase((db) =>
				db.update(agent).set({ model: "test/model" }).where(eq(agent.id, agentId)),
			);

			const opened = await chats.startInterview(agentId);
			if (!opened) throw new Error("The interview did not start");
			expect(await runOnPostgres(runningTurns(opened.id))).toHaveLength(1);
		});

		it("does not start for a bot that already has a task", async () => {
			await aTask();
			await interviewDue();

			expect(await chats.startInterview(agentId)).toBeNull();
		});

		it.each(["", "Help with releases"])(
			"does not start for a bot with written instructions %j",
			async (prompt) => {
				await onDatabase((db) => db.update(agent).set({ prompt }).where(eq(agent.id, agentId)));

				expect(await chats.startInterview(agentId)).toBeNull();
			},
		);
	});

	it("opens one main chat per channel, where a bot named in a message answers in it, and no bot otherwise", async () => {
		const input = { workspace: workspaceId, podId };
		const [first, again] = await Promise.all([chats.openPodChat(input), chats.openPodChat(input)]);
		expect(again.id).toBe(first.id);
		expect(first).toMatchObject({ kind: "pod_chat", podId, main: true, title: "General" });
		const [host] = await onDatabase((db) =>
			db.select({ handle: agent.handle }).from(agent).where(eq(agent.id, agentId)),
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
			expect.objectContaining({ request: expect.objectContaining({ agentId, reason: "mention" }) }),
		]);
	});

	it("lets a person in a channel decide the computer requests of the bots they made, and only theirs", async () => {
		await onDatabase((db) =>
			db.update(agent).set({ createdById: administratorId }).where(eq(agent.id, recipientAgentId)),
		);
		const chat = await chats.openPodChat({ workspace: workspaceId, podId });
		await onDatabase((db) =>
			db.insert(threadParticipant).values([
				{ threadId: chat.id, agentId },
				{ threadId: chat.id, agentId: recipientAgentId },
			]),
		);
		const threads = onPostgresAs(userId)(Context.get(conversations, ThreadView.Service));

		expect((await threads.get(chat.id)).capabilities?.approveSandboxRequestsOf).toEqual([agentId]);
	});

	it("asks the bot a message in the channel's main chat replies to, though it names nobody", async () => {
		const podChat = await chats.openPodChat({ workspace: workspaceId, podId });
		const [answer] = await onDatabase((db) =>
			db
				.insert(message)
				.values({
					threadId: podChat.id,
					authorAgentId: agentId,
					kind: "text",
					status: "complete",
					parts: [{ type: "text", text: "Nothing logged for yesterday." }],
					content: "Nothing logged for yesterday.",
				})
				.returning({ id: message.id }),
		);
		if (!answer) throw new Error("The bot's message was not written");

		await chats.post({
			conversationId: podChat.id,
			messageId: crypto.randomUUID(),
			content: "Do you have saved routines?",
			replyTo: answer.id,
		});

		expect(await runOnPostgres(runningTurns(podChat.id))).toEqual([
			expect.objectContaining({ request: expect.objectContaining({ agentId, reason: "reply" }) }),
		]);
	});

	it("keeps a bot out of its task for a message to a person in it, but not for a handle that is nobody's", async () => {
		const channel = await aTask();

		await chats.post({
			conversationId: channel.id,
			messageId: crypto.randomUUID(),
			content: "@chat-member can you look at this?",
		});

		expect(await runOnPostgres(runningTurns(channel.id))).toHaveLength(0);

		await chats.post({
			conversationId: channel.id,
			messageId: crypto.randomUUID(),
			content: "Please raise this with @Backlog Manager, high priority.",
		});

		expect(await runOnPostgres(runningTurns(channel.id))).toEqual([
			expect.objectContaining({ request: expect.objectContaining({ agentId, reason: "default" }) }),
		]);
	});

	it("keeps a bot out of its task for a message to someone who left the workspace but is still in the task", async () => {
		const channel = await aTask();
		const [former] = await onDatabase((db) =>
			db
				.insert(user)
				.values({ name: "Former member", email: `former-${crypto.randomUUID()}@example.com` })
				.returning(),
		);
		if (!former) throw new Error("Could not create the former member");
		await onDatabase((db) =>
			db.insert(threadParticipant).values({ threadId: channel.id, userId: former.id }),
		);

		await chats.post({
			conversationId: channel.id,
			messageId: crypto.randomUUID(),
			content: "@former-member are you still around?",
		});

		expect(await runOnPostgres(runningTurns(channel.id))).toHaveLength(0);
	});

	it("lists a channel's main chat with what the person has not read in it, and counts that on the rail", async () => {
		const podChat = await chats.openPodChat({ workspace: workspaceId, podId });
		await onDatabase((db) =>
			db.insert(message).values({
				threadId: podChat.id,
				authorUserId: administratorId,
				kind: "text",
				status: "complete",
				parts: [{ type: "text", text: "Lunch?" }],
				content: "Lunch?",
			}),
		);

		expect((await view.list({ workspace: workspaceId, pod: podId }))?.chats).toEqual([
			{ conversation: expect.objectContaining({ id: podChat.id, main: true }), unreadMessages: 1 },
		]);
		expect(await view.podMarkers(workspaceId)).toEqual({
			pods: { [podId]: { unreadMessages: 1, needsApproval: false, failedRoutines: 0 } },
			agents: {},
		});
	});

	it("lists the channel's main chat and threads, the main chat first, and hides a thread once archived", async () => {
		const first = await chats.openPodChat({ workspace: workspaceId, podId });
		const pricing = await chats.startChat({ podId, name: "Pricing" });
		const launch = await chats.startChat({ podId, name: "Launch" });

		const listed = async () =>
			(await view.list({ workspace: workspaceId, pod: podId }))?.chats.map(
				({ conversation }) => conversation.title,
			);
		expect(await listed()).toEqual([first.title, "Pricing", "Launch"]);

		// Changing a chat is for whoever may change the pod.
		const administering = onPostgresAs(administratorId)(Context.get(conversations, Chats.Service));
		await administering.changeChat({ conversationId: pricing.id, change: { name: "Prices" } });
		await administering.changeChat({ conversationId: launch.id, change: { archived: true } });
		// The first chat can be renamed, but stays.
		await administering.changeChat({ conversationId: first.id, change: { name: "Everyone" } });
		await expect(
			administering.changeChat({ conversationId: first.id, change: { archived: true } }),
		).rejects.toMatchObject({ _tag: "FirstChatNotArchivable" });

		expect(await listed()).toEqual(["Everyone", "Prices"]);
	});

	it("leaves renaming and archiving a channel's thread to whoever may change the channel", async () => {
		const pricing = await chats.startChat({ podId, name: "Pricing" });

		// The member the chats are with may start one, but not change the pod.
		await expect(
			chats.changeChat({ conversationId: pricing.id, change: { archived: true } }),
		).rejects.toMatchObject({ _tag: "ActionForbidden" });
	});

	it("refuses a message to an agent with no model, and saves nothing", async () => {
		await onDatabase((db) => db.update(agent).set({ model: null }).where(eq(agent.id, agentId)));
		const current = await aTask();
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
		const current = await aTask();
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
		const current = await aTask();
		const elsewhere = await aTask(recipientAgentId);
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
		const current = await aTask();
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
							eq(event.channel, threadChannel(current.id)),
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
		const current = await aTask();
		const asked = await chats.post({
			conversationId: current.id,
			messageId: crypto.randomUUID(),
			content: "Ship it?",
		});
		const [writing] = await onDatabase((db) =>
			db
				.insert(message)
				.values({
					threadId: current.id,
					authorAgentId: agentId,
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

	it("says which messages wait for the agent's next turn, and announces when one starts waiting", async () => {
		const threads = onPostgresAs(userId)(Context.get(conversations, ThreadView.Service));
		const current = await aTask();
		const post = (content: string) =>
			chats.post({ conversationId: current.id, messageId: crypto.randomUUID(), content });
		const changesAnnounced = async () =>
			(
				await onDatabase((db) =>
					db
						.select({ type: event.type })
						.from(event)
						.where(eq(event.channel, threadChannel(current.id))),
				)
			).filter(({ type }) => type === "thread.changed").length;

		await post("Is checkout timing out?");
		expect((await threads.get(current.id)).queuedSince).toBeNull();
		const changedBefore = await changesAnnounced();

		const followUp = await post("The Stripe webhook too?");
		await post("Started around 9.");

		expect((await threads.get(current.id)).queuedSince).toBe(followUp.createdAt);
		// Once, when the turn started waiting; the next message joins it.
		expect((await changesAnnounced()) - changedBefore).toBe(1);
	});

	it("queues nothing posted before a turn resumed from an earlier reply starts waiting", async () => {
		const threads = onPostgresAs(userId)(Context.get(conversations, ThreadView.Service));
		const turns = Context.get(conversations, Turns.Service);
		const current = await aTask();
		const asked = await chats.post({
			conversationId: current.id,
			messageId: crypto.randomUUID(),
			content: "Who owns checkout?",
		});

		// A collaboration answered after the agent moved on resumes it from the
		// reply that opened it, which is long since answered.
		await runOnPostgres(
			turns.ask({
				threadId: current.id,
				agentId,
				triggerMessageId: asked.id,
				reason: "resume",
			}),
		);
		const later = await chats.post({
			conversationId: current.id,
			messageId: crypto.randomUUID(),
			content: "And billing?",
		});

		const { queuedSince } = await threads.get(current.id);
		expect(Date.parse(queuedSince ?? "")).toBeGreaterThan(Date.parse(asked.createdAt));
		expect(Date.parse(queuedSince ?? "")).toBeLessThanOrEqual(Date.parse(later.createdAt));
	});

	it("announces a person's message before the agent it brings into the thread", async () => {
		const current = await aTask();
		// The chat's agent has not joined its thread yet, so the message brings it in.
		await onDatabase((db) =>
			db
				.delete(threadParticipant)
				.where(
					and(eq(threadParticipant.threadId, current.id), eq(threadParticipant.agentId, agentId)),
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
				.where(eq(event.channel, threadChannel(current.id)))
				.orderBy(event.seq),
		);
		expect(announced.slice(0, 2).map(({ type }) => type)).toEqual([
			"message.created",
			"thread.changed",
		]);
	});

	it("lists Routine runs in the routine's thread", async () => {
		const created = await routines.create(
			{ agentId },
			{
				name: "Overnight review",
				instructions: "Review overnight changes.",
				triggers: [{ kind: "webhook" }],
			},
		);
		const requestId = crypto.randomUUID();
		const accepted = await routines.run({ agentId, routineId: created.routine.id, requestId });
		// The routine's own thread, where its runs are listed.
		const current = await chats.openRoutineFeed({
			workspace: workspaceId,
			routineId: created.routine.id,
		});

		expect((await view.messages(current.id))?.items).toEqual([
			expect.objectContaining({
				kind: "routine",
				id: accepted.executionId,
				threadId: accepted.threadId,
				routineName: "Overnight review",
				triggerKind: "manual",
			}),
		]);
	});

	it("paginates interleaved messages and Routine runs in a routine's thread without gaps", async () => {
		const created = await routines.create(
			{ agentId },
			{
				name: "Overnight review",
				instructions: "Review overnight changes.",
				triggers: [{ kind: "webhook" }],
			},
		);
		const requestId = crypto.randomUUID();
		const accepted = await routines.run({ agentId, routineId: created.routine.id, requestId });
		// The routine's own thread, where its runs are listed.
		const current = await chats.openRoutineFeed({
			workspace: workspaceId,
			routineId: created.routine.id,
		});
		const olderMessageId = crypto.randomUUID();
		const newerMessageId = crypto.randomUUID();
		await onDatabase((db) =>
			db.insert(message).values([
				{
					id: olderMessageId,
					threadId: current.id,
					authorUserId: userId,
					kind: "text",
					status: "complete",
					parts: [{ type: "text", text: "Older message" }],
					content: "Older message",
					createdAt: new Date("2026-09-18T09:00:00.000Z"),
				},
				{
					id: newerMessageId,
					threadId: current.id,
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
				.update(routineExecution)
				.set({ acceptedAt: new Date("2026-09-18T10:00:00.000Z") })
				.where(eq(routineExecution.id, accepted.executionId)),
		);

		const firstPage = await view.messages(current.id, { limit: 2 });
		expect(firstPage?.items.map(timelineItemId)).toEqual([accepted.executionId, newerMessageId]);
		expect(firstPage?.nextCursor).toBeTypeOf("string");
		if (!firstPage?.nextCursor) throw new Error("Expected another Chat timeline page");

		const secondPage = await view.messages(current.id, {
			limit: 2,
			cursor: firstPage.nextCursor,
		});
		expect(secondPage?.items.map(timelineItemId)).toEqual([olderMessageId]);
		expect(secondPage?.nextCursor).toBeNull();
	});

	it("shows a collaboration in the asking task", async () => {
		const initiatorChat = await aTask();
		const trigger = await chats.post({
			conversationId: initiatorChat.id,
			messageId: crypto.randomUUID(),
			content: "Ask Impersonal Agent",
		});
		if (!trigger) throw new Error("Could not create collaboration trigger");
		const collaborationId = crypto.randomUUID();
		const [askingTurn] = await onDatabase((db) =>
			db
				.insert(turn)
				.values({
					threadId: initiatorChat.id,
					agentId,
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
					threadId: initiatorChat.id,
					authorAgentId: agentId,
					kind: "text",
					status: "complete",
					parts: [{ type: "collaboration", collaborationId }],
					content: "",
					turnId: askingTurn.id,
				})
				.returning(),
		);
		const [child] = await onDatabase((db) =>
			db
				.insert(thread)
				.values({
					workspaceId,
					hostAgentId: recipientAgentId,
					conversationId: initiatorChat.id,
					type: "collaboration",
					title: "Compare the launch plans",
					parentThreadId: initiatorChat.id,
					initiatorUserId: userId,
				})
				.returning(),
		);
		if (!parentMessage || !child) throw new Error("Could not create collaboration threads");
		await onDatabase((db) =>
			db.insert(threadParticipant).values([
				{ threadId: child.id, agentId },
				{ threadId: child.id, agentId: recipientAgentId },
			]),
		);
		await onDatabase((db) =>
			db.insert(collaboration).values({
				id: collaborationId,
				parentThreadId: initiatorChat.id,
				parentMessageId: parentMessage.id,
				turnId: askingTurn.id,
				childThreadId: child.id,
				collaboratorAgentId: recipientAgentId,
				brief: "Compare the launch plans",
				status: "waiting",
				atOffset: 0,
			}),
		);

		const outbound = await view.messages(initiatorChat.id);
		expect(outbound?.items.at(-1)).toMatchObject({
			kind: "message",
			message: { parts: [{ type: "collaboration", threadId: child.id }] },
		});
	});

	it("reports each history thread's own status, participants, and Routine run", async () => {
		const created = await routines.create(
			{ agentId },
			{
				name: "Overnight review",
				instructions: "Review overnight changes.",
				triggers: [{ kind: "webhook" }],
			},
		);
		const requestId = crypto.randomUUID();
		const accepted = await routines.run({ agentId, routineId: created.routine.id, requestId });
		// The routine's own thread, where its runs are listed.
		const current = await chats.openRoutineFeed({
			workspace: workspaceId,
			routineId: created.routine.id,
		});
		const [failed, running] = await onDatabase((db) =>
			db
				.insert(thread)
				.values(
					["Failed collaboration", "Running collaboration"].map((title) => ({
						workspaceId,
						hostAgentId: agentId,
						conversationId: current.id,
						type: "collaboration" as const,
						title,
						parentThreadId: current.id,
						initiatorUserId: userId,
					})),
				)
				.returning(),
		);
		if (!failed || !running) throw new Error("Could not create collaboration threads");
		await onDatabase((db) =>
			db.insert(threadParticipant).values([
				{ threadId: failed.id, agentId },
				{ threadId: running.id, userId },
				{ threadId: running.id, agentId: recipientAgentId },
			]),
		);
		const [failedTrigger] = await onDatabase((db) =>
			db
				.insert(message)
				.values({
					threadId: failed.id,
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
				threadId: failed.id,
				agentId,
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
				threadId: running.id,
				agentId: recipientAgentId,
				triggerMessageId: crypto.randomUUID(),
				reason: "collaboration",
			}),
		);

		const items = (await view.history(current.id))?.items ?? [];
		const entry = (threadId: string) => items.find((item) => item.threadId === threadId);
		expect(items).toHaveLength(3);
		expect(entry(failed.id)).toMatchObject({
			status: "failed",
			participants: [expect.objectContaining({ id: agentId })],
			routineExecution: null,
		});
		expect(entry(running.id)).toMatchObject({
			status: "running",
			participants: [
				expect.objectContaining({ id: userId }),
				expect.objectContaining({ id: recipientAgentId }),
			],
			routineExecution: null,
		});
		expect(entry(accepted.threadId)).toMatchObject({
			type: "routine",
			status: "queued",
			routineExecution: {
				executionId: accepted.executionId,
				routineId: created.routine.id,
				routineName: "Overnight review",
				triggerKind: "manual",
				triggeredAt: expect.any(String),
			},
		});
	});

	describe("the approvals and activity across a workspace", () => {
		/** The host writes `content` in `threadId`, `secondsLater` after now, and returns the message. */
		const botWrites = async (threadId: string, content: string, secondsLater = 0) => {
			const [written] = await onDatabase((db) =>
				db
					.insert(message)
					.values({
						threadId,
						authorAgentId: agentId,
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

		/** The run completes, posting `content` as its result in the routine's thread. */
		const runPosts = async (run: { executionId: string; threadId: string }, content: string) => {
			await onDatabase((db) =>
				db
					.update(routineExecution)
					.set({
						state: "completed",
						startedAt: sql`${routineExecution.acceptedAt}`,
						finishedAt: sql`${routineExecution.acceptedAt} + interval '1 minute'`,
					})
					.where(eq(routineExecution.id, run.executionId)),
			);
			const [runThread] = await onDatabase((db) =>
				db
					.select({ conversationId: thread.conversationId })
					.from(thread)
					.where(eq(thread.id, run.threadId)),
			);
			if (!runThread?.conversationId) throw new Error("fixture");
			await onDatabase((db) =>
				db.insert(message).values({
					threadId: runThread.conversationId as string,
					authorAgentId: agentId,
					routineExecutionId: run.executionId,
					kind: "text",
					status: "complete",
					parts: [{ type: "text", text: content }],
					content,
				}),
			);
		};

		/** A reply in the chat that called `tool` and stopped for someone to approve it. */
		const askForApproval = async (
			threadId: string,
			tool = "linear__create_issue",
			askingAgentId = agentId,
		) => {
			const reply = await botWrites(threadId, "", 1);
			const [asked] = await onDatabase((db) =>
				db
					.insert(turn)
					.values({
						threadId,
						agentId: askingAgentId,
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
						threadId,
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

		/** The host asks the other bot in its chat to compare the launch plans, and returns the asked bot's thread. */
		const collaborate = async (mainThreadId: string, conversationId: string) => {
			const trigger = await botWrites(mainThreadId, "", 0);
			const [askingTurn] = await onDatabase((db) =>
				db
					.insert(turn)
					.values({
						threadId: mainThreadId,
						agentId,
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
						threadId: mainThreadId,
						authorAgentId: agentId,
						kind: "text",
						status: "complete",
						parts: [{ type: "collaboration", collaborationId }],
						content: "",
						turnId: askingTurn.id,
					})
					.returning(),
			);
			const [child] = await onDatabase((db) =>
				db
					.insert(thread)
					.values({
						workspaceId,
						hostAgentId: recipientAgentId,
						conversationId,
						type: "collaboration",
						title: "Compare the launch plans",
						parentThreadId: mainThreadId,
						initiatorUserId: userId,
					})
					.returning(),
			);
			if (!asking || !child) throw new Error("fixture");
			await onDatabase((db) =>
				db.insert(collaboration).values({
					id: collaborationId,
					parentThreadId: mainThreadId,
					parentMessageId: asking.id,
					turnId: askingTurn.id,
					childThreadId: child.id,
					collaboratorAgentId: recipientAgentId,
					brief: "Compare the launch plans",
					status: "waiting",
					atOffset: 0,
				}),
			);
			return child.id;
		};

		it("lists a call waiting on the person's decision, then among the answered once decided", async () => {
			const current = await aTask();
			const callId = await askForApproval(current.id);

			expect(await view.approvals(workspaceId)).toEqual({
				waiting: [
					expect.objectContaining({
						call: expect.objectContaining({ id: callId, tool: "linear__create_issue" }),
						agent: expect.objectContaining({ id: agentId }),
						podId: null,
						threadId: current.id,
						conversationId: current.id,
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
		});

		it("lists a call waiting on the person's decision behind many they may not decide", async () => {
			// Made by the administrator, so the member uses it but does not manage it.
			await onDatabase((db) =>
				db.update(agent).set({ createdById: administratorId }).where(eq(agent.id, agentId)),
			);
			const current = await aTask();
			const created = await routines.create(
				{ agentId },
				{ name: "Overnight filing", instructions: "File it.", triggers: [{ kind: "webhook" }] },
			);
			const run = await routines.run({
				agentId,
				routineId: created.routine.id,
				requestId: crypto.randomUUID(),
			});
			// Only the bot's managers decide what an automation asks, and these are older than
			// every call the inbox would list, so they would fill it first.
			const reply = await botWrites(run.threadId, "", 1);
			const [asked] = await onDatabase((db) =>
				db
					.insert(turn)
					.values({
						threadId: run.threadId,
						agentId,
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
						threadId: run.threadId,
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
				db.update(agent).set({ createdById: administratorId }).where(eq(agent.id, agentId)),
			);
			const current = await aTask();
			await askForApproval(current.id, "request_network_access");
			const callId = await askForApproval(current.id);

			expect((await view.approvals(workspaceId)).waiting).toEqual([
				expect.objectContaining({ call: expect.objectContaining({ id: callId }) }),
			]);
		});

		it("lists what the person has not read, and keeps what mentions them once read", async () => {
			const current = await aTask();
			const news = await botWrites(current.id, "The deploy finished.", 1);
			const mention = await botWrites(current.id, "@chat-member can you check it?", 2);

			expect((await view.activity(workspaceId)).items).toEqual([
				expect.objectContaining({ kind: "mention", messageId: mention.id, unread: true }),
				expect.objectContaining({
					kind: "message",
					messageId: news.id,
					unread: true,
					preview: "The deploy finished.",
					conversationId: current.id,
				}),
			]);

			await chats.markRead(current.id);

			expect((await view.activity(workspaceId)).items).toEqual([
				expect.objectContaining({ kind: "mention", messageId: mention.id, unread: false }),
			]);
		});

		it("does not take an email address for a mention", async () => {
			const current = await aTask();
			await chats.markRead(current.id);
			await botWrites(current.id, "Mail it to ops@chat-member.example", 1);

			expect((await view.activity(workspaceId)).items).toEqual([
				expect.objectContaining({ kind: "message" }),
			]);
		});

		it("lists a routine run in the person's chats, with the start of what it said", async () => {
			const created = await routines.create(
				{ agentId },
				{ name: "Overnight review", instructions: "Review it.", triggers: [{ kind: "webhook" }] },
			);
			const accepted = await routines.run({
				agentId,
				routineId: created.routine.id,
				requestId: crypto.randomUUID(),
			});
			await botWrites(accepted.threadId, "Two PRs merged.\nThe release branch is green.", 1);
			await runPosts(accepted, "Two PRs merged.\nThe release branch is green.");

			expect((await view.activity(workspaceId)).items).toContainEqual(
				expect.objectContaining({
					kind: "routine",
					threadId: accepted.threadId,
					routineName: "Overnight review",
					triggerKind: "manual",
					agent: expect.objectContaining({ id: agentId }),
					preview: "Two PRs merged. The release branch is green.",
					conversationId: (await view.botTasks(agentId)).routines[0]?.conversation?.id,
					mentionsYou: false,
					unread: true,
				}),
			);
		});

		it("counts a routine run unread only once it posted a result or failed", async () => {
			const created = await routines.create(
				{ agentId },
				{ name: "Overnight review", instructions: "Review it.", triggers: [{ kind: "webhook" }] },
			);
			const runRoutine = () =>
				routines.run({ agentId, routineId: created.routine.id, requestId: crypto.randomUUID() });
			const running = await runRoutine();
			const quiet = await runRoutine();
			await onDatabase((db) =>
				db
					.update(routineExecution)
					.set({ state: "completed", startedAt: new Date(), finishedAt: new Date() })
					.where(eq(routineExecution.id, quiet.executionId)),
			);
			const asking = await runRoutine();
			await runPosts(asking, "@chat-member the deploy needs your sign-off.");

			const runs = (await view.activity(workspaceId)).items.flatMap((item) =>
				item.kind === "routine"
					? [{ threadId: item.threadId, unread: item.unread, mentionsYou: item.mentionsYou }]
					: [],
			);
			expect(runs).toEqual([
				{ threadId: asking.threadId, unread: true, mentionsYou: true },
				{ threadId: running.threadId, unread: false, mentionsYou: false },
			]);
		});

		it("shows what a routine run said in the routine's thread", async () => {
			const created = await routines.create(
				{ agentId },
				{ name: "Overnight review", instructions: "Review it.", triggers: [{ kind: "webhook" }] },
			);
			const accepted = await routines.run({
				agentId,
				routineId: created.routine.id,
				requestId: crypto.randomUUID(),
			});
			await botWrites(accepted.threadId, "Two PRs merged.\nThe release branch is green.", 1);
			const feed = (await view.botTasks(agentId)).routines[0]?.conversation;

			expect((await view.messages(feed?.id ?? ""))?.items).toEqual([
				expect.objectContaining({
					kind: "routine",
					threadId: accepted.threadId,
					report: "Two PRs merged.\nThe release branch is green.",
				}),
			]);
		});

		it("makes a run opened while it ran news again once it posts its result", async () => {
			const created = await routines.create(
				{ agentId },
				{ name: "Overnight review", instructions: "Review it.", triggers: [{ kind: "webhook" }] },
			);
			const run = await routines.run({
				agentId,
				routineId: created.routine.id,
				requestId: crypto.randomUUID(),
			});
			await chats.markItemRead(run.threadId);

			await runPosts(run, "@chat-member the deploy needs your sign-off.");

			expect((await view.activity(workspaceId)).items).toContainEqual(
				expect.objectContaining({ threadId: run.threadId, unread: true, mentionsYou: true }),
			);
		});

		it("leaves a result posted in a channel's chat as well to mention the person there", async () => {
			const created = await routines.create(
				{ agentId },
				{ name: "Overnight review", instructions: "Review it.", triggers: [{ kind: "webhook" }] },
			);
			const run = await routines.run({
				agentId,
				routineId: created.routine.id,
				requestId: crypto.randomUUID(),
			});
			const content = "@chat-member the deploy needs your sign-off.";
			await runPosts(run, content);
			const podChat = await chats.openPodChat({ workspace: workspaceId, podId });
			const [inChat] = await onDatabase((db) =>
				db
					.insert(message)
					.values({
						threadId: podChat.id,
						authorAgentId: agentId,
						routineExecutionId: run.executionId,
						kind: "text",
						status: "complete",
						parts: [{ type: "text", text: content }],
						content,
					})
					.returning(),
			);

			const { items } = await view.activity(workspaceId);
			expect(items).toContainEqual(
				expect.objectContaining({ kind: "mention", messageId: inChat?.id }),
			);
			expect(items).toContainEqual(
				expect.objectContaining({ threadId: run.threadId, mentionsYou: false }),
			);
		});

		it("lists a collaboration in the person's chats", async () => {
			const current = await aTask();
			const childThreadId = await collaborate(current.id, current.id);

			expect((await view.activity(workspaceId)).items).toContainEqual(
				expect.objectContaining({
					kind: "collaboration",
					threadId: childThreadId,
					initiator: expect.objectContaining({ id: agentId }),
					recipient: expect.objectContaining({ id: recipientAgentId }),
					status: "waiting",
					brief: "Compare the launch plans",
					conversationId: current.id,
					unread: true,
				}),
			);
		});

		it("shows a private bot's collaboration to the people of the conversation that asked it, and nobody else", async () => {
			// The member's private bot asks the administrator's private bot.
			await onDatabase((db) =>
				db.update(agent).set({ visibility: "private" }).where(eq(agent.id, agentId)),
			);
			await onDatabase((db) =>
				db
					.update(agent)
					.set({ visibility: "private", createdById: administratorId })
					.where(eq(agent.id, recipientAgentId)),
			);
			const current = await aTask();
			const childThreadId = await collaborate(current.id, current.id);
			const callId = await askForApproval(childThreadId, "linear__create_issue", recipientAgentId);
			const adminView = onPostgresAs(administratorId)(Context.get(conversations, ChatView.Service));

			expect((await view.activity(workspaceId)).items).toContainEqual(
				expect.objectContaining({
					kind: "collaboration",
					threadId: childThreadId,
					recipient: expect.objectContaining({ id: recipientAgentId }),
				}),
			);
			expect((await view.history(current.id)).items).toContainEqual(
				expect.objectContaining({ threadId: childThreadId }),
			);
			// The member decides what the asked bot needs approved, though they don't reach it.
			expect((await view.approvals(workspaceId)).waiting).toEqual([
				expect.objectContaining({
					call: expect.objectContaining({ id: callId }),
					conversationId: current.id,
				}),
			]);

			// The administrator made the asked bot, but does not reach the member's task.
			expect((await adminView.activity(workspaceId)).items).not.toContainEqual(
				expect.objectContaining({ threadId: childThreadId }),
			);
			expect((await adminView.approvals(workspaceId)).waiting).toEqual([]);
		});

		it("reads a collaboration with the conversation it was asked in", async () => {
			const current = await aTask();
			const childThreadId = await collaborate(current.id, current.id);

			await chats.markRead(current.id);

			expect((await view.activity(workspaceId)).items).toContainEqual(
				expect.objectContaining({ kind: "collaboration", threadId: childThreadId, unread: false }),
			);
		});

		/** Whether each routine run and collaboration in activity is unread, by its thread. */
		const itemsUnread = async () =>
			new Map(
				(await view.activity(workspaceId)).items.flatMap((item) =>
					item.kind === "routine" || item.kind === "collaboration"
						? [[item.threadId, item.unread] as const]
						: [],
				),
			);

		it("reads only the routine run opened, leaving the routine's other runs unread", async () => {
			const created = await routines.create(
				{ agentId },
				{ name: "Overnight review", instructions: "Review it.", triggers: [{ kind: "webhook" }] },
			);
			const runRoutine = () =>
				routines.run({ agentId, routineId: created.routine.id, requestId: crypto.randomUUID() });
			const earlier = await runRoutine();
			const opened = await runRoutine();
			const later = await runRoutine();
			for (const run of [earlier, opened, later]) await runPosts(run, "All green.");

			await chats.markItemRead(opened.threadId);

			const unread = await itemsUnread();
			expect(unread.get(earlier.threadId)).toBe(true);
			expect(unread.get(opened.threadId)).toBe(false);
			expect(unread.get(later.threadId)).toBe(true);
		});

		it("reads only the collaboration opened, leaving the conversation's others unread", async () => {
			const current = await aTask();
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
			const current = await aTask();
			const before = await botWrites(current.id, "The launch plan is ready", -60);
			const opened = await collaborate(current.id, current.id);

			await chats.markItemRead(opened);

			const { items } = await view.activity(workspaceId);
			expect(items).toContainEqual(
				expect.objectContaining({ kind: "message", messageId: before.id, unread: true }),
			);
		});

		it("refuses a thread that is not a routine run or collaboration", async () => {
			const current = await aTask();

			await expect(chats.markItemRead(current.id)).rejects.toMatchObject({
				_tag: "ResourceHidden",
			});
		});

		it("counts a routine run and a collaboration caught up with once the person writes after them", async () => {
			const current = await aTask();
			const created = await routines.create(
				{ agentId },
				{ name: "Overnight review", instructions: "Review it.", triggers: [{ kind: "webhook" }] },
			);
			const run = await routines.run({
				agentId,
				routineId: created.routine.id,
				requestId: crypto.randomUUID(),
			});
			await runPosts(run, "All green.");
			const childThreadId = await collaborate(current.id, current.id);
			const unreadOf = async () =>
				(await view.activity(workspaceId)).items.flatMap((item) =>
					item.kind === "routine" || item.kind === "collaboration"
						? [{ threadId: item.threadId, unread: item.unread }]
						: [],
				);
			expect(await unreadOf()).toEqual(
				expect.arrayContaining([
					{ threadId: run.threadId, unread: true },
					{ threadId: childThreadId, unread: true },
				]),
			);

			await chats.post({
				conversationId: current.id,
				messageId: crypto.randomUUID(),
				content: "Seen both",
			});
			// The run is listed in the routine's own thread, read there.
			await chats.markRead(
				(await chats.openRoutineFeed({ workspace: workspaceId, routineId: created.routine.id })).id,
			);

			expect(await unreadOf()).toEqual(
				expect.arrayContaining([
					{ threadId: run.threadId, unread: false },
					{ threadId: childThreadId, unread: false },
				]),
			);
		});
	});

	describe("sending files", () => {
		/** The chat, with the member's uploads to it. */
		async function aChatWithFiles() {
			const { id: conversationId } = await aTask();
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
		const asPart = ({ id, name, contentType, size }: ThreadFiles.Upload): FilePart => ({
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
						and(eq(event.channel, threadChannel(sent.threadId)), eq(event.type, "message.created")),
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
			).rejects.toBeInstanceOf(ThreadFiles.UploadsNotFound);
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
			await expect(send([other.id])).rejects.toBeInstanceOf(ThreadRepository.MessageIdConflict);
		});
	});

	it("keeps an uploaded file as the type it was given, or else the type its name suggests", async () => {
		const { id: conversationId } = await aTask();
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
