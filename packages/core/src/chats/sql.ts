import type {
	AutomationState,
	AutomationTrigger,
	AutomationTriggerAuthor,
	AutomationTriggerKind,
	ChatKind,
	JsonValue,
	MessageStatus,
	RunState,
	RunTrigger,
	RunTriggerKind,
	SystemBotKey,
	ToolApprovalStatus,
	ToolCallStatus,
	WrittenFileKind,
} from "@sugabots/contracts";
import type { UserText } from "@sugabots/errors";
import { sql } from "drizzle-orm";
import {
	type AnyPgColumn,
	boolean,
	check,
	foreignKey,
	index,
	integer,
	jsonb,
	pgTable,
	pgView,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { primaryKey, stamp, updatedStamp } from "../database/sql.ts";
import { bot, member, project, workspace } from "../workspaces/sql.ts";

/**
 * Work a project's lead bot does on its own, in the project, on its computer
 * and with its connectors, started by its routines and triggers. A bot's own
 * automations are its default project's.
 */
export const automation = pgTable(
	"automation",
	{
		id: primaryKey(),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspace.id, { onDelete: "cascade" }),
		projectId: uuid("project_id").notNull(),
		name: text("name").notNull(),
		instructions: text("instructions").notNull(),
		state: text("state").$type<AutomationState>().notNull().default("enabled"),
		/**
		 * When the automation paused itself after two failed runs in a row, until
		 * somebody turns it on again or pauses it by hand.
		 */
		pausedAfterFailuresAt: timestamp("paused_after_failures_at", { withTimezone: true }),
		createdById: uuid("created_by_id").references(() => member.id, { onDelete: "set null" }),
		/** Set when a bot working in the project made it, at `createdById`'s request. */
		createdByBotId: uuid("created_by_bot_id").references(() => bot.id, { onDelete: "set null" }),
		deletedAt: timestamp("deleted_at", { withTimezone: true }),
		createdAt: stamp("created_at"),
		updatedAt: updatedStamp("updated_at"),
	},
	(table) => [
		foreignKey({
			columns: [table.projectId, table.workspaceId],
			foreignColumns: [project.id, project.workspaceId],
			name: "automation_project_workspace_fkey",
		}).onDelete("cascade"),
		check("automation_state_valid", sql`${table.state} in ('enabled', 'paused')`),
		check(
			"automation_paused_after_failures_valid",
			sql`${table.pausedAfterFailuresAt} is null or ${table.state} = 'paused'`,
		),
		uniqueIndex("automation_project_name_idx")
			.on(table.projectId, table.name)
			.where(sql`${table.deletedAt} is null`),
		uniqueIndex("automation_id_workspace_id_idx").on(table.id, table.workspaceId),
	],
);

/**
 * A routine or trigger that starts an automation; an automation may have several, of any
 * kinds, or none and run only when someone runs it. `settings` holds what
 * each kind is, with the kind; a webhook keeps its secret in its own column,
 * and a routine its next time, while its automation is enabled.
 */
export const automationTrigger = pgTable(
	"automation_trigger",
	{
		id: primaryKey(),
		workspaceId: uuid("workspace_id").notNull(),
		automationId: uuid("automation_id").notNull(),
		/** Follows `settings`, so the kind and its settings can't disagree. */
		kind: text("kind")
			.$type<AutomationTriggerKind>()
			.generatedAlwaysAs(sql`settings->>'kind'`)
			.notNull(),
		settings: jsonb("settings").$type<AutomationTriggerSettings>().notNull(),
		/** A webhook's secret, encrypted by `Secrets` for that one use: checking a signature needs the secret itself. */
		secretEncrypted: text("secret_encrypted"),
		/** When a routine next runs its automation; null while the automation is paused. */
		nextScheduledAt: timestamp("next_scheduled_at", { withTimezone: true }),
		createdAt: stamp("created_at"),
		updatedAt: updatedStamp("updated_at"),
	},
	(table) => [
		foreignKey({
			columns: [table.automationId, table.workspaceId],
			foreignColumns: [automation.id, automation.workspaceId],
			name: "automation_trigger_automation_workspace_fkey",
		}).onDelete("cascade"),
		check(
			"automation_trigger_secret_valid",
			sql`${table.secretEncrypted} is null or ${table.kind} = 'webhook'`,
		),
		check(
			"automation_trigger_routine_valid",
			sql`${table.kind} = 'routine' or ${table.nextScheduledAt} is null`,
		),
		index("automation_trigger_automation_idx").on(table.automationId, table.createdAt),
		index("automation_trigger_due_idx")
			.on(table.nextScheduledAt, table.id)
			.where(sql`${table.nextScheduledAt} is not null`),
	],
);

/**
 * The kinds of chat members open and post in: a project's chat (a
 * bot's chats being its default project's) and an automation's feed. The
 * others are opened from one of these.
 */
export const OPENABLE_CHAT_KINDS = [
	"project_chat",
	"automation_feed",
] as const satisfies readonly ChatKind[];

/**
 * A project's chat, an automation run or feed, or a system bot's chat: what
 * every kind has. What makes each kind what it is lives in the kind's own
 * table, keyed by the same id (`project_chat`, `run`, `automation_feed`,
 * `system_chat`), and `placedChat` reads them back together.
 *
 * Every chat has exactly the kind row its kind says. A kind row can
 * only name a chat of its kind (each references `(id, kind)`), the
 * `chat_has_kind_row` trigger refuses, at commit, a chat left
 * without one, and deleting a kind row deletes its chat.
 *
 * Deleting a chat, by any route including its workspace's, project's
 * or bot's cascade, queues its blobs for deletion: see `blob_deletion`.
 */
export const chat = pgTable(
	"chat",
	{
		id: primaryKey(),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspace.id, { onDelete: "cascade" }),
		kind: text("kind").$type<ChatKind>().notNull(),
		title: text("title").notNull(),
		createdAt: stamp("created_at"),
		updatedAt: updatedStamp("updated_at"),
	},
	(table) => [
		check(
			"chat_kind_valid",
			sql`${table.kind} in ('project_chat', 'run', 'automation_feed', 'system_chat')`,
		),
		// What each kind table points at, so a kind row only names a chat of its kind.
		uniqueIndex("chat_id_kind_idx").on(table.id, table.kind),
		uniqueIndex("chat_id_kind_workspace_idx").on(table.id, table.kind, table.workspaceId),
		index("chat_workspace_created_at_idx").on(table.workspaceId, table.createdAt),
		index("chat_workspace_updated_at_idx").on(table.workspaceId, table.updatedAt),
	],
);

/** A kind table's `kind`: always its own kind, so its row can only name a chat of that kind. */
const kindOf = <Kind extends ChatKind>(kind: Kind) =>
	text("kind")
		.$type<Kind>()
		.notNull()
		.generatedAlwaysAs(sql.raw(`'${kind}'`));

/** A kind row's chat, which must be of the row's kind and in the row's workspace. */
const chatOfKind = (
	table: { chatId: AnyPgColumn; kind: AnyPgColumn; workspaceId: AnyPgColumn },
	name: string,
) =>
	foreignKey({
		columns: [table.chatId, table.kind, table.workspaceId],
		foreignColumns: [chat.id, chat.kind, chat.workspaceId],
		name,
	}).onDelete("cascade");

/**
 * One of a project's chats: a project is made of its chats, with no main
 * chat beside them. A bot's chats are its default project's.
 */
export const projectChat = pgTable(
	"project_chat",
	{
		chatId: uuid("chat_id").primaryKey(),
		kind: kindOf("project_chat"),
		workspaceId: uuid("workspace_id").notNull(),
		projectId: uuid("project_id").notNull(),
		/**
		 * When somebody marked the chat resolved, which moves it off the list
		 * until something new is posted in it or it is reopened.
		 */
		resolvedAt: timestamp("resolved_at", { withTimezone: true }),
		/** The member who started it. */
		startedById: uuid("started_by_id")
			.notNull()
			.references(() => member.id, { onDelete: "restrict" }),
	},
	(table) => [
		chatOfKind(table, "project_chat_chat_fkey"),
		foreignKey({
			columns: [table.projectId, table.workspaceId],
			foreignColumns: [project.id, project.workspaceId],
			name: "project_chat_project_workspace_fkey",
		}).onDelete("cascade"),
		index("project_chat_project_idx").on(table.projectId),
	],
);

/**
 * An automation's own chat, where each of its runs posts its result.
 * It is in the automation's project, and its lead bot answers there.
 */
export const automationFeed = pgTable(
	"automation_feed",
	{
		chatId: uuid("chat_id").primaryKey(),
		kind: kindOf("automation_feed"),
		workspaceId: uuid("workspace_id").notNull(),
		automationId: uuid("automation_id").notNull(),
	},
	(table) => [
		chatOfKind(table, "automation_feed_chat_fkey"),
		foreignKey({
			columns: [table.automationId, table.workspaceId],
			foreignColumns: [automation.id, automation.workspaceId],
			name: "automation_feed_automation_workspace_fkey",
		}).onDelete("cascade"),
		// One feed per automation.
		uniqueIndex("automation_feed_automation_idx").on(table.automationId),
	],
);

/**
 * Where a system bot works on another chat, which it serves rather
 * than belongs to: one per system bot per served chat, hidden from
 * every list.
 */
export const systemChat = pgTable(
	"system_chat",
	{
		chatId: uuid("chat_id").primaryKey(),
		kind: kindOf("system_chat"),
		workspaceId: uuid("workspace_id").notNull(),
		/** The system bot working here. */
		botId: uuid("bot_id").notNull(),
		systemBotKey: text("system_bot_key").$type<SystemBotKey>().notNull(),
		servedChatId: uuid("served_chat_id")
			.notNull()
			.references((): AnyPgColumn => chat.id, { onDelete: "cascade" }),
	},
	(table) => [
		chatOfKind(table, "system_chat_chat_fkey"),
		foreignKey({
			columns: [table.botId, table.workspaceId],
			foreignColumns: [bot.id, bot.workspaceId],
			name: "system_chat_bot_workspace_fkey",
		}).onDelete("cascade"),
		uniqueIndex("system_chat_served_key_idx").on(table.servedChatId, table.systemBotKey),
	],
);

/**
 * One time an automation ran, in its own chat. An automation is
 * deleted by marking it so, keeping its runs; only deleting its project
 * deletes it, and its runs with it.
 */
export const automationRun = pgTable(
	"run",
	{
		id: primaryKey(),
		automationId: uuid("automation_id")
			.notNull()
			.references(() => automation.id, { onDelete: "cascade" }),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspace.id, { onDelete: "cascade" }),
		/** The bot that did the run: its project's lead bot when it was started. */
		botId: uuid("bot_id").notNull(),
		/** The run's own chat, where its bot works. */
		chatId: uuid("chat_id").notNull(),
		kind: kindOf("run"),
		/** The trigger that started it; null for a run someone started, or once the trigger is removed. */
		triggerId: uuid("trigger_id").references(() => automationTrigger.id, { onDelete: "set null" }),
		triggerKind: text("trigger_kind").$type<RunTriggerKind>().notNull(),
		triggerIdentity: text("trigger_identity"),
		trigger: jsonb("trigger").$type<RunTrigger>().notNull(),
		automationName: text("automation_name").notNull(),
		instructions: text("instructions").notNull(),
		state: text("state").$type<RunState>().notNull().default("queued"),
		error: text("error").$type<UserText>(),
		pendingTerminalState: text("pending_terminal_state").$type<"failed" | "cancelled">(),
		pendingTerminalError: text("pending_terminal_error").$type<UserText>(),
		acceptedAt: stamp("accepted_at"),
		startedAt: timestamp("started_at", { withTimezone: true }),
		finishedAt: timestamp("finished_at", { withTimezone: true }),
		createdAt: stamp("created_at"),
		updatedAt: updatedStamp("updated_at"),
	},
	(table) => [
		foreignKey({
			columns: [table.botId, table.workspaceId],
			foreignColumns: [bot.id, bot.workspaceId],
			name: "run_bot_workspace_fkey",
		}).onDelete("cascade"),
		foreignKey({
			columns: [table.automationId, table.workspaceId],
			foreignColumns: [automation.id, automation.workspaceId],
			name: "run_automation_workspace_fkey",
		}).onDelete("cascade"),
		chatOfKind(table, "run_chat_fkey"),
		check(
			"run_trigger_valid",
			sql`${table.trigger}->>'kind' = ${table.triggerKind}
				and (${table.triggerKind} = 'webhook' or ${table.triggerIdentity} is not null)
				and (${table.triggerKind} <> 'manual' or ${table.triggerId} is null)`,
		),
		check(
			"run_state_valid",
			sql`(
				${table.state} = 'queued'
				and ${table.startedAt} is null
				and ${table.finishedAt} is null
				and ${table.error} is null
			) or (
				${table.state} = 'running'
				and ${table.startedAt} is not null
				and ${table.finishedAt} is null
			) or (
				${table.state} in ('completed', 'failed', 'cancelled')
				and ${table.finishedAt} is not null
			)`,
		),
		check(
			"run_pending_terminal_valid",
			sql`(${table.pendingTerminalState} is null and ${table.pendingTerminalError} is null)
				or (${table.state} = 'running' and ${table.pendingTerminalState} = 'cancelled' and ${table.pendingTerminalError} is null)
				or (${table.state} = 'running' and ${table.pendingTerminalState} = 'failed' and ${table.pendingTerminalError} is not null)`,
		),
		uniqueIndex("run_chat_idx").on(table.chatId),
		// A trigger's retry of a delivery or an occurrence lands on the run it started.
		uniqueIndex("run_trigger_identity_idx")
			.on(table.triggerId, table.triggerIdentity)
			.where(sql`${table.triggerId} is not null and ${table.triggerIdentity} is not null`),
		uniqueIndex("run_manual_identity_idx")
			.on(table.automationId, table.triggerIdentity)
			.where(sql`${table.triggerKind} = 'manual'`),
		uniqueIndex("run_running_idx").on(table.automationId).where(sql`${table.state} = 'running'`),
		index("run_list_idx").on(table.automationId, table.acceptedAt, table.id),
	],
);

export const chatParticipant = pgTable(
	"chat_participant",
	{
		id: primaryKey(),
		chatId: uuid("chat_id")
			.notNull()
			.references(() => chat.id, { onDelete: "cascade" }),
		memberId: uuid("member_id").references(() => member.id, { onDelete: "cascade" }),
		botId: uuid("bot_id").references(() => bot.id, { onDelete: "cascade" }),
		createdAt: stamp("created_at"),
	},
	(table) => [
		check(
			"chat_participant_one_identity",
			sql`num_nonnulls(${table.memberId}, ${table.botId}) = 1`,
		),
		uniqueIndex("chat_participant_member_idx")
			.on(table.chatId, table.memberId)
			.where(sql`${table.memberId} is not null`),
		uniqueIndex("chat_participant_bot_idx")
			.on(table.chatId, table.botId)
			.where(sql`${table.botId} is not null`),
	],
);

/**
 * Why a bot was given a turn: a member mentioned it or replied to it, it was the default,
 * it leads a project whose chat got a message mentioning only members (`optional`: it
 * may stay silent), another bot's message mentioned it to ask for its help
 * (`collaboration`: it is that bot's helper), an automation ran, the bots it
 * asked for help have all answered (`hand_back`), it opened its setup
 * interview, or a bot started its chat for a member and briefed it.
 */
export type TurnReason =
	| "mention"
	| "reply"
	| "default"
	| "optional"
	| "collaboration"
	// An automation ran, whatever started it: a routine, a trigger or somebody by hand.
	| "automation"
	| "hand_back"
	| "interview"
	| "brief";

export type TurnStatus = "running" | "waiting" | "done" | "failed" | "cancelled";

/** The statuses of a turn that has not ended. */
export const ACTIVE_TURN_STATUSES = ["running", "waiting"] as const satisfies readonly TurnStatus[];

export const turn = pgTable(
	"turn",
	{
		id: primaryKey(),
		chatId: uuid("chat_id")
			.notNull()
			.references(() => chat.id, { onDelete: "cascade" }),
		botId: uuid("bot_id")
			.notNull()
			.references(() => bot.id, { onDelete: "cascade" }),
		triggerMessageId: uuid("trigger_message_id")
			.notNull()
			.references((): AnyPgColumn => message.id, { onDelete: "cascade" }),
		/**
		 * The workflow execution running this turn, including while it is
		 * suspended. A suspended turn resumes only in that execution.
		 */
		executionId: text("execution_id"),
		status: text("status").$type<TurnStatus>().notNull(),
		model: text("model").notNull(),
		contextTokens: integer("context_tokens"),
		contextCapacity: integer("context_capacity"),
		interruptRequested: boolean("interrupt_requested").notNull().default(false),
		/**
		 * Runs since the turn last got anywhere: started, retried or resumed, and
		 * back to zero when it stops to wait for approvals. A turn that keeps
		 * stopping its process is given up on rather than run forever.
		 */
		runs: integer("runs").notNull().default(0),
		/** A write/delete tool call crossed its durable dispatch boundary. */
		writeOrDeleteStarted: boolean("write_or_delete_started").notNull().default(false),
		/** Server-owned AI SDK messages needed to continue after tool approval. */
		checkpoint: jsonb("checkpoint").$type<unknown>(),
		// Why this bot got the turn, for reading the floor's decision back later.
		reason: text("reason").$type<TurnReason>(),
		error: text("error").$type<UserText>(),
		startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
		finishedAt: timestamp("finished_at", { withTimezone: true }),
		createdAt: stamp("created_at"),
		updatedAt: updatedStamp("updated_at"),
	},
	(table) => [
		index("turn_chat_started_at_idx").on(table.chatId, table.startedAt),
		uniqueIndex("turn_trigger_bot_idx").on(table.triggerMessageId, table.botId),
		index("turn_active_idx")
			.on(table.status, table.startedAt)
			.where(sql`${table.status} = 'running'`),
		check("turn_failure_has_error", sql`${table.status} <> 'failed' or ${table.error} is not null`),
	],
);

export const message = pgTable(
	"message",
	{
		id: primaryKey(),
		chatId: uuid("chat_id")
			.notNull()
			.references(() => chat.id, { onDelete: "cascade" }),
		authorMemberId: uuid("author_member_id").references(() => member.id, { onDelete: "restrict" }),
		authorBotId: uuid("author_bot_id").references(() => bot.id, { onDelete: "cascade" }),
		automationTrigger: jsonb("automation_trigger").$type<AutomationTriggerAuthor>(),
		status: text("status").$type<MessageStatus>().notNull(),
		parts: jsonb("parts").$type<StoredMessagePart[]>().notNull(),
		content: text("content").notNull(),
		mentions: jsonb("mentions").$type<string[]>().notNull().default([]),
		turnId: uuid("turn_id").references(() => turn.id, { onDelete: "set null" }),
		/** The automation run this message is the result of, posted in the automation's feed. */
		runId: uuid("run_id").references(() => automationRun.id, {
			onDelete: "set null",
		}),
		/** The message this one quotes and answers, always in the same chat. */
		replyToMessageId: uuid("reply_to_message_id").references((): AnyPgColumn => message.id, {
			onDelete: "set null",
		}),
		createdAt: stamp("created_at"),
	},
	(table) => [
		check(
			"message_one_author",
			sql`num_nonnulls(${table.authorMemberId}, ${table.authorBotId}, ${table.automationTrigger}) = 1`,
		),
		index("message_chat_created_at_idx").on(table.chatId, table.createdAt),
		// A run's result is posted once, in its automation's feed.
		uniqueIndex("message_run_idx").on(table.runId).where(sql`${table.runId} is not null`),
		// What a bot's search_history tool matches against. Stemmed so "hotels"
		// finds "hotel"; unstemmed as well, so a word the English rules drop or
		// change (German "was", French "hôtels") still matches as written; and
		// by trigram, a substring match that works in any script, including
		// languages written without spaces between words. Only complete messages
		// are searched, so only they are indexed: a reply being written rewrites its
		// content every second, and would otherwise re-index it each time.
		index("message_content_search_idx")
			.using("gin", sql`to_tsvector('english', ${table.content})`)
			.where(sql`${table.status} = 'complete'`),
		index("message_content_simple_search_idx")
			.using("gin", sql`to_tsvector('simple', ${table.content})`)
			.where(sql`${table.status} = 'complete'`),
		index("message_content_trigram_idx")
			.using("gin", table.content.op("gin_trgm_ops"))
			.where(sql`${table.status} = 'complete'`),
	],
);

/**
 * One emoji reaction to a message, by a member or by a bot. Each adds each
 * emoji at most once. A bot reacts only with 👀, to a message it read on an
 * optional turn and chose not to answer.
 */
export const messageReaction = pgTable(
	"message_reaction",
	{
		id: primaryKey(),
		messageId: uuid("message_id")
			.notNull()
			.references(() => message.id, { onDelete: "cascade" }),
		memberId: uuid("member_id").references(() => member.id, { onDelete: "cascade" }),
		botId: uuid("bot_id").references(() => bot.id, { onDelete: "cascade" }),
		emoji: text("emoji").notNull(),
		createdAt: stamp("created_at"),
	},
	(table) => [
		check("message_reaction_one_reactor", sql`num_nonnulls(${table.memberId}, ${table.botId}) = 1`),
		uniqueIndex("message_reaction_message_member_emoji_idx")
			.on(table.messageId, table.memberId, table.emoji)
			.where(sql`${table.memberId} is not null`),
		uniqueIndex("message_reaction_message_bot_emoji_idx")
			.on(table.messageId, table.botId, table.emoji)
			.where(sql`${table.botId} is not null`),
	],
);

/**
 * A message's parts as stored. A tool call is kept by reference: its output
 * lands on the `tool_call` row without rewriting the reply's parts. A file on
 * an automation run's posted result is kept whole: it names the version the
 * run wrote, which never changes.
 */
export type StoredMessagePart =
	| { type: "text"; text: string }
	| { type: "tool_call"; toolCallId: string }
	| { type: "written_file"; fileId: string; kind: WrittenFileKind; title: string; version: number };

/**
 * One call a bot's reply made to a tool: what it was given, what came back,
 * and where in the reply it happened. See `turns/tool-calls/store.ts`.
 *
 * `chat_id` is here as well as on the message so the table can be
 * filtered by chat without a join. `input` and `output` are truncated to
 * `MAX_STORED_JSON_CHARACTERS` before they are written; the model saw the
 * whole result.
 */
export const toolCall = pgTable(
	"tool_call",
	{
		id: primaryKey(),
		chatId: uuid("chat_id")
			.notNull()
			.references(() => chat.id, { onDelete: "cascade" }),
		/** The reply the call was made in. */
		messageId: uuid("message_id")
			.notNull()
			.references(() => message.id, { onDelete: "cascade" }),
		turnId: uuid("turn_id")
			.notNull()
			.references(() => turn.id, { onDelete: "cascade" }),
		tool: text("tool").notNull(),
		/** Stable AI SDK call identity across approval continuation. */
		sdkToolCallId: text("sdk_tool_call_id"),
		approvalId: text("approval_id"),
		approvalStatus: text("approval_status").$type<ToolApprovalStatus>(),
		approvalReason: text("approval_reason"),
		decidedById: uuid("decided_by_id").references(() => member.id, { onDelete: "set null" }),
		decidedAt: timestamp("decided_at", { withTimezone: true }),
		connectorId: uuid("connector_id"),
		connectorRevision: integer("connector_revision"),
		remoteToolName: text("remote_tool_name"),
		/** The complete input used for continuation; `input` below is display-bounded. */
		executionInput: jsonb("execution_input").$type<JsonValue>(),
		input: jsonb("input").$type<JsonValue>().notNull(),
		output: jsonb("output").$type<JsonValue>(),
		status: text("status").$type<ToolCallStatus>().notNull().default("running"),
		error: text("error").$type<UserText>(),
		/** Whether the tool may have changed something at the other end. */
		writeOrDelete: boolean("write_or_delete").notNull().default(false),
		/** Where in the reply's text the call was made. */
		atOffset: integer("at_offset").notNull(),
		startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
		finishedAt: timestamp("finished_at", { withTimezone: true }),
		createdAt: stamp("created_at"),
		updatedAt: updatedStamp("updated_at"),
	},
	(table) => [
		index("tool_call_message_idx").on(table.messageId),
		index("tool_call_turn_idx").on(table.turnId),
		uniqueIndex("tool_call_sdk_call_idx").on(table.turnId, table.sdkToolCallId),
		uniqueIndex("tool_call_approval_idx").on(table.approvalId),
	],
);

export type ToolCallRow = typeof toolCall.$inferSelect;

/**
 * What a bot reads in place of a long chat's older messages, written by the
 * Compaction bot. The bot reads `condensed`, then every message from `keptFrom` on word
 * for word. The condensed account covers the messages from `historyStartsAt` to `keptFrom`;
 * anything earlier is left out, and the bot searches for it when it needs it.
 */
export const chatCompaction = pgTable("compaction", {
	chatId: uuid("chat_id")
		.primaryKey()
		.references(() => chat.id, { onDelete: "cascade" }),
	condensed: text("condensed").notNull(),
	historyStartsAt: timestamp("history_starts_at", { withTimezone: true }).notNull(),
	keptFrom: timestamp("kept_from", { withTimezone: true }).notNull(),
	updatedAt: updatedStamp("updated_at"),
});

/**
 * A member's read cursor in a chat: every message there up to
 * `readThrough` has been on their screen. No row means they never opened it.
 *
 * A message is stamped when its transaction begins, so one that began before
 * a read was recorded and committed after it counts as read. The window is a
 * transaction long, and the next message moves the chat on.
 */
export const readCursor = pgTable(
	"read_cursor",
	{
		id: primaryKey(),
		chatId: uuid("chat_id")
			.notNull()
			.references(() => chat.id, { onDelete: "cascade" }),
		memberId: uuid("member_id")
			.notNull()
			.references(() => member.id, { onDelete: "cascade" }),
		readThrough: timestamp("read_through", { withTimezone: true }).notNull(),
		createdAt: stamp("created_at"),
		updatedAt: updatedStamp("updated_at"),
	},
	(table) => [uniqueIndex("read_cursor_member_chat_idx").on(table.memberId, table.chatId)],
);

/**
 * Every chat with what its kind table says about it, read as one
 * row: the shape most reads want. Columns a kind does not have are null. The
 * kind tables stay the only place each fact is written.
 */
export const placedChat = pgView("placed_chat", {
	id: uuid("id").notNull(),
	workspaceId: uuid("workspace_id").notNull(),
	kind: text("kind").$type<ChatKind>().notNull(),
	title: text("title").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
	/**
	 * The bot it is with: the bot whose default project a chat, an
	 * automation's feed or a run is in, or the system bot. Null in a project
	 * members made.
	 */
	botId: uuid("bot_id"),
	/** The project a chat, an automation's feed or a run is in: the automation's. */
	projectId: uuid("project_id"),
	/**
	 * The chat members open that it is in: its own id on a project's
	 * chat and an automation's feed; the automation's feed on a run.
	 * Null on a system bot's chat, which serves one rather than
	 * belonging to one.
	 */
	rootChatId: uuid("root_chat_id"),
	/** What it was opened under: the chat a system bot's serves. */
	parentChatId: uuid("parent_chat_id"),
	/** Who started a project's chat. */
	startedById: uuid("started_by_id"),
	systemBotKey: text("system_bot_key").$type<SystemBotKey>(),
	resolvedAt: timestamp("resolved_at", { withTimezone: true }),
	/** On an automation's feed: the automation. */
	automationId: uuid("automation_id"),
}).as(sql`select
	c.id, c.workspace_id, c.kind, c.title, c.created_at, c.updated_at,
	coalesce(p.default_of_bot_id, sc.bot_id) as bot_id,
	p.id as project_id,
	case c.kind
		when 'run' then rf.chat_id
		when 'system_chat' then null
		else c.id
	end as root_chat_id,
	sc.served_chat_id as parent_chat_id,
	cc.started_by_id,
	sc.system_bot_key,
	cc.resolved_at,
	f.automation_id
from ${chat} c
left join ${projectChat} cc on cc.chat_id = c.id
left join ${automationRun} r on r.chat_id = c.id
left join ${automationFeed} rf on rf.automation_id = r.automation_id
left join ${automationFeed} f on f.chat_id = c.id
left join ${automation} a on a.id = coalesce(r.automation_id, f.automation_id)
left join ${project} p on p.id = coalesce(cc.project_id, a.project_id)
left join ${systemChat} sc on sc.chat_id = c.id`);

export type ChatRow = typeof chat.$inferSelect;
export type PlacedChatRow = typeof placedChat.$inferSelect;
export type AutomationRow = typeof automation.$inferSelect;
export type AutomationTriggerRow = typeof automationTrigger.$inferSelect;
/** What a trigger is, by kind: a trigger as the API shows it, without what the row keeps apart. */
export type AutomationTriggerSettings = AutomationTrigger extends infer T
	? T extends AutomationTrigger
		? Omit<T, "id" | "nextScheduledAt">
		: never
	: never;
export type RunRow = typeof automationRun.$inferSelect;
export type MessageRow = typeof message.$inferSelect;
export type TurnRow = typeof turn.$inferSelect;
