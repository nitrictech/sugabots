import { eq } from "drizzle-orm";
import { Context } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { CommittedEvent } from "../../database/events/outbox.ts";
import { agent, turn } from "../../database/schema.ts";
import { closeDatabase, onDatabase, onPostgres, runOnPostgres } from "../../database/testing.ts";
import { UserMessage } from "../../user-message.ts";
import { onPostgresAs } from "../../workspaces/testing.ts";
import { Chats } from "../chats/chats.ts";
import { conversationsForTests } from "../testing.ts";
import { type PreparedTurn, replyTurnOf, TurnExecution } from "./execution.ts";
import { MAX_TURN_RUNS } from "./lifecycle.ts";
import { type TurnCheckpoint, TurnRepository } from "./repository.ts";
import { aChatAwaitingReply, prepareRunnable, runningTurns } from "./testing.ts";
import { ToolCallRepository } from "./tool-calls/repository.ts";

/**
 * Turns against Postgres: how a turn opens again for another run, gives up,
 * parks for approvals and ends, as the repository writes and announces it.
 */
describe.skipIf(!process.env.DATABASE_URL)("turns, against Postgres", async () => {
	let delivered: CommittedEvent[] = [];
	const conversations = await conversationsForTests({
		publishCommitted: async (events) => {
			delivered.push(...events);
		},
	});
	const turns = onPostgres(Context.get(conversations, TurnRepository.Service));
	const calls = onPostgres(Context.get(conversations, ToolCallRepository.Service));
	const chatsAs = (userId: string) =>
		onPostgresAs(userId)(Context.get(conversations, Chats.Service));
	const execution = onPostgres({
		prepare: Context.get(conversations, TurnExecution.Service).prepare,
	});
	const emptyReply = { content: "", collaborations: [], toolCalls: [] };
	const providerDown = UserMessage.of`The model provider could not answer.`;
	let threadId: string;
	let prepared: PreparedTurn;

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		({ threadId } = await aChatAwaitingReply(chatsAs));
		const [run] = await runOnPostgres(runningTurns(threadId));
		if (!run) throw new Error("no turn running");
		prepared = await prepareRunnable(execution, run);
		delivered = [];
	});

	const storedTurn = async () => {
		const [row] = await onDatabase((db) =>
			db.select().from(turn).where(eq(turn.id, prepared.turnId)),
		);
		return row;
	};

	const deliveredEvents = () => delivered.map(({ event }) => event);

	const checkpoint = (): TurnCheckpoint => ({
		messages: [{ role: "assistant", content: "I need approval." }],
		approvals: [],
		modelInput: { model: "test", system: "test", messages: [{ role: "user", content: "Go" }] },
		reply: { content: "Waiting.", collaborations: [], toolCalls: [] },
		modelCalls: 1,
		connectionToolMode: "direct",
	});

	it("runs a failed turn again, starting its reply over, while no change stands in the way", async () => {
		expect(
			await turns.fail(replyTurnOf(prepared), emptyReply, {
				userMessage: providerDown,
				mayRunAgain: true,
			}),
		).toBe(true);

		const second = await prepareRunnable(execution, prepared.run);

		expect(second.turnId).toBe(prepared.turnId);
		expect(second.responseMessage).toMatchObject({
			id: prepared.responseMessage.id,
			status: "streaming",
		});
		expect(await storedTurn()).toMatchObject({ status: "running", runs: 2, error: null });
		// Running again could act again, so the turn stops here for a person.
		expect(
			await turns.fail(
				replyTurnOf(second),
				{ ...emptyReply, acted: true },
				{
					userMessage: providerDown,
					mayRunAgain: true,
				},
			),
		).toBe(false);
	});

	it("does not run a failed turn again when its failure rules that out", async () => {
		const told = UserMessage.of`The reply stopped before answering.`;

		expect(
			await turns.fail(replyTurnOf(prepared), emptyReply, {
				userMessage: told,
				mayRunAgain: false,
			}),
		).toBe(false);

		expect(await storedTurn()).toMatchObject({ status: "failed" });
		expect(deliveredEvents()).toContainEqual(
			expect.objectContaining({ type: "message.failed", willRetry: false, error: told }),
		);
	});

	it("gives up on a turn that keeps stopping before it gets anywhere", async () => {
		await onDatabase((db) =>
			db.update(turn).set({ runs: MAX_TURN_RUNS }).where(eq(turn.id, prepared.turnId)),
		);

		expect(await execution.prepare(prepared.run)).toMatchObject({
			_tag: "NotRunnable",
			ended: { state: "failed" },
		});
		expect(await storedTurn()).toMatchObject({ status: "failed" });
		expect(deliveredEvents()).toContainEqual(
			expect.objectContaining({ type: "message.failed", messageId: prepared.responseMessage.id }),
		);
	});

	it("counts a turn's runs again from its last stop for approvals", async () => {
		expect((await storedTurn())?.runs).toBe(1);

		expect(await turns.suspend(replyTurnOf(prepared), checkpoint(), [])).toBe(true);

		expect(await storedTurn()).toMatchObject({ status: "waiting", runs: 0 });
	});

	it("resumes a checkpointed turn left running by a stopped server from its checkpoint", async () => {
		const saved = checkpoint();
		await turns.suspend(replyTurnOf(prepared), saved, []);
		await onDatabase((db) =>
			db.update(turn).set({ status: "running" }).where(eq(turn.id, prepared.turnId)),
		);

		const resumed = await prepareRunnable(execution, prepared.run);

		expect(resumed.turnId).toBe(prepared.turnId);
		expect(resumed.checkpoint).toEqual(saved);
	});

	it("ends a turn whose checkpoint cannot be read rather than resuming it", async () => {
		await turns.suspend(replyTurnOf(prepared), checkpoint(), []);
		await onDatabase((db) =>
			db
				.update(turn)
				.set({ checkpoint: { messages: "not a transcript" } })
				.where(eq(turn.id, prepared.turnId)),
		);

		await expect(execution.prepare(prepared.run)).rejects.toThrow();
	});

	it("ends a turn somebody asked to stop instead of opening it again after a crash", async () => {
		await onDatabase((db) =>
			db.update(turn).set({ cancelRequested: true }).where(eq(turn.id, prepared.turnId)),
		);

		expect(await execution.prepare(prepared.run)).toMatchObject({
			_tag: "NotRunnable",
			ended: { state: "cancelled" },
		});
		expect(await storedTurn()).toMatchObject({ status: "cancelled", checkpoint: null });
		expect(deliveredEvents()).toContainEqual(
			expect.objectContaining({
				type: "message.completed",
				messageId: prepared.responseMessage.id,
				status: "cancelled",
			}),
		);
	});

	it("tells the thread that a turn its workflow gave up on failed, calls and all", async () => {
		const opened = await calls.open({
			threadId,
			messageId: prepared.responseMessage.id,
			turnId: prepared.turnId,
			tool: "web_fetch",
			input: { url: "https://example.com" },
			atOffset: 0,
		});
		delivered = [];
		const stopped = UserMessage.of`The reply stopped unexpectedly.`;

		expect(
			await turns.abandon(prepared.run.executionId, { status: "failed", userMessage: stopped }),
		).toEqual({ state: "failed", error: stopped });

		expect(deliveredEvents()).toEqual([
			expect.objectContaining({
				type: "tool_call.completed",
				toolCall: expect.objectContaining({ id: opened.id, status: "failed" }),
			}),
			expect.objectContaining({
				type: "message.failed",
				messageId: prepared.responseMessage.id,
				willRetry: false,
				error: "The reply stopped unexpectedly.",
			}),
			expect.objectContaining({ type: "thread.changed", threadId }),
		]);
	});

	it("records a waiting turn as cancelled once its workflow stops waiting, and says so", async () => {
		await turns.suspend(replyTurnOf(prepared), checkpoint(), []);
		delivered = [];

		await turns.cancelWaiting(prepared.run.request);

		expect(await storedTurn()).toMatchObject({ status: "cancelled", checkpoint: null });
		expect(deliveredEvents()).toContainEqual(
			expect.objectContaining({ type: "turn.completed", status: "cancelled" }),
		);
	});

	describe("an agent with no model chosen", () => {
		const noModel = async () => {
			const [host] = await onDatabase((db) =>
				db
					.update(agent)
					.set({ model: null })
					.where(eq(agent.id, prepared.run.request.agentId))
					.returning({ name: agent.name }),
			);
			if (!host) throw new Error("no host");
			return UserMessage.of`${UserMessage.unchecked(host.name)} has no model chosen, so it cannot reply. Choose one in its settings.`;
		};

		it("fails the turn it was running, saying why", async () => {
			const told = await noModel();

			expect(await execution.prepare(prepared.run)).toMatchObject({ _tag: "NotRunnable" });
			expect(await storedTurn()).toMatchObject({ status: "failed", error: told });
			expect(deliveredEvents()).toContainEqual(
				expect.objectContaining({ type: "message.failed", willRetry: false, error: told }),
			);
		});

		it("tells the thread why it cannot reply when it has no turn to end", async () => {
			const told = await noModel();
			const unowned = { ...prepared.run, executionId: crypto.randomUUID() };

			expect(await execution.prepare(unowned)).toMatchObject({ _tag: "NotRunnable" });
			expect(deliveredEvents()).toContainEqual(
				expect.objectContaining({ type: "thread.notice", threadId, notice: told }),
			);
		});
	});
});
