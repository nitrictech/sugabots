import {
	type ConnectorAccess,
	chatStream,
	START_CHAT_TOOL,
	streamEvent,
} from "@sugabots/contracts";
import { tool } from "ai";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { CurrentActor } from "../../authorization/current-actor.ts";
import { effectRunner, type RunEffect } from "../../database/database.ts";
import { EventBus } from "../../database/events/bus.ts";
import { EventStore } from "../../database/events/store.ts";
import { noDatabase } from "../../database/testing.ts";
import { ChatFileStore } from "../../files/chat-file-store.ts";
import { Files } from "../../files/files.ts";
import { Ids } from "../../ids/ids.ts";
import { Models } from "../../providers/models/models.ts";
import { chunks, scriptedModel, streamed, unusedModel } from "../../providers/models/testing.ts";
import { ServerSettings } from "../../server-settings/server-settings.ts";
import { unimplemented } from "../../testing.ts";
import { BotAdministration } from "../../workspaces/bots/bot-administration.ts";
import { AssistantGuide } from "../assistant/assistant-guide.ts";
import { BotAutomations } from "../automations/bot-automations.ts";
import { BotChats } from "../chats/bot-chats.ts";
import { SEARCH_HISTORY_TOOL } from "../store/message-text.ts";
import {
	ADD_BOT_TO_PROJECT_TOOL,
	CREATE_PROJECT_TOOL,
	JOIN_PROJECT_TOOL,
	PIN_BOT_TOOL,
	WORKSPACE_GUIDE_TOOL,
} from "../tools/assistant/tool.ts";
import { AUTOMATION_TOOLS } from "../tools/automations/tool.ts";
import { BuiltInTools } from "../tools/built-in.ts";
import { Collaborations } from "../tools/collaborate/collaborations.ts";
import { COLLABORATE_TOOL } from "../tools/collaborate/tool.ts";
import { ComputerTools } from "../tools/computer.ts";
import { ConnectorTools } from "../tools/connectors.ts";
import { FILE_TOOLS } from "../tools/files/tool.ts";
import { HOST_REQUEST_TOOL, hostRequestTool } from "../tools/host-request/tool.ts";
import { MARK_RESOLVED_TOOL } from "../tools/mark-resolved/tool.ts";
import { READ_CHAT_FILE_TOOL } from "../tools/read-chat-file/tool.ts";
import { SAVE_INSTRUCTIONS_TOOL } from "../tools/save-instructions/tool.ts";
import { CALL_TOOL, TOOL_SEARCH } from "../tools/tool-search/tool.ts";
import {
	ApprovedToolCalls,
	ToolApprovalsIncomplete,
	ToolExecutionRefused,
} from "./approvals/approved-calls.ts";
import { type PreparedTurn, replyTurnOf, TurnExecution, type TurnRun } from "./execution.ts";
import { type NotRunnable, TurnStore } from "./store.ts";
import { ToolCallStore } from "./tool-calls/store.ts";
import { runSegment } from "./turn.steps.ts";

/**
 * What a segment does that a real database cannot produce or show: what the
 * model is sent, a defect or a race forced from a fake, the flush and the
 * cancellation poll on fake timers (which would also stop the database pool),
 * and what reaches the stores only as an argument. The stores here
 * are fakes that never query, so the database they run against is one nothing
 * reaches. `turn.segment.test.ts` runs segments against the real ones.
 */
const runWithServices: RunEffect = effectRunner(ManagedRuntime.make(noDatabase));

const run: TurnRun = {
	executionId: "0199a3a0-0000-7000-8000-000000000010",
	request: {
		chatId: "0199a3a0-0000-7000-8000-000000000001",
		botId: "0199a3a0-0000-7000-8000-000000000003",
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
		chatId: run.request.chatId,
		author: {
			kind: "bot",
			id: run.request.botId,
			name: "Host Bot",
			handle: "host-bot",
			color: "green",
			eyes: "pill",
			shape: "circle",
		},
		kind: "text",
		status: "writing",
		parts: [],
		content: "",
		createdAt: "2026-09-10T04:00:00.000Z",
	},
	context: {
		chat: {
			id: run.request.chatId,
			workspaceId: "0199a3a0-0000-7000-8000-000000000002",
			title: "Check the release",
			kind: "project_chat",
			botId: run.request.botId,
			parentChatId: null,
		},
		bot: {
			id: run.request.botId,
			name: "Host Bot",
			handle: "host-bot",
			model: "claude-sonnet-4-20250514",
			prompt: "",
			disabledTools: [],
			usesComputer: false,
			naturalBrowsing: false,
			assistantOf: null,
			visibility: "public",
			color: "orange",
			acceptsImages: false,
			defaultProjectId: "0199a3a0-0000-7000-8000-000000000004",
		},
		projectId: "0199a3a0-0000-7000-8000-000000000004",
		reason: "default",
		windowTokens: 128_000,
		compaction: undefined,
		automationInstructions: new Map(),
		project: null,
		workspaceName: "Suga",
		workspaceSlug: "suga",
		workspaceTimeZone: "UTC",
		askerId: null,
		startedFor: null,
		collaborators: [],
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

	it("offers a connector's tools for the turn, records that the turn acted once one that changes things starts, and closes the session after", async () => {
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
						await input.tools?.[CALL_TOOL]?.execute?.(
							{ tool: "wiki__wipe", arguments: {} } as never,
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
				connectorTools: {
					forTurn: () =>
						Effect.succeed({
							tools: {
								wiki__wipe: {
									tool: wipe,
									writeOrDelete: true,
									access: "ask",
									connectorId: "0199a3a0-0000-7000-8000-0000000000cc",
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
							close,
						}),
				},
				approvals: {
					responsesForTurn: () => Effect.fail(new ToolApprovalsIncomplete({ message: "unused" })),
					beginExecution: ({ atOffset }) =>
						calls.open({
							chatId: prepared.context.chat.id,
							messageId: prepared.responseMessage.id,
							turnId: prepared.turnId,
							tool: "wiki__wipe",
							input: {},
							atOffset,
							writeOrDelete: true,
						}),
				},
			}),
		);

		expect(calls.open).toHaveBeenCalledWith(
			expect.objectContaining({ tool: "wiki__wipe", writeOrDelete: true }),
		);
		expect(turns.markActed).toHaveBeenCalledWith(prepared.turnId);
		expect(turns.complete).toHaveBeenCalledWith(
			replyTurn,
			expect.objectContaining({ content: "Clearing. Done." }),
			{ contextCapacity: 128_000, readKeptFrom: null },
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
				bot: { ...prepared.context.bot, model: "new-model", prompt: "new prompt" },
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
				modelRequests: 1,
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

	it("gives a Personal Assistant answering its person its guide, and asks them before it acts, with no instructions of its own nor tools for its automations", async () => {
		const { execution, turns } = fakes();
		const connectorTool = (name: string, writeOrDelete: boolean) => ({
			tool: tool({
				inputSchema: Schema.Struct({}).pipe(
					Schema.toStandardSchemaV1,
					Schema.toStandardJSONSchemaV1,
				),
				execute: async () => ({ content: [] }),
			}),
			writeOrDelete,
			access: "allow" as const,
			connectorId: "0199a3a0-0000-7000-8000-0000000000cc",
			handle: "notes",
			description: "",
			inputSchema: { type: "object" as const, properties: {} },
			connectorRevision: 1,
			remoteToolName: name,
		});
		const personId = "0199a3a0-0000-7000-8000-0000000000aa";
		vi.mocked(execution.prepare).mockReturnValue(
			Effect.succeed({
				...prepared,
				context: {
					...prepared.context,
					bot: { ...prepared.context.bot, assistantOf: personId },
					askerId: personId,
				},
			}),
		);
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
				connectorTools: {
					forTurn: () =>
						Effect.succeed({
							tools: {
								notes__write: connectorTool("write", true),
								notes__read: connectorTool("read", false),
							},
							unavailable: [],
							signInExpired: [],
							instructions: {},
							addable: [],
							fromProjectAndBot: false,
							close: async () => undefined,
						}),
				},
			}),
		);

		const offered = Object.keys(received?.tools ?? {});
		expect(offered).toEqual(
			expect.arrayContaining([
				WORKSPACE_GUIDE_TOOL,
				CREATE_PROJECT_TOOL,
				JOIN_PROJECT_TOOL,
				ADD_BOT_TO_PROJECT_TOOL,
				PIN_BOT_TOOL,
				START_CHAT_TOOL,
				COLLABORATE_TOOL,
			]),
		);
		expect(offered).not.toContain(SAVE_INSTRUCTIONS_TOOL);
		for (const automationTool of AUTOMATION_TOOLS) expect(offered).not.toContain(automationTool);
		const approvals = received?.toolApproval as
			| Record<string, (input: unknown) => unknown>
			| undefined;
		expect(approvals?.[CREATE_PROJECT_TOOL]?.({ name: "Launch" })).toBe("user-approval");
		expect(approvals?.[START_CHAT_TOOL]?.({ title: "Report", brief: "Write it." })).toBe(
			"user-approval",
		);
		// The bot it asks acts with its own connectors, so its person allows that too.
		expect(approvals?.[COLLABORATE_TOOL]?.({ to: "Researcher", brief: "Find it." })).toBe(
			"user-approval",
		);
		expect(approvals?.[WORKSPACE_GUIDE_TOOL]).toBeUndefined();
		// A call that may change something asks, though its connector allows it.
		expect(approvals?.[CALL_TOOL]?.({ tool: "notes__write", arguments: {} })).toBe("user-approval");
		expect(approvals?.[CALL_TOOL]?.({ tool: "notes__read", arguments: {} })).toBeUndefined();
	});

	it("reaches connector tools, and Sugabots' own occasional ones, through tool search, asking first only for connector tools that ask", async () => {
		const { execution, turns } = fakes();
		const lookup = tool({
			inputSchema: Schema.Struct({}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
			execute: async () => ({ content: [] }),
		});
		const offered = (name: string, access: ConnectorAccess) => ({
			tool: lookup,
			writeOrDelete: false,
			access,
			connectorId: "0199a3a0-0000-7000-8000-0000000000cc",
			handle: "wiki",
			description: "",
			inputSchema: {
				type: "object" as const,
				properties: { q: { type: "string" as const } },
				required: ["q"],
			},
			connectorRevision: 1,
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
				connectorTools: {
					forTurn: () =>
						Effect.succeed({
							tools: {
								wiki__lookup: offered("lookup", "allow"),
								notes__lookup: offered("lookup", "ask"),
								drive__lookup: offered("lookup", "off"),
							},
							unavailable: [],
							signInExpired: [],
							instructions: {},
							addable: [],
							fromProjectAndBot: false,
							close: async () => undefined,
						}),
				},
			}),
		);

		expect(Object.keys(received?.tools ?? {}).filter((key) => !FILE_TOOLS.has(key))).toEqual([
			TOOL_SEARCH,
			CALL_TOOL,
			SEARCH_HISTORY_TOOL,
			READ_CHAT_FILE_TOOL,
			...AUTOMATION_TOOLS,
			// No person asked this turn, so it is offered no start_chat.
			MARK_RESOLVED_TOOL,
			SAVE_INSTRUCTIONS_TOOL,
			"collaborate",
		]);
		const approvals = received?.toolApproval as
			| Record<string, (input: unknown) => unknown>
			| undefined;
		const approval = approvals?.[CALL_TOOL];
		expect(approval?.({ tool: "notes__lookup", arguments: { q: "x" } })).toBe("user-approval");
		expect(approval?.({ tool: "wiki__lookup", arguments: { q: "x" } })).toBeUndefined();
		expect(approval?.({ tool: "notes__lookup", arguments: {} })).toBeUndefined();
		const turnNote = received?.messages.at(-1)?.content;
		expect(turnNote).toContain("wiki__lookup");
		expect(turnNote).not.toContain("drive__lookup");
		expect(turnNote).toContain("- sugabots (2 tools): read_docs, workspace_access");
	});

	it("refuses a request for a host the workspace blocked at once, asking nobody", async () => {
		const { turns } = fakes();
		const usingComputer: PreparedTurn = {
			...prepared,
			context: {
				...prepared.context,
				bot: { ...prepared.context.bot, usesComputer: true },
			},
		};
		const execution: Given["execution"] = { prepare: () => Effect.succeed(usingComputer) };
		const calls = toolCalls();
		let received: Models.StreamRequest | undefined;
		const model = Models.fromStream((input) => {
			received = input;
			return Effect.succeed(streamed(chunks("Done")));
		});
		const request = hostRequestTool({
			turnId: prepared.turnId,
			network: { grantRequest: () => Effect.die("a refused request is never granted") },
			blocked: ["*.pastebin.com"],
			run: () => Promise.reject(new Error("a refused request runs nothing")),
		});

		await runWithServices(
			segmentWith({
				execution,
				turns,
				model,
				events: eventBus(),
				collaborations: collaborations(),
				toolCalls: calls,
				computerTools: {
					forTurn: () =>
						Effect.succeed({
							tools: {},
							requests: { [HOST_REQUEST_TOOL]: request },
							usable: true,
							note: undefined,
							workspace: undefined,
							signsIn: false,
						}),
				},
			}),
		);
		const approval = (received?.toolApproval ?? {}) as Record<string, (input: unknown) => unknown>;
		const blocked = { host: "paste.pastebin.com" };
		const output = await received?.tools?.[HOST_REQUEST_TOOL]?.execute?.(blocked, {
			toolCallId: "sdk-1",
			messages: [],
		} as never);

		expect(approval[HOST_REQUEST_TOOL]?.(blocked)).toBe("not-applicable");
		expect(approval[HOST_REQUEST_TOOL]?.({ host: "api.example.com" })).toBe("user-approval");
		expect(output).toMatchObject({ status: "failed", error: expect.stringContaining("blocked") });
		expect(calls.close).toHaveBeenCalledWith(expect.anything(), {
			error: expect.stringContaining("*.pastebin.com"),
		});
	});

	it("still offers a built-in tool the bot has switched off, refusing each call to it", async () => {
		const { execution, turns } = fakes();
		const probe = tool({
			inputSchema: Schema.Struct({}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
			execute: vi.fn(async () => "ok"),
		});
		let received: Models.StreamRequest | undefined;
		let outcome: unknown;
		const model = Models.fromStream((input) =>
			Effect.sync(() => {
				received = input;
				return streamed(
					(async function* () {
						outcome = await input.tools?.probe?.execute?.(
							{} as never,
							{ toolCallId: "sdk-1", messages: [] } as never,
						);
						yield "Done";
					})(),
				);
			}),
		);
		vi.mocked(execution.prepare).mockReturnValueOnce(
			Effect.succeed({
				...prepared,
				context: {
					...prepared.context,
					bot: { ...prepared.context.bot, disabledTools: ["probe"] },
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
				builtInTools: {
					forWorkspace: () =>
						Effect.succeed({ tools: { probe, other: probe }, usable: ["probe", "other"] }),
				},
			}),
		);

		expect(Object.keys(received?.tools ?? {})).toEqual(expect.arrayContaining(["probe", "other"]));
		expect(probe.execute).not.toHaveBeenCalled();
		expect(outcome).toMatchObject({ status: "failed" });
		expect(received?.messages.at(-1)?.content).toMatch(/Built-in tools you can call: other[,.]/);
	});

	it.each([
		{ disabledTools: [], called: true },
		{ disabledTools: ["automations"], called: false },
	])(
		"sets up an automation for the person the turn answers unless automations are off ($disabledTools)",
		async ({ disabledTools, called }) => {
			const { execution, turns } = fakes();
			const askerId = "0199a3a0-0000-7000-8000-0000000000f1";
			const create = vi.fn(() => Effect.fail(new CurrentActor.NobodyAsked()));
			let outcome: unknown;
			const model = Models.fromStream((input) =>
				Effect.sync(() =>
					streamed(
						(async function* () {
							outcome = await input.tools?.create_automation?.execute?.(
								{
									name: "Morning standup",
									instructions: "Ask how everyone is going.",
									routineExpression: "0 9 * * 1-5",
									results: "post_to_chat",
								},
								{ toolCallId: "sdk-1", messages: [] } as never,
							);
							yield "Done";
						})(),
					),
				),
			);
			vi.mocked(execution.prepare).mockReturnValueOnce(
				Effect.succeed({
					...prepared,
					context: {
						...prepared.context,
						askerId,
						bot: { ...prepared.context.bot, disabledTools },
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
					automations: { create },
				}),
			);

			if (called) {
				expect(create).toHaveBeenCalledWith(
					{ botId: prepared.context.bot.id, projectId: prepared.context.projectId, askerId },
					expect.objectContaining({ name: "Morning standup", routineExpression: "0 9 * * 1-5" }),
				);
				expect(outcome).toMatchObject({ refused: expect.any(String) });
			} else {
				expect(create).not.toHaveBeenCalled();
				expect(outcome).toMatchObject({ status: "failed" });
			}
		},
	);

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

	it("completes a reply that says nothing but carries a file the bot attached", async () => {
		const { execution, turns } = fakes();
		vi.mocked(turns.replyFiles).mockReturnValue(
			Effect.succeed([
				{
					type: "file",
					id: "0199a3a0-0000-7000-8000-0000000000f1",
					name: "chart.png",
					contentType: "image/png",
					size: 4_096,
				},
			]),
		);

		await runWithServices(
			segmentWith({
				execution,
				turns,
				model: scriptedModel(""),
				events: eventBus(),
				collaborations: collaborations(),
				toolCalls: toolCalls(),
			}),
		);

		expect(turns.complete).toHaveBeenCalledWith(replyTurn, reply(""), expect.anything());
		expect(turns.fail).not.toHaveBeenCalled();
	});

	it("finishes a turn that may not run without writing a reply", async () => {
		const { execution, turns } = fakes();
		vi.mocked(execution.prepare).mockReturnValueOnce(
			Effect.succeed({
				_tag: "NotRunnable",
				reason: "The bot left its project",
				ended: undefined,
			}),
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
		replyFiles: vi.fn(() => Effect.succeed([])),
		markActed: vi.fn(() => Effect.void),
	};
	return { execution, turns };
}

/** What a case gives its segment: the doubles of the services it runs on, and its options. */
interface Given {
	execution: Pick<TurnExecution.Interface, "prepare">;
	turns: Pick<
		TurnStore.Interface,
		| "saveReply"
		| "suspend"
		| "complete"
		| "fail"
		| "cancel"
		| "isCancellationRequested"
		| "abandon"
		| "replyFiles"
		| "markActed"
	>;
	toolCalls: Pick<ToolCallStore.Interface, "open" | "close">;
	collaborations: Partial<Collaborations.Interface>;
	approvals?: ApprovedToolCalls.Interface;
	model: Models.Interface;
	events: EventBus.Interface;
	builtInTools?: BuiltInTools.Interface;
	connectorTools?: ConnectorTools.Interface;
	computerTools?: ComputerTools.Interface;
	automations?: Partial<BotAutomations.Interface>;
}

/**
 * Runs a segment of `run` on `given`, with no approvals, built-in tools or
 * connector tools unless given.
 */
function segmentWith(given: Given) {
	return runSegment(run).pipe(
		Effect.provide(
			Layer.mergeAll(
				Layer.succeed(Models.Service, given.model),
				Layer.succeed(EventBus.Service, given.events),
				Layer.succeed(BuiltInTools.Service, given.builtInTools ?? BuiltInTools.none),
				Layer.succeed(ComputerTools.Service, given.computerTools ?? ComputerTools.none),
				Layer.succeed(ConnectorTools.Service, given.connectorTools ?? ConnectorTools.none),
				unimplemented(TurnExecution.Service, given.execution),
				unimplemented(TurnStore.Service, given.turns),
				unimplemented(ToolCallStore.Service, given.toolCalls),
				unimplemented(Collaborations.Service, given.collaborations),
				unimplemented(BotAdministration.Service, {}),
				unimplemented(ChatFileStore.Service, { resultFiles: () => Effect.succeed(new Map()) }),
				unimplemented(Files.Authoring, {}),
				unimplemented(BotAutomations.Service, given.automations ?? {}),
				Layer.succeed(
					ServerSettings.Service,
					ServerSettings.fromUrls({ isProduction: false, publicUrl: "http://sugabots.test" }),
				),
				unimplemented(BotChats.Service, {}),
				unimplemented(AssistantGuide.Service, {}),
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
 * A segment whose model asks a person to approve one call to a write/delete
 * connector tool, `wiki__wipe`, which runs `execute`.
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
								toolName: CALL_TOOL,
								input: { tool: "wiki__wipe", arguments: {} },
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
							connectorId: "0199a3a0-0000-7000-8000-0000000000cc",
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
		writeOrDelete: false,
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
		chatStream(run.request.chatId),
		streamEvent("turn.cancel_requested", {
			chatId: run.request.chatId,
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
