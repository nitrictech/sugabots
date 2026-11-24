import { FILE_WRITING_TOOLS, START_CHAT_TOOL } from "@sugabots/contracts";
import { docPages } from "@sugabots/docs";
import { userText } from "@sugabots/errors";
import type { Tool, ToolSet } from "ai";
import type { Effect } from "effect";
import type { RunEffect } from "../../database/database.ts";
import type { ChatFileStore } from "../../files/chat-file-store.ts";
import type { Files } from "../../files/files.ts";
import { botSettingsPath } from "../../server-settings/web-app-paths.ts";
import type { BotAdministration } from "../../workspaces/bots/bot-administration.ts";
import type { AssistantGuide } from "../assistant/assistant-guide.ts";
import type { BotAutomations } from "../automations/bot-automations.ts";
import type { BotChats } from "../chats/bot-chats.ts";
import { SEARCH_HISTORY_TOOL } from "../store/message-text.ts";
import { WORKSPACE_GUIDE_TOOL, workspaceGuideTool } from "../tools/assistant/tool.ts";
import {
	AUTOMATION_TOOL_WRITES_OR_DELETES,
	AUTOMATION_TOOLS,
	AUTOMATIONS_KEY,
	automationTools,
	hasAutomationTools,
} from "../tools/automations/tool.ts";
import type { BuiltInTools } from "../tools/built-in.ts";
import { READ_FILE_TOOL, SHARE_FILE_TOOL } from "../tools/computer/tools.ts";
import type { ComputerTools, Request } from "../tools/computer.ts";
import type { OfferedTool } from "../tools/connectors.ts";
import { fileTools } from "../tools/files/tool.ts";
import { MARK_RESOLVED_TOOL, markResolvedTool } from "../tools/mark-resolved/tool.ts";
import { READ_CHAT_FILE_TOOL, readChatFileTool } from "../tools/read-chat-file/tool.ts";
import { READ_DOCS_TOOL, readDocsTool } from "../tools/read-docs/tool.ts";
import { SAVE_INSTRUCTIONS_TOOL, saveInstructionsTool } from "../tools/save-instructions/tool.ts";
import { searchHistoryTool } from "../tools/search-history/tool.ts";
import { startChatTool } from "../tools/start-chat/tool.ts";
import { buildCatalog, type CatalogEntry } from "../tools/tool-search/catalog.ts";
import { CALL_TOOL, callToolTool, TOOL_SEARCH, toolSearchTool } from "../tools/tool-search/tool.ts";
import { WORKSPACE_ROLE_TOOL, workspaceRoleTool } from "../tools/workspace-role/tool.ts";
import type { ApprovedToolCalls } from "./approvals/approved-calls.ts";
import type { PreparedTurn } from "./execution.ts";
import type { TurnStore } from "./store.ts";
import { type RecordingOptions, recorded, refused } from "./tool-calls/recorded.ts";
import type { ToolCallStore } from "./tool-calls/store.ts";

/**
 * The tools a turn's model may call. One directory per tool under `tools/`;
 * this is the only place that knows which ones exist, so adding a tool is a
 * folder and a line here rather than a change to the turn's steps.
 *
 * Three kinds. The built-in tools do work for the bot,
 * the computer tools work in the computer of the project the turn works in
 * (see `TurnContext.projectId`), and the connector tools do work at a server
 * one of the turn's connectors reaches: the project's and the bot's own, the
 * project's winning when both have a connector with the same handle. Every
 * call is recorded as a `tool_call` part of the reply
 * (`tool-calls/recorded.ts`). A bot asks another bot for help by mentioning
 * it in its reply, not through a tool.
 * Connector tools, and the built-in tools a bot needs only now and then,
 * such as `read_docs` and `workspace_role`, are in the catalog: reached
 * through `tool_search` and `call_tool`, so they cost a line in the turn's
 * note rather than a whole description and schema in every request.
 *
 * A tool that can't run is still offered, and its calls refused: the tools
 * lead the provider's cached prompt, so changing them mid-chat loses the
 * cache.
 */

interface ToolDependencies {
	authoring: Files.AuthoringInterface;
	/** Where a built-in tool's calls are written down. */
	calls: Pick<ToolCallStore.Interface, "open" | "close" | "completedOutputs">;
	approvals: Pick<ApprovedToolCalls.Interface, "beginExecution">;
	/** Where the turn records that a tool which may change something started. */
	turns: Pick<TurnStore.Interface, "markActed">;
	/** Resumed approval calls stay guarded even if fresh server metadata calls them read-only. */
	approvalBoundTools: ReadonlySet<string>;
	/** The built-in tools this server offers, by key. */
	builtIn: BuiltInTools.Offered;
	/** The tools that work in the computer of the project the turn works in. */
	computer: ComputerTools.Offered;
	/** The tools of the project's and the bot's connectors, keyed `handle__tool`, reached through `tool_search` and `call_tool`. */
	connectors: Readonly<Record<string, OfferedTool>>;
	/** The chat's files: where long tool results are kept, and what `read_chat_file` reads. */
	files: Pick<ChatFileStore.Interface, "read" | "readMessageFile" | "write">;
	/** Where the bot's own instructions are saved, as the member it is answering. */
	bots: Pick<BotAdministration.Interface, "update">;
	/** Where the web app is served, for links to its pages. */
	webAppUrl: string;
	/** The automations of the project the turn works in, read and changed for the member it is answering. */
	automations: BotAutomations.Interface;
	/** Chats the bot starts, and marks resolved, for the member it is answering. */
	chats: Pick<BotChats.Interface, "start" | "markResolved">;
	/** Runs a service's Effect from inside the SDK's promise-shaped tool call. */
	run: RunEffect;
	/** The reply being written, for tools that leave a mark in it. */
	reply: {
		length: () => number;
		noteToolCall: (call: {
			id: string;
			atOffset: number;
			writeOrDelete: boolean;
		}) => Effect.Effect<void>;
	};
	/**
	 * On a Personal Assistant's turn answering its member: what it knows of
	 * their workspace, and what it does there for them once they approve.
	 */
	assistant?: {
		guide: Pick<AssistantGuide.Interface, "guide">;
		member: AssistantGuide.Member;
		requests: Readonly<Record<string, Request>>;
	};
}

/** What members, and the model, are told of a call to a tool the bot has turned off. */
const TOOL_TURNED_OFF = userText`This tool is turned off for this bot.`;

const NO_COMPUTER = userText`This bot has no computer to work in.`;

const readDocs = readDocsTool(docPages);

/**
 * The computer tools after which a failed turn can run again: they change
 * nothing in the computer, and the files a reply shared go when it starts again.
 */
const RETRYABLE_COMPUTER_TOOLS: ReadonlySet<string> = new Set([READ_FILE_TOOL, SHARE_FILE_TOOL]);

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
			chatId: prepared.context.chat.id,
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
			: refused(key, tool, TOOL_TURNED_OFF, recording);
	}
	// Once a command or a write has started, the computer may have changed, so
	// a turn that fails afterwards is not run again.
	for (const [key, tool] of Object.entries(deps.computer.tools)) {
		tools[key] = deps.computer.usable
			? recorded(key, tool, { ...recording, writeOrDelete: !RETRYABLE_COMPUTER_TOOLS.has(key) })
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
			writeOrDelete: true,
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
		[WORKSPACE_ROLE_TOOL]: workspaceRoleTool({
			chatId: prepared.context.chat.id,
			workspaceId: prepared.context.chat.workspaceId,
			run: deps.run,
		}),
	};
	const catalogTools: Record<string, Tool> = {};
	for (const [key, found] of Object.entries(builtInFound)) {
		catalogTools[key] = recorded(key, found, recording);
	}
	for (const [key, offered] of Object.entries(deps.connectors)) {
		const approvalBound = deps.approvalBoundTools.has(key);
		// An approved call is left to its approval, which refuses it if the tool
		// was turned off since.
		if (offered.access === "off" && !approvalBound) {
			catalogTools[key] = refused(key, offered.tool, TOOL_TURNED_OFF, recording);
			continue;
		}
		catalogTools[key] = recorded(key, offered.tool, {
			...recording,
			writeOrDelete: offered.writeOrDelete || approvalBound,
			...(offered.access === "ask" || approvalBound
				? {
						approval: { approvals: deps.approvals, binding: bindingOf(offered) },
					}
				: {}),
		});
	}
	const writing = fileTools({
		by: {
			botId: prepared.context.bot.id,
			chatId: prepared.context.chat.id,
		},
		turnId: prepared.turnId,
		calls: deps.calls,
		authoring: deps.authoring,
		run: deps.run,
	});
	for (const [key, tool] of Object.entries(writing)) {
		if (prepared.context.bot.disabledTools.includes(key)) continue;
		tools[key] = recorded(key, tool, { ...recording, writeOrDelete: FILE_WRITING_TOOLS.has(key) });
	}
	// Always these two, so a bot gaining or losing tools leaves the tools sent, and the cached prompt, as they were.
	const catalog = buildCatalog(deps.connectors, builtInFound);
	tools[TOOL_SEARCH] = recorded(TOOL_SEARCH, toolSearchTool({ catalog }), recording);
	// Not recorded itself: the tool it calls records the call, under its own name.
	tools[CALL_TOOL] = callToolTool({ catalog, tools: catalogTools });
	tools[SEARCH_HISTORY_TOOL] = recorded(
		SEARCH_HISTORY_TOOL,
		searchHistoryTool({
			chatId: prepared.context.chat.id,
			before: prepared.context.compaction?.keptFrom,
			usesComputer: prepared.context.bot.usesComputer,
			run: deps.run,
		}),
		recording,
	);
	tools[READ_CHAT_FILE_TOOL] = recorded(
		READ_CHAT_FILE_TOOL,
		readChatFileTool({
			chatId: prepared.context.chat.id,
			files: deps.files,
			acceptsImages: prepared.context.bot.acceptsImages,
			run: deps.run,
		}),
		recording,
	);
	if (hasAutomationTools(prepared.context)) {
		const { projectId } = prepared.context;
		const automationsOff = prepared.context.bot.disabledTools.includes(AUTOMATIONS_KEY);
		const ownAutomations = automationTools({
			bot: { botId: prepared.context.bot.id, projectId, askerId: prepared.context.askerId },
			timeZone: prepared.context.workspaceTimeZone,
			automations: deps.automations,
			run: deps.run,
		});
		for (const key of AUTOMATION_TOOLS) {
			tools[key] = automationsOff
				? refused(key, ownAutomations[key], TOOL_TURNED_OFF, recording)
				: recorded(key, ownAutomations[key], {
						...recording,
						writeOrDelete: AUTOMATION_TOOL_WRITES_OR_DELETES[key],
					});
		}
	}
	const askedBot: BotChats.Bot = {
		botId: prepared.context.bot.id,
		workspaceId: prepared.context.chat.workspaceId,
		askerId: prepared.context.askerId,
	};
	// Offered only when a member asked: a turn answering a brief or an
	// automation could only be refused, and a briefed bot starting chats of its
	// own would let bots brief each other without end. Nor to a helper, which
	// writes no briefs. A Personal Assistant's is among its requests, which wait
	// for its member to allow them.
	if (prepared.context.askerId && prepared.context.reason !== "collaboration" && !deps.assistant) {
		tools[START_CHAT_TOOL] = recorded(
			START_CHAT_TOOL,
			startChatTool({ bot: askedBot, chats: deps.chats, run: deps.run }),
			{ ...recording, writeOrDelete: true },
		);
	}
	// Only a project's chat is ever resolved; an automation's feed is not.
	if (prepared.context.chat.kind === "project_chat") {
		tools[MARK_RESOLVED_TOOL] = recorded(
			MARK_RESOLVED_TOOL,
			markResolvedTool({
				bot: {
					...askedBot,
					askerId: prepared.context.askerId ?? prepared.context.startedFor,
				},
				chatId: prepared.context.chat.id,
				chats: deps.chats,
				run: deps.run,
			}),
			{ ...recording, writeOrDelete: true },
		);
	}
	if (deps.assistant) {
		tools[WORKSPACE_GUIDE_TOOL] = recorded(
			WORKSPACE_GUIDE_TOOL,
			workspaceGuideTool({ ...deps.assistant, run: deps.run }),
			recording,
		);
		// Each changes the workspace for the member, so each waits for them to allow it.
		for (const [key, request] of Object.entries(deps.assistant.requests)) {
			tools[key] = recorded(key, request.tool, {
				...recording,
				writeOrDelete: true,
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
				askerId: prepared.context.askerId,
				bots: deps.bots,
				settingsUrl: `${deps.webAppUrl}${botSettingsPath(prepared.context.workspaceSlug, prepared.context.bot.handle)}`,
				run: deps.run,
			}),
			{ ...recording, writeOrDelete: true },
		);
	}
	return { tools, catalog };
}

/** What a call to a connector's tool is approved against: the connector as it is configured now. */
export function bindingOf(offered: OfferedTool): ToolCallStore.ApprovalBinding {
	return {
		kind: "connector",
		connectorId: offered.connectorId,
		connectorRevision: offered.connectorRevision,
		remoteToolName: offered.remoteToolName,
	};
}
