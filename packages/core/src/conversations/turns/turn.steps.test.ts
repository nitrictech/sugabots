import { streamEvent, threadChannel } from "@sugabots/contracts";
import { tool } from "ai";
import { Context, Effect, ManagedRuntime, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { effectRunner, type RunEffect } from "../../database/database.ts";
import { createEventBus, type EventBus } from "../../database/events/bus.ts";
import { memoryEventStore } from "../../database/events/store.ts";
import { noDatabase } from "../../database/testing.ts";
import {
	noToolApprovalStore,
	ToolApprovalsIncomplete,
	ToolExecutionRefused,
} from "../tools/approvals/store.ts";
import { noBuiltInTools } from "../tools/built-in.ts";
import type { CollaborationStore } from "../tools/collaborate/store.ts";
import { noConnectionTools } from "../tools/connections.ts";
import { type PreparedTurn, replyTurnOf, type TurnRun } from "./execution.ts";
import { ModelRequestFailed, type TurnModel, type TurnModelInput } from "./model.ts";
import type { NotRunnable } from "./repository.ts";
import { runSegment, type TurnStepsDependencies } from "./turn.steps.ts";

/**
 * The repositories and models in these cases are fakes that never query, so
 * the database they run against is one nothing reaches. `repository.test.ts`
 * runs a segment against the real ones.
 */
const runWithServices: RunEffect = effectRunner(ManagedRuntime.make(noDatabase));

const run: TurnRun = {
	executionId: "0199a3a0-0000-7000-8000-000000000010",
	request: {
		threadId: "0199a3a0-0000-7000-8000-000000000001",
		agentId: "0199a3a0-0000-7000-8000-000000000003",
		triggerMessageId: "0199a3a0-0000-7000-8000-000000000006",
		reason: "default",
	},
};

const prepared: PreparedTurn = {
	_tag: "Prepared",
	run,
	turnId: "0199a3a0-0000-7000-8000-000000000011",
	responseMessage: {
		id: "0199a3a0-0000-7000-8000-000000000012",
		threadId: run.request.threadId,
		author: {
			kind: "agent",
			id: run.request.agentId,
			name: "Host Agent",
			handle: "host-agent",
			color: "green",
			face: "pill",
		},
		kind: "text",
		status: "streaming",
		parts: [],
		content: "",
		createdAt: "2026-09-10T04:00:00.000Z",
	},
	context: {
		thread: {
			id: run.request.threadId,
			workspaceId: "0199a3a0-0000-7000-8000-000000000002",
			title: "Check the release",
			parentThreadId: null,
		},
		agent: {
			id: run.request.agentId,
			podId: "0199a3a0-0000-7000-8000-000000000004",
			name: "Host Agent",
			handle: "host-agent",
			model: "claude-sonnet-4-20250514",
			prompt: "",
			disabledTools: [],
		},
		reason: "default",
		routing: { facilitator: false },
		podName: "Release",
		workspaceName: "Suga",
		crew: [],
		participants: [],
		messages: [],
	},
};

/** Where the prepared turn's outcome is recorded. */
const replyTurn = replyTurnOf(prepared);

/** A reply draft with no collaborations or tool calls, which is most replies in these cases. */
const reply = (content: string) => ({ content, collaborations: [], toolCalls: [] });

describe("runSegment", () => {
	it("persists a streamed reply and publishes only ephemeral deltas", async () => {
		const { execution, turns } = fakes();
		const queueSummary = vi.fn(noSummary);
		const events = eventBus();
		const model: TurnModel = {
			stream: () =>
				Effect.sync(() => ({
					text: chunks("Release", " checked"),
					accounting: Effect.succeed({
						usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
						reportedCost: 0.001,
					}),
				})),
		};

		await runWithServices(
			runSegment(
				run,
				dependencies({
					execution,
					turns,
					model,
					events,
					collaborations: collaborations(),
					toolCalls: toolCalls(),
					requests: { queueSummary },
				}),
			),
		);

		expect(turns.complete).toHaveBeenCalledWith(replyTurn, reply("Release checked"), {
			usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
			reportedCost: 0.001,
		});
		expect(turns.fail).not.toHaveBeenCalled();
		expect(queueSummary).toHaveBeenCalledWith({
			threadId: prepared.context.thread.id,
			agentId: prepared.context.agent.id,
			sourceMessageId: prepared.responseMessage.id,
		});
		expect(eventTypes(events)).toEqual(["message.delta", "message.delta"]);
	});

	it("records a built-in tool's call where the reply made it", async () => {
		const { execution, turns } = fakes();
		const calls = toolCalls();
		const toolContext = Context.Reference("test/turn-tool-context", {
			defaultValue: () => "missing",
		});
		const openCall = toolCalls().open;
		vi.mocked(calls.open).mockImplementation((input) =>
			Effect.gen(function* () {
				expect(yield* toolContext).toBe("turn-context");
				return yield* openCall(input);
			}),
		);
		vi.mocked(turns.saveReply).mockImplementation(() =>
			Effect.gen(function* () {
				expect(yield* toolContext).toBe("turn-context");
			}),
		);
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
		const model: TurnModel = {
			stream: (input: TurnModelInput) =>
				Effect.sync(() => ({
					text: (async function* () {
						yield "Looking. ";
						const output = await input.tools?.probe?.execute?.(
							{ q: "hi" } as never,
							{ toolCallId: "sdk-1", messages: [] } as never,
						);
						yield `Found ${JSON.stringify(output)}.`;
					})(),
					accounting: Effect.succeed({ usage: {} }),
				})),
		};

		await runWithServices(
			runSegment(
				run,
				dependencies({
					execution,
					turns,
					model,
					events: eventBus(),
					collaborations: collaborations(),
					toolCalls: calls,
					requests: { queueSummary: noSummary },
					builtInTools: { forWorkspace: () => Effect.succeed({ probe }) },
				}),
			).pipe(Effect.provideService(toolContext, "turn-context")),
		);

		expect(calls.open).toHaveBeenCalledWith({
			threadId: run.request.threadId,
			messageId: prepared.responseMessage.id,
			turnId: prepared.turnId,
			tool: "probe",
			input: { q: "hi" },
			atOffset: "Looking. ".length,
			mutating: false,
		});
		expect(calls.close).toHaveBeenCalledWith("0199a3a0-0000-7000-8000-0000000000aa", {
			output: { answer: "hi!" },
		});
		expect(turns.complete).toHaveBeenCalledWith(
			replyTurn,
			{
				content: 'Looking. Found {"answer":"hi!"}.',
				collaborations: [],
				toolCalls: [{ id: "0199a3a0-0000-7000-8000-0000000000aa", atOffset: "Looking. ".length }],
			},
			{ usage: {} },
		);
	});

	it("offers a connection's tools for the turn, notes when an allowed one acted, and closes the session after", async () => {
		const { execution, turns } = fakes();
		const calls = toolCalls();
		const close = vi.fn(async () => undefined);
		const wipe = tool({
			inputSchema: Schema.Struct({}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
			execute: async () => ({ content: [] }),
		});
		const model: TurnModel = {
			stream: (input: TurnModelInput) =>
				Effect.sync(() => ({
					text: (async function* () {
						yield "Clearing. ";
						await input.tools?.wiki__wipe?.execute?.(
							{} as never,
							{
								toolCallId: "sdk-1",
								messages: [],
							} as never,
						);
						yield "Done.";
					})(),
					accounting: Effect.succeed({ usage: {} }),
				})),
		};

		await runWithServices(
			runSegment(
				run,
				dependencies({
					execution,
					turns,
					model,
					events: eventBus(),
					collaborations: collaborations(),
					toolCalls: calls,
					requests: { queueSummary: noSummary },
					connectionTools: {
						forPod: () =>
							Effect.succeed({
								tools: {
									wiki__wipe: {
										tool: wipe,
										mutating: true,
										requiresApproval: true,
										connectionId: "0199a3a0-0000-7000-8000-0000000000cc",
										connectionRevision: 1,
										remoteToolName: "wipe",
									},
								},
								close,
							}),
					},
					approvals: {
						responsesForTurn: () => Effect.fail(new ToolApprovalsIncomplete({ message: "unused" })),
						beginExecution: ({ atOffset }) =>
							calls.open({
								threadId: prepared.context.thread.id,
								messageId: prepared.responseMessage.id,
								turnId: prepared.turnId,
								tool: "wiki__wipe",
								input: {},
								atOffset,
								mutating: true,
							}),
						decide: () => Effect.die(new Error("unused")),
					},
				}),
			),
		);

		expect(calls.open).toHaveBeenCalledWith(
			expect.objectContaining({ tool: "wiki__wipe", mutating: true }),
		);
		expect(turns.complete).toHaveBeenCalledWith(
			replyTurn,
			expect.objectContaining({ content: "Clearing. Done.", acted: true }),
			{ usage: {} },
		);
		expect(close).toHaveBeenCalledOnce();
	});

	it("parks a mutating call without executing it when approval is required", async () => {
		const { execution, turns } = fakes();
		const execute = vi.fn(async () => ({ removed: true }));
		const model: TurnModel = {
			stream: () =>
				Effect.succeed({
					text: (async function* () {
						yield "I need approval.";
					})(),
					accounting: Effect.succeed({ usage: { modelCalls: 1 } }),
					continuation: Effect.succeed({
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
				}),
		};

		const outcome = await runWithServices(
			runSegment(
				run,
				dependencies({
					execution,
					turns,
					model,
					events: eventBus(),
					collaborations: collaborations(),
					toolCalls: toolCalls(),
					requests: { queueSummary: noSummary },
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
										connectionId: "0199a3a0-0000-7000-8000-0000000000cc",
										connectionRevision: 1,
										remoteToolName: "wipe",
									},
								},
								close: async () => undefined,
							}),
					},
					approvals: {
						responsesForTurn: () => Effect.fail(new ToolApprovalsIncomplete({ message: "unused" })),
						beginExecution: () =>
							Effect.fail(new ToolExecutionRefused({ message: "must not execute" })),
						decide: () => Effect.die(new Error("unused")),
					},
				}),
			),
		);

		expect(execute).not.toHaveBeenCalled();
		expect(turns.complete).not.toHaveBeenCalled();
		expect(turns.suspend).toHaveBeenCalledWith(
			replyTurn,
			expect.objectContaining({
				approvals: [expect.objectContaining({ approvalId: "approval-1" })],
				reply: expect.objectContaining({
					content: "I need approval.",
					toolCalls: [expect.objectContaining({ atOffset: 16 })],
				}),
			}),
			[expect.objectContaining({ approvalId: "approval-1", sdkToolCallId: "sdk-1" })],
		);
		expect(outcome).toEqual({ _tag: "Suspended", approvals: ["approval-1"] });
	});

	it("resumes with the checkpointed model input instead of changed turn context", async () => {
		const { execution, turns } = fakes();
		const resumed: PreparedTurn = {
			...prepared,
			context: {
				...prepared.context,
				agent: { ...prepared.context.agent, model: "new-model", prompt: "new prompt" },
			},
			checkpoint: {
				messages: [],
				approvals: [],
				modelInput: {
					model: "reviewed-model",
					system: "reviewed system",
					messages: [{ role: "user", content: "reviewed history" }],
				},
				reply: reply(""),
				accounting: { usage: { modelCalls: 1 } },
			},
		};
		vi.mocked(execution.prepare).mockReturnValueOnce(Effect.succeed(resumed));
		let received: TurnModelInput | undefined;
		const model: TurnModel = {
			stream: (input) => {
				received = input;
				return Effect.succeed({ text: chunks("Done"), accounting: Effect.succeed({ usage: {} }) });
			},
		};

		await runWithServices(
			runSegment(
				run,
				dependencies({
					execution,
					turns,
					model,
					events: eventBus(),
					collaborations: collaborations(),
					toolCalls: toolCalls(),
					requests: { queueSummary: noSummary },
					approvals: {
						responsesForTurn: () => Effect.succeed({ role: "tool", content: [] }),
						beginExecution: () => Effect.fail(new ToolExecutionRefused({ message: "unused" })),
						decide: () => Effect.die(new Error("unused")),
					},
				}),
			),
		);

		expect(received).toMatchObject({
			model: "reviewed-model",
			system: "reviewed system",
			messages: [{ role: "user", content: "reviewed history" }],
		});
	});

	it("tells the model which connection tools wait for a person", async () => {
		const { execution, turns } = fakes();
		const lookup = tool({
			inputSchema: Schema.Struct({}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
			execute: async () => ({ content: [] }),
		});
		const offered = (name: string, requiresApproval: boolean) => ({
			tool: lookup,
			mutating: false,
			requiresApproval,
			connectionId: "0199a3a0-0000-7000-8000-0000000000cc",
			connectionRevision: 1,
			remoteToolName: name,
		});
		let received: TurnModelInput | undefined;
		const model: TurnModel = {
			stream: (input) => {
				received = input;
				return Effect.succeed({ text: chunks("Done"), accounting: Effect.succeed({ usage: {} }) });
			},
		};

		await runWithServices(
			runSegment(
				run,
				dependencies({
					execution,
					turns,
					model,
					events: eventBus(),
					collaborations: collaborations(),
					toolCalls: toolCalls(),
					requests: { queueSummary: noSummary },
					connectionTools: {
						forPod: () =>
							Effect.succeed({
								tools: {
									wiki__lookup: offered("lookup", false),
									notes__lookup: offered("lookup", true),
								},
								close: async () => undefined,
							}),
					},
				}),
			),
		);

		expect(received?.toolApproval).toEqual({ notes__lookup: "user-approval" });
	});

	it("leaves out a built-in tool the agent has switched off", async () => {
		const { execution, turns } = fakes();
		const probe = tool({
			inputSchema: Schema.Struct({}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
			execute: async () => "ok",
		});
		const offered: string[][] = [];
		const model: TurnModel = {
			stream: (input: TurnModelInput) =>
				Effect.sync(() => {
					offered.push(Object.keys(input.tools ?? {}));
					return { text: chunks("Done"), accounting: Effect.succeed({ usage: {} }) };
				}),
		};
		vi.mocked(execution.prepare).mockReturnValueOnce(
			Effect.succeed({
				...prepared,
				context: {
					...prepared.context,
					agent: { ...prepared.context.agent, disabledTools: ["probe"] },
				},
			}),
		);

		await runWithServices(
			runSegment(
				run,
				dependencies({
					execution,
					turns,
					model,
					events: eventBus(),
					collaborations: collaborations(),
					toolCalls: toolCalls(),
					requests: { queueSummary: noSummary },
					builtInTools: { forWorkspace: () => Effect.succeed({ probe, other: probe }) },
				}),
			),
		);

		expect(offered).toEqual([["other"]]);
	});

	it("leaves a defect while preparing to the workflow, which ends the turn", async () => {
		const { execution, turns } = fakes();
		vi.mocked(execution.prepare).mockReturnValueOnce(Effect.die(new Error("database unavailable")));

		await expect(
			runWithServices(
				runSegment(
					run,
					dependencies({
						execution,
						turns,
						model: unusedModel(),
						events: eventBus(),
						collaborations: collaborations(),
						toolCalls: toolCalls(),
						requests: { queueSummary: noSummary },
					}),
				),
			),
		).rejects.toThrow("database unavailable");
		expect(turns.abandon).not.toHaveBeenCalled();
	});

	it("finishes a turn that may not run without streaming", async () => {
		const { execution, turns } = fakes();
		vi.mocked(execution.prepare).mockReturnValueOnce(
			Effect.succeed({ _tag: "NotRunnable", reason: "The agent left its pod", ended: undefined }),
		);

		const outcome = await runWithServices(
			runSegment(
				run,
				dependencies({
					execution,
					turns,
					model: unusedModel(),
					events: eventBus(),
					collaborations: collaborations(),
					toolCalls: toolCalls(),
					requests: { queueSummary: noSummary },
				}),
			),
		);

		expect(outcome).toEqual({ _tag: "Finished" });
		expect(turns.complete).not.toHaveBeenCalled();
	});

	it("fails the turn for good when its last run fails", async () => {
		const { execution, turns } = fakes();
		vi.mocked(turns.fail).mockReturnValueOnce(Effect.succeed(false));

		const outcome = await runWithServices(
			runSegment(
				run,
				dependencies({
					execution,
					turns,
					model: {
						stream: () =>
							Effect.fail(
								new ModelRequestFailed({ message: "provider down", reason: "unavailable" }),
							),
					},
					events: eventBus(),
					collaborations: collaborations(),
					toolCalls: toolCalls(),
					requests: { queueSummary: noSummary },
				}),
			),
		);

		expect(outcome).toEqual({ _tag: "Finished" });
		expect(turns.fail).toHaveBeenCalledWith(
			replyTurn,
			reply(""),
			"The model provider could not answer.",
		);
	});

	it("keeps a completed turn successful when its summary cannot be queued", async () => {
		const { execution, turns } = fakes();
		const queueSummary = () => Effect.die(new Error("database unavailable"));
		await runWithServices(
			runSegment(
				run,
				dependencies({
					execution,
					turns,
					model: {
						stream: () =>
							Effect.sync(() => ({
								text: chunks("Done"),
								accounting: Effect.succeed({ usage: {} }),
							})),
					},
					events: eventBus(),
					collaborations: collaborations(),
					toolCalls: toolCalls(),
					requests: { queueSummary },
				}),
			),
		);

		expect(turns.complete).toHaveBeenCalledOnce();
		expect(turns.fail).not.toHaveBeenCalled();
	});

	it("keeps a turn successful when an ephemeral delta cannot be published", async () => {
		const { execution, turns } = fakes();
		const events = eventBus();
		vi.mocked(events.publish).mockRejectedValueOnce(new Error("subscriber unavailable"));
		await runWithServices(
			runSegment(
				run,
				dependencies({
					execution,
					turns,
					model: {
						stream: () =>
							Effect.sync(() => ({
								text: chunks("Done"),
								accounting: Effect.succeed({ usage: {} }),
							})),
					},
					events,
					collaborations: collaborations(),
					toolCalls: toolCalls(),
					requests: { queueSummary: noSummary },
				}),
			),
		);

		expect(turns.complete).toHaveBeenCalledOnce();
		expect(turns.fail).not.toHaveBeenCalled();
	});

	it("marks a failed generation for retry without duplicating its response", async () => {
		const { execution, turns } = fakes();
		const model: TurnModel = {
			stream: () =>
				Effect.fail(
					new ModelRequestFailed({ message: "provider unavailable", reason: "unavailable" }),
				),
		};
		const events = eventBus();

		const outcome = await runWithServices(
			runSegment(
				run,
				dependencies({
					execution,
					turns,
					model,
					events,
					collaborations: collaborations(),
					toolCalls: toolCalls(),
					requests: { queueSummary: noSummary },
				}),
			),
		);

		expect(outcome).toEqual({ _tag: "Retry" });
		expect(turns.fail).toHaveBeenCalledWith(
			replyTurn,
			reply(""),
			"The model provider could not answer.",
		);
		expect(eventTypes(events)).toEqual([]);
	});

	it("flushes a short partial response after one second", async () => {
		vi.useFakeTimers();
		try {
			const { execution, turns } = fakes();
			const segment = runWithServices(
				runSegment(
					run,
					dependencies({
						execution,
						turns,
						model: {
							stream: () =>
								Effect.sync(() => ({
									text: delayedChunks(),
									accounting: Effect.succeed({ usage: {} }),
								})),
						},
						events: eventBus(),
						collaborations: collaborations(),
						toolCalls: toolCalls(),
						requests: { queueSummary: noSummary },
					}),
				),
			);

			await vi.advanceTimersByTimeAsync(1_000);
			expect(turns.saveReply).toHaveBeenCalledWith(replyTurn, reply("short"));
			await vi.advanceTimersByTimeAsync(100);
			await segment;
		} finally {
			vi.useRealTimers();
		}
	});

	it("leaves a turn running until its cancellation is requested", async () => {
		vi.useFakeTimers();
		try {
			const { execution, turns } = fakes();
			const events = liveEventBus();
			const segment = runWithServices(
				runSegment(
					run,
					dependencies({
						execution,
						turns,
						model: {
							stream: (input) =>
								Effect.sync(() => ({
									text: chunksUntilAborted(input.signal),
									accounting: Effect.succeed({ usage: {} }),
								})),
						},
						events,
						collaborations: collaborations(),
						toolCalls: toolCalls(),
						requests: { queueSummary: noSummary },
					}),
				),
			);

			await vi.advanceTimersByTimeAsync(5_000);
			expect(turns.cancel).not.toHaveBeenCalled();
			expect(turns.fail).not.toHaveBeenCalled();

			await requestCancellation(events);
			await vi.advanceTimersByTimeAsync(0);
			await segment;
			expect(turns.cancel).toHaveBeenCalledWith(replyTurn, reply("partial"));
			expect(turns.fail).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("reads a cancellation it was not told about, while it runs", async () => {
		vi.useFakeTimers();
		try {
			const { execution, turns } = fakes();
			const segment = runWithServices(
				runSegment(
					run,
					dependencies({
						execution,
						turns,
						model: {
							stream: (input) =>
								Effect.sync(() => ({
									text: chunksUntilAborted(input.signal),
									accounting: Effect.succeed({ usage: {} }),
								})),
						},
						events: liveEventBus(),
						collaborations: collaborations(),
						toolCalls: toolCalls(),
						requests: { queueSummary: noSummary },
					}),
				),
			);

			await vi.advanceTimersByTimeAsync(0);
			vi.mocked(turns.isCancellationRequested).mockReturnValue(Effect.succeed(true));
			await vi.advanceTimersByTimeAsync(15_000);
			await segment;
			expect(turns.cancel).toHaveBeenCalledWith(replyTurn, reply("partial"));
		} finally {
			vi.useRealTimers();
		}
	});
});

/** Prepares `prepared` and records nothing; the cases check what was asked to be recorded. */
function fakes() {
	const execution: TurnStepsDependencies["execution"] = {
		prepare: vi.fn(() => Effect.succeed<PreparedTurn | NotRunnable>(prepared)),
		giveFloor: vi.fn(() =>
			Effect.succeed({ kind: "nobody" as const, why: "exchange-over" as const }),
		),
	};
	const turns: TurnStepsDependencies["turns"] = {
		saveReply: vi.fn(() => Effect.void),
		suspend: vi.fn(() => Effect.succeed(true)),
		complete: vi.fn(() => Effect.void),
		fail: vi.fn(() => Effect.succeed(true)),
		cancel: vi.fn(() => Effect.void),
		isCancellationRequested: vi.fn(() => Effect.succeed(false)),
		stopWaiting: vi.fn(() => Effect.void),
		abandon: vi.fn(() => Effect.undefined),
	};
	return { execution, turns };
}

/** What a segment runs on, with no approvals, built-in tools or connection tools unless given. */
function dependencies(
	given: Omit<TurnStepsDependencies, "approvals" | "builtInTools" | "connectionTools" | "emit"> &
		Partial<Pick<TurnStepsDependencies, "approvals" | "builtInTools" | "connectionTools" | "emit">>,
): TurnStepsDependencies {
	return {
		approvals: noToolApprovalStore,
		builtInTools: noBuiltInTools,
		connectionTools: noConnectionTools,
		emit: () => Effect.void,
		...given,
	};
}

/** Records nothing; the cases that call a tool check what it was asked to record. */
function toolCalls(): TurnStepsDependencies["toolCalls"] {
	const part = (id: string, atOffset: number) => ({
		type: "tool_call" as const,
		id,
		tool: "probe",
		input: {},
		output: null,
		status: "running" as const,
		error: null,
		mutating: false,
		atOffset,
		startedAt: "2026-09-14T00:00:00.000Z",
		finishedAt: null,
	});
	return {
		open: vi.fn(({ atOffset }) =>
			Effect.succeed(part("0199a3a0-0000-7000-8000-0000000000aa", atOffset)),
		),
		close: vi.fn(() => Effect.undefined),
		recordDecision: vi.fn(() => Effect.void),
	};
}

/** No case here collaborates, so every method dies if reached. */
function collaborations(): CollaborationStore {
	const unused = () => Effect.die(new Error("These cases do not collaborate"));
	return {
		open: unused,
		stopWaiting: unused,
		readAnswer: unused,
		deliverAnswer: unused,
		failUnder: unused,
	};
}

function eventBus(): EventBus {
	return {
		publish: vi.fn(async () => {}),
		publishCommitted: vi.fn(async () => {}),
		subscribe: vi.fn(async function* () {}),
	};
}

/** The real in-process bus, so a cancellation reaches the worker the way it does in production. */
function liveEventBus(): EventBus {
	return createEventBus({ store: memoryEventStore() });
}

function requestCancellation(events: EventBus) {
	return events.publish(
		threadChannel(run.request.threadId),
		streamEvent("turn.cancel_requested", {
			threadId: run.request.threadId,
			turnId: prepared.turnId,
		}),
	);
}

function eventTypes(events: EventBus): string[] {
	return vi.mocked(events.publish).mock.calls.map(([, event]) => event.type);
}

const noSummary = () => Effect.void;

async function* chunks(...values: string[]): AsyncIterable<string> {
	for (const value of values) {
		yield value;
	}
}

async function* delayedChunks(): AsyncIterable<string> {
	yield "short";
	await new Promise((resolve) => setTimeout(resolve, 1_100));
	yield " end";
}

async function* chunksUntilAborted(signal: AbortSignal): AsyncIterable<string> {
	yield "partial";
	await new Promise((_, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		signal.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
}

function unusedModel(): TurnModel {
	return {
		stream: () =>
			Effect.fail(new ModelRequestFailed({ message: "unused model", reason: "unavailable" })),
	};
}
