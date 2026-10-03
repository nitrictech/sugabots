import { streamEvent, threadChannel } from "@sugabots/contracts";
import { tool } from "ai";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { effectRunner, type RunEffect } from "../../database/database.ts";
import { EventBus } from "../../database/events/bus.ts";
import { EventStore } from "../../database/events/store.ts";
import { noDatabase } from "../../database/testing.ts";
import { Ids } from "../../ids/ids.ts";
import { Models } from "../../providers/models/models.ts";
import { chunks, scriptedModel, streamed, unusedModel } from "../../providers/models/testing.ts";
import { unimplemented } from "../../testing.ts";
import { AgentRepository } from "../../workspaces/agents/agent-repository.ts";
import { BuiltInTools } from "../tools/built-in.ts";
import { Collaborations } from "../tools/collaborate/collaborations.ts";
import { ConnectionTools } from "../tools/connections.ts";
import {
	ApprovedToolCalls,
	ToolApprovalsIncomplete,
	ToolExecutionRefused,
} from "./approvals/approved-calls.ts";
import { type PreparedTurn, replyTurnOf, TurnExecution, type TurnRun } from "./execution.ts";
import { type NotRunnable, TurnRepository } from "./repository.ts";
import { ToolCallRepository } from "./tool-calls/repository.ts";
import { runSegment } from "./turn.steps.ts";

/**
 * What a segment does that a real database cannot produce or show: what the
 * model is sent, a defect or a race forced from a fake, the flush and the
 * cancellation poll on fake timers (which would also stop the database pool),
 * and what reaches the repositories only as an argument. The repositories here
 * are fakes that never query, so the database they run against is one nothing
 * reaches. `turn.segment.test.ts` runs segments against the real ones.
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
			interviewing: false,
		},
		reason: "default",
		routing: { facilitator: false },
		windowTokens: 128_000,
		compaction: undefined,
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
	it("completes the reply with where the compaction it read kept history from", async () => {
		const { execution, turns } = fakes();
		const keptFrom = new Date("2026-09-10T03:00:00.000Z");
		vi.mocked(execution.prepare).mockReturnValueOnce(
			Effect.succeed({
				...prepared,
				context: {
					...prepared.context,
					compaction: { summary: "Earlier work.", historyStartsAt: keptFrom, keptFrom },
				},
			}),
		);

		await runWithServices(
			segmentWith({
				execution,
				turns,
				model: scriptedModel("Done"),
				events: eventBus(),
				collaborations: collaborations(),
				toolCalls: toolCalls(),
			}),
		);

		expect(turns.complete).toHaveBeenCalledWith(
			replyTurn,
			reply("Done"),
			expect.objectContaining({ readKeptFrom: keptFrom.toISOString() }),
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
		const model = Models.fromStream((input) =>
			Effect.sync(() =>
				streamed(
					(async function* () {
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
				),
			),
		);

		await runWithServices(
			segmentWith({
				execution,
				turns,
				model,
				events: eventBus(),
				collaborations: collaborations(),
				toolCalls: calls,
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
				},
			}),
		);

		expect(calls.open).toHaveBeenCalledWith(
			expect.objectContaining({ tool: "wiki__wipe", mutating: true }),
		);
		expect(turns.complete).toHaveBeenCalledWith(
			replyTurn,
			expect.objectContaining({ content: "Clearing. Done.", acted: true }),
			{ contextCapacity: 128_000, readKeptFrom: null, answeredCollaboration: false },
		);
		expect(close).toHaveBeenCalledOnce();
	});

	it("cancels with the reply as it was when the turn may no longer park, placing no call it never recorded", async () => {
		const { execution, turns } = fakes();
		vi.mocked(turns.suspend).mockReturnValue(Effect.succeed(false));

		const outcome = await runWithServices(
			segmentAskingApproval({ execution, turns }, async () => ({ removed: true })),
		);

		expect(turns.cancel).toHaveBeenCalledWith(replyTurn, reply("I need approval."));
		expect(outcome).toEqual({ _tag: "Finished" });
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
				modelCalls: 1,
			},
		};
		vi.mocked(execution.prepare).mockReturnValueOnce(Effect.succeed(resumed));
		let received: Models.StreamRequest | undefined;
		const model = Models.fromStream((input) => {
			received = input;
			return Effect.succeed(streamed(chunks("Done")));
		});

		await runWithServices(
			segmentWith({
				execution,
				turns,
				model,
				events: eventBus(),
				collaborations: collaborations(),
				toolCalls: toolCalls(),
				approvals: {
					responsesForTurn: () => Effect.succeed({ role: "tool", content: [] }),
					beginExecution: () => Effect.fail(new ToolExecutionRefused({ message: "unused" })),
				},
			}),
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
		let received: Models.StreamRequest | undefined;
		const model = Models.fromStream((input) => {
			received = input;
			return Effect.succeed(streamed(chunks("Done")));
		});

		await runWithServices(
			segmentWith({
				execution,
				turns,
				model,
				events: eventBus(),
				collaborations: collaborations(),
				toolCalls: toolCalls(),
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
		const model = Models.fromStream((input) =>
			Effect.sync(() => {
				offered.push(Object.keys(input.tools ?? {}));
				return streamed(chunks("Done"));
			}),
		);
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
			segmentWith({
				execution,
				turns,
				model,
				events: eventBus(),
				collaborations: collaborations(),
				toolCalls: toolCalls(),
				builtInTools: { forWorkspace: () => Effect.succeed({ probe, other: probe }) },
			}),
		);

		expect(offered).toEqual([["other", "read_docs", "workspace_access"]]);
	});

	it("leaves a defect while preparing to the workflow, which ends the turn", async () => {
		const { execution, turns } = fakes();
		vi.mocked(execution.prepare).mockReturnValueOnce(Effect.die(new Error("database unavailable")));

		await expect(
			runWithServices(
				segmentWith({
					execution,
					turns,
					model: unusedModel(),
					events: eventBus(),
					collaborations: collaborations(),
					toolCalls: toolCalls(),
				}),
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
			segmentWith({
				execution,
				turns,
				model: unusedModel(),
				events: eventBus(),
				collaborations: collaborations(),
				toolCalls: toolCalls(),
			}),
		);

		expect(outcome).toEqual({ _tag: "Finished" });
		expect(turns.complete).not.toHaveBeenCalled();
	});

	it("flushes a short partial response after one second", async () => {
		vi.useFakeTimers();
		try {
			const { execution, turns } = fakes();
			const segment = runWithServices(
				segmentWith({
					execution,
					turns,
					model: Models.fromStream(() => Effect.sync(() => streamed(delayedChunks()))),
					events: eventBus(),
					collaborations: collaborations(),
					toolCalls: toolCalls(),
				}),
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
				segmentWith({
					execution,
					turns,
					model: Models.fromStream(() =>
						Effect.map(Effect.abortSignal, (signal) => streamed(chunksUntilAborted(signal))),
					),
					events,
					collaborations: collaborations(),
					toolCalls: toolCalls(),
				}),
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
				segmentWith({
					execution,
					turns,
					model: Models.fromStream(() =>
						Effect.map(Effect.abortSignal, (signal) => streamed(chunksUntilAborted(signal))),
					),
					events: liveEventBus(),
					collaborations: collaborations(),
					toolCalls: toolCalls(),
				}),
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
	const execution: Given["execution"] = {
		prepare: vi.fn(() => Effect.succeed<PreparedTurn | NotRunnable>(prepared)),
	};
	const turns: Given["turns"] = {
		saveReply: vi.fn(() => Effect.void),
		suspend: vi.fn(() => Effect.succeed(true)),
		complete: vi.fn(() => Effect.void),
		fail: vi.fn(() => Effect.succeed(true)),
		cancel: vi.fn(() => Effect.void),
		isCancellationRequested: vi.fn(() => Effect.succeed(false)),
		abandon: vi.fn(() => Effect.undefined),
	};
	return { execution, turns };
}

/** What a case gives its segment: the doubles of the services it runs on, and its options. */
interface Given {
	execution: Pick<TurnExecution.Interface, "prepare">;
	turns: Pick<
		TurnRepository.Interface,
		"saveReply" | "suspend" | "complete" | "fail" | "cancel" | "isCancellationRequested" | "abandon"
	>;
	toolCalls: Pick<ToolCallRepository.Interface, "open" | "close">;
	collaborations: Partial<Collaborations.Interface>;
	approvals?: ApprovedToolCalls.Interface;
	model: Models.Interface;
	events: EventBus.Interface;
	builtInTools?: BuiltInTools.Interface;
	connectionTools?: ConnectionTools.Interface;
}

/**
 * Runs a segment of `run` on `given`, with no approvals, built-in tools or
 * connection tools unless given.
 */
function segmentWith(given: Given) {
	return runSegment(run).pipe(
		Effect.provide(
			Layer.mergeAll(
				Layer.succeed(Models.Service, given.model),
				Layer.succeed(EventBus.Service, given.events),
				Layer.succeed(BuiltInTools.Service, given.builtInTools ?? BuiltInTools.none),
				Layer.succeed(ConnectionTools.Service, given.connectionTools ?? ConnectionTools.none),
				unimplemented(TurnExecution.Service, given.execution),
				unimplemented(TurnRepository.Service, given.turns),
				unimplemented(ToolCallRepository.Service, given.toolCalls),
				unimplemented(Collaborations.Service, given.collaborations),
				unimplemented(AgentRepository.Service, {}),
				unimplemented(
					ApprovedToolCalls.Service,
					given.approvals ?? {
						responsesForTurn: () =>
							Effect.fail(
								new ToolApprovalsIncomplete({ message: "These cases ask for no approvals" }),
							),
						beginExecution: () =>
							Effect.fail(
								new ToolExecutionRefused({ message: "These cases ask for no approvals" }),
							),
					},
				),
				Ids.layer,
			),
		),
	);
}

/**
 * A segment whose model asks a person to approve one call to a mutating
 * connection tool, `wiki__wipe`, which runs `execute`.
 */
function segmentAskingApproval(
	{ execution, turns }: Pick<Given, "execution" | "turns">,
	execute: () => Promise<unknown>,
) {
	return segmentWith({
		execution,
		turns,
		model: Models.fromStream(() =>
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
		),
		events: eventBus(),
		collaborations: collaborations(),
		toolCalls: toolCalls(),
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
			beginExecution: () => Effect.fail(new ToolExecutionRefused({ message: "must not execute" })),
		},
	});
}

/** Records nothing; the cases that call a tool check what it was asked to record. */
function toolCalls(): Given["toolCalls"] {
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
	};
}

/** No case here collaborates, so it has no collaborations to offer; reaching one dies. */
function collaborations(): Given["collaborations"] {
	return {};
}

function eventBus(): EventBus.Interface {
	return {
		publish: vi.fn(async () => {}),
		publishCommitted: vi.fn(async () => {}),
		subscribe: vi.fn(async function* () {}),
		close: vi.fn(async () => {}),
	};
}

/** The real in-process bus, so a cancellation reaches the turn the way it does in production. */
function liveEventBus(): EventBus.Interface {
	return EventBus.inProcess({ store: EventStore.inMemory() });
}

function requestCancellation(events: EventBus.Interface) {
	return events.publish(
		threadChannel(run.request.threadId),
		streamEvent("turn.cancel_requested", {
			threadId: run.request.threadId,
			turnId: prepared.turnId,
		}),
	);
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
