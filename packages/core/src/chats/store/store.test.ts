import { chatStream, handleFromName } from "@sugabots/contracts";
import { eq } from "drizzle-orm";
import { Context, Effect } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ResourceHidden } from "../../authorization/access.ts";
import { EventBus } from "../../database/events/bus.ts";
import { EventStore } from "../../database/events/store.ts";
import {
	bot,
	chat,
	file,
	member,
	membership,
	message,
	modelProvider,
	project,
	projectBot,
	projectMember,
	providerModel,
	turn,
	workspace,
} from "../../database/schema.ts";
import {
	closeDatabase,
	onDatabase,
	onPostgres,
	runOnPostgres,
	servedOnPostgres,
} from "../../database/testing.ts";
import { lane } from "../../workflows/sql.ts";
import { BotStore } from "../../workspaces/bots/bot-store.ts";
import { SYSTEM_BOTS } from "../../workspaces/bots/system-bots.ts";
import { defaultProjectOf } from "../../workspaces/projects/project-reads.ts";
import { seedProject } from "../../workspaces/projects/seed.test-support.ts";
import { onPostgresAs } from "../../workspaces/testing.ts";
import { ChatDetailsView } from "../chat-details-view.ts";
import { ChatView } from "../chats/chat-view.ts";
import { Chats } from "../chats/chats.ts";
import { startBotChat } from "../chats/testing.ts";
import { compactionLane } from "../compaction/compaction.workflow.ts";
import { Compactions } from "../compaction/compactions.ts";
import { compactionLineTokens } from "../compaction/window.ts";
import { seedChat } from "../seed.test-support.ts";
import { chatServicesForTests } from "../testing.ts";
import { searchHistoryTool } from "../tools/search-history/tool.ts";
import {
	modelPrompt,
	prepareRunnable,
	queueTurnForTests,
	releaseTurn,
	replyTurnOf,
	runningTurns,
	TurnExecution,
	TurnStore,
} from "../turns/testing.ts";

/** What these tests set the workspace's system bots up with. */
const SYSTEM_BOT_MODEL = "test-model";

const eventStore = await runOnPostgres(EventStore.make);

describe.skipIf(!process.env.DATABASE_URL)("chats, against Postgres", async () => {
	const eventBus = EventBus.inProcess({ store: eventStore });
	const services = await chatServicesForTests(eventBus);
	const viewAs = (memberId: string) =>
		onPostgresAs(memberId)(Context.get(services, ChatDetailsView.Service));
	const chatsAs = (memberId: string) =>
		onPostgresAs(memberId)(Context.get(services, Chats.Service));
	const chatViewAs = (memberId: string) =>
		onPostgresAs(memberId)(Context.get(services, ChatView.Service));
	const turns = onPostgres({ prepare: Context.get(services, TurnExecution.Service).prepare });
	const turnStore = onPostgres(Context.get(services, TurnStore.Service));
	const compactions = onPostgres({
		prepare: Context.get(services, Compactions.Service).prepare,
		complete: Context.get(services, Compactions.Service).complete,
	});
	let workspaceId: string;
	let projectId: string;
	let botId: string;
	let memberId: string;
	let outsiderId: string;
	let outsiderEmail: string;

	/** A chat the member starts with the bot by sending it `message`, which the bot is asked to answer. */
	async function startChat(input: { botId: string; startedById: string; message: string }) {
		const started = await startBotChat(chatsAs(input.startedById), {
			botId: input.botId,
			messageId: crypto.randomUUID(),
			content: input.message,
		});
		return started.chat;
	}

	/** A chat as `startChat` starts it, with its participants and messages. */
	async function startChatShown(input: Parameters<typeof startChat>[0]) {
		const started = await startChat(input);
		return viewAs(input.startedById).get(started.id);
	}

	/** The bot's turn running in the chat, as its workflow runs it. */
	async function runningTurn(chatId: string, bot = botId) {
		const run = (await runOnPostgres(runningTurns(chatId))).find(
			(running) => running.request.botId === bot,
		);
		if (!run) throw new Error("No turn is running in the chat");
		return run;
	}

	/** Prepares the compaction `request` asks for, for a case that needs it to run. */
	async function preparedCompaction(request: Parameters<typeof compactions.prepare>[0]) {
		const preparation = await compactions.prepare(request);
		if (preparation._tag !== "Prepared") {
			throw new Error(`Chat test could not prepare its compaction: ${preparation.reason}`);
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
				.values({ name: `Chat test ${suffix}`, slug: `chat-test-${suffix}` })
				.returning(),
		);
		const members = await onDatabase((db) =>
			db
				.insert(member)
				.values([
					{ name: "Sam", email: `chat-sam-${suffix}@example.com` },
					{ name: "Kim", email: `chat-kim-${suffix}@example.com` },
				])
				.returning(),
		);
		const [insider, outsider] = members;
		if (!workspaceRow || !insider || !outsider) {
			throw new Error("Could not create chat test records");
		}
		workspaceId = workspaceRow.id;
		memberId = insider.id;
		outsiderId = outsider.id;
		outsiderEmail = outsider.email;

		await onDatabase((db) =>
			db.insert(membership).values([
				{ workspaceId, memberId: memberId },
				{ workspaceId, memberId: outsiderId },
			]),
		);
		const projectRow = await onDatabase((db) =>
			seedProject(db, {
				workspaceId,
				name: "Suga-Team",
				slug: `suga-${suffix}`,
				createdById: memberId,
			}),
		);
		const [botRow] = await onDatabase((db) =>
			db
				.insert(bot)
				.values({
					workspaceId,
					name: `Release bot ${suffix}`,
					handle: handleFromName(`Release bot ${suffix}`),
					color: "green",
					eyes: "pill",
					model: "claude-opus-4-1-20250805",
					createdById: memberId,
				})
				.returning(),
		);
		if (!botRow) throw new Error("Could not create chat scope");
		projectId = projectRow.id;
		botId = botRow.id;
		await onDatabase((db) =>
			db.insert(projectMember).values({ workspaceId, projectId, memberId: memberId }),
		);
		// The system bots belong to the workspace, not to the project, and each is
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
						eyes: definition.eyes,
						model: SYSTEM_BOT_MODEL,
						instructions: definition.instructions,
					})),
				)
				.returning({ id: bot.id }),
		);
		if (placed.length !== SYSTEM_BOTS.length) {
			throw new Error("Could not create the workspace's system bots");
		}
	});

	it("prepares a turn for a project bot other than the one that spoke first", async () => {
		// Every bot mentioned in a project's chat takes a turn, not only the
		// first, so a turn for any of them prepares.
		const [otherRow] = await onDatabase((db) =>
			db
				.insert(bot)
				.values({
					workspaceId,
					name: `Second bot ${Date.now()}`,
					handle: handleFromName(`Second bot ${Date.now()}`),
					color: "teal",
					eyes: "dot",
					model: "claude-opus-4-1-20250805",
					createdById: memberId,
				})
				.returning({ id: bot.id }),
		);
		if (!otherRow) throw new Error("Could not create the second bot");
		await onDatabase((db) =>
			db.insert(projectBot).values([
				{ workspaceId, projectId, botId },
				{ workspaceId, projectId, botId: otherRow.id },
			]),
		);
		// The bot that speaks first, by leading the project.
		await onDatabase((db) =>
			db.update(project).set({ leadBotId: botId }).where(eq(project.id, projectId)),
		);
		const { chat: projectChat, message: posted } = await chatsAs(memberId).startProjectChat({
			projectId,
			messageId: crypto.randomUUID(),
			content: "Who should answer this?",
		});
		await runOnPostgres(
			queueTurnForTests({
				chatId: projectChat.id,
				botId: otherRow.id,
				triggerMessageId: posted.id,
				reason: "mention",
			}),
		);
		const prepared = await prepareRunnable(turns, await runningTurn(projectChat.id, otherRow.id));

		expect(prepared.context.bot.id).toBe(otherRow.id);
	});

	it("shows a chat as working while its turn lane is busy", async () => {
		const details = await startChatShown({
			botId,
			startedById: memberId,
			message: "Run as a workflow",
		});
		const workingNow = async () => (await viewAs(memberId).get(details.chat.id))?.chat.working;
		expect(await workingNow()).toBe(true);

		await runOnPostgres(releaseTurn(await runningTurn(details.chat.id)));

		expect(await workingNow()).toBe(false);
	});

	it("loads a chat with its participants and first message", async () => {
		const details = await startChatShown({
			botId,
			startedById: memberId,
			message: "Check the release\nPay attention to migrations.",
		});

		// A chat is titled from its first message.
		expect(details.chat.title).toBe("Check the release Pay attention to migrations.");
		expect(details.participants.map(({ kind }) => kind).sort()).toEqual(["bot", "member"]);
		expect(details.messages).toMatchObject([
			{
				author: { kind: "member", id: memberId },
				content: "Check the release\nPay attention to migrations.",
				parts: [{ type: "text", text: "Check the release\nPay attention to migrations." }],
			},
		]);
		expect(await runOnPostgres(runningTurns(details.chat.id))).toMatchObject([
			{
				request: {
					chatId: details.chat.id,
					botId,
					triggerMessageId: details.messages[0]?.id,
				},
			},
		]);
	});

	it("pages a large history without gaps at equal-timestamp boundaries", async () => {
		const details = await startChatShown({
			botId,
			startedById: memberId,
			message: "Message 000",
		});
		const firstMessageId = details.messages[0]?.id;
		if (!firstMessageId) {
			throw new Error("Chat test has no first message");
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
					chatId: details.chat.id,
					authorMemberId: memberId,
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
					chatId: details.chat.id,
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
			const page = await viewAs(memberId).get(details.chat.id, { limit: 50, cursor });
			if (!page) {
				throw new Error("Chat history disappeared");
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
			viewAs(memberId).get(details.chat.id, { limit: 50, cursor: "not-a-cursor" }),
		).rejects.toMatchObject({ _tag: "InvalidCursor" });
	});

	it("replays a committed message after reconnect", async () => {
		const details = await startChatShown({
			botId,
			startedById: memberId,
			message: "First",
		});
		const stream = chatStream(details.chat.id);
		const [resumePoint] = await eventStore.replay(stream, 0, 10);
		if (!resumePoint) {
			throw new Error("Chat creation did not commit its durable event");
		}

		const messageId = crypto.randomUUID();
		if (!details.chat.rootChatId) throw new Error("The chat has no root chat");
		await chatsAs(memberId).post({
			chatId: details.chat.rootChatId,
			messageId,
			content: "Second",
		});

		const iterator = eventBus.subscribe(stream, { since: resumePoint.seq })[Symbol.asyncIterator]();
		const replayed = await iterator.next();
		await iterator.return?.();
		expect(replayed.value?.event).toMatchObject({
			type: "message.created",
			message: { id: messageId, content: "Second" },
		});
	});

	it("rejects projects and bots from another workspace at the database boundary", async () => {
		const [otherWorkspace] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({
					name: "Other chat workspace",
					slug: `other-chat-${crypto.randomUUID()}`,
				})
				.returning(),
		);
		if (!otherWorkspace) {
			throw new Error("Could not create other chat workspace");
		}
		await onDatabase((db) =>
			db.insert(membership).values({ workspaceId: otherWorkspace.id, memberId: memberId }),
		);
		const foreignProject = await onDatabase((db) =>
			seedProject(db, {
				workspaceId: otherWorkspace.id,
				name: "Foreign",
				slug: "foreign",
			}),
		);
		const [foreignBot] = await onDatabase((db) =>
			db
				.insert(bot)
				.values({
					workspaceId: otherWorkspace.id,
					name: "Foreign bot",
					handle: "foreign-bot",
					color: "rose",
					eyes: "pill",
					model: "test/model",
				})
				.returning(),
		);
		if (!foreignProject || !foreignBot) {
			throw new Error("Could not create foreign chat scope");
		}

		await expect(
			onDatabase((db) =>
				seedChat(db, {
					workspaceId,
					kind: "project_chat",
					projectId: foreignProject.id,
					title: "Foreign project",
					startedById: memberId,
				}),
			),
		).rejects.toThrow();
		await expect(
			onDatabase((db) =>
				seedChat(db, {
					workspaceId,
					kind: "project_chat",
					botId: foreignBot.id,
					title: "Foreign host",
					startedById: memberId,
				}),
			),
		).rejects.toThrow();
	});

	it("deletes a bot's chat history with the bot", async () => {
		const details = await startChatShown({
			botId,
			startedById: memberId,
			message: "Keep this history",
		});

		const bots = await servedOnPostgres(BotStore.Service, BotStore.layer);
		await bots.remove(workspaceId, botId, memberId, Effect.void);
		expect(
			await onDatabase((db) => db.select().from(chat).where(eq(chat.id, details.chat.id))),
		).toHaveLength(0);
	});

	it("adds each member who writes to the participant stack", async () => {
		const details = await startChatShown({
			botId,
			startedById: memberId,
			message: "First",
		});

		if (!details.chat.rootChatId) throw new Error("The chat has no root chat");
		await chatsAs(outsiderId).post({
			chatId: details.chat.rootChatId,
			messageId: crypto.randomUUID(),
			content: "I can help",
		});

		expect((await viewAs(memberId).get(details.chat.id))?.participants).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "member", id: outsiderId, email: outsiderEmail }),
			]),
		);
	});

	it("counts a quiet chat's latest messages as recent, and a busy chat's last week", async () => {
		const details = await startChatShown({
			botId,
			startedById: memberId,
			message: "Latest",
		});
		const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		const written = (author: { authorMemberId: string } | { authorBotId: string }, at: Date) => ({
			chatId: details.chat.id,
			...author,
			status: "complete" as const,
			parts: [{ type: "text" as const, text: "Earlier" }],
			content: "Earlier",
			createdAt: at,
		});
		await onDatabase((db) =>
			db
				.insert(message)
				.values([
					written({ authorMemberId: outsiderId }, daysAgo(30)),
					written({ authorBotId: botId }, daysAgo(3)),
				]),
		);
		const recentIds = async () =>
			(await chatViewAs(memberId).chats(await runOnPostgres(defaultProjectOf(botId)))).chats
				.find((listed) => listed.chat.id === details.chat.id)
				?.participants.map(({ id }) => id);

		expect(await recentIds()).toEqual([memberId, botId, outsiderId]);

		await onDatabase((db) =>
			db
				.insert(message)
				.values(
					Array.from({ length: 100 }, () => written({ authorMemberId: memberId }, daysAgo(1))),
				),
		);
		expect(await recentIds()).toEqual([memberId, botId]);
	});

	it("compacts a long chat into a condensed account and the newest messages, and searches what came before", async () => {
		const details = await startChatShown({
			botId,
			startedById: memberId,
			message: "Plan the trip",
		});
		// Twenty messages of about 10,000 tokens each, written before the one
		// that opened the chat: far past the compaction line between them.
		const long = (index: number) =>
			`${index === 2 ? "The hotel budget is 150 euros a night. " : ""}Message ${index}. ${"word ".repeat(8_000)}`;
		const earlier = await onDatabase((db) =>
			db
				.insert(message)
				.values(
					Array.from({ length: 20 }, (_, index) => ({
						chatId: details.chat.id,
						authorMemberId: memberId,
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
			chatId: details.chat.id,
			botId,
			sourceMessageId,
			readKeptFrom: null,
		});

		// Kept word for word: the newest six long messages and the short one,
		// about a quarter of the window. Condensed: the eleven before them.
		expect(prepared.model).toBe("claude-opus-4-1-20250805");
		expect(prepared.keptFrom).toEqual(earlier[14]?.createdAt);
		expect(prepared.historyStartsAt).toEqual(earlier[3]?.createdAt);
		expect(prepared.transcript.map(({ content }) => content.split(".")[0])).toEqual(
			Array.from({ length: 11 }, (_, index) => `Message ${index + 4}`),
		);
		// The Compaction bot works in its own chat hanging off the one it
		// compacts, which stays out of the project's chat list.
		expect(prepared.compactor.chatId).not.toBe(details.chat.id);
		const { chats } = await chatViewAs(memberId).chats(
			await runOnPostgres(defaultProjectOf(botId)),
		);
		expect(chats.some((listed) => listed.chat.id === prepared.compactor.chatId)).toBe(false);
		await compactions.complete(prepared, "The family is planning a trip.");

		const turn = await prepareRunnable(turns, await runningTurn(details.chat.id));
		expect(turn.context.compaction).toEqual({
			condensed: "The family is planning a trip.",
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
		await turnStore.complete(
			replyTurnOf(turn),
			{ content: "Here is the plan.", toolCalls: [] },
			{
				contextTokens: 70_000,
				contextCapacity: turn.context.windowTokens,
				readKeptFrom: prepared.keptFrom.toISOString(),
			},
		);
		expect(await viewAs(memberId).context(details.chat.id)).toMatchObject({
			usedTokens: 70_000,
			compactedAt: expect.any(String),
		});

		const search = searchHistoryTool({
			chatId: details.chat.id,
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
		// Nothing new past what the compaction kept: nothing to condense.
		expect(
			await compactions.prepare({
				chatId: details.chat.id,
				botId,
				sourceMessageId,
				readKeptFrom,
			}),
		).toMatchObject({ _tag: "Skipped" });

		// Three more long messages push the kept part on. A turn measured before the
		// compaction says nothing about the chat now, so only one that read it counts.
		const later = await onDatabase((db) =>
			db
				.insert(message)
				.values(
					Array.from({ length: 3 }, (_, index) => ({
						chatId: details.chat.id,
						authorMemberId: memberId,
						status: "complete" as const,
						parts: [{ type: "text" as const, text: long(21 + index) }],
						content: long(21 + index),
						createdAt: new Date(Date.now() + (index + 1) * 60_000),
					})),
				)
				.returning({ id: message.id }),
		);
		const newest = {
			chatId: details.chat.id,
			botId,
			sourceMessageId: later[2]?.id ?? "",
		};
		expect(await compactions.prepare({ ...newest, readKeptFrom: null })).toMatchObject({
			_tag: "Skipped",
		});

		// The next compaction carries the first condensed account forward rather than dropping it.
		const next = await preparedCompaction({ ...newest, readKeptFrom });
		expect(next.previousCondensed).toBe("The family is planning a trip.");
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
			const details = await startChatShown({
				botId,
				startedById: memberId,
				message: "Plan the trip",
			});
			const prepared = await prepareRunnable(turns, await runningTurn(details.chat.id));

			await turnStore.complete(
				replyTurnOf(prepared),
				{ content: "Here is the plan.", toolCalls: [] },
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
					.where(eq(lane.key, compactionLane({ chatId: details.chat.id }))),
			);
			expect(compaction?.payload).toEqual(
				asked
					? {
							// Stored under the keys the first compactions were.
							chatId: details.chat.id,
							botId: botId,
							sourceMessageId: prepared.responseMessage.id,
							readKeptFrom: null,
						}
					: undefined,
			);
		},
	);

	it("searches history in any language: stemmed, as written, and as substrings", async () => {
		const details = await startChatShown({
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
					chatId: details.chat.id,
					authorMemberId: memberId,
					status: "complete" as const,
					parts: [{ type: "text" as const, text: content }],
					content,
					createdAt: new Date(Date.now() - (said.length - index) * 60_000),
				})),
			),
		);
		const search = searchHistoryTool({
			chatId: details.chat.id,
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
		const details = await startChatShown({
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
						chatId: details.chat.id,
						authorMemberId: memberId,
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
						chatId: details.chat.id,
						kind: "attachment" as const,
						uploaderId: memberId,
						position: 0,
						size: 2048,
					})),
				)
				.returning({ id: file.id, name: file.name }),
		);
		const fileIdOf = (name: string) => attached.find((file) => file.name === name)?.id;
		const search = searchHistoryTool({
			chatId: details.chat.id,
			before: new Date(Date.now() + 60_000),
			usesComputer: true,
			run: runOnPostgres,
		});
		const found = async (input: { query?: string; after?: string }) => {
			const result = await search.execute?.(input, { toolCallId: "search", messages: [] } as never);
			return result && "messages" in result ? result.messages.map(({ text }) => text) : [];
		};

		expect(await found({ query: "signed contract" })).toEqual([
			`Here is the signed contract\n[Attached contract.pdf (application/pdf, 2.0 KB) as file ${fileIdOf("contract.pdf")}, which read_chat_file reads, or copy_file_to_computer copies]`,
		]);
		// By its name, for a message that says nothing else.
		expect(await found({ query: "chart.png" })).toEqual([
			`[Attached chart.png (image/png, 2.0 KB) as file ${fileIdOf("chart.png")}, which read_chat_file reads, or copy_file_to_computer copies]`,
		]);
		expect(await found({ after: started.toISOString() })).toContain(
			`[Attached chart.png (image/png, 2.0 KB) as file ${fileIdOf("chart.png")}, which read_chat_file reads, or copy_file_to_computer copies]`,
		);
	});

	/**
	 * A chat of twenty long messages, about 10K tokens each, before its
	 * first, with the bot's model given a 128K window and the system bots'
	 * a 64K one.
	 */
	async function chatWithLongHistory() {
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
		const details = await startChatShown({
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
						chatId: details.chat.id,
						authorMemberId: memberId,
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
		const { details, earlier } = await chatWithLongHistory();

		const prepared = await preparedCompaction({
			chatId: details.chat.id,
			botId,
			sourceMessageId: details.messages[0]?.id ?? "",
			readKeptFrom: null,
		});

		expect(prepared.model).toBe("claude-opus-4-1-20250805");
		// A quarter of the bot's 128K is kept: the three newest long messages.
		expect(prepared.keptFrom).toEqual(earlier[17]?.createdAt);
		// Up to the 89.6K compaction line less what is kept is condensed.
		expect(prepared.transcript.map(({ content }) => content.split(".")[0])).toEqual([
			"Message 13",
			"Message 14",
			"Message 15",
			"Message 16",
			"Message 17",
		]);

		const turn = await prepareRunnable(turns, await runningTurn(details.chat.id));
		expect(turn.context.windowTokens).toBe(128_000);
		await turnStore.complete(
			replyTurnOf(turn),
			{ content: "Here is the plan.", toolCalls: [] },
			{
				contextTokens: 50_000,
				contextCapacity: turn.context.windowTokens,
				readKeptFrom: null,
			},
		);
		expect(await viewAs(memberId).context(details.chat.id)).toMatchObject({
			windowTokens: 128_000,
			compactionLineTokens: 89_600,
		});
	});

	it("compacts for a bot without a model on the system bots' model, capped to its window", async () => {
		const { details, earlier } = await chatWithLongHistory();
		await onDatabase((db) => db.update(bot).set({ model: null }).where(eq(bot.id, botId)));

		const prepared = await preparedCompaction({
			chatId: details.chat.id,
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

	it("treats a malformed chat id as absent", async () => {
		await expect(viewAs(memberId).get("not-a-uuid")).rejects.toThrow(ResourceHidden);
	});
});
