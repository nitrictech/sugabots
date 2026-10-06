import { type ConnectionAccess, streamEvent, threadChannel } from "@sugabots/contracts";
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
import { CALL_TOOL, TOOL_SEARCH } from "../tools/tool-search/tool.ts";
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
									access: "ask",
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

	it("tells the model which connection tools wait for a person, offering the ones turned off too", async () => {
		const { execution, turns } = fakes();
		const lookup = tool({
			inputSchema: Schema.Struct({}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
			execute: async () => ({ content: [] }),
		});
		const offered = (name: string, access: ConnectionAccess) => ({
			tool: lookup,
			mutating: false,
			access,
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
								wiki__lookup: offered("lookup", "allow"),
								notes__lookup: offered("lookup", "ask"),
								drive__lookup: offered("lookup", "off"),
							},
							close: async () => undefined,
						}),
				},
			}),
		);

		expect(received?.toolApproval).toEqual({ notes__lookup: "user-approval" });
		expect(Object.keys(received?.tools ?? {})).toEqual(
			expect.arrayContaining(["wiki__lookup", "notes__lookup", "drive__lookup"]),
		);
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

		expect(offered).toEqual([["other"]]);
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

describe("a pod whose connection tool definitions would crowd the model's window", () => {
	// One tool's description alone is past the share of the 128k-token window the cases read with.
	const crowding = "Looks up a page in the wiki. ".repeat(2_000);
	const callOptions = { toolCallId: "sdk-1", messages: [] } as never;

	/** A pod with one huge tool to read with, one that asks first and one turned off. */
	function crowdedPod() {
		const lookup = vi.fn(async () => ({ content: [{ type: "text", text: "found" }] }));
		const wipe = vi.fn(async () => ({ content: [] }));
		const offered = (
			description: string,
			remoteToolName: string,
			access: ConnectionAccess,
			execute: () => Promise<unknown>,
		) => ({
			tool: tool({
				description,
				inputSchema: Schema.Struct({ page: Schema.String }).pipe(
					Schema.toStandardSchemaV1,
					Schema.toStandardJSONSchemaV1,
				),
				execute,
			}),
			mutating: access === "ask",
			access,
			connectionId: "0199a3a0-0000-7000-8000-0000000000cc",
			connectionRevision: 1,
			remoteToolName,
		});
		const connectionTools: ConnectionTools.Interface = {
			forPod: () =>
				Effect.succeed({
					tools: {
						wiki__lookup: offered(crowding, "lookup", "allow", lookup),
						wiki__wipe: offered("Deletes a page.", "wipe", "ask", wipe),
						drive__lookup: offered("Looks up a file.", "lookup", "off", lookup),
					},
					close: async () => undefined,
				}),
		};
		return { connectionTools, lookup, wipe };
	}

	/** Runs a segment on the crowded pod whose model does `act` with the tools it is offered. */
	async function bridgedSegment(
		act: (input: Models.StreamRequest) => Promise<void>,
		calls = toolCalls(),
	) {
		const { execution, turns } = fakes();
		const pod = crowdedPod();
		const model = Models.fromStream((input) =>
			Effect.sync(() =>
				streamed(
					(async function* () {
						await act(input);
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
				connectionTools: pod.connectionTools,
			}),
		);
		return pod;
	}

	it("offers the tools to find and call them in place of the tools themselves", async () => {
		let received: Models.StreamRequest | undefined;
		let found: unknown;

		await bridgedSegment(async (input) => {
			received = input;
			found = await input.tools?.[TOOL_SEARCH]?.execute?.(
				{ query: "look up a page" } as never,
				callOptions,
			);
		});

		expect(Object.keys(received?.tools ?? {})).toEqual(
			expect.arrayContaining([TOOL_SEARCH, CALL_TOOL]),
		);
		expect(Object.keys(received?.tools ?? {})).not.toContain("wiki__lookup");
		const turnNote = received?.messages.at(-1)?.content;
		expect(turnNote).toContain(TOOL_SEARCH);
		expect(turnNote).toContain("- wiki (2 tools): lookup, wipe");
		expect(turnNote).not.toContain("drive");
		expect(found).toMatchObject({
			tools: expect.arrayContaining([
				expect.objectContaining({ tool: "wiki__lookup", inputSchema: expect.anything() }),
			]),
		});
	});

	it("asks a person first only for a call to a tool that asks first", async () => {
		let received: Models.StreamRequest | undefined;

		await bridgedSegment(async (input) => {
			received = input;
		});

		const approvals = received?.toolApproval as
			| Record<string, (input: unknown) => unknown>
			| undefined;
		const approval = approvals?.[CALL_TOOL];
		if (!approval) throw new Error("no approval for the bridge's calls");
		expect(approval({ tool: "wiki__wipe", arguments: { page: "Home" } })).toBe("user-approval");
		expect(approval({ tool: "wiki__lookup", arguments: { page: "Home" } })).toBeUndefined();
		expect(approval({ tool: "constructor", arguments: {} })).toBeUndefined();
	});

	it("runs a found tool as itself, recorded under its own name", async () => {
		const calls = toolCalls();
		let outcome: unknown;

		const { lookup } = await bridgedSegment(async (input) => {
			outcome = await input.tools?.[CALL_TOOL]?.execute?.(
				{ tool: "wiki__lookup", arguments: { page: "Home" } } as never,
				callOptions,
			);
		}, calls);

		expect(lookup).toHaveBeenCalledWith({ page: "Home" }, callOptions);
		expect(outcome).toEqual({ content: [{ type: "text", text: "found" }] });
		expect(calls.open).toHaveBeenCalledWith(
			expect.objectContaining({ tool: "wiki__lookup", input: { page: "Home" } }),
		);
	});

	it("tells the model when a call names no tool it has, running nothing", async () => {
		let outcome: unknown;

		const { lookup } = await bridgedSegment(async (input) => {
			outcome = await input.tools?.[CALL_TOOL]?.execute?.(
				{ tool: "wiki__look", arguments: { page: "Home" } } as never,
				callOptions,
			);
		});

		expect(lookup).not.toHaveBeenCalled();
		expect(outcome).toMatchObject({
			status: "failed",
			reason: expect.stringContaining(TOOL_SEARCH),
		});
	});

	it("waits for a person to approve a call through the bridge as a call to the tool it names", async () => {
		const { execution, turns } = fakes();
		const pod = crowdedPod();
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
								input: { tool: "wiki__wipe", arguments: { page: "Home" } },
							},
						},
					] as never,
					responseMessages: [{ role: "assistant", content: "I need approval." }] as never,
				}),
			),
		);

		const outcome = await runWithServices(
			segmentWith({
				execution,
				turns,
				model,
				events: eventBus(),
				collaborations: collaborations(),
				toolCalls: toolCalls(),
				connectionTools: pod.connectionTools,
			}),
		);

		expect(outcome).toEqual({ _tag: "Suspended", approvals: ["approval-1"] });
		expect(pod.wipe).not.toHaveBeenCalled();
		expect(turns.suspend).toHaveBeenCalledWith(
			replyTurn,
			expect.objectContaining({
				connectionToolMode: "bridged",
				approvals: [expect.objectContaining({ tool: "wiki__wipe" })],
			}),
			[
				expect.objectContaining({
					sdkToolCallId: "sdk-1",
					tool: "wiki__wipe",
					input: { page: "Home" },
					remoteToolName: "wipe",
				}),
			],
		);
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
							access: "ask",
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
