import { type CollaborationPart, FILE_WRITING_TOOLS, START_TASK_TOOL } from "@sugabots/contracts";
import { docPages } from "@sugabots/docs";
import { userText } from "@sugabots/errors";
import type { Tool, ToolSet } from "ai";
import type { Effect } from "effect";
import type { RunEffect } from "../../database/database.ts";
import type { EventBus } from "../../database/events/bus.ts";
import type { ConversationFiles } from "../../files/conversation-files.ts";
import type { Files } from "../../files/files.ts";
import { botSettingsPath } from "../../installation/web-app-paths.ts";
import type { BotAdministration } from "../../workspaces/bots/bot-administration.ts";
import type { AssistantGuide } from "../assistant/assistant-guide.ts";
import type { BotAutomations } from "../automations/bot-automations.ts";
import type { BotTasks } from "../chats/bot-tasks.ts";
import { SEARCH_HISTORY_TOOL } from "../repository/message-text.ts";
import { WORKSPACE_GUIDE_TOOL, workspaceGuideTool } from "../tools/assistant/tool.ts";
import {
	AUTOMATION_TOOL_MUTATES,
	AUTOMATION_TOOLS,
	AUTOMATIONS_KEY,
	automationTools,
} from "../tools/automations/tool.ts";
import type { BuiltInTools } from "../tools/built-in.ts";
import type { Collaborations } from "../tools/collaborate/collaborations.ts";
import {
	COLLABORATE_TOOL,
	type CollaborateToolOptions,
	collaborateTool,
} from "../tools/collaborate/tool.ts";
import { READ_FILE_TOOL, SHARE_FILE_TOOL } from "../tools/computer/tools.ts";
import type { ComputerTools, Request } from "../tools/computer.ts";
import type { OfferedTool } from "../tools/connections.ts";
import { fileTools } from "../tools/files/tool.ts";
import { MARK_DONE_TOOL, markDoneTool } from "../tools/mark-done/tool.ts";
import {
	READ_CONVERSATION_FILE_TOOL,
	readConversationFileTool,
} from "../tools/read-conversation-file/tool.ts";
import { READ_DOCS_TOOL, readDocsTool } from "../tools/read-docs/tool.ts";
import { SAVE_INSTRUCTIONS_TOOL, saveInstructionsTool } from "../tools/save-instructions/tool.ts";
import { searchHistoryTool } from "../tools/search-history/tool.ts";
import { startTaskTool } from "../tools/start-task/tool.ts";
import { buildCatalog, type CatalogEntry } from "../tools/tool-search/catalog.ts";
import { CALL_TOOL, callToolTool, TOOL_SEARCH, toolSearchTool } from "../tools/tool-search/tool.ts";
import { WORKSPACE_ACCESS_TOOL, workspaceAccessTool } from "../tools/workspace-access/tool.ts";
import type { ApprovedToolCalls } from "./approvals/approved-calls.ts";
import type { PreparedTurn } from "./execution.ts";
import type { TurnRepository } from "./repository.ts";
import { type RecordingOptions, recorded, refused } from "./tool-calls/recorded.ts";
import type { ToolCallRepository } from "./tool-calls/repository.ts";

/**
 * The tools a turn's model may call. One directory per tool under `tools/`;
 * this is the only place that knows which ones exist, so adding a tool is a
 * folder and a line here rather than a change to the turn's steps.
 *
 * Four kinds. The collaboration tool `collaborate` reaches other bots
 * and leave their own records. The built-in tools do work for the bot, the
 * computer tools work in the bot's computer, and the connection tools do work
 * at a server the workspace configured; every call to any of them is recorded
 * as a `tool_call` part of the reply (`calls/`).
 * Connection tools, and the built-in tools a bot needs only now and then,
 * such as `read_docs` and `workspace_access`, are in the catalog: reached
 * through `tool_search` and `call_tool`, so they cost a line in the turn's
 * note rather than a whole description and schema in every request.
 *
 * A tool that can't run is still offered, and its calls refused: the tools
 * lead the provider's cached prompt, so changing them mid-conversation loses the
 * cache.
 */

interface ToolDependencies {
	collaborations: Pick<Collaborations.Interface, "open" | "collectAnswer">;
	authoring: Files.AuthoringInterface;
	/** Where a built-in tool's calls are written down. */
	calls: Pick<ToolCallRepository.Interface, "open" | "close" | "completedOutputs">;
	approvals: Pick<ApprovedToolCalls.Interface, "beginExecution">;
	/** Where the turn records that a tool which may change something started. */
	turns: Pick<TurnRepository.Interface, "markActed">;
	/** Resumed approval calls stay guarded even if fresh server metadata calls them read-only. */
	approvalBoundTools?: ReadonlySet<string>;
	/** The built-in tools this installation offers, by key. */
	builtIn: BuiltInTools.Offered;
	/** The tools that work in the bot's computer. */
	computer: ComputerTools.Offered;
	/** The bot's connections' tools, keyed `handle__tool`, reached through `tool_search` and `call_tool`. */
	connections: Readonly<Record<string, OfferedTool>>;
	/** The conversation's files: where long tool results are kept, and what `read_conversation_file` reads. */
	files: Pick<ConversationFiles.Interface, "read" | "readMessageFile" | "write">;
	/** Where the bot's own instructions are saved, as the person it is answering. */
	bots: Pick<BotAdministration.Interface, "update">;
	/** Where the web app is served, for links to its pages. */
	webAppUrl: string;
	/** The bot's own automations, read and changed for the person it is answering. */
	automations: BotAutomations.Interface;
	/** Tasks the bot starts, and marks done, for the person it is answering. */
	tasks: Pick<BotTasks.Interface, "start" | "markDone">;
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
	};
	/** The turn's own abort signal, so a cancelled turn stops its tools too. */
	signal: AbortSignal;
	/**
	 * On a Personal Assistant's turn answering its person: what it knows of
	 * their workspace, and what it does there for them once they approve.
	 */
	assistant?: {
		guide: Pick<AssistantGuide.Interface, "guide">;
		person: AssistantGuide.Person;
		requests: Readonly<Record<string, Request>>;
	};
}

/** What people, and the model, are told of a call to a tool the bot has turned off. */
const TOOL_TURNED_OFF = userText`This tool is turned off for this bot.`;

const TOOL_UNAVAILABLE = userText`This tool is switched off for this bot.`;

const ASSISTANT_ASKS_ONLY_FOR_ITS_PERSON = userText`A Personal Assistant asks other bots only while answering its person, who approves each request.`;

const NO_COMPUTER = userText`This bot has no computer to work in.`;

const readDocs = readDocsTool(docPages);

/**
 * The computer tools after which a failed turn can run again: they change
 * nothing in the computer, and the files a reply shared go when it starts again.
 */
const RERUNNABLE_COMPUTER_TOOLS: ReadonlySet<string> = new Set([READ_FILE_TOOL, SHARE_FILE_TOOL]);

/** The tools sent with the turn's requests, and the catalog `tool_search` finds the rest in. */
interface TurnTools {
	tools: ToolSet;
	catalog: CatalogEntry[];
}

export function toolsForTurn(prepared: PreparedTurn, deps: ToolDependencies): TurnTools {
	const tools: ToolSet = {};
	const recording: RecordingOptions = {
		calls: deps.calls,
		files: deps.files,
		run: deps.run,
		from: {
			conversationId: prepared.context.conversation.id,
			messageId: prepared.responseMessage.id,
			turnId: prepared.turnId,
		},
		replyLength: deps.reply.length,
		noteToolCall: deps.reply.noteToolCall,
		markActed: () => deps.turns.markActed(prepared.turnId),
	};
	for (const [key, tool] of Object.entries(deps.builtIn.tools)) {
		tools[key] = deps.builtIn.usable.includes(key)
			? recorded(key, tool, recording)
			: refused(key, tool, TOOL_UNAVAILABLE, recording);
	}
	// Once a command or a write has started, the computer may have changed, so
	// a turn that fails afterwards is not run again.
	for (const [key, tool] of Object.entries(deps.computer.tools)) {
		tools[key] = deps.computer.usable
			? recorded(key, tool, { ...recording, mutating: !RERUNNABLE_COMPUTER_TOOLS.has(key) })
			: refused(key, tool, NO_COMPUTER, recording);
	}
	// What a request does once allowed changes something, so a turn that fails
	// afterwards is not run again.
	for (const [key, request] of Object.entries(deps.computer.requests)) {
		if (!deps.computer.usable) {
			tools[key] = refused(key, request.tool, NO_COMPUTER, recording);
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
	// Sugabots' own tools in the catalog, which are always there to be found.
	const builtInFound: Record<string, Tool> = {
		[READ_DOCS_TOOL]: readDocs,
		[WORKSPACE_ACCESS_TOOL]: workspaceAccessTool({
			conversationId: prepared.context.conversation.id,
			workspaceId: prepared.context.conversation.workspaceId,
			run: deps.run,
		}),
	};
	const catalogTools: Record<string, Tool> = {};
	for (const [key, found] of Object.entries(builtInFound)) {
		catalogTools[key] = recorded(key, found, recording);
	}
	for (const [key, offered] of Object.entries(deps.connections)) {
		const approvalBound = deps.approvalBoundTools?.has(key) ?? false;
		// An approved call is left to its approval, which refuses it if the tool
		// was turned off since.
		if (offered.access === "off" && !approvalBound) {
			catalogTools[key] = refused(key, offered.tool, TOOL_TURNED_OFF, recording);
			continue;
		}
		catalogTools[key] = recorded(key, offered.tool, {
			...recording,
			mutating: offered.mutating || approvalBound,
			...(offered.access === "ask" || approvalBound
				? {
						approval: { approvals: deps.approvals, binding: bindingOf(offered) },
					}
				: {}),
		});
	}
	const writing = fileTools({
		by: {
			workspaceId: prepared.context.conversation.workspaceId,
			botId: prepared.context.bot.id,
			conversationId: prepared.context.conversation.id,
		},
		turnId: prepared.turnId,
		calls: deps.calls,
		authoring: deps.authoring,
		run: deps.run,
	});
	for (const [key, tool] of Object.entries(writing)) {
		if (prepared.context.bot.disabledTools.includes(key)) continue;
		tools[key] = recorded(key, tool, { ...recording, mutating: FILE_WRITING_TOOLS.has(key) });
	}
	// Always these two, so a bot gaining or losing tools leaves the tools sent, and the cached prompt, as they were.
	const catalog = buildCatalog(deps.connections, builtInFound);
	tools[TOOL_SEARCH] = recorded(TOOL_SEARCH, toolSearchTool({ catalog }), recording);
	// Not recorded itself: the tool it calls records the call, under its own name.
	tools[CALL_TOOL] = callToolTool({ catalog, tools: catalogTools });
	tools[SEARCH_HISTORY_TOOL] = recorded(
		SEARCH_HISTORY_TOOL,
		searchHistoryTool({
			conversationId: prepared.context.conversation.id,
			before: prepared.context.compaction?.keptFrom,
			usesComputer: prepared.context.bot.usesComputer,
			run: deps.run,
		}),
		recording,
	);
	tools[READ_CONVERSATION_FILE_TOOL] = recorded(
		READ_CONVERSATION_FILE_TOOL,
		readConversationFileTool({
			conversationId: prepared.context.conversation.id,
			files: deps.files,
			acceptsImages: prepared.context.bot.acceptsImages,
			run: deps.run,
		}),
		recording,
	);
	// Sugabots manages a Personal Assistant, which has no automations of its own.
	if (prepared.context.bot.assistantOf === null) {
		const automationsOff = prepared.context.bot.disabledTools.includes(AUTOMATIONS_KEY);
		const ownAutomations = automationTools({
			bot: { botId: prepared.context.bot.id, askedBy: prepared.context.askedBy },
			timeZone: prepared.context.workspaceTimeZone,
			automations: deps.automations,
			run: deps.run,
		});
		for (const key of AUTOMATION_TOOLS) {
			tools[key] = automationsOff
				? refused(key, ownAutomations[key], TOOL_UNAVAILABLE, recording)
				: recorded(key, ownAutomations[key], {
						...recording,
						mutating: AUTOMATION_TOOL_MUTATES[key],
					});
		}
	}
	const askedBot: BotTasks.Bot = {
		botId: prepared.context.bot.id,
		workspaceId: prepared.context.conversation.workspaceId,
		askedBy: prepared.context.askedBy,
	};
	// Offered only when a person asked: a turn answering a bot, a brief or an
	// automation could only be refused, and a briefed bot starting tasks of its
	// own would let bots brief each other without end. A Personal Assistant's
	// is among its requests, which wait for its person to allow them.
	if (prepared.context.askedBy && !deps.assistant) {
		tools[START_TASK_TOOL] = recorded(
			START_TASK_TOOL,
			startTaskTool({ bot: askedBot, tasks: deps.tasks, run: deps.run }),
			{ ...recording, mutating: true },
		);
	}
	// Only a task is ever done; a channel's conversation or an automation's feed is not.
	if (prepared.context.conversation.kind === "task") {
		tools[MARK_DONE_TOOL] = recorded(
			MARK_DONE_TOOL,
			markDoneTool({
				bot: {
					...askedBot,
					askedBy: prepared.context.askedBy ?? prepared.context.startedFor,
				},
				conversationId: prepared.context.conversation.id,
				tasks: deps.tasks,
				run: deps.run,
			}),
			{ ...recording, mutating: true },
		);
	}
	if (deps.assistant) {
		tools[WORKSPACE_GUIDE_TOOL] = recorded(
			WORKSPACE_GUIDE_TOOL,
			workspaceGuideTool({ ...deps.assistant, run: deps.run }),
			recording,
		);
		// Each changes the workspace for the person, so each waits for them to allow it.
		for (const [key, request] of Object.entries(deps.assistant.requests)) {
			tools[key] = recorded(key, request.tool, {
				...recording,
				mutating: true,
				approval: { approvals: deps.approvals, binding: { kind: "built-in" } },
			});
		}
	}
	// A Personal Assistant's instructions are Sugabots', so it has none of its own to save.
	if (prepared.context.bot.assistantOf === null) {
		tools[SAVE_INSTRUCTIONS_TOOL] = recorded(
			SAVE_INSTRUCTIONS_TOOL,
			saveInstructionsTool({
				botId: prepared.context.bot.id,
				askedBy: prepared.context.askedBy,
				bots: deps.bots,
				settingsUrl: `${deps.webAppUrl}${botSettingsPath(prepared.context.workspaceSlug, prepared.context.bot.handle)}`,
				run: deps.run,
			}),
			{ ...recording, mutating: true },
		);
	}
	const collaborating: CollaborateToolOptions = {
		from: {
			conversationId: prepared.context.conversation.id,
			botId: prepared.context.bot.id,
			turnId: prepared.turnId,
			messageId: prepared.responseMessage.id,
		},
		collaborations: deps.collaborations,
		bus: deps.bus,
		run: deps.run,
		replyLength: deps.reply.length,
		noteCollaboration: deps.reply.noteCollaboration,
		signal: deps.signal,
	};
	// A Personal Assistant's is among its requests, which wait for its person to
	// allow them; on a turn that isn't answering its person there is nobody to ask.
	if (prepared.context.bot.assistantOf === null) {
		tools[COLLABORATE_TOOL] = collaborateTool(collaborating);
	} else if (!deps.assistant) {
		tools[COLLABORATE_TOOL] = refused(
			COLLABORATE_TOOL,
			collaborateTool(collaborating),
			ASSISTANT_ASKS_ONLY_FOR_ITS_PERSON,
			recording,
		);
	}
	return { tools, catalog };
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
