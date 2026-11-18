import { conversationChannel, handleFromName } from "@sugabots/contracts";
import { DisplayName } from "@sugabots/errors";
import { and, eq } from "drizzle-orm";
import { Context, Effect } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ResourceHidden } from "../../authorization/access.ts";
import { EventBus } from "../../database/events/bus.ts";
import { EventStore } from "../../database/events/store.ts";
import {
	bot,
	channel,
	channelBot,
	channelMember,
	conversation,
	conversationSummary,
	event,
	file,
	message,
	modelProvider,
	placedConversation,
	providerModel,
	turn,
	user,
	workspace,
	workspaceMember,
} from "../../database/schema.ts";
import {
	closeDatabase,
	onDatabase,
	onPostgres,
	runOnPostgres,
	servedOnPostgres,
} from "../../database/testing.ts";
import { Models } from "../../providers/models/models.ts";
import { lane } from "../../workflows/sql.ts";
import { BotRepository } from "../../workspaces/bots/bot-repository.ts";
import { SYSTEM_BOTS } from "../../workspaces/bots/system-bots.ts";
import { onPostgresAs } from "../../workspaces/testing.ts";
import { Chats } from "../chats/chats.ts";
import { compactionLane } from "../compaction/compaction.workflow.ts";
import { Compactions } from "../compaction/compactions.ts";
import { compactionLineTokens } from "../compaction/window.ts";
import { ConversationView } from "../conversation-view.ts";
import { seedConversation } from "../seed.test-support.ts";
import { Summaries } from "../summaries/summaries.ts";
import { summarise } from "../summaries/summary.steps.ts";
import { conversationsForTests } from "../testing.ts";
import { searchHistoryTool } from "../tools/search-history/tool.ts";
import {
	modelPrompt,
	prepareRunnable,
	queueTurnForTests,
	releaseTurn,
	replyTurnOf,
	runningTurns,
	TurnExecution,
	TurnRepository,
} from "../turns/testing.ts";
import { Turns } from "../turns/turns.ts";

/** What these tests set the workspace's system bots up with. */
const SYSTEM_BOT_MODEL = "test-model";

const eventStore = await runOnPostgres(EventStore.make);

describe.skipIf(!process.env.DATABASE_URL)("conversations, against Postgres", async () => {
	const eventBus = EventBus.inProcess({ store: eventStore });
	const conversations = await conversationsForTests(eventBus);
	const viewAs = (userId: string) =>
		onPostgresAs(userId)(Context.get(conversations, ConversationView.Service));
	const chatsAs = (userId: string) =>
		onPostgresAs(userId)(Context.get(conversations, Chats.Service));
	const controlsAs = (userId: string) =>
		onPostgresAs(userId)(Context.get(conversations, Turns.Controls));
	const turns = onPostgres({ prepare: Context.get(conversations, TurnExecution.Service).prepare });
	const turnRecords = onPostgres(Context.get(conversations, TurnRepository.Service));
	const summaries = onPostgres({
		prepare: Context.get(conversations, Summaries.Service).prepare,
		complete: Context.get(conversations, Summaries.Service).complete,
		prepareBotSummary: Context.get(conversations, Summaries.Service).prepareBotSummary,
		completeBotSummary: Context.get(conversations, Summaries.Service).completeBotSummary,
	});
	const compactions = onPostgres({
		prepare: Context.get(conversations, Compactions.Service).prepare,
		complete: Context.get(conversations, Compactions.Service).complete,
	});
	let workspaceId: string;
	let channelId: string;
	let botId: string;
	let memberId: string;
	let outsiderId: string;
	let outsiderEmail: string;

	/** A task the person starts with the bot by sending it `message`, which the bot is asked to answer. */
	async function startTask(input: { botId: string; startedById: string; message: string }) {
		const started = await chatsAs(input.startedById).startTask({
			botId: input.botId,
			messageId: crypto.randomUUID(),
			content: input.message,
		});
		return started.conversation;
	}

	/** A task as `startTask` starts it, with its participants and messages. */
	async function startTaskShown(input: Parameters<typeof startTask>[0]) {
		const started = await startTask(input);
		return viewAs(input.startedById).get(started.id);
	}

	/** Makes the bot private, so only its creator, the member, reaches it. */
	async function makeBotPrivate() {
		await onDatabase((db) =>
			db.update(bot).set({ visibility: "private" }).where(eq(bot.id, botId)),
		);
	}

	/** The bot's turn running in the conversation, as its workflow runs it. */
	async function runningTurn(conversationId: string, bot = botId) {
		const run = (await runOnPostgres(runningTurns(conversationId))).find(
			(running) => running.request.botId === bot,
		);
		if (!run) throw new Error("No turn is running in the conversation");
		return run;
	}

	/** Prepares the summary `request` asks for, for a case that needs it to run. */
	async function preparedSummary(request: Parameters<typeof summaries.prepare>[0]) {
		const preparation = await summaries.prepare(request);
		if (preparation._tag !== "Prepared") {
			throw new Error(`Conversation test could not prepare its summary: ${preparation.reason}`);
		}
		return preparation;
	}

	/** Prepares the compaction `request` asks for, for a case that needs it to run. */
	async function preparedCompaction(request: Parameters<typeof compactions.prepare>[0]) {
		const preparation = await compactions.prepare(request);
		if (preparation._tag !== "Prepared") {
			throw new Error(`Conversation test could not prepare its compaction: ${preparation.reason}`);
		}
		return preparation;
	}

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const [workspaceRow] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: `Conversation test ${suffix}`, slug: `conversation-test-${suffix}` })
				.returning(),
		);
		const people = await onDatabase((db) =>
			db
				.insert(user)
				.values([
					{ name: "Sam", email: `conversation-sam-${suffix}@example.com` },
					{ name: "Kim", email: `conversation-kim-${suffix}@example.com` },
				])
				.returning(),
		);
		const [member, outsider] = people;
		if (!workspaceRow || !member || !outsider) {
			throw new Error("Could not create conversation test records");
		}
		workspaceId = workspaceRow.id;
		memberId = member.id;
		outsiderId = outsider.id;
		outsiderEmail = outsider.email;

		await onDatabase((db) =>
			db.insert(workspaceMember).values([
				{ workspaceId, userId: memberId },
				{ workspaceId, userId: outsiderId },
			]),
		);
		const [channelRow] = await onDatabase((db) =>
			db
				.insert(channel)
				.values({
					workspaceId,
					name: "Suga-Team",
					slug: `suga-${suffix}`,
					createdById: memberId,
				})
				.returning(),
		);
		const [botRow] = await onDatabase((db) =>
			db
				.insert(bot)
				.values({
					workspaceId,
					name: `Release bot ${suffix}`,
					handle: handleFromName(`Release bot ${suffix}`),
					color: "green",
					face: "pill",
					model: "claude-opus-4-1-20250805",
					createdById: memberId,
				})
				.returning(),
		);
		if (!channelRow || !botRow) {
			throw new Error("Could not create conversation scope");
		}
		channelId = channelRow.id;
		botId = botRow.id;
		await onDatabase((db) =>
			db.insert(channelMember).values({ workspaceId, channelId, userId: memberId }),
		);
		// The system bots belong to the workspace, not to the channel, and each is
		// set up by being given a model.
		const placed = await onDatabase((db) =>
			db
				.insert(bot)
				.values(
					SYSTEM_BOTS.map((definition) => ({
						workspaceId,
						createdById: memberId,
						name: definition.name,
						handle: handleFromName(definition.name),
						systemBotKey: definition.key,
						description: definition.description,
						color: definition.color,
						face: definition.face,
						model: SYSTEM_BOT_MODEL,
						prompt: definition.prompt,
					})),
				)
				.returning({ id: bot.id }),
		);
		if (placed.length !== SYSTEM_BOTS.length) {
			throw new Error("Could not create the workspace's system bots");
		}
	});

	it("prepares a turn for a channel bot other than the one that spoke first", async () => {
		// Every bot mentioned in a channel's main chat takes a turn, not only the
		// first: preparing one for any bot but the first must not discard it as
		// "the conversation or its host bot no longer exists".
		const [otherRow] = await onDatabase((db) =>
			db
				.insert(bot)
				.values({
					workspaceId,
					name: `Second bot ${Date.now()}`,
					handle: handleFromName(`Second bot ${Date.now()}`),
					color: "teal",
					face: "dot",
					model: "claude-opus-4-1-20250805",
					createdById: memberId,
				})
				.returning({ id: bot.id }),
		);
		if (!otherRow) throw new Error("Could not create the second bot");
		await onDatabase((db) =>
			db.insert(channelBot).values([
				{ workspaceId, channelId, botId },
				{ workspaceId, channelId, botId: otherRow.id },
			]),
		);
		const chats = chatsAs(memberId);
		const mainChat = await chats.openMainChat({ workspace: workspaceId, channelId });
		const posted = await chats.post({
			conversationId: mainChat.id,
			messageId: crypto.randomUUID(),
			content: "Who should answer this?",
		});
		await runOnPostgres(
			queueTurnForTests({
				conversationId: mainChat.id,
				botId: otherRow.id,
				triggerMessageId: posted.id,
				reason: "mention",
			}),
		);
		const prepared = await prepareRunnable(turns, await runningTurn(mainChat.id, otherRow.id));

		expect(prepared.context.bot.id).toBe(otherRow.id);
	});

	it("refuses a bot's turn by name once its model has been cleared", async () => {
		// Cleared after the message is queued: a chat refuses the message itself
		// when the model is already gone, so this is the turn that slips through.
		const details = await startTaskShown({
			botId,
			startedById: memberId,
			message: "Anyone there?",
		});
		await onDatabase((db) => db.update(bot).set({ model: null }).where(eq(bot.id, botId)));
		const run = await runningTurn(details.conversation.id);

		// It stops rather than falling back to some other model, and the reason
		// names the bot so somebody can go and fix it.
		expect(await turns.prepare(run)).toMatchObject({
			_tag: "NotRunnable",
			reason: expect.stringContaining("has no model chosen"),
		});
	});

	it("shows a task as running while its turn lane is busy", async () => {
		const details = await startTaskShown({
			botId,
			startedById: memberId,
			message: "Run as a workflow",
		});
		const statusNow = async () =>
			(await viewAs(memberId).get(details.conversation.id))?.conversation.status;
		expect(await statusNow()).toBe("running");

		await runOnPostgres(releaseTurn(await runningTurn(details.conversation.id)));

		expect(await statusNow()).toBe("done");
	});

	it("loads a conversation with its participants and first message", async () => {
		const details = await startTaskShown({
			botId,
			startedById: memberId,
			message: "Check the release\nPay attention to migrations.",
		});

		// A task is titled from its first message.
		expect(details.conversation.title).toBe("Check the release Pay attention to migration…");
		expect(details.participants.map(({ kind }) => kind).sort()).toEqual(["bot", "person"]);
		expect(details.messages).toMatchObject([
			{
				author: { kind: "person", id: memberId },
				content: "Check the release\nPay attention to migrations.",
				parts: [{ type: "text", text: "Check the release\nPay attention to migrations." }],
			},
		]);
		expect(await runOnPostgres(runningTurns(details.conversation.id))).toMatchObject([
			{
				request: {
					conversationId: details.conversation.id,
					botId,
					triggerMessageId: details.messages[0]?.id,
				},
			},
		]);
	});

	it("pages a large history without gaps at equal-timestamp boundaries", async () => {
		const details = await startTaskShown({
			botId,
			startedById: memberId,
			message: "Message 000",
		});
		const firstMessageId = details.messages[0]?.id;
		if (!firstMessageId) {
			throw new Error("Conversation test has no first message");
		}
		const firstCreatedAt = new Date("2026-09-10T03:59:59.000Z");
		const sharedCreatedAt = new Date("2026-09-10T04:00:00.000Z");
		await onDatabase((db) =>
			db.update(message).set({ createdAt: firstCreatedAt }).where(eq(message.id, firstMessageId)),
		);
		const historyIdPrefix = crypto.randomUUID().slice(0, 24);
		const historyIds = Array.from(
			{ length: 124 },
			(_, index) => `${historyIdPrefix}${(index + 1).toString(16).padStart(12, "0")}`,
		);
		await onDatabase((db) =>
			db.insert(message).values(
				historyIds.map((id, index) => ({
					id,
					conversationId: details.conversation.id,
					authorUserId: memberId,
					kind: "text" as const,
					status: "complete" as const,
					parts: [{ type: "text" as const, text: `Message ${String(index + 1).padStart(3, "0")}` }],
					content: `Message ${String(index + 1).padStart(3, "0")}`,
					createdAt: sharedCreatedAt,
				})),
			),
		);
		await onDatabase((db) =>
			db.insert(turn).values(
				historyIds.map((triggerMessageId) => ({
					conversationId: details.conversation.id,
					botId,
					triggerMessageId,
					status: "done" as const,
					model: "test/model",
					startedAt: sharedCreatedAt,
					finishedAt: sharedCreatedAt,
				})),
			),
		);

		const pages = [];
		let cursor: string | undefined;
		do {
			const page = await viewAs(memberId).get(details.conversation.id, { limit: 50, cursor });
			if (!page) {
				throw new Error("Conversation history disappeared");
			}
			pages.push(page);
			cursor = page.olderMessagesCursor ?? undefined;
		} while (cursor);

		expect(pages.map((page) => page.messages.length)).toEqual([50, 50, 25]);
		const allMessages = [...pages].reverse().flatMap((page) => page.messages);
		expect(new Set(allMessages.map(({ id }) => id)).size).toBe(125);
		expect(allMessages.map(({ content }) => content)).toEqual([
			"Message 000",
			...historyIds.map((_, index) => `Message ${String(index + 1).padStart(3, "0")}`),
		]);
		await expect(
			viewAs(memberId).get(details.conversation.id, { limit: 50, cursor: "not-a-cursor" }),
		).rejects.toMatchObject({ _tag: "InvalidConversationHistoryCursor" });
	});

	it("replays a committed message after reconnect", async () => {
		const details = await startTaskShown({
			botId,
			startedById: memberId,
			message: "First",
		});
		const channel = conversationChannel(details.conversation.id);
		const [resumePoint] = await eventStore.replay(channel, 0, 10);
		if (!resumePoint) {
			throw new Error("Conversation creation did not commit its durable event");
		}

		const messageId = crypto.randomUUID();
		if (!details.conversation.rootConversationId)
			throw new Error("The conversation is in no conversation");
		await chatsAs(memberId).post({
			conversationId: details.conversation.rootConversationId,
			messageId,
			content: "Second",
		});

		const iterator = eventBus
			.subscribe(channel, { since: resumePoint.seq })
			[Symbol.asyncIterator]();
		const replayed = await iterator.next();
		await iterator.return?.();
		expect(replayed.value?.event).toMatchObject({
			type: "message.created",
			message: { id: messageId, content: "Second" },
		});
	});

	it("rejects channels and bots from another workspace at the database boundary", async () => {
		const [otherWorkspace] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({
					name: "Other conversation workspace",
					slug: `other-conversation-${crypto.randomUUID()}`,
				})
				.returning(),
		);
		if (!otherWorkspace) {
			throw new Error("Could not create other conversation workspace");
		}
		await onDatabase((db) =>
			db.insert(workspaceMember).values({ workspaceId: otherWorkspace.id, userId: memberId }),
		);
		const [foreignChannel] = await onDatabase((db) =>
			db
				.insert(channel)
				.values({
					workspaceId: otherWorkspace.id,
					name: "Foreign",
					slug: "foreign",
				})
				.returning(),
		);
		const [foreignBot] = await onDatabase((db) =>
			db
				.insert(bot)
				.values({
					workspaceId: otherWorkspace.id,
					name: "Foreign bot",
					handle: "foreign-bot",
					color: "rose",
					face: "pill",
					model: "test/model",
				})
				.returning(),
		);
		if (!foreignChannel || !foreignBot) {
			throw new Error("Could not create foreign conversation scope");
		}

		await expect(
			onDatabase((db) =>
				seedConversation(db, {
					workspaceId,
					kind: "channel_conversation",
					channelId: foreignChannel.id,
					title: "Foreign channel",
					startedById: memberId,
				}),
			),
		).rejects.toThrow();
		await expect(
			onDatabase((db) =>
				seedConversation(db, {
					workspaceId,
					kind: "task",
					botId: foreignBot.id,
					title: "Foreign host",
					startedById: memberId,
				}),
			),
		).rejects.toThrow();
	});

	it("deletes a bot's task history with the bot", async () => {
		const details = await startTaskShown({
			botId,
			startedById: memberId,
			message: "Keep this history",
		});

		const bots = await servedOnPostgres(BotRepository.Service, BotRepository.layer);
		await bots.remove(workspaceId, botId);
		expect(
			await onDatabase((db) =>
				db.select().from(conversation).where(eq(conversation.id, details.conversation.id)),
			),
		).toHaveLength(0);
	});

	it("adds each human sender to the participant stack", async () => {
		const details = await startTaskShown({
			botId,
			startedById: memberId,
			message: "First",
		});

		if (!details.conversation.rootConversationId)
			throw new Error("The conversation is in no conversation");
		await chatsAs(outsiderId).post({
			conversationId: details.conversation.rootConversationId,
			messageId: crypto.randomUUID(),
			content: "I can help",
		});

		expect((await viewAs(memberId).get(details.conversation.id))?.participants).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "person", id: outsiderId, email: outsiderEmail }),
			]),
		);
	});

	it("counts a quiet task's latest messages as recent, and a busy task's last week", async () => {
		const details = await startTaskShown({
			botId,
			startedById: memberId,
			message: "Latest",
		});
		const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		const written = (author: { authorUserId: string } | { authorBotId: string }, at: Date) => ({
			conversationId: details.conversation.id,
			...author,
			kind: "text" as const,
			status: "complete" as const,
			parts: [{ type: "text" as const, text: "Earlier" }],
			content: "Earlier",
			createdAt: at,
		});
		await onDatabase((db) =>
			db
				.insert(message)
				.values([
					written({ authorUserId: outsiderId }, daysAgo(30)),
					written({ authorBotId: botId }, daysAgo(3)),
				]),
		);
		const recentIds = async () =>
			(await viewAs(memberId).activity(details.conversation.id))?.recentParticipants.map(
				({ id }) => id,
			);

		expect(await recentIds()).toEqual([memberId, botId, outsiderId]);

		await onDatabase((db) =>
			db
				.insert(message)
				.values(Array.from({ length: 100 }, () => written({ authorUserId: memberId }, daysAgo(1)))),
		);
		expect(await recentIds()).toEqual([memberId, botId]);
	});

	it("queues and persists a fresh summary after a completed exchange", async () => {
		const started = await startTask({
			botId,
			startedById: memberId,
			message: "Summarize this conversation",
		});
		const firstRun = await runningTurn(started.id);
		const preparedTurn = await prepareRunnable(turns, firstRun);
		await turnRecords.complete(
			replyTurnOf(preparedTurn),
			{ content: "The work is complete.", collaborations: [], toolCalls: [] },
			{
				contextTokens: 30,
				contextCapacity: 200_000,
				readKeptFrom: null,
			},
		);
		await runOnPostgres(releaseTurn(firstRun));
		const firstSummary = await preparedSummary({
			conversationId: started.id,
			botId: preparedTurn.context.bot.id,
			sourceMessageId: preparedTurn.responseMessage.id,
		});
		expect(firstSummary.model).toBe(SYSTEM_BOT_MODEL);

		// The summariser works in its own conversation hanging off the one it summarises,
		// so its turns never appear in the conversation people are having.
		expect(firstSummary.summariser.conversationId).not.toBe(started.id);
		const [systemBotConversation] = await onDatabase((db) =>
			db
				.select({
					systemBotKey: placedConversation.systemBotKey,
					parentConversationId: placedConversation.parentConversationId,
				})
				.from(placedConversation)
				.where(eq(placedConversation.id, firstSummary.summariser.conversationId)),
		);
		expect(systemBotConversation).toMatchObject({
			systemBotKey: "summarise",
			parentConversationId: started.id,
		});

		// And it stays out of the channel's thread list.
		const listed = await viewAs(memberId).list(workspaceId);
		expect(listed.some((row) => row.id === firstSummary.summariser.conversationId)).toBe(false);
		// Recorded as the Summariser's turn, measured at 1,000 tokens.
		await runOnPostgres(
			Context.get(conversations, Turns.Service).recordSystemTurn(
				{
					...firstSummary.summariser,
					triggerMessageId: firstSummary.sourceMessageId,
					model: firstSummary.model,
					name: "summary",
				},
				() =>
					Context.get(conversations, Summaries.Service)
						.complete(firstSummary, {
							title: "Verify the release",
							content: "The release work is complete.",
						})
						.pipe(Effect.as({ value: undefined, contextTokens: 1_000 })),
			),
		);

		const refreshed = await viewAs(memberId).get(started.id);
		// The first summary titles the conversation, and the conversation holding the summaries
		// is named after it.
		expect(refreshed?.conversation.title).toBe("Verify the release");
		const [summariesConversation] = await onDatabase((db) =>
			db
				.select({ title: placedConversation.title })
				.from(placedConversation)
				.where(
					and(
						eq(placedConversation.parentConversationId, started.id),
						eq(placedConversation.systemBotKey, "summarise"),
					),
				),
		);
		expect(summariesConversation?.title).toBe("Summaries of Verify the release");
		expect((await viewAs(memberId).activity(started.id))?.summary).toMatchObject({
			content: "The release work is complete.",
			sourceMessageId: preparedTurn.responseMessage.id,
		});
		// The Summariser's own turn, measured at 1,000 tokens, is in a conversation of its own, so
		// the context is the bot reply's.
		expect((await viewAs(memberId).activity(started.id))?.context).toEqual({
			usedTokens: 30,
			measuredAt: expect.any(String),
			// The window the reply was read with, as its turn recorded it.
			windowTokens: 200_000,
			compactionLineTokens: 140_000,
			compactedAt: null,
		});

		await chatsAs(memberId).post({
			conversationId: started.id,
			messageId: crypto.randomUUID(),
			content: "What remains?",
		});
		const nextTurn = await prepareRunnable(turns, await runningTurn(started.id));
		expect(nextTurn.context).not.toHaveProperty("summary");
		expect(nextTurn.context.messages.map(({ content }) => content)).toEqual([
			"Summarize this conversation",
			"The work is complete.",
			"What remains?",
		]);
		await turnRecords.complete(
			replyTurnOf(nextTurn),
			{ content: "Only approval remains.", collaborations: [], toolCalls: [] },
			{ contextCapacity: 128_000, readKeptFrom: null },
		);
		const nextSummary = await preparedSummary({
			conversationId: started.id,
			botId: nextTurn.context.bot.id,
			sourceMessageId: nextTurn.responseMessage.id,
		});
		expect(nextSummary).toMatchObject({
			previousContent: "The release work is complete.",
			transcript: [
				{ content: "Summarize this conversation" },
				{ content: "The work is complete." },
				{ content: "What remains?" },
				{ content: "Only approval remains." },
			],
		});
		await summaries.complete(nextSummary, { content: "Only approval remains." });
		// Only the first summary titles the conversation.
		expect((await viewAs(memberId).get(started.id))?.conversation.title).toBe("Verify the release");

		// The bot's own summary is written from its tasks' summaries, the newest first.
		const bot = await summaries.prepareBotSummary(started.id);
		expect(bot).toMatchObject({
			botId,
			previousContent: undefined,
			conversations: [
				{ title: "Verify the release", summary: "Only approval remains.", doneAt: null },
			],
		});
		if (!bot) throw new Error("The bot's summary was not prepared");
		await summaries.completeBotSummary(bot, "Verifying the release; only approval remains.");
		expect(await summaries.prepareBotSummary(started.id)).toMatchObject({
			previousContent: "Verifying the release; only approval remains.",
		});

		// A collaboration the bot was asked in belongs to the conversation that asked it.
		const asked = await onDatabase((db) =>
			seedConversation(db, {
				workspaceId,
				kind: "collaboration",
				title: "A private plan",
				collaboration: {
					parentConversationId: started.id,
					rootConversationId: started.id,
					parentMessageId: nextTurn.responseMessage.id,
					turnId: nextTurn.turnId,
					collaboratorBotId: botId,
					brief: "Plan something private.",
					atOffset: 0,
				},
			}),
		);
		const [answer] = await onDatabase((db) =>
			db
				.insert(message)
				.values({
					conversationId: asked.id,
					authorBotId: botId,
					kind: "text",
					status: "complete",
					parts: [{ type: "text", text: "Planned." }],
					content: "Planned.",
				})
				.returning(),
		);
		if (!answer) throw new Error("The collaboration has no answer");
		await onDatabase((db) =>
			db.insert(conversationSummary).values({
				conversationId: asked.id,
				content: "Planning something private.",
				sourceMessageId: answer.id,
			}),
		);
		expect(await summaries.prepareBotSummary(asked.id)).toBeUndefined();
		expect((await summaries.prepareBotSummary(started.id))?.conversations).toEqual([
			expect.objectContaining({ title: "Verify the release" }),
		]);
	});

	it("does not summarise a channel's main chat the bot replies in", async () => {
		const [host] = await onDatabase((db) =>
			db.select({ handle: bot.handle }).from(bot).where(eq(bot.id, botId)),
		);
		if (!host) throw new Error("The bot is gone");
		await onDatabase((db) => db.insert(channelBot).values({ workspaceId, channelId, botId }));
		const chats = chatsAs(memberId);
		const mainChat = await chats.openMainChat({ workspace: workspaceId, channelId });
		await chats.post({
			conversationId: mainChat.id,
			messageId: crypto.randomUUID(),
			content: `@${host.handle} what changed?`,
		});
		const run = await runningTurn(mainChat.id);
		const reply = await prepareRunnable(turns, run);
		await turnRecords.complete(
			replyTurnOf(reply),
			{ content: "Nothing yet.", collaborations: [], toolCalls: [] },
			{ contextCapacity: 200_000, readKeptFrom: null },
		);
		await runOnPostgres(releaseTurn(run));

		expect(
			await summaries.prepare({
				conversationId: mainChat.id,
				botId,
				sourceMessageId: reply.responseMessage.id,
			}),
		).toMatchObject({ _tag: "Skipped" });
	});

	it("records a summary the model could not write as the Summariser's failed turn", async () => {
		const started = await startTask({
			botId,
			startedById: memberId,
			message: "Summarize this conversation",
		});
		const preparedTurn = await prepareRunnable(turns, await runningTurn(started.id));
		await turnRecords.complete(
			replyTurnOf(preparedTurn),
			{ content: "The work is complete.", collaborations: [], toolCalls: [] },
			{ contextCapacity: 128_000, readKeptFrom: null },
		);
		const unreachable = new Models.ProviderUnreachable({
			provider: DisplayName.fromRecord("Test provider"),
			model: DisplayName.fromRecord("test-model"),
			cause: new Error("ECONNREFUSED"),
		});
		const providerDown = Models.fromStream(() => Effect.fail(unreachable));

		await runOnPostgres(
			summarise(
				{
					conversationId: started.id,
					botId,
					sourceMessageId: preparedTurn.responseMessage.id,
				},
				providerDown,
			).pipe(Effect.provideContext(conversations)),
		);

		const summariserTurns = await onDatabase((db) =>
			db
				.select({ status: turn.status, error: turn.error })
				.from(turn)
				.innerJoin(placedConversation, eq(placedConversation.id, turn.conversationId))
				.where(
					and(
						eq(placedConversation.parentConversationId, started.id),
						eq(placedConversation.systemBotKey, "summarise"),
					),
				),
		);
		expect(summariserTurns).toEqual([{ status: "failed", error: unreachable.userMessage }]);
	});

	it("requests cancellation only once while an authorized turn remains active", async () => {
		await makeBotPrivate();
		const details = await startTaskShown({
			botId,
			startedById: memberId,
			message: "Wait for review",
		});
		const prepared = await prepareRunnable(turns, await runningTurn(details.conversation.id));

		expect(await controlsAs(memberId).cancel(prepared.turnId)).toBe(true);
		expect(await controlsAs(memberId).cancel(prepared.turnId)).toBe(false);
		await expect(controlsAs(outsiderId).cancel(prepared.turnId)).rejects.toThrow(ResourceHidden);
		// Announced once, for the workflow running the turn.
		const announced = await onDatabase((db) =>
			db
				.select({ payload: event.payload })
				.from(event)
				.where(eq(event.type, "turn.cancel_requested")),
		);
		expect(announced.filter(({ payload }) => payload.turnId === prepared.turnId)).toHaveLength(1);
	});

	it("does not expose a private bot's task to another workspace member", async () => {
		await makeBotPrivate();
		const details = await startTaskShown({
			botId,
			startedById: memberId,
			message: "Private to its creator",
		});

		await expect(viewAs(outsiderId).get(details.conversation.id)).rejects.toThrow(ResourceHidden);
		expect(await viewAs(outsiderId).list(workspaceId)).toEqual([]);
	});

	it("compacts a long task into a summary and the newest messages, and searches what came before", async () => {
		const details = await startTaskShown({
			botId,
			startedById: memberId,
			message: "Plan the trip",
		});
		// Twenty messages of about 10,000 tokens each, written before the one
		// that opened the conversation: far past the compaction line between them.
		const long = (index: number) =>
			`${index === 2 ? "The hotel budget is 150 euros a night. " : ""}Message ${index}. ${"word ".repeat(8_000)}`;
		const earlier = await onDatabase((db) =>
			db
				.insert(message)
				.values(
					Array.from({ length: 20 }, (_, index) => ({
						conversationId: details.conversation.id,
						authorUserId: memberId,
						kind: "text" as const,
						status: "complete" as const,
						parts: [{ type: "text" as const, text: long(index + 1) }],
						content: long(index + 1),
						createdAt: new Date(Date.now() - (20 - index) * 60_000),
					})),
				)
				.returning({ createdAt: message.createdAt }),
		);
		const sourceMessageId = details.messages[0]?.id ?? "";

		const prepared = await preparedCompaction({
			conversationId: details.conversation.id,
			botId,
			sourceMessageId,
			readKeptFrom: null,
		});

		// Kept word for word: the newest six long messages and the short one,
		// about a quarter of the window. Summarised: the eleven before them.
		expect(prepared.model).toBe("claude-opus-4-1-20250805");
		expect(prepared.keptFrom).toEqual(earlier[14]?.createdAt);
		expect(prepared.historyStartsAt).toEqual(earlier[3]?.createdAt);
		expect(prepared.transcript.map(({ content }) => content.split(".")[0])).toEqual(
			Array.from({ length: 11 }, (_, index) => `Message ${index + 4}`),
		);
		await compactions.complete(prepared, "The family is planning a trip.");

		const turn = await prepareRunnable(turns, await runningTurn(details.conversation.id));
		expect(turn.context.compaction).toEqual({
			summary: "The family is planning a trip.",
			historyStartsAt: earlier[3]?.createdAt,
			keptFrom: earlier[14]?.createdAt,
		});
		expect(turn.context.messages.map(({ content }) => content.split(".")[0])).toEqual([
			...Array.from({ length: 6 }, (_, index) => `Message ${index + 15}`),
			"Plan the trip",
		]);
		const prompt = modelPrompt(turn.context, {
			now: new Date(),
			builtInTools: [],
			toolCatalog: undefined,
			computer: undefined,
		});
		expect(prompt.messages[0]?.content).toContain("The family is planning a trip.");
		await turnRecords.complete(
			replyTurnOf(turn),
			{ content: "Here is the plan.", collaborations: [], toolCalls: [] },
			{
				contextTokens: 70_000,
				contextCapacity: turn.context.windowTokens,
				readKeptFrom: prepared.keptFrom.toISOString(),
			},
		);
		expect((await viewAs(memberId).activity(details.conversation.id))?.context).toMatchObject({
			usedTokens: 70_000,
			compactedAt: expect.any(String),
		});

		const search = searchHistoryTool({
			conversationId: details.conversation.id,
			before: prepared.keptFrom,
			usesComputer: false,
			run: runOnPostgres,
		});
		const searchFor = (input: { query?: string; after?: string; before?: string }) =>
			search.execute?.(input, { toolCallId: "search", messages: [] } as never);
		expect(await searchFor({ query: "hotel budget" })).toEqual({
			messages: [
				expect.objectContaining({
					author: "Sam",
					text: expect.stringContaining("The hotel budget is 150 euros a night."),
				}),
			],
			more: false,
		});
		// A time range alone lists what was said then, oldest first.
		const listed = await searchFor({
			after: earlier[0]?.createdAt.toISOString(),
			before: earlier[2]?.createdAt.toISOString(),
		});
		expect(listed).toMatchObject({ more: false });
		expect(
			listed && "messages" in listed ? listed.messages.map(({ text }) => text.split(".")[0]) : [],
		).toEqual(["Message 1", "The hotel budget is 150 euros a night"]);
		// Nothing the bot already reads word for word, however late the range runs.
		const late = await searchFor({ after: earlier[13]?.createdAt.toISOString() });
		expect(
			late && "messages" in late ? late.messages.map(({ text }) => text.split(".")[0]) : [],
		).toEqual(["Message 14"]);
		expect(await searchFor({})).toEqual({
			refused: "Give words to look for, a time range, or both.",
		});

		const readKeptFrom = prepared.keptFrom.toISOString();
		// Nothing new past what the compaction kept: nothing to summarise.
		expect(
			await compactions.prepare({
				conversationId: details.conversation.id,
				botId,
				sourceMessageId,
				readKeptFrom,
			}),
		).toMatchObject({ _tag: "Skipped" });

		// Three more long messages push the kept part on. A turn measured before the
		// compaction says nothing about the conversation now, so only one that read it counts.
		const later = await onDatabase((db) =>
			db
				.insert(message)
				.values(
					Array.from({ length: 3 }, (_, index) => ({
						conversationId: details.conversation.id,
						authorUserId: memberId,
						kind: "text" as const,
						status: "complete" as const,
						parts: [{ type: "text" as const, text: long(21 + index) }],
						content: long(21 + index),
						createdAt: new Date(Date.now() + (index + 1) * 60_000),
					})),
				)
				.returning({ id: message.id }),
		);
		const newest = {
			conversationId: details.conversation.id,
			botId,
			sourceMessageId: later[2]?.id ?? "",
		};
		expect(await compactions.prepare({ ...newest, readKeptFrom: null })).toMatchObject({
			_tag: "Skipped",
		});

		// The next compaction carries the first summary forward rather than dropping it.
		const next = await preparedCompaction({ ...newest, readKeptFrom });
		expect(next.previousSummary).toBe("The family is planning a trip.");
		expect(next.historyStartsAt).toEqual(earlier[3]?.createdAt);
		expect(next.keptFrom).toEqual(earlier[17]?.createdAt);
		expect(next.transcript.map(({ content }) => content.split(".")[0])).toEqual([
			"Message 15",
			"Message 16",
			"Message 17",
		]);
	});

	it.each([
		// A 128K model compacts at 70% of its own window, not of the 256K ceiling.
		{ contextTokens: compactionLineTokens(128_000) - 1, asked: false },
		{ contextTokens: compactionLineTokens(128_000), asked: true },
	])(
		"asks for a compaction only once a reply's prompt reaches the compaction line ($contextTokens tokens)",
		async ({ contextTokens, asked }) => {
			const details = await startTaskShown({
				botId,
				startedById: memberId,
				message: "Plan the trip",
			});
			const prepared = await prepareRunnable(turns, await runningTurn(details.conversation.id));

			await turnRecords.complete(
				replyTurnOf(prepared),
				{ content: "Here is the plan.", collaborations: [], toolCalls: [] },
				{
					contextTokens,
					contextCapacity: 128_000,
					readKeptFrom: null,
				},
			);

			const [compaction] = await onDatabase((db) =>
				db
					.select({ payload: lane.payload })
					.from(lane)
					.where(eq(lane.key, compactionLane({ conversationId: details.conversation.id }))),
			);
			expect(compaction?.payload).toEqual(
				asked
					? {
							// Stored under the keys the first compactions were.
							threadId: details.conversation.id,
							agentId: botId,
							sourceMessageId: prepared.responseMessage.id,
							readKeptFrom: null,
						}
					: undefined,
			);
		},
	);

	it("searches history in any language: stemmed, as written, and as substrings", async () => {
		const details = await startTaskShown({
			botId,
			startedById: memberId,
			message: "Plan the trip",
		});
		const said = [
			"The hotels near the river are all booked.",
			// "was" is an English stop word, so stemmed English search drops it.
			"Was kostet das Hotel pro Nacht?",
			// No spaces between words: full-text search reads this as one token.
			"我们的酒店预算是每晚150欧元。",
			"Discount code: 50%_OFF",
			// "river" only as part of a longer word: a substring match, not a full-text one.
			"Riverside parking is free.",
		];
		await onDatabase((db) =>
			db.insert(message).values(
				said.map((content, index) => ({
					conversationId: details.conversation.id,
					authorUserId: memberId,
					kind: "text" as const,
					status: "complete" as const,
					parts: [{ type: "text" as const, text: content }],
					content,
					createdAt: new Date(Date.now() - (said.length - index) * 60_000),
				})),
			),
		);
		const search = searchHistoryTool({
			conversationId: details.conversation.id,
			before: new Date(Date.now() + 60_000),
			usesComputer: false,
			run: runOnPostgres,
		});
		const found = async (query: string) => {
			const result = await search.execute?.({ query }, {
				toolCallId: "search",
				messages: [],
			} as never);
			return result && "messages" in result ? result.messages.map(({ text }) => text) : [];
		};

		expect(await found("hotel booking")).toEqual([said[0]]);
		expect(await found("was kostet")).toEqual([said[1]]);
		expect(await found("酒店预算")).toEqual([said[2]]);
		// Wildcards the bot types are taken literally.
		expect(await found("50%_OFF")).toEqual([said[3]]);
		expect(await found("5%OFF")).toEqual([]);
		// A full-text match ranks above one found only as a substring, even a newer one.
		expect(await found("river")).toEqual([said[0], said[4]]);
	});

	it("finds the files a message carried, even one with nothing else in it", async () => {
		const details = await startTaskShown({
			botId,
			startedById: memberId,
			message: "Contracts",
		});
		const started = new Date(Date.now() - 10 * 60_000);
		const sent = await onDatabase((db) =>
			db
				.insert(message)
				.values(
					["Here is the signed contract", ""].map((content, index) => ({
						conversationId: details.conversation.id,
						authorUserId: memberId,
						kind: "text" as const,
						status: "complete" as const,
						parts: content ? [{ type: "text" as const, text: content }] : [],
						content,
						createdAt: new Date(started.getTime() + index * 60_000),
					})),
				)
				.returning({ id: message.id }),
		);
		const [withText, filesOnly] = sent;
		if (!withText || !filesOnly) throw new Error("Could not create the messages");
		const attached = await onDatabase((db) =>
			db
				.insert(file)
				.values(
					[
						{ messageId: withText.id, name: "contract.pdf", contentType: "application/pdf" },
						{ messageId: filesOnly.id, name: "chart.png", contentType: "image/png" },
					].map((file) => ({
						...file,
						conversationId: details.conversation.id,
						kind: "upload" as const,
						uploaderId: memberId,
						position: 0,
						size: 2048,
					})),
				)
				.returning({ id: file.id, name: file.name }),
		);
		const fileIdOf = (name: string) => attached.find((file) => file.name === name)?.id;
		const search = searchHistoryTool({
			conversationId: details.conversation.id,
			before: new Date(Date.now() + 60_000),
			usesComputer: true,
			run: runOnPostgres,
		});
		const found = async (input: { query?: string; after?: string }) => {
			const result = await search.execute?.(input, { toolCallId: "search", messages: [] } as never);
			return result && "messages" in result ? result.messages.map(({ text }) => text) : [];
		};

		expect(await found({ query: "signed contract" })).toEqual([
			`Here is the signed contract\n[Attached contract.pdf (application/pdf, 2.0 KB) as file ${fileIdOf("contract.pdf")}, which read_conversation_file reads, or copy_file_to_computer copies]`,
		]);
		// By its name, for a message that says nothing else.
		expect(await found({ query: "chart.png" })).toEqual([
			`[Attached chart.png (image/png, 2.0 KB) as file ${fileIdOf("chart.png")}, which read_conversation_file reads, or copy_file_to_computer copies]`,
		]);
		expect(await found({ after: started.toISOString() })).toContain(
			`[Attached chart.png (image/png, 2.0 KB) as file ${fileIdOf("chart.png")}, which read_conversation_file reads, or copy_file_to_computer copies]`,
		);
	});

	/**
	 * A task of twenty long messages, about 10K tokens each, before its
	 * first, with the bot's model given a 128K window and the system bots'
	 * a 64K one.
	 */
	async function taskWithLongHistory() {
		const [provider] = await onDatabase((db) =>
			db
				.insert(modelProvider)
				.values({
					workspaceId,
					name: "Windows",
					baseUrl: "https://models.example/v1",
					apiFormat: "openai",
					active: true,
				})
				.returning({ id: modelProvider.id }),
		);
		if (!provider) throw new Error("Could not create the model provider");
		await onDatabase((db) =>
			db.insert(providerModel).values([
				// Both smaller than the 256K ceiling.
				{
					workspaceId,
					providerId: provider.id,
					modelId: "claude-opus-4-1-20250805",
					contextLength: 128_000,
					enabled: true,
					source: "manual" as const,
				},
				{
					workspaceId,
					providerId: provider.id,
					modelId: SYSTEM_BOT_MODEL,
					contextLength: 64_000,
					enabled: true,
					source: "manual" as const,
				},
			]),
		);
		const details = await startTaskShown({
			botId,
			startedById: memberId,
			message: "Plan the trip",
		});
		const long = (index: number) => `Message ${index}. ${"word ".repeat(8_000)}`;
		const earlier = await onDatabase((db) =>
			db
				.insert(message)
				.values(
					Array.from({ length: 20 }, (_, index) => ({
						conversationId: details.conversation.id,
						authorUserId: memberId,
						kind: "text" as const,
						status: "complete" as const,
						parts: [{ type: "text" as const, text: long(index + 1) }],
						content: long(index + 1),
						createdAt: new Date(Date.now() - (20 - index) * 60_000),
					})),
				)
				.returning({ createdAt: message.createdAt }),
		);
		return { details, earlier };
	}

	it("compacts on the bot's model, sized to its window", async () => {
		const { details, earlier } = await taskWithLongHistory();

		const prepared = await preparedCompaction({
			conversationId: details.conversation.id,
			botId,
			sourceMessageId: details.messages[0]?.id ?? "",
			readKeptFrom: null,
		});

		expect(prepared.model).toBe("claude-opus-4-1-20250805");
		// A quarter of the bot's 128K is kept: the three newest long messages.
		expect(prepared.keptFrom).toEqual(earlier[17]?.createdAt);
		// Up to the 89.6K compaction line less what is kept is summarised.
		expect(prepared.transcript.map(({ content }) => content.split(".")[0])).toEqual([
			"Message 13",
			"Message 14",
			"Message 15",
			"Message 16",
			"Message 17",
		]);

		const turn = await prepareRunnable(turns, await runningTurn(details.conversation.id));
		expect(turn.context.windowTokens).toBe(128_000);
		await turnRecords.complete(
			replyTurnOf(turn),
			{ content: "Here is the plan.", collaborations: [], toolCalls: [] },
			{
				contextTokens: 50_000,
				contextCapacity: turn.context.windowTokens,
				readKeptFrom: null,
			},
		);
		expect((await viewAs(memberId).activity(details.conversation.id))?.context).toMatchObject({
			windowTokens: 128_000,
			compactionLineTokens: 89_600,
		});
	});

	it("compacts for a bot without a model on the system bots' model, capped to its window", async () => {
		const { details, earlier } = await taskWithLongHistory();
		await onDatabase((db) => db.update(bot).set({ model: null }).where(eq(bot.id, botId)));

		const prepared = await preparedCompaction({
			conversationId: details.conversation.id,
			botId,
			sourceMessageId: details.messages[0]?.id ?? "",
			readKeptFrom: null,
		});

		expect(prepared.model).toBe(SYSTEM_BOT_MODEL);
		// A quarter of the 256K ceiling is kept: the six newest long messages.
		expect(prepared.keptFrom).toEqual(earlier[14]?.createdAt);
		// The 64K model is given at most 60% of its window, three messages,
		// rather than the 115.2K the reader's window alone would allow.
		expect(prepared.transcript.map(({ content }) => content.split(".")[0])).toEqual([
			"Message 12",
			"Message 13",
			"Message 14",
		]);
	});

	it("treats a malformed conversation id as absent", async () => {
		await expect(viewAs(memberId).get("not-a-uuid")).rejects.toThrow(ResourceHidden);
	});
});
