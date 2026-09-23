import type { CollaborationPart } from "@sugabots/contracts";
import type { ToolSet } from "ai";
import type { Effect } from "effect";
import type { RunEffect } from "../../database/database.ts";
import type { EventBus } from "../../database/events/bus.ts";
import type { PreparedTurn } from "../turns/store.ts";
import type { ToolApprovalStore } from "./approvals/store.ts";
import { type RecordingOptions, recorded } from "./calls/recorded.ts";
import type { ToolCallStore } from "./calls/store.ts";
import type { CollaborationStore } from "./collaborate/store.ts";
import { collaborateTool } from "./collaborate/tool.ts";
import type { OfferedTool } from "./connections.ts";

/**
 * The tools a turn's model may call. One directory per tool under `tools/`;
 * this is the only place that knows which ones exist, so adding a tool is a
 * folder and a line here rather than a change to the worker.
 *
 * Three kinds. The crew tool `collaborate` reaches other agents
 * and leave their own records. The built-in tools do work for the agent, and
 * the connection tools do work at a server the workspace configured; every
 * call to either is recorded as a `tool_call` part of the reply (`calls/`).
 */

export interface ToolDependencies {
	collaborations: CollaborationStore;
	/** Where a built-in tool's calls are written down. */
	calls: ToolCallStore;
	approvals: ToolApprovalStore;
	automaticallyAllowedTools: ReadonlySet<string>;
	/** Resumed approval calls stay guarded even if fresh server metadata calls them read-only. */
	approvalBoundTools?: ReadonlySet<string>;
	/** The built-in tools this installation offers, by key. */
	builtIn: ToolSet;
	/** The pod connections' tools, keyed `handle__tool`, each with whether it changes things. */
	connections?: Record<string, OfferedTool>;
	/** For a tool that watches for something else to happen. */
	bus: Pick<EventBus, "subscribe">;
	/** Runs a store Effect from inside the SDK's promise-shaped tool call. */
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
		tools[key] = recorded(key, offered.tool, {
			...recording,
			mutating: offered.mutating || approvalBound,
			...(offered.mutating || approvalBound
				? {
						approval: {
							store: deps.approvals,
							connectionId: offered.connectionId,
							connectionRevision: offered.connectionRevision,
							remoteToolName: offered.remoteToolName,
							automaticallyAllowed: deps.automaticallyAllowedTools.has(key),
						},
					}
				: {}),
		});
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
