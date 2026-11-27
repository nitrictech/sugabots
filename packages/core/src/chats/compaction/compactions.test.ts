import { eq } from "drizzle-orm";
import { Context } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { seedBot } from "../../authentication/seed.test-support.ts";
import { EventBus } from "../../database/events/bus.ts";
import { EventStore } from "../../database/events/store.ts";
import { bot, message, modelProvider, providerModel } from "../../database/schema.ts";
import { closeDatabase, onDatabase, onPostgres, runOnPostgres } from "../../database/testing.ts";
import { asMember } from "../../operations/chats/testing.ts";
import { servedOperations } from "../../operations/testing.ts";
import { lane } from "../../workflows/sql.ts";
import { COMPACT_SYSTEM_BOT } from "../../workspaces/bots/system-bots.ts";
import { defaultProjectOf } from "../../workspaces/projects/project-reads.ts";
import { chatServicesForTests } from "../testing.ts";
import {
	aChatAwaitingReply,
	completeTurn,
	modelPrompt,
	prepareTurn,
	queueTurnForTests,
	runningTurns,
	runOver,
} from "../turns/testing.ts";
import { compactionLane } from "./compaction.workflow.ts";
import { Compactions } from "./compactions.ts";
import { compactionLineTokens } from "./window.ts";

const READER_MODEL = "m";
const COMPACTOR_MODEL = "test-compactor";
const CONDENSED = "Sam is comparing hotels for a trip.";
const FIRST_HISTORY_AT = new Date("2025-01-01T00:00:00Z");
const HISTORY_MESSAGE_INTERVAL_MS = 60_000;

describe.skipIf(!process.env.DATABASE_URL)("compaction, against Postgres", async () => {
	const eventStore = await runOnPostgres(EventStore.make);
	const services = await chatServicesForTests(EventBus.inProcess({ store: eventStore }));
	const call = await servedOperations({ chats: services });
	const chatsAs = (memberId: string) => asMember(call, memberId);
	const drive = runOver(services);
	const { prepare, complete } = Context.get(services, Compactions.Service);
	const compactions = onPostgres({ prepare, complete });

	afterAll(closeDatabase);

	async function chatWithModelWindows(readerTokens: number, compactorTokens: number) {
		const chat = await aChatAwaitingReply(chatsAs);
		const { workspaceId, chatId } = chat;
		const compactor = await seedBot(workspaceId, { systemBotKey: COMPACT_SYSTEM_BOT });
		await onDatabase((db) =>
			db.update(bot).set({ model: COMPACTOR_MODEL }).where(eq(bot.id, compactor.id)),
		);
		const [provider] = await onDatabase((db) =>
			db
				.insert(modelProvider)
				.values({
					workspaceId,
					name: "Models",
					baseUrl: "https://models.example/v1",
					apiFormat: "openai",
					active: true,
				})
				.returning({ id: modelProvider.id }),
		);
		if (!provider) throw new Error("Could not create the model provider");
		await onDatabase((db) =>
			db.insert(providerModel).values(
				[
					{ modelId: READER_MODEL, contextLength: readerTokens },
					{ modelId: COMPACTOR_MODEL, contextLength: compactorTokens },
				].map((model) => ({
					...model,
					workspaceId,
					providerId: provider.id,
					enabled: true,
					source: "manual" as const,
				})),
			),
		);
		const [run] = await runOnPostgres(runningTurns(chatId));
		if (!run) throw new Error("The chat has no turn");
		return {
			...chat,
			run,
			projectId: await runOnPostgres(defaultProjectOf(chat.botId)),
			request: {
				chatId,
				botId: chat.botId,
				sourceMessageId: run.request.triggerMessageId,
				readKeptFrom: null,
			},
		};
	}

	async function writeHistory(
		{ chatId, adminId }: { chatId: string; adminId: string },
		{
			count,
			characters,
			firstNumber = 1,
			firstAt = FIRST_HISTORY_AT,
		}: { count: number; characters: number; firstNumber?: number; firstAt?: Date },
	) {
		const entries = Array.from({ length: count }, (_, index) => {
			const title = `Message ${firstNumber + index}`;
			const prefix = `${title}. Hotel prices, transport and dates.`;
			const content = `${prefix.padEnd(characters - 3)}End`;
			return {
				id: crypto.randomUUID(),
				content,
				createdAt: new Date(firstAt.getTime() + index * HISTORY_MESSAGE_INTERVAL_MS),
			};
		});
		await onDatabase((db) =>
			db.insert(message).values(
				entries.map(({ id, content, createdAt }) => ({
					id,
					chatId,
					authorMemberId: adminId,
					status: "complete" as const,
					parts: [{ type: "text" as const, text: content }],
					content,
					createdAt,
				})),
			),
		);
		return entries;
	}

	async function chatWithLongHistory(readerTokens = 2_560) {
		const chat = await chatWithModelWindows(readerTokens, 640);
		const earlier = await writeHistory(chat, { count: 20, characters: 400 });
		return { ...chat, earlier };
	}

	async function prepareCompaction(request: Parameters<typeof compactions.prepare>[0]) {
		const prepared = await compactions.prepare(request);
		if (prepared._tag === "Skipped") throw new Error(prepared.reason);
		return prepared;
	}

	it("gives the Compaction bot the history before the newest messages and keeps its chat out of the project list", async () => {
		const { request, earlier, adminId, projectId, chatId } = await chatWithLongHistory();

		const prepared = await prepareCompaction(request);

		expect(prepared.model).toBe(READER_MODEL);
		expect(prepared.keptFrom).toEqual(earlier[14]?.createdAt);
		expect(prepared.historyStartsAt).toEqual(earlier[3]?.createdAt);
		expect(prepared.transcript.map(({ content }) => content)).toEqual(
			earlier.slice(3, 14).map(({ content }) => content),
		);
		expect(prepared.compactor.chatId).not.toBe(chatId);
		const { chats } = await chatsAs(adminId).chats(projectId);
		expect(chats.map(({ chat }) => chat.id)).toEqual([chatId]);
	});

	it("gives a later turn the condensed account and the messages compaction kept", async () => {
		const { request, earlier, run, chatId, adminId } = await chatWithLongHistory();
		const prepared = await prepareCompaction(request);
		await compactions.complete(prepared, CONDENSED);

		const turn = await drive(prepareTurn(run));
		const prompt = modelPrompt(turn.context, {
			now: FIRST_HISTORY_AT,
			builtInTools: [],
			toolCatalog: undefined,
			computer: undefined,
		});

		expect(prompt.messages[0]?.content).toContain(CONDENSED);
		expect(turn.context.messages.map(({ content }) => content)).toEqual([
			...earlier.slice(14).map(({ content }) => content),
			"What does example.com say?",
		]);

		const measuredTokens = 1_700;
		await drive(completeTurn(turn, "Here is the plan.", measuredTokens));
		expect(await chatsAs(adminId).context(chatId)).toMatchObject({
			usedTokens: measuredTokens,
			compactedAt: expect.any(String),
		});
	});

	it("skips another compaction until there is new history and the triggering turn has read the latest compaction", async () => {
		const chat = await chatWithLongHistory();
		const prepared = await prepareCompaction(chat.request);
		await compactions.complete(prepared, CONDENSED);
		const readKeptFrom = prepared.keptFrom.toISOString();

		expect(await compactions.prepare({ ...chat.request, readKeptFrom })).toMatchObject({
			_tag: "Skipped",
		});

		const newest = await appendLongHistory(chat);
		expect(await compactions.prepare(newest)).toMatchObject({ _tag: "Skipped" });
		expect(await compactions.prepare({ ...newest, readKeptFrom })).toMatchObject({
			_tag: "Prepared",
		});
	});

	async function appendLongHistory(chat: Awaited<ReturnType<typeof chatWithLongHistory>>) {
		const [source] = await onDatabase((db) =>
			db
				.select({ createdAt: message.createdAt })
				.from(message)
				.where(eq(message.id, chat.request.sourceMessageId)),
		);
		if (!source) throw new Error("The message that started the chat is missing");
		const later = await writeHistory(chat, {
			count: 3,
			characters: 400,
			firstNumber: 21,
			firstAt: new Date(source.createdAt.getTime() + HISTORY_MESSAGE_INTERVAL_MS),
		});
		const newest = later.at(-1);
		if (!newest) throw new Error("The later history is missing");
		return { ...chat.request, sourceMessageId: newest.id };
	}

	it("carries the previous condensed account forward when compaction advances", async () => {
		const chat = await chatWithLongHistory();
		const prepared = await prepareCompaction(chat.request);
		await compactions.complete(prepared, CONDENSED);
		const newest = await appendLongHistory(chat);

		const next = await prepareCompaction({
			...newest,
			readKeptFrom: prepared.keptFrom.toISOString(),
		});

		expect(next.previousCondensed).toBe(CONDENSED);
		expect(next.historyStartsAt).toEqual(chat.earlier[3]?.createdAt);
		expect(next.keptFrom).toEqual(chat.earlier[17]?.createdAt);
		expect(next.transcript.map(({ content }) => content)).toEqual(
			chat.earlier.slice(14, 17).map(({ content }) => content),
		);
	});

	it("keeps the message a waiting turn answers and every message after it", async () => {
		const { request, earlier, chatId, botId } = await chatWithLongHistory();
		const answered = earlier[5];
		if (!answered) throw new Error("The message to answer is missing");
		await runOnPostgres(
			queueTurnForTests({
				chatId,
				botId,
				triggerMessageId: answered.id,
				reason: "mention",
			}),
		);

		const prepared = await prepareCompaction(request);

		expect(prepared.keptFrom).toEqual(answered.createdAt);
		expect(prepared.transcript.map(({ content }) => content)).toEqual(
			earlier.slice(3, 5).map(({ content }) => content),
		);
	});

	it("sizes compaction to the reader model's window", async () => {
		const { request, earlier, run, adminId, chatId } = await chatWithLongHistory(1_280);

		const prepared = await prepareCompaction(request);

		expect(prepared.model).toBe(READER_MODEL);
		expect(prepared.keptFrom).toEqual(earlier[17]?.createdAt);
		expect(prepared.transcript.map(({ content }) => content)).toEqual(
			earlier.slice(12, 17).map(({ content }) => content),
		);
		const turn = await drive(prepareTurn(run));
		expect(turn.context.windowTokens).toBe(1_280);
		await drive(completeTurn(turn, "Here is the plan.", 500));
		expect(await chatsAs(adminId).context(chatId)).toMatchObject({
			windowTokens: 1_280,
			compactionLineTokens: 896,
		});
	});

	it("caps the transcript to the Compaction bot's model window when the reader has no model", async () => {
		const chat = await chatWithModelWindows(128_000, 64_000);
		await onDatabase((db) => db.update(bot).set({ model: null }).where(eq(bot.id, chat.botId)));
		const earlier = await writeHistory(chat, { count: 10, characters: 40_000 });

		const prepared = await prepareCompaction(chat.request);

		expect(prepared.model).toBe(COMPACTOR_MODEL);
		expect(prepared.keptFrom).toEqual(earlier[4]?.createdAt);
		expect(prepared.transcript.map(({ content }) => content)).toEqual(
			earlier.slice(1, 4).map(({ content }) => content),
		);
	});

	it.each([
		{ contextTokens: compactionLineTokens(128_000) - 1, asked: false },
		{ contextTokens: compactionLineTokens(128_000), asked: true },
	])(
		"asks for a compaction only once a reply's prompt reaches the compaction line ($contextTokens tokens)",
		async ({ contextTokens, asked }) => {
			const { run, chatId, botId } = await chatWithModelWindows(128_000, 64_000);
			const turn = await drive(prepareTurn(run));

			await drive(completeTurn(turn, "Here is the plan.", contextTokens));

			const [compaction] = await onDatabase((db) =>
				db
					.select({ payload: lane.payload })
					.from(lane)
					.where(eq(lane.key, compactionLane({ chatId }))),
			);
			expect(compaction?.payload).toEqual(
				asked
					? { chatId, botId, sourceMessageId: turn.replyMessageId, readKeptFrom: null }
					: undefined,
			);
		},
	);
});
