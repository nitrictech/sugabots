import type {
	AutomationState,
	AutomationTrigger,
	AutomationTriggerAuthor,
	AutomationTriggerKind,
	CollaborationStatus,
	ConversationKind,
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
import { bot, project, user, workspace } from "../workspaces/sql.ts";

/**
 * Work a project's lead bot does on its own, in the project, on its computer
 * and with its connections, started by its routines and triggers. A bot's own
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
		createdById: uuid("created_by_id").references(() => user.id, { onDelete: "set null" }),
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
		/** A webhook's secret, sealed with `Credentials`: checking a signature needs the secret itself. */
		secretEncrypted: text("secret_encrypted"),
		/**
		 * The scrypt hash of a webhook's bearer secret made before secrets were
		 * kept sealed. It still admits callers until the secret is replaced.
		 */
		secretDigest: text("secret_digest"),
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
			sql`(${table.secretEncrypted} is null and ${table.secretDigest} is null)
				or (${table.kind} = 'webhook' and (${table.secretEncrypted} is null or ${table.secretDigest} is null))`,
		),
		check(
			"automation_trigger_digest_valid",
			sql`${table.secretDigest} is null or ${table.settings}->'auth'->>'kind' = 'bearer'`,
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
 * The kinds of conversation people open and post in: a project's thread (a
 * bot's threads being its default project's), an automation's feed, and a
 * direct message between people. The others are opened from one of these.
 */
export const OPENABLE_CONVERSATION_KINDS = [
	"project_thread",
	"automation_feed",
	"direct_message",
] as const satisfies readonly ConversationKind[];

/**
 * A project's thread, a direct message, a collaboration, an automation run or
 * feed, or a system bot's conversation: what every kind has. What
 * makes each kind what it is lives in the kind's own table, keyed by the same
 * id (`project_thread`, `direct_message`, `collaboration`,
 * `run`, `automation_feed`, `system_conversation`), and `placedConversation`
 * reads them back together.
 *
 * Every conversation has exactly the kind row its kind says. A kind row can
 * only name a conversation of its kind (each references `(id, kind)`), the
 * `conversation_has_kind_row` trigger refuses, at commit, a conversation left
 * without one, and deleting a kind row deletes its conversation.
 *
 * Deleting a conversation, by any route including its workspace's, project's
 * or bot's cascade, queues its blobs for deletion: see `blob_deletion`.
 */
export const conversation = pgTable(
	"conversation",
	{
		id: primaryKey(),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspace.id, { onDelete: "cascade" }),
		kind: text("kind").$type<ConversationKind>().notNull(),
		title: text("title").notNull(),
		createdAt: stamp("created_at"),
		updatedAt: updatedStamp("updated_at"),
	},
	(table) => [
		check(
			"conversation_kind_valid",
			sql`${table.kind} in ('project_thread', 'direct_message', 'collaboration', 'run', 'automation_feed', 'system')`,
		),
		// What each kind table points at, so a kind row only names a conversation of its kind.
		uniqueIndex("conversation_id_kind_idx").on(table.id, table.kind),
		uniqueIndex("conversation_id_kind_workspace_idx").on(table.id, table.kind, table.workspaceId),
		index("conversation_workspace_created_at_idx").on(table.workspaceId, table.createdAt),
		index("conversation_workspace_updated_at_idx").on(table.workspaceId, table.updatedAt),
	],
);

/** A kind table's `kind`: always its own kind, so its row can only name a conversation of that kind. */
const kindOf = <Kind extends ConversationKind>(kind: Kind) =>
	text("kind")
		.$type<Kind>()
		.notNull()
		.generatedAlwaysAs(sql.raw(`'${kind}'`));

/** A kind row's conversation, which must be of the row's kind and in the row's workspace. */
const conversationOfKind = (
	table: { conversationId: AnyPgColumn; kind: AnyPgColumn; workspaceId: AnyPgColumn },
	name: string,
) =>
	foreignKey({
		columns: [table.conversationId, table.kind, table.workspaceId],
		foreignColumns: [conversation.id, conversation.kind, conversation.workspaceId],
		name,
	}).onDelete("cascade");

/**
 * One of a project's threads: a project is made of its threads and has no
 * chat of its own. A bot's threads are its default project's.
 */
export const projectThread = pgTable(
	"project_thread",
	{
		conversationId: uuid("conversation_id").primaryKey(),
		kind: kindOf("project_thread"),
		workspaceId: uuid("workspace_id").notNull(),
		projectId: uuid("project_id").notNull(),
		/** When somebody archived the thread, which hides it from the project's list. */
		archivedAt: timestamp("archived_at", { withTimezone: true }),
		/** When somebody marked the thread done, until something new is posted in it or it is reopened. */
		doneAt: timestamp("done_at", { withTimezone: true }),
		/** Who started it; null on a thread from before every thread was started by a person. */
		startedById: uuid("started_by_id").references(() => user.id, { onDelete: "restrict" }),
	},
	(table) => [
		conversationOfKind(table, "project_thread_conversation_fkey"),
		foreignKey({
			columns: [table.projectId, table.workspaceId],
			foreignColumns: [project.id, project.workspaceId],
			name: "project_thread_project_workspace_fkey",
		}).onDelete("cascade"),
		index("project_thread_project_idx").on(table.projectId),
	],
);

/**
 * A conversation between two or more people, in no project and with no bots:
 * its members alone reach it (see `directMessageMember`).
 */
export const directMessage = pgTable(
	"direct_message",
	{
		conversationId: uuid("conversation_id").primaryKey(),
		kind: kindOf("direct_message"),
		workspaceId: uuid("workspace_id").notNull(),
		/**
		 * The ids of everybody in it, sorted and joined by `:`, so each set of
		 * people has one. It still names somebody after they have left, which
		 * `directMessageMember` does not once their account is gone.
		 */
		directKey: text("direct_key").notNull(),
		startedById: uuid("started_by_id").references(() => user.id, { onDelete: "restrict" }),
	},
	(table) => [
		conversationOfKind(table, "direct_message_conversation_fkey"),
		// One direct message per set of people in a workspace.
		uniqueIndex("direct_message_key_idx").on(table.workspaceId, table.directKey),
	],
);

/**
 * An automation's own conversation, where each of its runs posts its result.
 * It is in the automation's project, and its lead bot answers there.
 */
export const automationFeed = pgTable(
	"automation_feed",
	{
		conversationId: uuid("conversation_id").primaryKey(),
		kind: kindOf("automation_feed"),
		workspaceId: uuid("workspace_id").notNull(),
		automationId: uuid("automation_id").notNull(),
	},
	(table) => [
		conversationOfKind(table, "automation_feed_conversation_fkey"),
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
 * Where a system bot works on another conversation, which it serves rather
 * than belongs to: one per system bot per served conversation, hidden from
 * every list.
 */
export const systemConversation = pgTable(
	"system_conversation",
	{
		conversationId: uuid("conversation_id").primaryKey(),
		kind: kindOf("system"),
		workspaceId: uuid("workspace_id").notNull(),
		/** The system bot working here. */
		botId: uuid("bot_id").notNull(),
		systemBotKey: text("system_bot_key").$type<SystemBotKey>().notNull(),
		servedConversationId: uuid("served_conversation_id")
			.notNull()
			.references((): AnyPgColumn => conversation.id, { onDelete: "cascade" }),
	},
	(table) => [
		conversationOfKind(table, "system_conversation_conversation_fkey"),
		foreignKey({
			columns: [table.botId, table.workspaceId],
			foreignColumns: [bot.id, bot.workspaceId],
			name: "system_conversation_bot_workspace_fkey",
		}).onDelete("cascade"),
		uniqueIndex("system_conversation_served_key_idx").on(
			table.servedConversationId,
			table.systemBotKey,
		),
	],
);

/**
 * One time an automation ran, in its own conversation. An automation is
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
		/** The run's own conversation, where its bot works. */
		conversationId: uuid("conversation_id").notNull(),
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
		conversationOfKind(table, "run_conversation_fkey"),
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
				or (${table.state} = 'running' and ${table.pendingTerminalState} = 'failed')`,
		),
		uniqueIndex("run_conversation_idx").on(table.conversationId),
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

/**
 * Who is in a direct message, and so alone reaches it while they are in its
 * workspace. Unlike `conversationParticipant`, which records who has taken
 * part, this is the whole set from the start, and it never changes: a
 * different set of people is a different direct message. A row outlives its
 * person leaving the workspace, so rejoining gives the conversation back.
 */
export const directMessageMember = pgTable(
	"direct_message_member",
	{
		conversationId: uuid("conversation_id").notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		createdAt: stamp("created_at"),
	},
	(table) => [
		foreignKey({
			columns: [table.conversationId],
			foreignColumns: [directMessage.conversationId],
			name: "direct_message_member_direct_message_fkey",
		}).onDelete("cascade"),
		uniqueIndex("direct_message_member_conversation_user_idx").on(
			table.conversationId,
			table.userId,
		),
		index("direct_message_member_user_idx").on(table.userId),
	],
);

export const conversationParticipant = pgTable(
	"conversation_participant",
	{
		id: primaryKey(),
		conversationId: uuid("conversation_id")
			.notNull()
			.references(() => conversation.id, { onDelete: "cascade" }),
		userId: uuid("user_id").references(() => user.id, { onDelete: "cascade" }),
		botId: uuid("bot_id").references(() => bot.id, { onDelete: "cascade" }),
		createdAt: stamp("created_at"),
	},
	(table) => [
		check(
			"conversation_participant_one_identity",
			sql`num_nonnulls(${table.userId}, ${table.botId}) = 1`,
		),
		uniqueIndex("conversation_participant_user_idx")
			.on(table.conversationId, table.userId)
			.where(sql`${table.userId} is not null`),
		uniqueIndex("conversation_participant_bot_idx")
			.on(table.conversationId, table.botId)
			.where(sql`${table.botId} is not null`),
	],
);

/**
 * Why a bot was given a turn: a person mentioned it or replied to it, it was the default,
 * it leads a project whose thread got a message mentioning only people (`optional`: it
 * may stay silent),
 * it was asked to collaborate, an automation ran, a collaboration it stopped
 * waiting on ended, it opened its setup interview, or a bot started its conversation
 * for a person and briefed it.
 */
export type TurnReason =
	| "mention"
	| "reply"
	| "default"
	| "optional"
	| "collaboration"
	// An automation ran, whatever started it: a routine, a trigger or somebody by hand.
	| "automation"
	| "resume"
	| "interview"
	| "brief";

/**
 * A turn's reason as turns and the turn workflow's payloads store it: an
 * automation's run is stored as `routine`, which turns already stored and
 * workflows already running hold.
 */
export type StoredTurnReason = Exclude<TurnReason, "automation"> | "routine";

export const storedTurnReason = (reason: TurnReason): StoredTurnReason =>
	reason === "automation" ? "routine" : reason;

export const turnReasonOfStored = (stored: StoredTurnReason): TurnReason =>
	stored === "routine" ? "automation" : stored;

export type TurnStatus = "running" | "waiting" | "done" | "failed" | "cancelled";

/** The statuses of a turn that has not ended. */
export const ACTIVE_TURN_STATUSES = ["running", "waiting"] as const satisfies readonly TurnStatus[];

export const turn = pgTable(
	"turn",
	{
		id: primaryKey(),
		conversationId: uuid("conversation_id")
			.notNull()
			.references(() => conversation.id, { onDelete: "cascade" }),
		botId: uuid("bot_id")
			.notNull()
			.references(() => bot.id, { onDelete: "cascade" }),
		triggerMessageId: uuid("trigger_message_id")
			.notNull()
			.references((): AnyPgColumn => message.id, { onDelete: "cascade" }),
		/**
		 * The workflow execution running this turn, including while it is
		 * suspended. A resumed turn must be resumed by its owner.
		 */
		owner: text("owner"),
		status: text("status").$type<TurnStatus>().notNull(),
		model: text("model").notNull(),
		contextTokens: integer("context_tokens"),
		contextCapacity: integer("context_capacity"),
		cancelRequested: boolean("cancel_requested").notNull().default(false),
		/**
		 * Runs since the turn last got anywhere: started, retried or resumed, and
		 * back to zero when it stops to wait for approvals. A turn that keeps
		 * stopping its process is given up on rather than run forever.
		 */
		runs: integer("runs").notNull().default(0),
		/** A mutating operation crossed its durable dispatch boundary. */
		mutationStarted: boolean("mutation_started").notNull().default(false),
		/** Server-owned AI SDK messages needed to continue after tool approval. */
		checkpoint: jsonb("checkpoint").$type<unknown>(),
		// Why this bot got the turn, for reading a routing decision back later.
		reason: text("reason").$type<StoredTurnReason>(),
		error: text("error").$type<UserText>(),
		startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
		finishedAt: timestamp("finished_at", { withTimezone: true }),
		createdAt: stamp("created_at"),
		updatedAt: updatedStamp("updated_at"),
	},
	(table) => [
		index("turn_conversation_started_at_idx").on(table.conversationId, table.startedAt),
		uniqueIndex("turn_trigger_bot_idx").on(table.triggerMessageId, table.botId),
		index("turn_active_idx")
			.on(table.status, table.startedAt)
			.where(sql`${table.status} = 'running'`),
	],
);

export const message = pgTable(
	"message",
	{
		id: primaryKey(),
		conversationId: uuid("conversation_id")
			.notNull()
			.references(() => conversation.id, { onDelete: "cascade" }),
		authorUserId: uuid("author_user_id").references(() => user.id, { onDelete: "restrict" }),
		authorBotId: uuid("author_bot_id").references(() => bot.id, { onDelete: "cascade" }),
		automationTrigger: jsonb("automation_trigger").$type<AutomationTriggerAuthor>(),
		kind: text("kind").$type<"text">().notNull(),
		status: text("status").$type<MessageStatus>().notNull(),
		parts: jsonb("parts").$type<StoredMessagePart[]>().notNull(),
		content: text("content").notNull(),
		mentions: jsonb("mentions").$type<string[]>().notNull().default([]),
		turnId: uuid("turn_id").references(() => turn.id, { onDelete: "set null" }),
		/** The automation run this message is the result of, posted in the automation's feed. */
		runId: uuid("run_id").references(() => automationRun.id, {
			onDelete: "set null",
		}),
		/** The message this one quotes and answers, always in the same conversation. */
		replyToMessageId: uuid("reply_to_message_id").references((): AnyPgColumn => message.id, {
			onDelete: "set null",
		}),
		createdAt: stamp("created_at"),
	},
	(table) => [
		check(
			"message_one_author",
			sql`num_nonnulls(${table.authorUserId}, ${table.authorBotId}, ${table.automationTrigger}) = 1`,
		),
		index("message_conversation_created_at_idx").on(table.conversationId, table.createdAt),
		// A run's result is posted once in each conversation it goes to.
		uniqueIndex("message_run_idx")
			.on(table.runId, table.conversationId)
			.where(sql`${table.runId} is not null`),
		// What a bot's search_history tool matches against. Stemmed so "hotels"
		// finds "hotel"; unstemmed as well, so a word the English rules drop or
		// change (German "was", French "hôtels") still matches as written; and
		// by trigram, a substring match that works in any script, including
		// languages written without spaces between words. Only complete messages
		// are searched, so only they are indexed: a streaming reply rewrites its
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
 * One emoji reaction to a message, by a person or by a bot. Each adds each
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
		userId: uuid("user_id").references(() => user.id, { onDelete: "cascade" }),
		botId: uuid("bot_id").references(() => bot.id, { onDelete: "cascade" }),
		emoji: text("emoji").notNull(),
		createdAt: stamp("created_at"),
	},
	(table) => [
		check("message_reaction_one_reactor", sql`num_nonnulls(${table.userId}, ${table.botId}) = 1`),
		uniqueIndex("message_reaction_message_user_emoji_idx")
			.on(table.messageId, table.userId, table.emoji)
			.where(sql`${table.userId} is not null`),
		uniqueIndex("message_reaction_message_bot_emoji_idx")
			.on(table.messageId, table.botId, table.emoji)
			.where(sql`${table.botId} is not null`),
	],
);

/**
 * A message's parts as stored. A collaboration is kept by reference: its status and
 * answer live on the `collaboration` row and are composed in on read, so the reply's
 * writer and the collaborator's completing turn never write the same row. A tool
 * call is kept by reference for the same reason in the other direction: its
 * output lands on the `tool_call` row without rewriting the reply's parts. A
 * file on an automation run's posted result is kept whole: it names the
 * version the run wrote, which never changes.
 */
export type StoredMessagePart =
	| { type: "text"; text: string }
	| { type: "collaboration"; collaborationId: string }
	| { type: "tool_call"; toolCallId: string }
	| { type: "written_file"; fileId: string; kind: WrittenFileKind; title: string; version: number };

/**
 * One bot asking another for help mid-reply, and the collaboration's own
 * conversation, where the collaborator answers. The reply is `parentMessage`,
 * in `parentConversationId`. See `tools/collaborate/collaborations.ts`.
 */
export const collaboration = pgTable(
	"collaboration",
	{
		id: primaryKey(),
		/** The collaboration's own conversation, where the collaborator answers. */
		conversationId: uuid("conversation_id").notNull(),
		kind: kindOf("collaboration"),
		/** The conversation it was asked from, where the asking reply is. */
		parentConversationId: uuid("parent_conversation_id")
			.notNull()
			.references(() => conversation.id, { onDelete: "cascade" }),
		/**
		 * The conversation people opened that it hangs under: its parent's, or
		 * the parent itself, for the first collaboration asked from it.
		 */
		rootConversationId: uuid("root_conversation_id")
			.notNull()
			.references((): AnyPgColumn => conversation.id, { onDelete: "cascade" }),
		parentMessageId: uuid("parent_message_id")
			.notNull()
			.references(() => message.id, { onDelete: "cascade" }),
		/** The asking bot's turn, which bounds collaborations per turn. */
		turnId: uuid("turn_id")
			.notNull()
			.references(() => turn.id, { onDelete: "cascade" }),
		collaboratorBotId: uuid("collaborator_bot_id")
			.notNull()
			.references(() => bot.id, { onDelete: "cascade" }),
		brief: text("brief").notNull(),
		status: text("status").$type<CollaborationStatus>().notNull().default("waiting"),
		answer: text("answer"),
		/** Where in the reply's text the call was made. */
		atOffset: integer("at_offset").notNull(),
		createdAt: stamp("created_at"),
		updatedAt: updatedStamp("updated_at"),
	},
	(table) => [
		foreignKey({
			columns: [table.conversationId, table.kind],
			foreignColumns: [conversation.id, conversation.kind],
			name: "collaboration_conversation_fkey",
		}).onDelete("cascade"),
		index("collaboration_parent_message_idx").on(table.parentMessageId),
		uniqueIndex("collaboration_conversation_idx").on(table.conversationId),
		index("collaboration_root_idx").on(table.rootConversationId),
		index("collaboration_collaborator_created_at_idx").on(table.collaboratorBotId, table.createdAt),
		index("collaboration_turn_idx").on(table.turnId),
	],
);

export type CollaborationRow = typeof collaboration.$inferSelect;

/**
 * One call a bot's reply made to a built-in tool: what it was given, what
 * came back, and where in the reply it happened. See `tools/calls/repository.ts`.
 *
 * `conversation_id` is here as well as on the message so the table can be
 * filtered by conversation without a join. `input` and `output` are truncated to
 * `MAX_STORED_JSON_CHARACTERS` before they are written; the model saw the
 * whole result.
 */
export const toolCall = pgTable(
	"tool_call",
	{
		id: primaryKey(),
		conversationId: uuid("conversation_id")
			.notNull()
			.references(() => conversation.id, { onDelete: "cascade" }),
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
		decidedById: uuid("decided_by_id").references(() => user.id, { onDelete: "set null" }),
		decidedAt: timestamp("decided_at", { withTimezone: true }),
		connectionId: uuid("connection_id"),
		connectionRevision: integer("connection_revision"),
		remoteToolName: text("remote_tool_name"),
		/** The complete input used for continuation; `input` below is display-bounded. */
		executionInput: jsonb("execution_input").$type<JsonValue>(),
		input: jsonb("input").$type<JsonValue>().notNull(),
		output: jsonb("output").$type<JsonValue>(),
		status: text("status").$type<ToolCallStatus>().notNull().default("running"),
		error: text("error").$type<UserText>(),
		/** Whether the tool may have changed something at the other end. */
		mutating: boolean("mutating").notNull().default(false),
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

/** The Summariser's short account of one conversation, written from its messages up to `sourceMessageId`. */
export const conversationSummary = pgTable("summary", {
	conversationId: uuid("conversation_id")
		.primaryKey()
		.references(() => conversation.id, { onDelete: "cascade" }),
	content: text("content").notNull(),
	sourceMessageId: uuid("source_message_id")
		.notNull()
		.references(() => message.id, { onDelete: "cascade" }),
	updatedAt: updatedStamp("updated_at"),
});

/**
 * What a bot has been doing lately, at a glance: written by the Summariser
 * from the summaries of the bot's newest threads and automation feeds, each
 * time one of them is summarised. People who reach the bot read it on its
 * page, and their Personal Assistant reads it to know what the bot is up to.
 */
export const botSummary = pgTable("bot_summary", {
	botId: uuid("bot_id")
		.primaryKey()
		.references(() => bot.id, { onDelete: "cascade" }),
	content: text("content").notNull(),
	/**
	 * When the newest conversation summary it was written from was written. A
	 * summary written from older ones never replaces it, however late it
	 * arrives.
	 */
	coversThrough: timestamp("covers_through", { withTimezone: true }).notNull(),
	updatedAt: updatedStamp("updated_at"),
});

/**
 * What a bot reads in place of a long conversation's older messages, written by the
 * Compaction bot. The bot reads `summary`, then every message from `keptFrom` on word
 * for word. The summary covers the messages from `historyStartsAt` to `keptFrom`;
 * anything earlier is left out, and the bot searches for it when it needs it.
 */
export const conversationCompaction = pgTable("compaction", {
	conversationId: uuid("conversation_id")
		.primaryKey()
		.references(() => conversation.id, { onDelete: "cascade" }),
	summary: text("summary").notNull(),
	historyStartsAt: timestamp("history_starts_at", { withTimezone: true }).notNull(),
	keptFrom: timestamp("kept_from", { withTimezone: true }).notNull(),
	updatedAt: updatedStamp("updated_at"),
});

/**
 * How far one person has read a conversation: every message there up to
 * `readThrough` has been on their screen. No row means they never opened it.
 *
 * A message is stamped when its transaction begins, so one that began before
 * a read was recorded and committed after it counts as read. The window is a
 * transaction long, and the next message moves the chat on.
 */
export const conversationRead = pgTable(
	"conversation_read",
	{
		id: primaryKey(),
		conversationId: uuid("conversation_id")
			.notNull()
			.references(() => conversation.id, { onDelete: "cascade" }),
		userId: uuid("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		readThrough: timestamp("read_through", { withTimezone: true }).notNull(),
		createdAt: stamp("created_at"),
		updatedAt: updatedStamp("updated_at"),
	},
	(table) => [
		uniqueIndex("conversation_read_user_conversation_idx").on(table.userId, table.conversationId),
	],
);

/**
 * Every conversation with what its kind table says about it, read as one
 * row: the shape most reads want. Columns a kind does not have are null. The
 * kind tables stay the only place each fact is written.
 */
export const placedConversation = pgView("placed_conversation", {
	id: uuid("id").notNull(),
	workspaceId: uuid("workspace_id").notNull(),
	kind: text("kind").$type<ConversationKind>().notNull(),
	title: text("title").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
	/**
	 * The bot it is with: the bot whose default project a thread, an
	 * automation's feed or a run is in, the collaborator, or the system bot.
	 * Null in a project people made and on a direct message.
	 */
	botId: uuid("bot_id"),
	/** The project a thread, an automation's feed or a run is in: the automation's. */
	projectId: uuid("project_id"),
	/**
	 * The conversation people open that it is in: its own id on a project's
	 * thread, a direct message and an automation's feed; the
	 * one it hangs under on a collaboration; the automation's feed on a run.
	 * Null on a system bot's conversation, which serves one rather than
	 * belonging to one.
	 */
	rootConversationId: uuid("root_conversation_id"),
	/** What it was opened under: the asking conversation of a collaboration, the served one of a system bot's. */
	parentConversationId: uuid("parent_conversation_id"),
	/** Who started a project's thread or a direct message. */
	startedById: uuid("started_by_id"),
	systemBotKey: text("system_bot_key").$type<SystemBotKey>(),
	doneAt: timestamp("done_at", { withTimezone: true }),
	/** On an automation's feed: the automation. */
	automationId: uuid("automation_id"),
	archivedAt: timestamp("archived_at", { withTimezone: true }),
	directKey: text("direct_key"),
}).as(sql`select
	c.id, c.workspace_id, c.kind, c.title, c.created_at, c.updated_at,
	coalesce(p.default_of_bot_id, co.collaborator_bot_id, sc.bot_id) as bot_id,
	p.id as project_id,
	case c.kind
		when 'collaboration' then co.root_conversation_id
		when 'run' then rf.conversation_id
		when 'system' then null
		else c.id
	end as root_conversation_id,
	coalesce(co.parent_conversation_id, sc.served_conversation_id) as parent_conversation_id,
	coalesce(cc.started_by_id, dm.started_by_id) as started_by_id,
	sc.system_bot_key,
	cc.done_at,
	f.automation_id,
	cc.archived_at,
	dm.direct_key
from ${conversation} c
left join ${projectThread} cc on cc.conversation_id = c.id
left join ${directMessage} dm on dm.conversation_id = c.id
left join ${collaboration} co on co.conversation_id = c.id
left join ${automationRun} r on r.conversation_id = c.id
left join ${automationFeed} rf on rf.automation_id = r.automation_id
left join ${automationFeed} f on f.conversation_id = c.id
left join ${automation} a on a.id = coalesce(r.automation_id, f.automation_id)
left join ${project} p on p.id = coalesce(cc.project_id, a.project_id)
left join ${systemConversation} sc on sc.conversation_id = c.id`);

export type ConversationRow = typeof conversation.$inferSelect;
export type PlacedConversationRow = typeof placedConversation.$inferSelect;
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
export type SummaryRow = typeof conversationSummary.$inferSelect;
