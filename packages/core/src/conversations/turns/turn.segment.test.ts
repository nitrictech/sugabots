import { tool } from "ai";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "../../database/events/bus.ts";
import type { CommittedEvent } from "../../database/events/outbox.ts";
import { EventStore } from "../../database/events/store.ts";
import { agent, message, toolCall, turn, user } from "../../database/schema.ts";
import { closeDatabase, onDatabase, onPostgres, runOnPostgres } from "../../database/testing.ts";
import { Models } from "../../providers/models/models.ts";
import { chunks, scriptedModel, streamed } from "../../providers/models/testing.ts";
import { UserMessage } from "../../user-message.ts";
import { INTERVIEW_PROMPT } from "../../workspaces/agents/interview-prompt.ts";
import { onPostgresAs } from "../../workspaces/testing.ts";
import { Chats } from "../chats/chats.ts";
import { conversationsForTests } from "../testing.ts";
import { BuiltInTools } from "../tools/built-in.ts";
import { ConnectionTools } from "../tools/connections.ts";
import { SAVE_INSTRUCTIONS_TOOL } from "../tools/save-instructions/tool.ts";
import { type PreparedTurn, TurnExecution } from "./execution.ts";
import { MAX_TURN_RUNS } from "./lifecycle.ts";
import { aChatAwaitingReply, prepareRunnable, runningTurns } from "./testing.ts";
import { runSegment } from "./turn.steps.ts";

/**
 * A turn's segment run through the real conversation services on Postgres:
 * what it leaves in the turn, its reply and its tool calls, and what it tells
 * the thread. The model, the tools and the event bus stand in for the outside.
 * `turn.steps.test.ts` covers what cannot be produced against a database.
 */
describe.skipIf(!process.env.DATABASE_URL)("a turn's segment, against Postgres", async () => {
	let delivered: CommittedEvent[] = [];
	const conversations = await conversationsForTests({
		publishCommitted: async (events) => {
			delivered.push(...events);
		},
	});
	const chatsAs = (userId: string) =>
		onPostgresAs(userId)(Context.get(conversations, Chats.Service));
	const execution = onPostgres({
		prepare: Context.get(conversations, TurnExecution.Service).prepare,
	});
	const providerDown = UserMessage.of`The model provider could not answer.`;
	let threadId: string;
	let connectionId: string;
	let hostId: string;
	let prepared: PreparedTurn;

	afterAll(async () => {
		await closeDatabase();
	});

	// Each case's turn is already prepared, so the segment opens it again for its own run.
	beforeEach(async () => {
		({ threadId, connectionId, hostId } = await aChatAwaitingReply(chatsAs));
		const [run] = await runOnPostgres(runningTurns(threadId));
		if (!run) throw new Error("no turn running");
		prepared = await prepareRunnable(execution, run);
		delivered = [];
	});

	const segmentWith = (
		model: Models.Interface,
		outside: {
			events?: EventBus.Interface;
			builtInTools?: BuiltInTools.Interface;
			connectionTools?: ConnectionTools.Interface;
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
						Layer.succeed(ConnectionTools.Service, outside.connectionTools ?? ConnectionTools.none),
					),
				),
				Effect.provideContext(conversations),
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

	it("prepares, streams and completes the reply, and tells the thread", async () => {
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
		const outcome = await segmentWith(
			Models.fromStream(() =>
				Effect.fail(new Models.RequestFailed({ message: "provider down", reason: "unavailable" })),
			),
		);

		expect(outcome).toEqual({ _tag: "Retry" });
		expect(await storedTurn()).toMatchObject({ status: "failed", error: providerDown });
		expect(deliveredEvents()).toContainEqual(
			expect.objectContaining({ type: "message.failed", willRetry: true, error: providerDown }),
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

		const outcome = await segmentWith(
			Models.fromStream(() =>
				Effect.fail(new Models.RequestFailed({ message: "provider down", reason: "unavailable" })),
			),
		);

		expect(outcome).toEqual({ _tag: "Finished" });
		expect(await storedTurn()).toMatchObject({ status: "failed", runs: MAX_TURN_RUNS });
		expect(deliveredEvents()).toContainEqual(
			expect.objectContaining({ type: "message.failed", willRetry: false }),
		);
	});

	it("fails the turn for good when the provider refused the request", async () => {
		const outcome = await segmentWith(
			Models.fromStream(() =>
				Effect.fail(
					new Models.RequestFailed({ message: "Provider returned 402", reason: "outOfCredit" }),
				),
			),
		);

		expect(outcome).toEqual({ _tag: "Finished" });
		expect(deliveredEvents()).toContainEqual(
			expect.objectContaining({ type: "message.failed", willRetry: false }),
		);
	});

	it("fails a reply the model finished without writing anything, for good", async () => {
		const outcome = await segmentWith(
			Models.fromStream(() => Effect.sync(() => streamed(chunks(" \n")))),
		);

		expect(outcome).toEqual({ _tag: "Finished" });
		expect(await storedTurn()).toMatchObject({
			status: "failed",
			error: UserMessage.of`The reply stopped before answering.`,
		});
		expect(deliveredEvents()).toContainEqual(
			expect.objectContaining({ type: "message.failed", willRetry: false }),
		);
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

		await segmentWith(model, { builtInTools: { forWorkspace: () => Effect.succeed({ probe }) } });

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

	it("parks a mutating call for approval without executing it", async () => {
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
								toolName: "wiki__wipe",
								input: {},
							},
						},
					] as never,
					responseMessages: [{ role: "assistant", content: "I need approval." }] as never,
				}),
			),
		);

		const outcome = await segmentWith(model, {
			connectionTools: {
				forPod: () =>
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
								mutating: true,
								requiresApproval: true,
								connectionId,
								connectionRevision: 1,
								remoteToolName: "wipe",
							},
						},
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
			{ tool: "wiki__wipe", approvalId: "approval-1", approvalStatus: "pending", mutating: true },
		]);
	});

	describe("a bot still on its interview", () => {
		beforeEach(async () => {
			await onDatabase((db) =>
				db.update(agent).set({ prompt: INTERVIEW_PROMPT }).where(eq(agent.id, hostId)),
			);
		});

		const storedAgent = async () => {
			const [row] = await onDatabase((db) =>
				db
					.select({ prompt: agent.prompt, description: agent.description })
					.from(agent)
					.where(eq(agent.id, hostId)),
			);
			return row;
		};

		it("saves the instructions its creator agreed to in place of the interview", async () => {
			const model = Models.fromStream((input) =>
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

			await segmentWith(model);

			expect(await storedAgent()).toEqual({
				prompt: "You triage support tickets.",
				description: "Sorts support tickets by urgency.",
			});
			expect(await storedReply()).toMatchObject({ content: 'Saved: {"saved":true}.' });
		});

		it("is not offered the tool when someone other than its creator asked", async () => {
			const [someoneElse] = await onDatabase((db) =>
				db
					.insert(user)
					.values({ name: "Kim", email: `kim-${crypto.randomUUID()}@example.com` })
					.returning({ id: user.id }),
			);
			await onDatabase((db) =>
				db.update(agent).set({ createdById: someoneElse?.id }).where(eq(agent.id, hostId)),
			);
			const offered: string[][] = [];
			const model = Models.fromStream((input) =>
				Effect.sync(() => {
					offered.push(Object.keys(input.tools ?? {}));
					return streamed(
						(async function* () {
							yield "Happy to help.";
						})(),
					);
				}),
			);

			await segmentWith(model);

			expect(offered).toEqual([expect.not.arrayContaining([SAVE_INSTRUCTIONS_TOOL])]);
			expect(await storedAgent()).toMatchObject({ prompt: INTERVIEW_PROMPT });
		});
	});
});
