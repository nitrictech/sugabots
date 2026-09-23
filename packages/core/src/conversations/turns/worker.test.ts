import { tool } from "ai";
import { Context, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { effectRunner, type RunEffect } from "../../database/database.ts";
import type { EventBus } from "../../database/events/bus.ts";
import { noDatabase } from "../../database/testing.ts";
import { JobNotRunnable } from "../jobs/queue.ts";
import type { ToolCallStore } from "../tools/calls/store.ts";
import type { CollaborationStore } from "../tools/collaborate/store.ts";
import type { TurnModel, TurnModelInput } from "./model.ts";
import type { ClaimedTurn, PreparedTurn, TurnStore } from "./store.ts";
import { runClaimedTurn, type TurnWorkerOptions, turnWorkerLayer } from "./worker.ts";

/**
 * The stores and models in these cases never query, so the database they run
 * against is one nothing reaches. The real one is the app runtime.
 */
const runWithServices: RunEffect = effectRunner(ManagedRuntime.make(noDatabase));

const claimed: ClaimedTurn = {
	id: "0199a3a0-0000-7000-8000-000000000010",
	threadId: "0199a3a0-0000-7000-8000-000000000001",
	payload: {
		agentId: "0199a3a0-0000-7000-8000-000000000003",
		triggerMessageId: "0199a3a0-0000-7000-8000-000000000006",
	},
	dedupeKey: "turn:0199a3a0-0000-7000-8000-000000000001:0199a3a0-0000-7000-8000-000000000003",
	attempts: 1,
};

const prepared: PreparedTurn = {
	job: claimed,
	turnId: "0199a3a0-0000-7000-8000-000000000011",
	responseMessage: {
		id: "0199a3a0-0000-7000-8000-000000000012",
		threadId: claimed.threadId,
		author: {
			kind: "agent",
			id: claimed.payload.agentId,
			name: "Host Agent",
			handle: "host-agent",
			hue: 150,
			face: "bar",
		},
		kind: "text",
		status: "streaming",
		parts: [],
		content: "",
		createdAt: "2026-09-10T04:00:00.000Z",
	},
	context: {
		thread: {
			id: claimed.threadId,
			workspaceId: "0199a3a0-0000-7000-8000-000000000002",
			title: "Check the release",
			parentThreadId: null,
		},
		agent: {
			id: claimed.payload.agentId,
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

/** A reply draft with no collaborations or tool calls, which is most replies in these cases. */
const reply = (content: string) => ({ content, collaborations: [], toolCalls: [] });

describe("runClaimedTurn", () => {
	it("persists a streamed reply and publishes only ephemeral deltas", async () => {
		const store = turnStore();
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
			runClaimedTurn(claimed, {
				store,
				model,
				events,
				collaborations: collaborations(),
				calls: toolCalls(),
			}),
		);

		expect(store.complete).toHaveBeenCalledWith(prepared, reply("Release checked"), {
			usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
			reportedCost: 0.001,
		});
		expect(store.fail).not.toHaveBeenCalled();
		expect(store.queueSummary).toHaveBeenCalledWith(prepared);
		expect(eventTypes(events)).toEqual(["message.delta", "message.delta"]);
	});

	it("records a built-in tool's call where the reply made it", async () => {
		const store = turnStore();
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
		vi.mocked(store.saveStreamingMessage).mockImplementation(() =>
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
			runClaimedTurn(claimed, {
				store,
				model,
				events: eventBus(),
				collaborations: collaborations(),
				calls,
				builtInTools: { forWorkspace: () => Effect.succeed({ probe }) },
			}).pipe(Effect.provideService(toolContext, "turn-context")),
		);

		expect(calls.open).toHaveBeenCalledWith({
			threadId: claimed.threadId,
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
		expect(store.complete).toHaveBeenCalledWith(
			prepared,
			{
				content: 'Looking. Found {"answer":"hi!"}.',
				collaborations: [],
				toolCalls: [{ id: "0199a3a0-0000-7000-8000-0000000000aa", atOffset: "Looking. ".length }],
			},
			{ usage: {} },
		);
	});

	it("offers a connection's tools for the turn, notes when one acted, and closes the session after", async () => {
		const store = turnStore();
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
			runClaimedTurn(claimed, {
				store,
				model,
				events: eventBus(),
				collaborations: collaborations(),
				calls,
				connectionTools: {
					forPod: () =>
						Effect.succeed({
							tools: {
								wiki__wipe: {
									tool: wipe,
									mutating: true,
									connectionId: "0199a3a0-0000-7000-8000-0000000000cc",
									connectionRevision: 1,
									remoteToolName: "wipe",
								},
							},
							close,
						}),
				},
				approvals: {
					allowedToolKeys: () => Effect.succeed(new Set(["wiki__wipe"])),
					responsesForTurn: () => Effect.fail(new Error("unused")),
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
					listRules: () => Effect.succeed([]),
					revokeRule: () => Effect.succeed(false),
				},
			}),
		);

		expect(calls.open).toHaveBeenCalledWith(
			expect.objectContaining({ tool: "wiki__wipe", mutating: true }),
		);
		expect(store.complete).toHaveBeenCalledWith(
			prepared,
			expect.objectContaining({ content: "Clearing. Done.", acted: true }),
			{ usage: {} },
		);
		expect(close).toHaveBeenCalledOnce();
	});

	it("parks a mutating call without executing it when approval is required", async () => {
		const store = turnStore();
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

		await runWithServices(
			runClaimedTurn(claimed, {
				store,
				model,
				events: eventBus(),
				collaborations: collaborations(),
				calls: toolCalls(),
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
									connectionId: "0199a3a0-0000-7000-8000-0000000000cc",
									connectionRevision: 1,
									remoteToolName: "wipe",
								},
							},
							close: async () => undefined,
						}),
				},
				approvals: {
					allowedToolKeys: () => Effect.succeed(new Set()),
					responsesForTurn: () => Effect.fail(new Error("unused")),
					beginExecution: () => Effect.fail(new Error("must not execute")),
					decide: () => Effect.die(new Error("unused")),
					listRules: () => Effect.succeed([]),
					revokeRule: () => Effect.succeed(false),
				},
			}),
		);

		expect(execute).not.toHaveBeenCalled();
		expect(store.complete).not.toHaveBeenCalled();
		expect(store.suspend).toHaveBeenCalledWith(
			prepared,
			expect.objectContaining({
				approvals: [expect.objectContaining({ approvalId: "approval-1" })],
				reply: expect.objectContaining({
					content: "I need approval.",
					toolCalls: [expect.objectContaining({ atOffset: 16 })],
				}),
			}),
			[expect.objectContaining({ approvalId: "approval-1", sdkToolCallId: "sdk-1" })],
		);
	});

	it("resumes with the checkpointed model input instead of changed turn context", async () => {
		const store = turnStore();
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
		vi.mocked(store.prepare).mockReturnValueOnce(Effect.succeed(resumed));
		let received: TurnModelInput | undefined;
		const model: TurnModel = {
			stream: (input) => {
				received = input;
				return Effect.succeed({ text: chunks("Done"), accounting: Effect.succeed({ usage: {} }) });
			},
		};

		await runWithServices(
			runClaimedTurn(claimed, {
				store,
				model,
				events: eventBus(),
				collaborations: collaborations(),
				calls: toolCalls(),
				approvals: {
					allowedToolKeys: () => Effect.succeed(new Set()),
					responsesForTurn: () => Effect.succeed({ role: "tool", content: [] }),
					beginExecution: () => Effect.fail(new Error("unused")),
					decide: () => Effect.die(new Error("unused")),
					listRules: () => Effect.succeed([]),
					revokeRule: () => Effect.succeed(false),
				},
			}),
		);

		expect(received).toMatchObject({
			model: "reviewed-model",
			system: "reviewed system",
			messages: [{ role: "user", content: "reviewed history" }],
		});
	});

	it("leaves out a built-in tool the agent has switched off", async () => {
		const store = turnStore();
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
		vi.mocked(store.prepare).mockReturnValueOnce(
			Effect.succeed({
				...prepared,
				context: {
					...prepared.context,
					agent: { ...prepared.context.agent, disabledTools: ["probe"] },
				},
			}),
		);

		await runWithServices(
			runClaimedTurn(claimed, {
				store,
				model,
				events: eventBus(),
				collaborations: collaborations(),
				calls: toolCalls(),
				builtInTools: { forWorkspace: () => Effect.succeed({ probe, other: probe }) },
			}),
		);

		expect(offered).toEqual([["other"]]);
	});

	it("releases a claim when preparing its database state fails", async () => {
		const store = turnStore();
		vi.mocked(store.prepare).mockReturnValueOnce(Effect.die(new Error("database unavailable")));

		await runWithServices(
			runClaimedTurn(claimed, {
				store,
				model: unusedModel(),
				events: eventBus(),
				collaborations: collaborations(),
				calls: toolCalls(),
			}),
		);

		expect(store.releaseFailedClaim).toHaveBeenCalledWith(claimed, "database unavailable");
	});

	it("settles a Routine as cancelled when its turn is not runnable", async () => {
		const store = turnStore();
		const settleThread = vi.fn(() => Effect.succeed(true));
		vi.mocked(store.prepare).mockReturnValueOnce(
			Effect.fail(new JobNotRunnable({ reason: "The agent left its pod" })),
		);

		await runWithServices(
			runClaimedTurn(claimed, {
				store,
				model: unusedModel(),
				events: eventBus(),
				collaborations: collaborations(),
				calls: toolCalls(),
				routines: { settleThread },
			}),
		);

		expect(store.discard).toHaveBeenCalledWith(claimed, "The agent left its pod");
		expect(settleThread).toHaveBeenCalledWith(claimed.threadId, { state: "cancelled" });
	});

	it("settles a Routine as failed when turn preparation exhausts its retries", async () => {
		const store = turnStore();
		const settleThread = vi.fn(() => Effect.succeed(true));
		vi.mocked(store.prepare).mockReturnValueOnce(Effect.die(new Error("database unavailable")));
		vi.mocked(store.releaseFailedClaim).mockReturnValueOnce(Effect.succeed(false));

		await runWithServices(
			runClaimedTurn(claimed, {
				store,
				model: unusedModel(),
				events: eventBus(),
				collaborations: collaborations(),
				calls: toolCalls(),
				routines: { settleThread },
			}),
		);

		expect(settleThread).toHaveBeenCalledWith(claimed.threadId, {
			state: "failed",
			error: "database unavailable",
		});
	});

	it("keeps a completed turn successful when its summary cannot be queued", async () => {
		const store = turnStore();
		vi.mocked(store.queueSummary).mockReturnValueOnce(
			Effect.die(new Error("database unavailable")),
		);
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await runWithServices(
				runClaimedTurn(claimed, {
					store,
					model: {
						stream: () =>
							Effect.sync(() => ({
								text: chunks("Done"),
								accounting: Effect.succeed({ usage: {} }),
							})),
					},
					events: eventBus(),
					collaborations: collaborations(),
					calls: toolCalls(),
				}),
			);
		} finally {
			error.mockRestore();
		}

		expect(store.complete).toHaveBeenCalledOnce();
		expect(store.fail).not.toHaveBeenCalled();
	});

	it("keeps a turn successful when an ephemeral delta cannot be published", async () => {
		const store = turnStore();
		const events = eventBus();
		vi.mocked(events.publish).mockRejectedValueOnce(new Error("subscriber unavailable"));
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await runWithServices(
				runClaimedTurn(claimed, {
					store,
					model: {
						stream: () =>
							Effect.sync(() => ({
								text: chunks("Done"),
								accounting: Effect.succeed({ usage: {} }),
							})),
					},
					events,
					collaborations: collaborations(),
					calls: toolCalls(),
				}),
			);
		} finally {
			error.mockRestore();
		}

		expect(store.complete).toHaveBeenCalledOnce();
		expect(store.fail).not.toHaveBeenCalled();
	});

	it("marks a failed generation for retry without duplicating its response", async () => {
		const store = turnStore();
		vi.mocked(store.fail).mockReturnValueOnce(Effect.succeed(true));
		const model: TurnModel = {
			stream: () => Effect.fail(new Error("provider unavailable")),
		};
		const events = eventBus();

		await runWithServices(
			runClaimedTurn(claimed, {
				store,
				model,
				events,
				collaborations: collaborations(),
				calls: toolCalls(),
			}),
		);

		expect(store.fail).toHaveBeenCalledWith(prepared, reply(""), "provider unavailable");
		expect(eventTypes(events)).toEqual([]);
	});

	it("flushes a short partial response after one second", async () => {
		vi.useFakeTimers();
		try {
			const store = turnStore();
			const execution = runWithServices(
				runClaimedTurn(claimed, {
					store,
					model: {
						stream: () =>
							Effect.sync(() => ({
								text: delayedChunks(),
								accounting: Effect.succeed({ usage: {} }),
							})),
					},
					events: eventBus(),
					collaborations: collaborations(),
					calls: toolCalls(),
				}),
			);

			await vi.advanceTimersByTimeAsync(1_000);
			expect(store.saveStreamingMessage).toHaveBeenCalledWith(prepared, reply("short"));
			await vi.advanceTimersByTimeAsync(100);
			await execution;
		} finally {
			vi.useRealTimers();
		}
	});

	it("leaves a turn running while nobody has asked to cancel it", async () => {
		vi.useFakeTimers();
		try {
			const store = turnStore();
			const execution = runWithServices(
				runClaimedTurn(claimed, {
					store,
					model: {
						stream: (input) =>
							Effect.sync(() => ({
								text: chunksUntilAborted(input.signal),
								accounting: Effect.succeed({ usage: {} }),
							})),
					},
					events: eventBus(),
					collaborations: collaborations(),
					calls: toolCalls(),
				}),
			);

			// Long enough for the cancellation poller to have run several times.
			await vi.advanceTimersByTimeAsync(5_000);
			expect(store.isCancellationRequested).toHaveBeenCalled();
			expect(store.cancel).not.toHaveBeenCalled();
			expect(store.fail).not.toHaveBeenCalled();

			vi.mocked(store.isCancellationRequested).mockReturnValue(Effect.succeed(true));
			await vi.advanceTimersByTimeAsync(1_000);
			await execution;
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps partial text when cancellation aborts generation", async () => {
		vi.useFakeTimers();
		try {
			const store = turnStore();
			const events = eventBus();
			const execution = runWithServices(
				runClaimedTurn(claimed, {
					store,
					model: {
						stream: (input) =>
							Effect.sync(() => ({
								text: chunksUntilAborted(input.signal),
								accounting: Effect.succeed({ usage: {} }),
							})),
					},
					events,
					collaborations: collaborations(),
					calls: toolCalls(),
				}),
			);

			await vi.advanceTimersByTimeAsync(0);
			expect(eventTypes(events)).toContain("message.delta");
			vi.mocked(store.isCancellationRequested).mockReturnValue(Effect.succeed(true));
			await vi.advanceTimersByTimeAsync(1_000);
			await execution;
			expect(store.cancel).toHaveBeenCalledWith(prepared, reply("partial"));
			expect(store.fail).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});

/**
 * Running the layer starts the worker; disposing the runtime interrupts it,
 * which is the whole of what shutting one down means now.
 */
function running(store: TurnStore, options: Omit<TurnWorkerOptions, "store">) {
	return ManagedRuntime.make(
		turnWorkerLayer({ store, ...options }).pipe(Layer.provide(noDatabase)),
	);
}

describe("the turn worker", () => {
	it("retries interrupted-job recovery before claiming work", async () => {
		vi.useFakeTimers();
		const store = turnStore();
		vi.mocked(store.requeueInterrupted)
			.mockReturnValueOnce(Effect.die(new Error("database unavailable")))
			.mockReturnValueOnce(Effect.void);
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const worker = running(store, {
			model: unusedModel(),
			events: eventBus(),
			collaborations: collaborations(),
			calls: toolCalls(),
			concurrency: 1,
			pollIntervalMs: 10,
		});
		try {
			await worker.runPromise(Effect.void);
			await vi.advanceTimersByTimeAsync(50);
			expect(store.requeueInterrupted).toHaveBeenCalledTimes(2);
			expect(store.claimNext).toHaveBeenCalled();
		} finally {
			await worker.dispose();
			error.mockRestore();
			vi.useRealTimers();
		}
	});

	it("waits for a turn in flight before shutdown continues", async () => {
		const store = turnStore();
		let wroteAt: number | undefined;
		vi.mocked(store.claimNext).mockReturnValueOnce(Effect.succeed(claimed));
		vi.mocked(store.prepare).mockReturnValueOnce(Effect.succeed(prepared));
		vi.mocked(store.fail).mockImplementation(() =>
			// The outcome write a turn does when its stream is torn down.
			Effect.promise(async () => {
				await new Promise((resolve) => setTimeout(resolve, 60));
				wroteAt = Date.now();
				return false;
			}),
		);

		const worker = running(store, {
			model: {
				stream: (input) =>
					Effect.sync(() => ({
						text: chunksUntilAborted(input.signal),
						accounting: Effect.succeed({ usage: {} }),
					})),
			},
			events: eventBus(),
			collaborations: collaborations(),
			calls: toolCalls(),
			concurrency: 1,
			pollIntervalMs: 10,
		});

		await worker.runPromise(Effect.void);
		await new Promise((resolve) => setTimeout(resolve, 40));

		await worker.dispose();
		const disposedAt = Date.now();

		// Without this the pool closes while the turn is still writing, and the
		// rejection goes nowhere: the turn stays running and the text is lost.
		expect(wroteAt).toBeDefined();
		expect(disposedAt).toBeGreaterThanOrEqual(wroteAt ?? Number.POSITIVE_INFINITY);
	});

	it("stops while recovery is waiting to retry", async () => {
		vi.useFakeTimers();
		const store = turnStore();
		vi.mocked(store.requeueInterrupted).mockReturnValue(
			Effect.die(new Error("database unavailable")),
		);
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const worker = running(store, {
			model: unusedModel(),
			events: eventBus(),
			collaborations: collaborations(),
			calls: toolCalls(),
			concurrency: 1,
			pollIntervalMs: 10_000,
		});
		try {
			await worker.runPromise(Effect.void);
			await vi.advanceTimersByTimeAsync(0);
			await worker.dispose();
			expect(store.claimNext).not.toHaveBeenCalled();
		} finally {
			error.mockRestore();
			vi.useRealTimers();
		}
	});
});

function turnStore(): TurnStore {
	return {
		requeueInterrupted: vi.fn(() => Effect.void),
		claimNext: vi.fn(() => Effect.succeed(undefined)),
		releaseFailedClaim: vi.fn(() => Effect.succeed(true)),
		prepare: vi.fn(() => Effect.succeed(prepared)),
		saveStreamingMessage: vi.fn(() => Effect.void),
		complete: vi.fn(() => Effect.void),
		suspend: vi.fn(() => Effect.succeed(true)),
		giveFloor: vi.fn(() =>
			Effect.succeed({ kind: "nobody" as const, why: "exchange-over" as const }),
		),
		queueSummary: vi.fn(() => Effect.void),
		fail: vi.fn(() => Effect.succeed(false)),
		cancel: vi.fn(() => Effect.void),
		isCancellationRequested: vi.fn(() => Effect.succeed(false)),
		requestCancel: vi.fn(() => Effect.succeed(false)),
		discard: vi.fn(() => Effect.void),
	};
}

/** Records nothing; the cases that call a tool check what it was asked to record. */
function toolCalls(): ToolCallStore {
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
		close: vi.fn(() => Effect.succeed(undefined)),
	};
}

/** No case here collaborates, so every method dies if reached. */
function collaborations(): CollaborationStore {
	const unused = () => Effect.die(new Error("These cases do not collaborate"));
	return { open: unused, stopWaiting: unused, readAnswer: unused, deliverAnswer: unused };
}

function eventBus(): EventBus {
	return {
		publish: vi.fn(async () => {}),
		publishCommitted: vi.fn(async () => {}),
		subscribe: vi.fn(async function* () {}),
	};
}

function eventTypes(events: EventBus): string[] {
	return vi.mocked(events.publish).mock.calls.map(([, event]) => event.type);
}

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
		stream: () => Effect.fail(new Error("unused model")),
	};
}
