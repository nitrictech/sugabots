import type { CollaborationPart } from "@sugabots/contracts";
import type { Tool, ToolSet } from "ai";
import type { Effect } from "effect";
import type { Artifacts } from "../../artifacts/artifacts.ts";
import type { RunEffect } from "../../database/database.ts";
import type { EventBus } from "../../database/events/bus.ts";
import { UserMessage } from "../../user-message.ts";
import type { AgentRepository } from "../../workspaces/agents/agent-repository.ts";
import type { ThreadFiles } from "../thread-files/thread-files.ts";
import { SEARCH_HISTORY_TOOL } from "../threads/message-text.ts";
import { artifactTools, MUTATING_ARTIFACT_TOOLS } from "../tools/artifacts/tool.ts";
import type { BuiltInTools } from "../tools/built-in.ts";
import type { Collaborations } from "../tools/collaborate/collaborations.ts";
import { collaborateTool } from "../tools/collaborate/tool.ts";
import type { OfferedTool } from "../tools/connections.ts";
import { READ_THREAD_FILE_TOOL, readThreadFileTool } from "../tools/read-thread-file/tool.ts";
import { READ_FILE_TOOL } from "../tools/sandbox/tools.ts";
import type { SandboxTools } from "../tools/sandbox.ts";
import { SAVE_INSTRUCTIONS_TOOL, saveInstructionsTool } from "../tools/save-instructions/tool.ts";
import { searchHistoryTool } from "../tools/search-history/tool.ts";
import { buildCatalog } from "../tools/tool-search/catalog.ts";
import { CALL_TOOL, callToolTool, TOOL_SEARCH, toolSearchTool } from "../tools/tool-search/tool.ts";
import type { ApprovedToolCalls } from "./approvals/approved-calls.ts";
import type { PreparedTurn } from "./execution.ts";
import { type RecordingOptions, recorded, refused } from "./tool-calls/recorded.ts";
import type { ToolCallRepository } from "./tool-calls/repository.ts";

/**
 * The tools a turn's model may call. One directory per tool under `tools/`;
 * this is the only place that knows which ones exist, so adding a tool is a
 * folder and a line here rather than a change to the turn's steps.
 *
 * Four kinds. The crew tool `collaborate` reaches other agents
 * and leave their own records. The built-in tools do work for the agent, the
 * sandbox tools work in the pod's sandbox, and the connection tools do work
 * at a server the workspace configured; every call to any of them is recorded
 * as a `tool_call` part of the reply (`calls/`).
 * Connection tools are reached through `tool_search` and `call_tool`.
 *
 * A tool that can't run is still offered, and its calls refused: the tools
 * lead the provider's cached prompt, so changing them mid-thread loses the
 * cache. Only `save_instructions` comes and goes, with an interview whose end
 * replaces the system text anyway.
 */

export interface ToolDependencies {
	collaborations: Pick<Collaborations.Interface, "open" | "collectAnswer">;
	artifacts: Artifacts.AuthoringInterface;
	/** Where a built-in tool's calls are written down. */
	calls: Pick<ToolCallRepository.Interface, "open" | "close">;
	approvals: Pick<ApprovedToolCalls.Interface, "beginExecution">;
	/** Resumed approval calls stay guarded even if fresh server metadata calls them read-only. */
	approvalBoundTools?: ReadonlySet<string>;
	/** The built-in tools this installation offers, by key. */
	builtIn: BuiltInTools.Offered;
	/** The tools that work in the pod's sandbox. */
	sandbox: SandboxTools.Offered;
	/** The pod connections' tools, keyed `handle__tool`, reached through `tool_search` and `call_tool`. */
	connections: Readonly<Record<string, OfferedTool>>;
	/** The thread's files: where long tool results are kept, and what `read_thread_file` reads. */
	files: Pick<ThreadFiles.Interface, "read" | "write">;
	/** Where an interviewing agent's own instructions are saved. */
	agents: Pick<AgentRepository.Interface, "finishInterview">;
	/** For a tool that watches for something else to happen. */
	bus: Pick<EventBus.Interface, "subscribe">;
	/** Runs a service's Effect from inside the SDK's promise-shaped tool call. */
	run: RunEffect;
	/** The reply being written, for tools that leave a mark in it. */
	reply: {
		length: () => number;
		noteCollaboration: (
			collaboration: Pick<CollaborationPart, "id" | "atOffset">,
		) => Effect.Effect<void>;
		noteToolCall: (call: {
			id: string;
			atOffset: number;
			mutating: boolean;
		}) => Effect.Effect<void>;
		markActed: () => Effect.Effect<void>;
	};
	/** The turn's own abort signal, so a cancelled turn stops its tools too. */
	signal: AbortSignal;
}

/** What people, and the model, are told of a call to a tool the pod has turned off. */
const TOOL_TURNED_OFF = UserMessage.of`This tool is turned off for bots in this pod.`;

const TOOL_UNAVAILABLE = UserMessage.of`This tool is switched off for this bot.`;

const NO_SANDBOX = UserMessage.of`This bot has no sandbox to work in.`;

export function toolsForTurn(prepared: PreparedTurn, deps: ToolDependencies): ToolSet {
	const tools: ToolSet = {};
	const recording: RecordingOptions = {
		calls: deps.calls,
		files: deps.files,
		run: deps.run,
		from: {
			threadId: prepared.context.thread.id,
			messageId: prepared.responseMessage.id,
			turnId: prepared.turnId,
		},
		replyLength: deps.reply.length,
		noteToolCall: deps.reply.noteToolCall,
		markActed: deps.reply.markActed,
	};
	for (const [key, tool] of Object.entries(deps.builtIn.tools)) {
		tools[key] = deps.builtIn.usable.includes(key)
			? recorded(key, tool, recording)
			: refused(key, tool, TOOL_UNAVAILABLE, recording);
	}
	// Once a command or a write has started, the sandbox may have changed, so
	// a turn that fails afterwards is not run again.
	for (const [key, tool] of Object.entries(deps.sandbox.tools)) {
		tools[key] = deps.sandbox.usable
			? recorded(key, tool, { ...recording, mutating: key !== READ_FILE_TOOL })
			: refused(key, tool, NO_SANDBOX, recording);
	}
	// What a request does once allowed changes something, so a turn that fails
	// afterwards is not run again.
	for (const [key, request] of Object.entries(deps.sandbox.requests)) {
		if (!deps.sandbox.usable) {
			tools[key] = refused(key, request.tool, NO_SANDBOX, recording);
			continue;
		}
		const asked = recorded(key, request.tool, {
			...recording,
			mutating: true,
			approval: { approvals: deps.approvals, binding: { kind: "built-in" } },
		});
		// A refused call was never put to anyone, so it has no approval to run under.
		tools[key] = {
			...asked,
			execute: (input, options) => {
				const reason = request.refusal(input);
				const call = reason ? refused(key, request.tool, reason, recording) : asked;
				return call.execute?.(input, options);
			},
		};
	}
	const connectionTools: Record<string, Tool> = {};
	for (const [key, offered] of Object.entries(deps.connections)) {
		const approvalBound = deps.approvalBoundTools?.has(key) ?? false;
		// An approved call is left to its approval, which refuses it if the tool
		// was turned off since.
		if (offered.access === "off" && !approvalBound) {
			connectionTools[key] = refused(key, offered.tool, TOOL_TURNED_OFF, recording);
			continue;
		}
		connectionTools[key] = recorded(key, offered.tool, {
			...recording,
			mutating: offered.mutating || approvalBound,
			...(offered.access === "ask" || approvalBound
				? {
						approval: { approvals: deps.approvals, binding: bindingOf(offered) },
					}
				: {}),
		});
	}
	const artifacts = artifactTools({
		by: {
			workspaceId: prepared.context.thread.workspaceId,
			podId: prepared.context.agent.podId,
			agentId: prepared.context.agent.id,
			threadId: prepared.context.thread.id,
		},
		authoring: deps.artifacts,
		run: deps.run,
	});
	for (const [key, tool] of Object.entries(artifacts)) {
		if (prepared.context.agent.disabledTools.includes(key)) continue;
		tools[key] = recorded(key, tool, { ...recording, mutating: MUTATING_ARTIFACT_TOOLS.has(key) });
	}
	// Always these two, so a pod gaining or losing tools leaves the tools sent, and the cached prompt, as they were.
	const catalog = buildCatalog(deps.connections);
	tools[TOOL_SEARCH] = recorded(TOOL_SEARCH, toolSearchTool({ catalog }), recording);
	// Not recorded itself: the tool it calls records the call, under its own name.
	tools[CALL_TOOL] = callToolTool({ catalog, connectionTools });
	tools[SEARCH_HISTORY_TOOL] = recorded(
		SEARCH_HISTORY_TOOL,
		searchHistoryTool({
			threadId: prepared.context.thread.id,
			before: prepared.context.compaction?.keptFrom,
			run: deps.run,
		}),
		recording,
	);
	tools[READ_THREAD_FILE_TOOL] = recorded(
		READ_THREAD_FILE_TOOL,
		readThreadFileTool({ threadId: prepared.context.thread.id, files: deps.files, run: deps.run }),
		recording,
	);
	if (prepared.context.agent.interviewing) {
		tools[SAVE_INSTRUCTIONS_TOOL] = recorded(
			SAVE_INSTRUCTIONS_TOOL,
			saveInstructionsTool({
				agent: { workspaceId: prepared.context.thread.workspaceId, id: prepared.context.agent.id },
				agents: deps.agents,
				run: deps.run,
			}),
			{ ...recording, mutating: true },
		);
	}
	tools.collaborate = collaborateTool({
		from: {
			threadId: prepared.context.thread.id,
			agentId: prepared.context.agent.id,
			turnId: prepared.turnId,
			messageId: prepared.responseMessage.id,
		},
		collaborations: deps.collaborations,
		bus: deps.bus,
		run: deps.run,
		replyLength: deps.reply.length,
		noteCollaboration: deps.reply.noteCollaboration,
		signal: deps.signal,
	});
	return tools;
}

/** What a call to a connection's tool is approved against: the connection as it is configured now. */
export function bindingOf(offered: OfferedTool): ToolCallRepository.ApprovalBinding {
	return {
		kind: "connection",
		connectionId: offered.connectionId,
		connectionRevision: offered.connectionRevision,
		remoteToolName: offered.remoteToolName,
	};
}
