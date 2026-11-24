import { DisplayName, userText } from "@sugabots/errors";
import { tool } from "ai";
import { eq } from "drizzle-orm";
import { Context, Duration, Effect, Layer, Schema } from "effect";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "../../database/events/bus.ts";
import type { CommittedEvent } from "../../database/events/outbox.ts";
import { EventStore } from "../../database/events/store.ts";
import {
	bot,
	membership,
	message,
	messageReaction,
	toolCall,
	turn,
	workspace,
} from "../../database/schema.ts";
import { closeDatabase, onDatabase, onPostgres, runOnPostgres } from "../../database/testing.ts";
import { Models } from "../../providers/models/models.ts";
import { chunks, scriptedModel, streamed } from "../../providers/models/testing.ts";
import { INTERVIEW_PROMPT } from "../../workspaces/bots/interview-prompt.ts";
import { onPostgresAs } from "../../workspaces/testing.ts";
import { Chats } from "../chats/chats.ts";
import { startBotChat } from "../chats/testing.ts";
import { chatServicesForTests } from "../testing.ts";
import { BuiltInTools } from "../tools/built-in.ts";
import { ComputerTools } from "../tools/computer.ts";
import { ConnectorTools } from "../tools/connectors.ts";
import { SAVE_INSTRUCTIONS_TOOL } from "../tools/save-instructions/tool.ts";
import { CALL_TOOL } from "../tools/tool-search/tool.ts";
import { type PreparedTurn, TurnExecution } from "./execution.ts";
import { MAX_TURN_RUNS } from "./lifecycle.ts";
import { aChatAwaitingReply, prepareRunnable, runningTurns } from "./testing.ts";
import { runSegment } from "./turn.steps.ts";

/**
 * A turn's segment run through the real chat services on Postgres:
 * what it leaves in the turn, its reply and its tool calls, and what it tells
 * the chat. The model, the tools and the event bus stand in for the outside.
 * `turn.steps.test.ts` covers what cannot be produced against a database.
 */
describe.skipIf(!process.env.DATABASE_URL)("a turn's segment, against Postgres", async () => {
	let delivered: CommittedEvent[] = [];
	const services = await chatServicesForTests({
		publishCommitted: async (events) => {
			delivered.push(...events);
		},
	});
	const chatsAs = (memberId: string) =>
		onPostgresAs(memberId)(Context.get(services, Chats.Service));
	const execution = onPostgres({
		prepare: Context.get(services, TurnExecution.Service).prepare,
	});
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
	let prepared: PreparedTurn;

	afterAll(async () => {
		await closeDatabase();
	});

	// Each case's turn is already prepared, so the segment opens it again for its own run.
	beforeEach(async () => {
		({ chatId, connectorId, botId, adminId } = await aChatAwaitingReply(chatsAs));
		const [run] = await runOnPostgres(runningTurns(chatId));
		if (!run) throw new Error("no turn running");
		prepared = await prepareRunnable(execution, run);
		delivered = [];
	});

	const segmentWith = (
		model: Models.Interface,
		outside: {
			events?: EventBus.Interface;
			builtInTools?: BuiltInTools.Interface;
			connectorTools?: ConnectorTools.Interface;
		} = {},
	) =>
		runOnPostgres(
			runSegment(prepared.run).pipe(
				Effect.provide(
					Layer.mergeAll(
						Layer.succeed(Models.Service, model),
						Layer.succeed(
							EventBus.Service,
							outside.events ?? EventBus.inProcess({ store: EventStore.inMemory() }),
						),
						Layer.succeed(BuiltInTools.Service, outside.builtInTools ?? BuiltInTools.none),
						Layer.succeed(ComputerTools.Service, ComputerTools.none),
						Layer.succeed(ConnectorTools.Service, outside.connectorTools ?? ConnectorTools.none),
					),
				),
				Effect.provideContext(services),
			),
		);

	const storedTurn = async () => {
		const [row] = await onDatabase((db) =>
			db.select().from(turn).where(eq(turn.id, prepared.turnId)),
		);
		return row;
	};

	const storedReply = async () => {
		const [row] = await onDatabase((db) =>
			db.select().from(message).where(eq(message.id, prepared.responseMessage.id)),
		);
		return row;
	};

	const deliveredEvents = () => delivered.map(({ event }) => event);

	it("prepares, streams and completes the reply, and tells the chat", async () => {
		const events = EventBus.inProcess({ store: EventStore.inMemory() });
		const publish = vi.fn(events.publish);
		const outcome = await segmentWith(
			Models.fromStream(() =>
				Effect.sync(() =>
					streamed(chunks("Example Domain", " says hello."), { contextTokens: 12 }),
				),
			),
			{ events: { ...events, publish } },
		);

		expect(outcome).toEqual({ _tag: "Finished" });
		expect(await storedTurn()).toMatchObject({ status: "done", contextTokens: 12 });
		expect(await storedReply()).toMatchObject({
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

	it("keeps the turn going when a reply's delta cannot be published", async () => {
		const events = EventBus.inProcess({ store: EventStore.inMemory() });
		const publish = vi.fn(events.publish);
		publish.mockRejectedValueOnce(new Error("subscriber unavailable"));

		await segmentWith(scriptedModel("Done"), { events: { ...events, publish } });

		expect(await storedTurn()).toMatchObject({ status: "done" });
		expect(await storedReply()).toMatchObject({ status: "complete", content: "Done" });
	});

	it("records a failed run, which the workflow runs again", async () => {
		const outcome = await segmentWith(Models.fromStream(() => Effect.fail(providerDown)));

		expect(outcome).toEqual({ _tag: "Retry" });
		expect(await storedTurn()).toMatchObject({ status: "failed", error: providerDown.userMessage });
		expect(deliveredEvents()).toContainEqual(
			expect.objectContaining({
				type: "message.failed",
				error: providerDown.userMessage,
			}),
		);
	});

	it("fails the turn for good when its last run fails", async () => {
		// The segment's own run is the last one allowed.
		await onDatabase((db) =>
			db
				.update(turn)
				.set({ runs: MAX_TURN_RUNS - 1 })
				.where(eq(turn.id, prepared.turnId)),
		);

		const outcome = await segmentWith(Models.fromStream(() => Effect.fail(providerDown)));

		expect(outcome).toEqual({ _tag: "Finished" });
		expect(await storedTurn()).toMatchObject({ status: "failed", runs: MAX_TURN_RUNS });
		expect(deliveredEvents()).toContainEqual(expect.objectContaining({ type: "message.failed" }));
	});

	it("fails the turn for good when the provider refused the request", async () => {
		const outcome = await segmentWith(
			Models.fromStream(() =>
				Effect.fail(
					new Models.ProviderQuotaExhausted({ ...testProvider, cause: new Error("402") }),
				),
			),
		);

		expect(outcome).toEqual({ _tag: "Finished" });
		expect(deliveredEvents()).toContainEqual(expect.objectContaining({ type: "message.failed" }));
	});

	it("fails the turn for good when the provider asks to be left too long", async () => {
		const outcome = await segmentWith(
			Models.fromStream(() =>
				Effect.fail(
					new Models.ProviderRateLimited({
						...testProvider,
						retryAfter: Duration.minutes(5),
						cause: new Error("429"),
					}),
				),
			),
		);

		expect(outcome).toEqual({ _tag: "Finished" });
		expect(deliveredEvents()).toContainEqual(expect.objectContaining({ type: "message.failed" }));
	});

	it("fails a reply the model finished without writing anything, for good", async () => {
		const outcome = await segmentWith(
			Models.fromStream(() => Effect.sync(() => streamed(chunks(" \n")))),
		);

		expect(outcome).toEqual({ _tag: "Finished" });
		expect(await storedTurn()).toMatchObject({
			status: "failed",
			error: userText`The reply stopped before answering.`,
		});
		expect(deliveredEvents()).toContainEqual(expect.objectContaining({ type: "message.failed" }));
	});

	describe("an optional turn, on a message in the bot's chat that mentions only members", () => {
		/** Starts another of the bot's chats with `content`, and prepares the turn it asks for. */
		const optionalTurnOn = async (content: string) => {
			const started = await startBotChat(chatsAs(adminId), {
				botId,
				messageId: crypto.randomUUID(),
				content,
			});
			const [run] = await runOnPostgres(runningTurns(started.chat.id));
			if (!run) throw new Error("no turn running");
			expect(run.request.reason).toBe("optional");
			prepared = await prepareRunnable(execution, run);
			delivered = [];
			return started.message;
		};

		it("lets the bot stay silent: no reply, a 👀 on the message it read, and the turn done", async () => {
			const read = await optionalTurnOn("@sam can you look at this?");

			const outcome = await segmentWith(
				Models.fromStream(() => Effect.sync(() => streamed(chunks(" \n")))),
			);

			expect(outcome).toEqual({ _tag: "Finished" });
			expect(await storedTurn()).toMatchObject({ status: "done", reason: "optional" });
			expect(await storedReply()).toBeUndefined();
			const reactions = await onDatabase((db) =>
				db.select().from(messageReaction).where(eq(messageReaction.messageId, read.id)),
			);
			expect(reactions).toEqual([expect.objectContaining({ botId, memberId: null, emoji: "👀" })]);
			expect(deliveredEvents()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ type: "turn.completed" }),
					expect.objectContaining({
						type: "message.reactions_changed",
						messageId: read.id,
						reactions: [
							{
								emoji: "👀",
								members: [],
								bots: [expect.objectContaining({ id: botId })],
							},
						],
					}),
				]),
			);
			expect(deliveredEvents()).not.toContainEqual(
				expect.objectContaining({ type: "message.failed" }),
			);
		});

		it("posts the reply as usual when the bot chooses to answer", async () => {
			const read = await optionalTurnOn("@sam can you look at this?");

			await segmentWith(Models.fromStream(() => Effect.sync(() => streamed(chunks("I can.")))));

			expect(await storedTurn()).toMatchObject({ status: "done" });
			expect(await storedReply()).toMatchObject({ status: "complete", content: "I can." });
			expect(
				await onDatabase((db) =>
					db.select().from(messageReaction).where(eq(messageReaction.messageId, read.id)),
				),
			).toEqual([]);
		});

		it("tells the bot it may stay silent", async () => {
			await optionalTurnOn("@sam can you look at this?");
			const asked = vi.fn(() => Effect.sync(() => streamed(chunks("I can."))));

			await segmentWith(Models.fromStream(asked));

			expect(JSON.stringify(asked.mock.calls)).toContain("stay silent by writing nothing at all");
		});
	});

	// Recording runs outside Effect, in the SDK's callback; with the real
	// repositories it fails unless the turn's services reach it.
	it("records a built-in tool's call where the reply made it", async () => {
		const probe = tool({
			description: "A tool that answers",
			inputSchema: Schema.Struct({ q: Schema.String }).pipe(
				Schema.toStandardSchemaV1,
				Schema.toStandardJSONSchemaV1,
			),
			execute: async ({ q }) => ({ answer: `${q}!` }),
		});
		// Stands in for the SDK: says a few words, calls the tool as the SDK
		// would, and carries on.
		const model = Models.fromStream((input) =>
			Effect.sync(() =>
				streamed(
					(async function* () {
						yield "Looking. ";
						const output = await input.tools?.probe?.execute?.(
							{ q: "hi" } as never,
							{ toolCallId: "sdk-1", messages: [] } as never,
						);
						yield `Found ${JSON.stringify(output)}.`;
					})(),
				),
			),
		);

		await segmentWith(model, {
			builtInTools: { forWorkspace: () => Effect.succeed({ tools: { probe }, usable: ["probe"] }) },
		});

		const calls = await onDatabase((db) =>
			db.select().from(toolCall).where(eq(toolCall.turnId, prepared.turnId)),
		);
		expect(calls).toMatchObject([
			{
				tool: "probe",
				input: { q: "hi" },
				output: { answer: "hi!" },
				status: "completed",
				atOffset: "Looking. ".length,
				messageId: prepared.responseMessage.id,
			},
		]);
		expect(await storedReply()).toMatchObject({
			status: "complete",
			content: 'Looking. Found {"answer":"hi!"}.',
		});
	});

	it("parks a write/delete tool call for approval without executing it", async () => {
		const execute = vi.fn(async () => ({ removed: true }));
		const model = Models.fromStream(() =>
			Effect.succeed(
				streamed(chunks("I need approval."), {
					approvalRequests: [
						{
							type: "tool-approval-request",
							approvalId: "approval-1",
							toolCall: {
								type: "tool-call",
								toolCallId: "sdk-1",
								toolName: CALL_TOOL,
								input: { tool: "wiki__wipe", arguments: {} },
							},
						},
					] as never,
					responseMessages: [{ role: "assistant", content: "I need approval." }] as never,
				}),
			),
		);

		const outcome = await segmentWith(model, {
			connectorTools: {
				forTurn: () =>
					Effect.succeed({
						tools: {
							wiki__wipe: {
								tool: tool({
									inputSchema: Schema.Struct({}).pipe(
										Schema.toStandardSchemaV1,
										Schema.toStandardJSONSchemaV1,
									),
									execute,
								}),
								writeOrDelete: true,
								access: "ask",
								connectorId,
								handle: "wiki",
								description: "",
								inputSchema: { type: "object" as const },
								connectorRevision: 1,
								remoteToolName: "wipe",
							},
						},
						unavailable: [],
						signInExpired: [],
						instructions: {},
						addable: [],
						fromProjectAndBot: false,
						close: async () => undefined,
					}),
			},
		});

		expect(outcome).toEqual({ _tag: "Suspended", approvals: ["approval-1"] });
		expect(execute).not.toHaveBeenCalled();
		expect(await storedTurn()).toMatchObject({ status: "waiting" });
		expect((await storedTurn())?.checkpoint).not.toBeNull();
		const calls = await onDatabase((db) =>
			db.select().from(toolCall).where(eq(toolCall.turnId, prepared.turnId)),
		);
		expect(calls).toMatchObject([
			{
				tool: "wiki__wipe",
				approvalId: "approval-1",
				approvalStatus: "pending",
				writeOrDelete: true,
			},
		]);
	});

	it("ends rather than starts again a turn whose server died after an allowed write/delete tool call ran", async () => {
		const execute = vi.fn(async () => ({ removed: true }));
		let reopened: Awaited<ReturnType<typeof execution.prepare>> | undefined;
		// The model calls the tool, which finishes; then, while the reply is
		// still being written, the server dies and another one picks the turn up.
		const model = Models.fromStream((input) =>
			Effect.sync(() =>
				streamed(
					(async function* () {
						yield "Wiping. ";
						await input.tools?.[CALL_TOOL]?.execute?.(
							{ tool: "wiki__wipe", arguments: {} } as never,
							{ toolCallId: "sdk-1", messages: [] } as never,
						);
						reopened = await execution.prepare(prepared.run);
						yield "Done.";
					})(),
				),
			),
		);

		await segmentWith(model, {
			connectorTools: {
				forTurn: () =>
					Effect.succeed({
						tools: {
							wiki__wipe: {
								tool: tool({
									inputSchema: Schema.Struct({}).pipe(
										Schema.toStandardSchemaV1,
										Schema.toStandardJSONSchemaV1,
									),
									execute,
								}),
								writeOrDelete: true,
								access: "allow",
								connectorId,
								handle: "wiki",
								description: "",
								inputSchema: { type: "object" as const },
								connectorRevision: 1,
								remoteToolName: "wipe",
							},
						},
						unavailable: [],
						signInExpired: [],
						instructions: {},
						addable: [],
						fromProjectAndBot: false,
						close: async () => undefined,
					}),
			},
		});

		expect(execute).toHaveBeenCalledOnce();
		expect(reopened).toMatchObject({ _tag: "NotRunnable", ended: { state: "failed" } });
		expect(await storedTurn()).toMatchObject({
			status: "failed",
			error: expect.stringContaining("may have run"),
		});
	});

	describe("saving its own instructions", () => {
		beforeEach(async () => {
			await onDatabase((db) =>
				db.update(bot).set({ instructions: INTERVIEW_PROMPT }).where(eq(bot.id, botId)),
			);
		});

		const storedBot = async () => {
			const [row] = await onDatabase((db) =>
				db
					.select({ instructions: bot.instructions, description: bot.description })
					.from(bot)
					.where(eq(bot.id, botId)),
			);
			return row;
		};

		const savingInstructions = () =>
			Models.fromStream((input) =>
				Effect.sync(() =>
					streamed(
						(async function* () {
							const output = await input.tools?.[SAVE_INSTRUCTIONS_TOOL]?.execute?.(
								{
									instructions: "You triage support tickets.",
									description: "Sorts support tickets by urgency.",
								} as never,
								{ toolCallId: "sdk-1", messages: [] } as never,
							);
							yield `Saved: ${JSON.stringify(output)}.`;
						})(),
					),
				),
			);

		it("saves its instructions as the member it answers, and links to them", async () => {
			await segmentWith(savingInstructions());

			expect(await storedBot()).toEqual({
				instructions: "You triage support tickets.",
				description: "Sorts support tickets by urgency.",
			});
			const [place] = await onDatabase((db) =>
				db
					.select({ workspace: workspace.slug, handle: bot.handle })
					.from(bot)
					.innerJoin(workspace, eq(workspace.id, bot.workspaceId))
					.where(eq(bot.id, botId)),
			);
			const settingsUrl = `http://sugabots.test/${place?.workspace}/bots/${place?.handle}/settings`;
			expect(await storedReply()).toMatchObject({
				content: `Saved: ${JSON.stringify({ saved: true, settingsUrl })}.`,
			});
		});

		it("refuses a member who may not edit the bot", async () => {
			await onDatabase((db) =>
				db
					.update(membership)
					.set({ role: "viewer" })
					.where(eq(membership.workspaceId, prepared.context.chat.workspaceId)),
			);

			await segmentWith(savingInstructions());

			expect(await storedBot()).toMatchObject({ instructions: INTERVIEW_PROMPT });
			expect(await storedReply()).toMatchObject({
				content: expect.stringContaining('"refused"'),
			});
		});

		it("saves new instructions straight away once the bot is set up", async () => {
			await onDatabase((db) =>
				db
					.update(bot)
					.set({ instructions: "You answer billing questions." })
					.where(eq(bot.id, botId)),
			);

			await segmentWith(savingInstructions());

			expect(await storedBot()).toEqual({
				instructions: "You triage support tickets.",
				description: "Sorts support tickets by urgency.",
			});
		});
	});
});
