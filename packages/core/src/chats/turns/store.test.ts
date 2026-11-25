import { UserText, userText } from "@sugabots/errors";
import { eq, like } from "drizzle-orm";
import { Context, Effect, Schema } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { BlobStore } from "../../blob-store/blob-store.ts";
import type { CommittedEvent } from "../../database/events/outbox.ts";
import { blob, bot, message, turn } from "../../database/schema.ts";
import { closeDatabase, onDatabase, onPostgres, runOnPostgres } from "../../database/testing.ts";
import { asMember } from "../../operations/chats/testing.ts";
import { servedOperations } from "../../operations/testing.ts";
import { chatServicesForTests } from "../testing.ts";
import { gaveUpAfter, MAX_TURN_RUNS } from "./lifecycle.ts";
import { TurnRecords } from "./records.ts";
import { TurnRuns } from "./runs.ts";
import { TurnStore } from "./store.ts";
import {
	aChatAwaitingReply,
	asTheLoop,
	endTurn,
	type OpenedTurnForTests,
	openTurn,
	parkTurn,
	recordToolCall,
	replyTurnOf,
	runningTurns,
	runOver,
	writeReply,
} from "./testing.ts";

/**
 * Turns against Postgres: how a turn opens again for another run, gives up,
 * parks for approvals and ends, as the store writes and announces it.
 */
describe.skipIf(!process.env.DATABASE_URL)("turns, against Postgres", async () => {
	let delivered: CommittedEvent[] = [];
	const services = await chatServicesForTests({
		publishCommitted: async (events) => {
			delivered.push(...events);
		},
	});
	const run = runOver(services);
	const turns = onPostgres(Context.get(services, TurnStore.Service));
	const runs = onPostgres(Context.get(services, TurnRuns.Service));
	const call = await servedOperations({ chats: services });
	const chatsAs = (memberId: string) => asMember(call, memberId);
	const providerDown = userText`The model provider could not answer.`;
	let chatId: string;
	let opened: OpenedTurnForTests;

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		({ chatId } = await aChatAwaitingReply(chatsAs));
		const [running] = await runOnPostgres(runningTurns(chatId));
		if (!running) throw new Error("no turn running");
		opened = await run(openTurn(running));
		delivered = [];
	});

	const storedTurn = async () => {
		const [row] = await onDatabase((db) =>
			db.select().from(turn).where(eq(turn.id, opened.turnId)),
		);
		return row;
	};

	const deliveredEvents = () => delivered.map(({ event }) => event);

	const markActed = (of: OpenedTurnForTests) =>
		run(
			asTheLoop(of, (runsTurn) =>
				Effect.flatMap(TurnStore.Service, (store) => store.markActed(runsTurn)),
			),
		);

	const load = (of: OpenedTurnForTests, step: number) =>
		run(
			asTheLoop(of, (runsTurn) =>
				Effect.flatMap(TurnRecords.Service, (records) => records.load(runsTurn, step)),
			),
		);

	it("runs a failed turn again, starting its reply over, while no change stands in the way", async () => {
		const blobsInChat = () => blobKeysUnder(BlobStore.key("chats", chatId));
		const shared = await turns.attachFile(
			{ ...replyTurnOf(opened), executionNumber: opened.principal.executionNumber },
			{
				name: "chart.png",
				contentType: "image/png",
				content: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
			},
		);
		expect(deliveredEvents()).toContainEqual(
			expect.objectContaining({ type: "message.files_changed", files: [shared] }),
		);
		expect(await blobsInChat()).toHaveLength(1);
		expect(
			await run(endTurn(opened, { kind: "failed", userMessage: providerDown, mayRunAgain: true })),
		).toEqual({ willRetry: true, steered: false });

		const second = await run(openTurn(opened.run));

		expect(second.turnId).toBe(opened.turnId);
		expect(second.reply).toMatchObject({
			id: opened.replyMessageId,
			retryKey: opened.turnId,
			status: "writing",
		});
		expect(second.reply.id).not.toBe(second.reply.retryKey);
		expect(await storedTurn()).toMatchObject({ status: "running", runs: 2, error: null });
		// The reply starts over without the file its last run shared, blob and all.
		expect(await turns.replyFiles(replyTurnOf(second))).toEqual([]);
		expect(await blobsInChat()).toEqual([]);
		// Running again could act again, so the turn stops here for a member.
		await markActed(second);
		expect(
			await run(endTurn(second, { kind: "failed", userMessage: providerDown, mayRunAgain: true })),
		).toEqual({ willRetry: false, steered: false });
	});

	it("does not run a failed turn again when its failure rules that out", async () => {
		const told = userText`The reply stopped before answering.`;

		expect(
			await run(endTurn(opened, { kind: "failed", userMessage: told, mayRunAgain: false })),
		).toEqual({ willRetry: false, steered: false });

		expect(await storedTurn()).toMatchObject({ status: "failed" });
		expect(deliveredEvents()).toContainEqual(
			expect.objectContaining({ type: "message.failed", error: told }),
		);
		// A file shared by a call still running when the turn ended isn't shared.
		await expect(
			turns.attachFile(
				{ ...replyTurnOf(opened), executionNumber: opened.principal.executionNumber },
				{
					name: "late.csv",
					contentType: "text/csv",
					content: new Uint8Array([0x61]),
				},
			),
		).rejects.toBeInstanceOf(TurnStore.ReplyEnded);
		expect(await turns.replyFiles(replyTurnOf(opened))).toEqual([]);
		expect(await blobKeysUnder(BlobStore.key("chats", chatId))).toEqual([]);
	});

	it("gives up on a turn that keeps stopping before it gets anywhere", async () => {
		await onDatabase((db) =>
			db.update(turn).set({ runs: MAX_TURN_RUNS }).where(eq(turn.id, opened.turnId)),
		);

		expect(await runs.open(opened.run)).toMatchObject({
			_tag: "NotRunnable",
			ended: { state: "failed" },
		});
		expect(await storedTurn()).toMatchObject({ status: "failed" });
		expect(deliveredEvents()).toContainEqual(
			expect.objectContaining({ type: "message.failed", messageId: opened.replyMessageId }),
		);
	});

	it("fails a turn when the same unfinished step reaches the retry limit", async () => {
		for (let loadNumber = 1; loadNumber < MAX_TURN_RUNS; loadNumber++) {
			expect(await load(opened, 0)).toMatchObject({ _tag: "Begun" });
		}

		expect(await load(opened, 0)).toEqual({ _tag: "Ended" });
		expect(deliveredEvents()).toContainEqual(
			expect.objectContaining({
				type: "message.failed",
				messageId: opened.replyMessageId,
				error: gaveUpAfter(MAX_TURN_RUNS),
			}),
		);
	});

	it("counts a turn's runs again from its last stop for approvals", async () => {
		expect((await storedTurn())?.runs).toBe(1);

		expect(await run(parkTurn(opened, []))).toEqual({ _tag: "Waiting", approvals: [] });

		expect(await storedTurn()).toMatchObject({ status: "waiting", runs: 0 });
	});

	it("finds a turn its run opened before a crash again, with what its steps wrote", async () => {
		await run(writeReply(opened, "Waiting."));

		const reopened = await run(openTurn(opened.run));

		expect(reopened.turnId).toBe(opened.turnId);
		expect(await storedTurn()).toMatchObject({
			status: "running",
			runs: 2,
			checkpoint: expect.objectContaining({
				reply: { content: "Waiting.", toolCalls: [] },
			}),
		});
		const [reply] = await onDatabase((db) =>
			db.select().from(message).where(eq(message.id, opened.replyMessageId)),
		);
		expect(reply).toMatchObject({ content: "Waiting.", status: "writing" });
	});

	it("does not load a turn whose checkpoint cannot be read, rather than carrying it on", async () => {
		await onDatabase((db) =>
			db
				.update(turn)
				.set({ checkpoint: { messages: "not a transcript" } })
				.where(eq(turn.id, opened.turnId)),
		);

		await expect(load(opened, 0)).rejects.toBeInstanceOf(Schema.SchemaError);
	});

	it("ends a turn somebody asked to stop instead of opening it again after a crash", async () => {
		await onDatabase((db) =>
			db.update(turn).set({ endRequested: "interrupted" }).where(eq(turn.id, opened.turnId)),
		);

		expect(await runs.open(opened.run)).toMatchObject({
			_tag: "NotRunnable",
			ended: { state: "cancelled" },
		});
		expect(await storedTurn()).toMatchObject({ status: "cancelled", checkpoint: null });
		expect(deliveredEvents()).toContainEqual(
			expect.objectContaining({
				type: "message.completed",
				messageId: opened.replyMessageId,
				status: "cancelled",
			}),
		);
	});

	it("cancels a turn somebody asked to stop between its steps once its next step begins", async () => {
		await run(writeReply(opened, "Halfway."));
		// The turn's automation run ends while no step runs to hear it.
		await turns.cancelUnder([chatId]);
		expect(await storedTurn()).toMatchObject({ status: "running", endRequested: "run_ended" });

		expect(await load(opened, 1)).toEqual({ _tag: "Ended" });

		expect(await storedTurn()).toMatchObject({ status: "cancelled" });
		const [reply] = await onDatabase((db) =>
			db.select().from(message).where(eq(message.id, opened.replyMessageId)),
		);
		expect(reply).toMatchObject({ content: "Halfway.", status: "cancelled" });
		expect(deliveredEvents()).toContainEqual(
			expect.objectContaining({
				type: "message.completed",
				messageId: opened.replyMessageId,
				status: "cancelled",
			}),
		);
	});

	it("ends a turn whose automation run asked it to end as asked, rather than failing it or running it again", async () => {
		await turns.cancelUnder([chatId]);

		expect(
			await run(
				endTurn(opened, {
					kind: "failed",
					userMessage: userText`The model provider could not answer.`,
					mayRunAgain: true,
					retryAfterMillis: 30_000,
				}),
			),
		).toEqual({ willRetry: false, steered: false });
		expect(await storedTurn()).toMatchObject({
			status: "cancelled",
			endRequested: "run_ended",
			retrying: false,
			retryAt: null,
		});
	});

	it("cancels a turn waiting to retry when its automation run ends", async () => {
		expect(
			await run(
				endTurn(opened, {
					kind: "failed",
					userMessage: userText`The model provider could not answer.`,
					mayRunAgain: true,
					retryAfterMillis: 30_000,
				}),
			),
		).toEqual({ willRetry: true, steered: false });

		expect(await turns.cancelUnder([chatId])).toEqual([opened.run.executionId]);
		expect(await storedTurn()).toMatchObject({
			status: "cancelled",
			retrying: false,
			retryAt: null,
		});
		expect(await runs.open(opened.run)).toMatchObject({ _tag: "NotRunnable", endedBefore: true });
		expect(deliveredEvents()).toContainEqual(
			expect.objectContaining({
				type: "message.completed",
				messageId: opened.replyMessageId,
				status: "cancelled",
			}),
		);
	});

	it("tells the chat that a turn its workflow gave up on failed, calls and all", async () => {
		const callId = await run(
			recordToolCall(opened, {
				toolCallId: "sdk-1",
				tool: "web_fetch",
				input: { url: "https://example.com" },
			}),
		);
		delivered = [];
		const stopped = userText`The reply stopped unexpectedly.`;

		expect(
			await turns.abandon(opened.run.executionId, { status: "failed", userMessage: stopped }),
		).toEqual({ state: "failed", error: stopped });

		expect(deliveredEvents()).toEqual([
			expect.objectContaining({
				type: "tool_call.completed",
				toolCall: expect.objectContaining({ id: callId, status: "failed" }),
			}),
			expect.objectContaining({
				type: "message.failed",
				messageId: opened.replyMessageId,
				error: stopped,
			}),
			expect.objectContaining({ type: "chat.changed", chatId }),
		]);
	});

	it("cancels a waiting turn once its workflow stops waiting, and says so", async () => {
		await run(parkTurn(opened, []));
		delivered = [];

		await run(endTurn(opened, { kind: "cancelled" }));

		expect(await storedTurn()).toMatchObject({ status: "cancelled", checkpoint: null });
		expect(deliveredEvents()).toContainEqual(
			expect.objectContaining({ type: "message.completed", status: "cancelled" }),
		);
	});

	it("records nothing more for a turn that has ended", async () => {
		await run(endTurn(opened, { kind: "cancelled" }));

		await expect(run(writeReply(opened, "Too late."))).rejects.toMatchObject({
			_tag: "TurnEnded",
		});
	});

	describe("a bot with no model chosen", () => {
		const noModel = async () => {
			const [host] = await onDatabase((db) =>
				db
					.update(bot)
					.set({ model: null })
					.where(eq(bot.id, opened.run.request.botId))
					.returning({ name: bot.name }),
			);
			if (!host) throw new Error("no host");
			return userText`${UserText.unchecked(host.name)} has no model chosen, so it cannot reply. Choose one in its settings.`;
		};

		it("fails the turn it was running, saying why", async () => {
			const told = await noModel();

			expect(await runs.open(opened.run)).toMatchObject({ _tag: "NotRunnable" });
			expect(await storedTurn()).toMatchObject({ status: "failed", error: told });
			expect(deliveredEvents()).toContainEqual(
				expect.objectContaining({ type: "message.failed", error: told }),
			);
		});

		it("tells the chat why it cannot reply when it has no turn to end", async () => {
			const told = await noModel();
			const unowned = { ...opened.run, executionId: crypto.randomUUID() };

			expect(await runs.open(unowned)).toMatchObject({ _tag: "NotRunnable" });
			expect(deliveredEvents()).toContainEqual(
				expect.objectContaining({ type: "chat.notice", chatId, notice: told }),
			);
		});
	});
});

/** The keys of the blobs stored under `prefix`, read from the store's table. */
async function blobKeysUnder(prefix: BlobStore.Key) {
	const rows = await onDatabase((db) =>
		db
			.select({ key: blob.key })
			.from(blob)
			.where(like(blob.key, `${prefix}/%`)),
	);
	return rows.map(({ key }) => key);
}
