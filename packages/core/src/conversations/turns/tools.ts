import type { CollaborationPart } from "@sugabots/contracts";
import type { Tool, ToolApprovalConfiguration, ToolSet } from "ai";
import { type Effect, Schema } from "effect";
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
import {
	type CatalogEntry,
	catalogListing,
	catalogOf,
	definitionJson,
} from "../tools/tool-search/catalog.ts";
import {
	bridgedCallOf,
	CALL_TOOL,
	callTool,
	TOOL_SEARCH,
	toolSearchTool,
} from "../tools/tool-search/tool.ts";
import type { ApprovedToolCalls } from "./approvals/approved-calls.ts";
import type { OfferedConnectionTools } from "./context.ts";
import { directToolDefinitionsLimitTokens, estimatedTokens } from "./context-window.ts";
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
 * recorded as refused without reaching the server. When the turn bridges its
 * connection tools, `tool_search` and `call_tool` are offered in their place,
 * and a call is recorded as the tool it names.
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
	/** The pod connections' tools, and whether they are offered as themselves or behind the bridge. */
	connections: ConnectionOffer;
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

/**
 * How a turn offers its pod's connection tools to the model.
 *
 * `direct`: every tool is in the request, as its own tool. `bridged`: the
 * request carries `tool_search` and `call_tool` instead, and the model reads
 * a found tool's schema from the search's result. A pod whose tools fit is
 * offered them directly; one whose tools would crowd out the conversation is
 * bridged, so a server listing hundreds of tools costs a short list in the
 * turn's note rather than the model's window.
 */
export const ConnectionToolMode = Schema.Literals(["direct", "bridged"]);
export type ConnectionToolMode = typeof ConnectionToolMode.Type;

/** A turn's connection tools, keyed `handle__tool`, and how they are offered. */
export interface ConnectionOffer {
	mode: ConnectionToolMode;
	tools: Readonly<Record<string, OfferedTool>>;
	/** Every tool as a request would define it, which a bridged turn searches. */
	catalog: readonly CatalogEntry[];
}

/** A turn with no connection tools. */
export const noConnectionTools: ConnectionOffer = { mode: "direct", tools: {}, catalog: [] };

/**
 * How `tools` are offered to a model whose window is `windowTokens`: the mode
 * a resumed turn already chose, or else directly while their definitions fit
 * within the share of the window tools may take. A tool set to `off` counts,
 * since offered directly it is sent.
 */
export function connectionOfferFor(
	tools: Readonly<Record<string, OfferedTool>>,
	windowTokens: number,
	chosen?: ConnectionToolMode,
): ConnectionOffer {
	const catalog = catalogOf(tools);
	const definitionTokens = catalog.reduce(
		(total, entry) => total + estimatedTokens(definitionJson(entry)),
		0,
	);
	const fits = definitionTokens <= directToolDefinitionsLimitTokens(windowTokens);
	return { mode: chosen ?? (fits ? "direct" : "bridged"), tools, catalog };
}

/** Which calls wait for a person to allow them: each to a tool whose access is `ask`. */
export function connectionToolApproval(
	offer: ConnectionOffer,
): ToolApprovalConfiguration<ToolSet, unknown> {
	switch (offer.mode) {
		case "direct":
			return Object.fromEntries(
				Object.entries(offer.tools)
					.filter(([, offered]) => offered.access === "ask")
					.map(([key]) => [key, "user-approval" as const]),
			);
		case "bridged":
			return {
				[CALL_TOOL]: (input: unknown) => {
					const call = bridgedCallOf(input);
					const offered = call && Object.hasOwn(offer.tools, call.tool) && offer.tools[call.tool];
					return offered && offered.access === "ask" ? ("user-approval" as const) : undefined;
				},
			};
	}
}

/** What the turn's note tells the model of its connection tools. */
export function connectionToolsNote(offer: ConnectionOffer): OfferedConnectionTools {
	switch (offer.mode) {
		case "direct":
			return { mode: "direct", keys: Object.keys(offer.tools) };
		case "bridged":
			return { mode: "bridged", listing: catalogListing(offer.catalog) };
	}
}

/**
 * The connection tool a call waiting for approval is for, and its input. A
 * call through the bridge is for the tool it names, so it is approved,
 * recorded and checked on resuming as that tool.
 */
export function connectionCallOf(
	offer: ConnectionOffer,
	toolCall: { toolName: string; input: unknown },
): { tool: string; input: unknown } | undefined {
	switch (offer.mode) {
		case "direct":
			return { tool: toolCall.toolName, input: toolCall.input };
		case "bridged": {
			const call = toolCall.toolName === CALL_TOOL ? bridgedCallOf(toolCall.input) : undefined;
			return call && { tool: call.tool, input: call.arguments };
		}
	}
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
	Object.assign(tools, connectionToolsOffered(deps, recording));
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

/** The connection tools the model is offered: each tool itself, or the bridge to them. */
function connectionToolsOffered(deps: ToolDependencies, recording: RecordingOptions): ToolSet {
	const connectionTools = connectionToolsForTurn(deps, recording);
	switch (deps.connections.mode) {
		case "direct":
			return connectionTools;
		case "bridged":
			return {
				[TOOL_SEARCH]: recorded(
					TOOL_SEARCH,
					toolSearchTool({ catalog: deps.connections.catalog }),
					recording,
				),
				// Not recorded itself: the tool it calls records the call, under its own name.
				[CALL_TOOL]: callTool({ callable: connectionTools }),
			};
	}
}

/** Each connection tool as the turn runs it: recorded, approved when it must be, or refused. */
function connectionToolsForTurn(
	deps: ToolDependencies,
	recording: RecordingOptions,
): Record<string, Tool> {
	const tools: Record<string, Tool> = {};
	for (const [key, offered] of Object.entries(deps.connections.tools)) {
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
	return tools;
}
