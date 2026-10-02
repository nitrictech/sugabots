import type { CollaborationPart } from "@sugabots/contracts";
import type { ToolSet } from "ai";
import type { Effect } from "effect";
import type { RunEffect } from "../../database/database.ts";
import type { EventBus } from "../../database/events/bus.ts";
import { UserMessage } from "../../user-message.ts";
import type { AgentRepository } from "../../workspaces/agents/agent-repository.ts";
import { SEARCH_HISTORY_TOOL } from "../threads/message-text.ts";
import type { Collaborations } from "../tools/collaborate/collaborations.ts";
import { collaborateTool } from "../tools/collaborate/tool.ts";
import type { OfferedTool } from "../tools/connections.ts";
import { SAVE_INSTRUCTIONS_TOOL, saveInstructionsTool } from "../tools/save-instructions/tool.ts";
import { searchHistoryTool } from "../tools/search-history/tool.ts";
import type { ApprovedToolCalls } from "./approvals/approved-calls.ts";
import type { PreparedTurn } from "./execution.ts";
import { type RecordingOptions, recorded, refused } from "./tool-calls/recorded.ts";
import type { ToolCallRepository } from "./tool-calls/repository.ts";

/**
 * The tools a turn's model may call. One directory per tool under `tools/`;
 * this is the only place that knows which ones exist, so adding a tool is a
 * folder and a line here rather than a change to the turn's steps.
 *
 * Three kinds. The crew tool `collaborate` reaches other agents
 * and leave their own records. The built-in tools do work for the agent, and
 * the connection tools do work at a server the workspace configured; every
 * call to either is recorded as a `tool_call` part of the reply (`calls/`).
 * A connection tool turned off is offered all the same, and each call to it is
 * recorded as refused without reaching the server.
 * `search_history` is recorded the same way, and offered only once the
 * thread has been compacted; `save_instructions` too, offered only while the
 * agent interviews its creator.
 */

export interface ToolDependencies {
	collaborations: Pick<Collaborations.Interface, "open" | "collectAnswer">;
	/** Where a built-in tool's calls are written down. */
	calls: Pick<ToolCallRepository.Interface, "open" | "close">;
	approvals: Pick<ApprovedToolCalls.Interface, "beginExecution">;
	/** Resumed approval calls stay guarded even if fresh server metadata calls them read-only. */
	approvalBoundTools?: ReadonlySet<string>;
	/** The built-in tools this installation offers, by key. */
	builtIn: ToolSet;
	/** The pod connections' tools, keyed `handle__tool`, each with whether it changes things. */
	connections?: Record<string, OfferedTool>;
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

export function toolsForTurn(prepared: PreparedTurn, deps: ToolDependencies): ToolSet {
	const tools: ToolSet = {};
	const recording: RecordingOptions = {
		calls: deps.calls,
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
	for (const [key, tool] of Object.entries(deps.builtIn)) {
		tools[key] = recorded(key, tool, recording);
	}
	for (const [key, offered] of Object.entries(deps.connections ?? {})) {
		const approvalBound = deps.approvalBoundTools?.has(key) ?? false;
		// An approved call is left to its approval, which refuses it if the tool
		// was turned off since.
		if (offered.access === "off" && !approvalBound) {
			tools[key] = refused(key, offered.tool, TOOL_TURNED_OFF, recording);
			continue;
		}
		tools[key] = recorded(key, offered.tool, {
			...recording,
			mutating: offered.mutating || approvalBound,
			...(offered.access === "ask" || approvalBound
				? {
						approval: {
							approvals: deps.approvals,
							connectionId: offered.connectionId,
							connectionRevision: offered.connectionRevision,
							remoteToolName: offered.remoteToolName,
						},
					}
				: {}),
		});
	}
	if (prepared.context.compaction) {
		tools[SEARCH_HISTORY_TOOL] = recorded(
			SEARCH_HISTORY_TOOL,
			searchHistoryTool({
				threadId: prepared.context.thread.id,
				before: prepared.context.compaction.keptFrom,
				run: deps.run,
			}),
			recording,
		);
	}
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
	if (prepared.context.crew.length > 0) {
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
	}
	return tools;
}
