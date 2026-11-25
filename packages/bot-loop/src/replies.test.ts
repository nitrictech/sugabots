import { randomUUID } from "node:crypto";
import { ModelRequests } from "@sugabots/core/accounting/model-requests";
import { startBotChat } from "@sugabots/core/chats/chats/testing";
import type { ConnectorCatalog } from "@sugabots/core/chats/tools/connector-catalog";
import { aChatWithConnectorAwaitingReply } from "@sugabots/core/chats/turns/testing";
import { Turns } from "@sugabots/core/chats/turns/turns";
import { EventBus } from "@sugabots/core/database/events/bus";
import type { CommittedEvent } from "@sugabots/core/database/events/outbox";
import { inMemoryEventStore } from "@sugabots/core/database/events/testing";
import { membership, modelRequest, turn } from "@sugabots/core/database/schema";
import { closeDatabase, onDatabase, runOnPostgres } from "@sugabots/core/database/testing";
import { asMember } from "@sugabots/core/operations/chats/testing";
import { Models } from "@sugabots/core/providers/models/models";
import { emptyRegistry, resolvedModel, streamed } from "@sugabots/core/providers/models/testing";
import { DisplayName, userText } from "@sugabots/errors";
import { eq } from "drizzle-orm";
import { Duration, Effect } from "effect";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as Steps from "./steps.ts";
import {
	botLoopOnPostgres,
	controlledClock,
	scriptedSteps,
	storedReply,
	storedTurn,
	wikiWipe,
} from "./testing.ts";

/**
 * A turn's replies through the bot loop on Postgres: one model request a
 * step, what it streams and keeps, and what becomes of the turn when a
 * request fails or runs too long. The model stands in for the provider.
 */
describe.skipIf(!process.env.DATABASE_URL)("a turn's replies, against Postgres", async () => {
	const delivered: CommittedEvent[] = [];
	let afterCommit: ((events: readonly CommittedEvent[]) => Promise<void>) | undefined;
	const loop = await botLoopOnPostgres(delivered, async (events) => afterCommit?.(events));
	const chatsAs = (memberId: string) => asMember(loop.call, memberId);
	const testProvider = {
		provider: DisplayName.fromRecord("Test provider"),
		model: DisplayName.fromRecord("test-model"),
	};
	const providerDown = new Models.ProviderServerError({
		...testProvider,
		cause: new Error("provider down"),
	});
	let chatId: string;
	let connectorId: string;
	let botId: string;
	let adminId: string;

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		({ chatId, connectorId, botId, adminId } = await aChatWithConnectorAwaitingReply(chatsAs));
		delivered.length = 0;
		afterCommit = undefined;
	});

	const deliveredEvents = () => delivered.map(({ event }) => event);

	/** The connector tool `wiki__wipe` of the connector `installedId`, with `access`, running `execute`. */
	const wiki = (
		access: "allow" | "ask" | "off",
		execute: Parameters<typeof wikiWipe>[2],
		installedId = connectorId,
	) => wikiWipe(installedId, access, execute);

	it("answers in one step: streams and completes the reply, and tells the chat", async () => {
		const events = EventBus.inProcess({ store: inMemoryEventStore() });
		const publish = vi.fn(events.publish);
		const { model, requests } = scriptedSteps({
			text: ["Example Domain", " says hello."],
			contextTokens: 12,
		});

		const ran = await loop.runTurn(chatId, { model, events: { ...events, publish } });

		expect(ran.outcomes).toEqual([{ _tag: "Finished" }]);
		expect(requests).toHaveLength(1);
		expect(await storedTurn(ran.turnId)).toMatchObject({ status: "done", contextTokens: 12 });
		expect(await storedReply(ran.turnId)).toMatchObject({
			status: "complete",
			content: "Example Domain says hello.",
		});
		expect(deliveredEvents().map(({ type }) => type)).toEqual(
			expect.arrayContaining(["turn.started", "message.completed", "turn.completed"]),
		);
		// Only the reply's deltas go straight to the bus; the rest commit first.
		expect(publish.mock.calls.map(([, event]) => event.type)).toEqual([
			"message.delta",
			"message.delta",
		]);
	});

	it("counts a provider's thinking tokens once in the turn's usage", async () => {
		const providerId = randomUUID();
		const requests = await runOnPostgres(ModelRequests.make);
		const model = Models.make({
			modelProviders: {
				resolve: () =>
					Effect.succeed(
						resolvedModel(
							{
								providerId,
								builtIn: "gemini",
								baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
								apiFormat: "openai",
								apiKey: "test",
								headers: {},
								configurationUpdatedAt: new Date(0),
							},
							["thinking"],
						),
					),
				renewOAuthTokens: () => Effect.die("Gemini has no OAuth credentials here"),
			},
			httpClients: {
				for: () => async () =>
					new Response(
						`data: ${JSON.stringify({
							candidates: [
								{
									content: {
										role: "model",
										parts: [{ text: "Check the result.", thought: true }, { text: "Done." }],
									},
									finishReason: "STOP",
								},
							],
							usageMetadata: {
								promptTokenCount: 100,
								candidatesTokenCount: 12,
								thoughtsTokenCount: 8,
								totalTokenCount: 120,
							},
						})}\n\n`,
						{ headers: { "content-type": "text/event-stream" } },
					),
			},
			requests,
			registry: { ...emptyRegistry, cost: () => ({ input: 0, output: 10 }) },
		});

		const ran = await loop.runTurn(chatId, { model });

		expect(await storedReply(ran.turnId)).toMatchObject({
			content: "Done.",
			parts: [
				{ type: "text", text: "Done." },
				{ type: "thinking", step: 0, text: "Check the result." },
			],
		});
		const ledger = await onDatabase((db) =>
			db.select().from(modelRequest).where(eq(modelRequest.turnId, ran.turnId)),
		);
		expect(ledger).toMatchObject([
			{
				outcome: "completed",
				step: 0,
				inputTokens: 100,
				outputTokens: 20,
				reasoningTokens: 8,
			},
		]);
		expect(Number(ledger[0]?.costUsd)).toBeCloseTo(0.0002, 9);
	});

	it("keeps the turn going when a reply's delta cannot be published", async () => {
		const events = EventBus.inProcess({ store: inMemoryEventStore() });
		const publish = vi.fn(events.publish);
		publish.mockRejectedValueOnce(new Error("subscriber unavailable"));

		const ran = await loop.runTurn(chatId, {
			model: scriptedSteps({ text: ["Done"] }).model,
			events: { ...events, publish },
		});

		expect(await storedTurn(ran.turnId)).toMatchObject({ status: "done" });
		expect(await storedReply(ran.turnId)).toMatchObject({ status: "complete", content: "Done" });
	});

	it("records a failed run, which the workflow runs again", async () => {
		const ran = await loop.runTurn(chatId, { model: scriptedSteps(providerDown).model });

		expect(ran.outcomes).toEqual([{ _tag: "Retry" }]);
		expect(await storedTurn(ran.turnId)).toMatchObject({
			status: "failed",
			error: providerDown.userMessage,
			retrying: true,
		});
		expect(deliveredEvents()).toContainEqual(
			expect.objectContaining({ type: "message.failed", error: providerDown.userMessage }),
		);
	});

	it("fails the turn for good when its last run fails", async () => {
		const ran = await loop.runTurn(
			chatId,
			{ model: scriptedSteps(providerDown).model },
			{
				// This run is the last one allowed.
				beforeSteps: (turnId) =>
					onDatabase((db) =>
						db.update(turn).set({ runs: Turns.MAX_TURN_RUNS }).where(eq(turn.id, turnId)),
					),
			},
		);

		expect(ran.outcomes).toEqual([{ _tag: "Finished" }]);
		expect(await storedTurn(ran.turnId)).toMatchObject({ status: "failed", retrying: false });
		expect(deliveredEvents()).toContainEqual(expect.objectContaining({ type: "message.failed" }));
	});

	it("fails the turn for good when the provider refused the request", async () => {
		const ran = await loop.runTurn(chatId, {
			model: scriptedSteps(
				new Models.ProviderQuotaExhausted({ ...testProvider, cause: new Error("402") }),
			).model,
		});

		expect(ran.outcomes).toEqual([{ _tag: "Finished" }]);
		expect(deliveredEvents()).toContainEqual(expect.objectContaining({ type: "message.failed" }));
	});

	it("fails the turn for good when the provider asks to be left too long", async () => {
		const ran = await loop.runTurn(chatId, {
			model: scriptedSteps(
				new Models.ProviderRateLimited({
					...testProvider,
					retryAfter: Duration.minutes(5),
					cause: new Error("429"),
				}),
			).model,
		});

		expect(ran.outcomes).toEqual([{ _tag: "Finished" }]);
		expect(await storedTurn(ran.turnId)).toMatchObject({ status: "failed", retrying: false });
	});

	it("fails a reply the model finished without writing anything, for good", async () => {
		const ran = await loop.runTurn(chatId, { model: scriptedSteps({ text: [" \n"] }).model });

		expect(ran.outcomes).toEqual([{ _tag: "Finished" }]);
		expect(await storedTurn(ran.turnId)).toMatchObject({
			status: "failed",
			error: userText`The reply stopped before answering.`,
		});
		expect(deliveredEvents()).toContainEqual(expect.objectContaining({ type: "message.failed" }));
	});

	describe("an optional turn, on a message in the bot's chat that mentions only members", () => {
		/** Starts another of the bot's chats with `content`, whose turn is optional. */
		const optionalTurnOn = async (content: string) => {
			const started = await startBotChat(chatsAs(adminId), {
				botId,
				messageId: crypto.randomUUID(),
				content,
			});
			delivered.length = 0;
			return started;
		};

		it.each([false, true])(
			"lets the bot stay silent and react 👀 with visible thinking set to %s",
			async (showsThinking) => {
				const started = await optionalTurnOn("@sam can you look at this?");

				const ran = await loop.runTurn(started.chat.id, {
					model: scriptedSteps({
						text: [" \n"],
						thinking: showsThinking ? ["The message asks Sam."] : [],
					}).model,
				});

				expect(ran.outcomes).toEqual([{ _tag: "Finished" }]);
				// Staying silent is an answer, not a failure.
				expect(await storedTurn(ran.turnId)).toMatchObject({ status: "done", error: null });
				expect(deliveredEvents().map(({ type }) => type)).not.toContain("message.failed");
				const details = await chatsAs(adminId).get(started.chat.id);
				expect(details.messages.map(({ author }) => author.kind)).toEqual(["member"]);
				expect(details.messages[0]?.reactions).toEqual([
					expect.objectContaining({ emoji: "👀", bots: [expect.objectContaining({ id: botId })] }),
				]);
			},
		);

		it("posts the reply as usual when the bot chooses to answer, having been told it may stay silent", async () => {
			const started = await optionalTurnOn("@sam can you look at this?");
			const { model, requests } = scriptedSteps({ text: ["I can."] });

			const ran = await loop.runTurn(started.chat.id, { model });

			expect(await storedReply(ran.turnId)).toMatchObject({
				status: "complete",
				content: "I can.",
			});
			expect(JSON.stringify(requests)).toContain("stay silent by writing nothing at all");
		});
	});

	it("ends a turn whose asker no longer reaches its chat, without asking the model", async () => {
		await onDatabase((db) => db.delete(membership).where(eq(membership.memberId, adminId)));
		const { model, requests } = scriptedSteps({ text: ["Hello."] });

		const ran = await loop.runTurn(chatId, { model });

		expect(ran.outcomes).toEqual([{ _tag: "Finished" }]);
		expect(requests).toEqual([]);
		expect(await storedTurn(ran.turnId)).toMatchObject({
			status: "failed",
			error: userText`This bot can no longer reach this chat, so it stopped.`,
		});
	});

	/** How long a turn's connector sessions are given to close before the loop gives up on them. */
	const SESSIONS_CLOSE_WAIT = Duration.seconds(2);

	it("ends a timed-out turn even when its connector sessions stall on close", async () => {
		const opened = wiki("allow", async () => ({ removed: true }));
		const closeStarted = Promise.withResolvers<void>();
		const closing = vi.fn(() => {
			closeStarted.resolve();
			return new Promise<void>(() => {});
		});
		const neverClose: ConnectorCatalog.Interface = {
			forTurn: (...args) =>
				Effect.map(opened.forTurn(...args), (tools) => ({ ...tools, close: closing })),
		};
		const requested = Promise.withResolvers<void>();
		// A model that never answers.
		const model = Models.fromStream(() =>
			Effect.sync(() => {
				requested.resolve();
				return streamed(
					(async function* () {
						yield* [];
						await new Promise(() => {});
					})(),
				);
			}),
		);
		const time = await controlledClock();
		const ran = loop.runTurn(chatId, { model, connectorTools: neverClose }, { clock: time.clock });

		// The step's deadline is set as it starts, before its model request.
		await requested.promise;
		expect(await time.waiting(1)).toContain(Duration.toMillis(Steps.timing.stepTimeout));
		await time.adjust(Steps.timing.stepTimeout);
		await closeStarted.promise;
		expect(await time.waiting(1)).toEqual([Duration.toMillis(SESSIONS_CLOSE_WAIT)]);
		await time.adjust(SESSIONS_CLOSE_WAIT);
		const { outcomes, turnId } = await ran;

		expect(closing).toHaveBeenCalledOnce();
		expect(outcomes).toEqual([{ _tag: "Retry" }]);
		expect(await storedTurn(turnId)).toMatchObject({
			status: "failed",
			error: userText`The reply took too long and was stopped.`,
		});
	});
});
