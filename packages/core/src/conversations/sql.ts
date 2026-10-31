import type {
	CollaborationStatus,
	JsonValue,
	MessageStatus,
	RoutineExecutionState,
	RoutineExecutionTrigger,
	RoutineExecutionTriggerKind,
	RoutineResults,
	RoutineState,
	RoutineTrigger,
	RoutineTriggerAuthor,
	RoutineTriggerKind,
	SystemAgentKey,
	ThreadType,
	ToolApprovalStatus,
	ToolCallStatus,
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
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { primaryKey, stamp, updatedStamp } from "../database/sql.ts";
import { agent, pod, user, workspace } from "../workspaces/sql.ts";

export const routine = pgTable(
	"routine",
	{
		id: primaryKey(),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspace.id, { onDelete: "cascade" }),
		agentId: uuid("agent_id").notNull(),
		name: text("name").notNull(),
		instructions: text("instructions").notNull(),
		state: text("state").$type<RoutineState>().notNull().default("enabled"),
		/**
		 * When the routine paused itself after two failed runs in a row, until
		 * somebody turns it on again or pauses it by hand.
		 */
		pausedAfterFailuresAt: timestamp("paused_after_failures_at", { withTimezone: true }),
		results: text("results").$type<RoutineResults>().notNull().default("keep_in_run"),
		/**
		 * The pod's chat its results go to when they are posted to chat; the
		 * pod's first chat when unset, or once this one is archived. Always a
		 * chat in its agent's pod, which `Routines` checks before writing it.
		 */
		chatId: uuid("chat_id").references((): AnyPgColumn => thread.id, { onDelete: "set null" }),
		createdById: uuid("created_by_id").references(() => user.id, { onDelete: "set null" }),
		/** Set when the routine's own agent made it, at `createdById`'s request. */
		createdByAgentId: uuid("created_by_agent_id"),
		deletedAt: timestamp("deleted_at", { withTimezone: true }),
		createdAt: stamp("created_at"),
		updatedAt: updatedStamp("updated_at"),
	},
	(table) => [
		foreignKey({
			columns: [table.agentId, table.workspaceId],
			foreignColumns: [agent.id, agent.workspaceId],
			name: "routine_agent_workspace_fkey",
		}).onDelete("cascade"),
		check("routine_state_valid", sql`${table.state} in ('enabled', 'paused')`),
		check(
			"routine_paused_after_failures_valid",
			sql`${table.pausedAfterFailuresAt} is null or ${table.state} = 'paused'`,
		),
		check("routine_results_valid", sql`${table.results} in ('keep_in_run', 'post_to_chat')`),
		check(
			"routine_created_by_agent_valid",
			sql`${table.createdByAgentId} is null or ${table.createdByAgentId} = ${table.agentId}`,
		),
		uniqueIndex("routine_agent_name_idx")
			.on(table.agentId, table.name)
			.where(sql`${table.deletedAt} is null`),
		uniqueIndex("routine_id_workspace_id_idx").on(table.id, table.workspaceId),
	],
);

/**
 * One of the things that start a routine; a routine may have several, of any
 * kinds, or none and run only when someone runs it. `settings` holds what
 * each kind is, with the kind; a webhook keeps its secret in its own column,
 * and a schedule its next time, while its routine is enabled.
 */
export const routineTrigger = pgTable(
	"routine_trigger",
	{
		id: primaryKey(),
		workspaceId: uuid("workspace_id").notNull(),
		routineId: uuid("routine_id").notNull(),
		/** Follows `settings`, so the kind and its settings can't disagree. */
		kind: text("kind")
			.$type<RoutineTriggerKind>()
			.generatedAlwaysAs(sql`settings->>'kind'`)
			.notNull(),
		settings: jsonb("settings").$type<RoutineTriggerSettings>().notNull(),
		/** A webhook's secret, sealed with `Credentials`: checking a signature needs the secret itself. */
		secretEncrypted: text("secret_encrypted"),
		/**
		 * The scrypt hash of a webhook's bearer secret made before secrets were
		 * kept sealed. It still admits callers until the secret is replaced.
		 */
		secretDigest: text("secret_digest"),
		/** When a schedule next runs its routine; null while the routine is paused. */
		nextScheduledAt: timestamp("next_scheduled_at", { withTimezone: true }),
		createdAt: stamp("created_at"),
		updatedAt: updatedStamp("updated_at"),
	},
	(table) => [
		foreignKey({
			columns: [table.routineId, table.workspaceId],
			foreignColumns: [routine.id, routine.workspaceId],
			name: "routine_trigger_routine_workspace_fkey",
		}).onDelete("cascade"),
		check(
			"routine_trigger_secret_valid",
			sql`(${table.secretEncrypted} is null and ${table.secretDigest} is null)
				or (${table.kind} = 'webhook' and (${table.secretEncrypted} is null or ${table.secretDigest} is null))`,
		),
		check(
			"routine_trigger_digest_valid",
			sql`${table.secretDigest} is null or ${table.settings}->'auth'->>'kind' = 'bearer'`,
		),
		check(
			"routine_trigger_schedule_valid",
			sql`${table.kind} = 'cron' or ${table.nextScheduledAt} is null`,
		),
		index("routine_trigger_routine_idx").on(table.routineId, table.createdAt),
		index("routine_trigger_due_idx")
			.on(table.nextScheduledAt, table.id)
			.where(sql`${table.nextScheduledAt} is not null`),
	],
);

/**
 * The thread types people open and post in, each one a conversation of its
 * own: a thread with a bot or between people (`conversation`), a pod's chat,
 * a bot's channel, and a routine's thread. The others are opened under one of
 * these.
 */
export const CONVERSATION_TYPES = [
	"conversation",
	"pod_chat",
	"bot_channel",
	"routine_feed",
] as const satisfies readonly ThreadType[];

/**
 * Deleting a thread, by any route including its workspace's, pod's or host
 * agent's cascade, queues its blobs for deletion: see `blob_deletion`.
 */
export const thread = pgTable(
	"thread",
	{
		id: primaryKey(),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspace.id, { onDelete: "cascade" }),
		podId: uuid("pod_id").notNull(),
		/**
		 * The bot the thread is with. Null on a pod's chat, which is the pod's
		 * people's, and on a thread between people started from one.
		 */
		hostAgentId: uuid("host_agent_id"),
		/**
		 * The conversation this thread belongs to: its own id on a conversation,
		 * a pod's chat or a routine's thread, and the one it was opened from on a
		 * collaboration or a routine run. Null on a system agent's thread, which
		 * serves a thread rather than belonging to one.
		 */
		conversationId: uuid("conversation_id").references((): AnyPgColumn => thread.id, {
			onDelete: "cascade",
		}),
		type: text("type").$type<ThreadType>().notNull(),
		title: text("title").notNull(),
		/**
		 * Set when this thread belongs to a system agent rather than to people and
		 * crew. System-agent threads hang off the thread they act on and are hidden
		 * from a pod's thread list.
		 */
		systemAgentKey: text("system_agent_key").$type<SystemAgentKey>(),
		parentThreadId: uuid("parent_thread_id").references((): AnyPgColumn => thread.id, {
			onDelete: "cascade",
		}),
		initiatorUserId: uuid("initiator_user_id").references(() => user.id, {
			onDelete: "restrict",
		}),
		/** On a thread started from a pod's chat or a bot's channel: the message there it hangs off. */
		originMessageId: uuid("origin_message_id").references((): AnyPgColumn => message.id, {
			onDelete: "set null",
		}),
		/** When somebody marked the conversation done, until it is reopened. */
		doneAt: timestamp("done_at", { withTimezone: true }),
		/** On a routine's own thread: the routine, each of whose runs posts in it. */
		routineId: uuid("routine_id").references((): AnyPgColumn => routine.id, {
			onDelete: "cascade",
		}),
		/**
		 * On a pod's chat: whether it is the pod's first, named for the pod,
		 * which every pod has once opened and which is never archived.
		 */
		main: boolean("main").notNull().default(false),
		/** When somebody archived the pod's chat, which hides it from the pod's list. */
		archivedAt: timestamp("archived_at", { withTimezone: true }),
		createdAt: stamp("created_at"),
		updatedAt: updatedStamp("updated_at"),
	},
	(table) => [
		check(
			"thread_type_valid",
			sql`${table.type} in ('conversation', 'pod_chat', 'bot_channel', 'collaboration', 'routine', 'routine_feed', 'system_agent')`,
		),
		// A pod's chat is its people's, a conversation may be with a bot or only
		// people, and every other thread is some bot's.
		check(
			"thread_host_valid",
			sql`case ${table.type} when 'pod_chat' then ${table.hostAgentId} is null when 'conversation' then true else ${table.hostAgentId} is not null end`,
		),
		foreignKey({
			columns: [table.podId, table.workspaceId],
			foreignColumns: [pod.id, pod.workspaceId],
			name: "thread_pod_workspace_fkey",
		}).onDelete("cascade"),
		foreignKey({
			columns: [table.hostAgentId, table.workspaceId],
			foreignColumns: [agent.id, agent.workspaceId],
			name: "thread_host_agent_workspace_fkey",
		}).onDelete("cascade"),
		uniqueIndex("thread_system_agent_key_idx").on(table.parentThreadId, table.systemAgentKey),
		index("thread_workspace_created_at_idx").on(table.workspaceId, table.createdAt),
		index("thread_pod_host_created_at_idx").on(table.podId, table.hostAgentId, table.createdAt),
		index("thread_workspace_updated_at_idx").on(table.workspaceId, table.updatedAt),
		index("thread_pod_host_updated_at_idx").on(table.podId, table.hostAgentId, table.updatedAt),
		index("thread_conversation_updated_at_idx").on(table.conversationId, table.updatedAt),
		check(
			"thread_routine_valid",
			sql`(${table.routineId} is not null) = (${table.type} = 'routine_feed')`,
		),
		// One thread per routine.
		uniqueIndex("thread_routine_feed_idx").on(table.routineId),
		// One channel per bot in a pod.
		uniqueIndex("thread_bot_channel_idx")
			.on(table.podId, table.hostAgentId)
			.where(sql`${table.type} = 'bot_channel'`),
		// One thread per message in a pod's chat.
		uniqueIndex("thread_origin_message_idx").on(table.originMessageId),
		check("thread_main_valid", sql`not ${table.main} or ${table.type} = 'pod_chat'`),
		check(
			"thread_archived_valid",
			sql`${table.archivedAt} is null or (${table.type} = 'pod_chat' and not ${table.main})`,
		),
		// One first chat per pod.
		uniqueIndex("thread_pod_chat_idx").on(table.podId).where(sql`${table.main}`),
	],
);

export const routineExecution = pgTable(
	"routine_execution",
	{
		id: primaryKey(),
		routineId: uuid("routine_id")
			.notNull()
			.references(() => routine.id, { onDelete: "restrict" }),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspace.id, { onDelete: "cascade" }),
		agentId: uuid("agent_id").notNull(),
		threadId: uuid("thread_id")
			.notNull()
			.references(() => thread.id, { onDelete: "cascade" }),
		/** The trigger that started it; null for a run someone started, or once the trigger is removed. */
		triggerId: uuid("trigger_id").references(() => routineTrigger.id, { onDelete: "set null" }),
		triggerKind: text("trigger_kind").$type<RoutineExecutionTriggerKind>().notNull(),
		triggerIdentity: text("trigger_identity"),
		trigger: jsonb("trigger").$type<RoutineExecutionTrigger>().notNull(),
		routineName: text("routine_name").notNull(),
		instructions: text("instructions").notNull(),
		/** The routine's `results` when the run was accepted. */
		results: text("results").$type<RoutineResults>().notNull().default("keep_in_run"),
		state: text("state").$type<RoutineExecutionState>().notNull().default("queued"),
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
			columns: [table.agentId, table.workspaceId],
			foreignColumns: [agent.id, agent.workspaceId],
			name: "routine_execution_agent_workspace_fkey",
		}).onDelete("cascade"),
		foreignKey({
			columns: [table.routineId, table.workspaceId],
			foreignColumns: [routine.id, routine.workspaceId],
			name: "routine_execution_routine_workspace_fkey",
		}).onDelete("restrict"),
		check(
			"routine_execution_trigger_valid",
			sql`${table.trigger}->>'kind' = ${table.triggerKind}
				and (${table.triggerKind} = 'webhook' or ${table.triggerIdentity} is not null)
				and (${table.triggerKind} <> 'manual' or ${table.triggerId} is null)`,
		),
		check(
			"routine_execution_state_valid",
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
			"routine_execution_pending_terminal_valid",
			sql`(${table.pendingTerminalState} is null and ${table.pendingTerminalError} is null)
				or (${table.state} = 'running' and ${table.pendingTerminalState} = 'cancelled' and ${table.pendingTerminalError} is null)
				or (${table.state} = 'running' and ${table.pendingTerminalState} = 'failed')`,
		),
		check(
			"routine_execution_results_valid",
			sql`${table.results} in ('keep_in_run', 'post_to_chat')`,
		),
		uniqueIndex("routine_execution_thread_idx").on(table.threadId),
		// A trigger's retry of a delivery or an occurrence lands on the run it started.
		uniqueIndex("routine_execution_trigger_identity_idx")
			.on(table.triggerId, table.triggerIdentity)
			.where(sql`${table.triggerId} is not null and ${table.triggerIdentity} is not null`),
		uniqueIndex("routine_execution_manual_identity_idx")
			.on(table.routineId, table.triggerIdentity)
			.where(sql`${table.triggerKind} = 'manual'`),
		uniqueIndex("routine_execution_running_idx")
			.on(table.routineId)
			.where(sql`${table.state} = 'running'`),
		index("routine_execution_list_idx").on(table.routineId, table.acceptedAt, table.id),
	],
);

export const threadParticipant = pgTable(
	"thread_participant",
	{
		id: primaryKey(),
		threadId: uuid("thread_id")
			.notNull()
			.references(() => thread.id, { onDelete: "cascade" }),
		userId: uuid("user_id").references(() => user.id, { onDelete: "cascade" }),
		agentId: uuid("agent_id").references(() => agent.id, { onDelete: "cascade" }),
		createdAt: stamp("created_at"),
	},
	(table) => [
		check(
			"thread_participant_one_identity",
			sql`num_nonnulls(${table.userId}, ${table.agentId}) = 1`,
		),
		uniqueIndex("thread_participant_user_idx")
			.on(table.threadId, table.userId)
			.where(sql`${table.userId} is not null`),
		uniqueIndex("thread_participant_agent_idx")
			.on(table.threadId, table.agentId)
			.where(sql`${table.agentId} is not null`),
	],
);

/**
 * Why an agent was given a turn: a person mentioned it, it was the default,
 * it was asked to collaborate, a routine ran, or a collaboration answer
 * resumed it, it opened its setup interview, or a bot started its thread
 * for a person and briefed it.
 */
export type TurnReason =
	| "mention"
	| "default"
	| "collaboration"
	| "routine"
	| "resume"
	| "interview"
	| "brief";

export type TurnStatus = "running" | "waiting" | "done" | "failed" | "cancelled";

/** The statuses of a turn that has not ended. */
export const ACTIVE_TURN_STATUSES = ["running", "waiting"] as const satisfies readonly TurnStatus[];

export const turn = pgTable(
	"turn",
	{
		id: primaryKey(),
		threadId: uuid("thread_id")
			.notNull()
			.references(() => thread.id, { onDelete: "cascade" }),
		agentId: uuid("agent_id")
			.notNull()
			.references(() => agent.id, { onDelete: "cascade" }),
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
		// Why this agent got the turn, for reading a routing decision back later.
		reason: text("reason").$type<TurnReason>(),
		error: text("error").$type<UserText>(),
		startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
		finishedAt: timestamp("finished_at", { withTimezone: true }),
		createdAt: stamp("created_at"),
		updatedAt: updatedStamp("updated_at"),
	},
	(table) => [
		index("turn_thread_started_at_idx").on(table.threadId, table.startedAt),
		uniqueIndex("turn_trigger_agent_idx").on(table.triggerMessageId, table.agentId),
		index("turn_active_idx")
			.on(table.status, table.startedAt)
			.where(sql`${table.status} = 'running'`),
	],
);

export const message = pgTable(
	"message",
	{
		id: primaryKey(),
		threadId: uuid("thread_id")
			.notNull()
			.references(() => thread.id, { onDelete: "cascade" }),
		authorUserId: uuid("author_user_id").references(() => user.id, { onDelete: "restrict" }),
		authorAgentId: uuid("author_agent_id").references(() => agent.id, { onDelete: "cascade" }),
		routineTrigger: jsonb("routine_trigger").$type<RoutineTriggerAuthor>(),
		kind: text("kind").$type<"text">().notNull(),
		status: text("status").$type<MessageStatus>().notNull(),
		parts: jsonb("parts").$type<StoredMessagePart[]>().notNull(),
		content: text("content").notNull(),
		mentions: jsonb("mentions").$type<string[]>().notNull().default([]),
		turnId: uuid("turn_id").references(() => turn.id, { onDelete: "set null" }),
		/** The routine run this message is the result of, posted in the routine's thread or a pod's chat. */
		routineExecutionId: uuid("routine_execution_id").references(() => routineExecution.id, {
			onDelete: "set null",
		}),
		/** The message this one quotes and answers, always in the same thread. */
		replyToMessageId: uuid("reply_to_message_id").references((): AnyPgColumn => message.id, {
			onDelete: "set null",
		}),
		createdAt: stamp("created_at"),
	},
	(table) => [
		check(
			"message_one_author",
			sql`num_nonnulls(${table.authorUserId}, ${table.authorAgentId}, ${table.routineTrigger}) = 1`,
		),
		index("message_thread_created_at_idx").on(table.threadId, table.createdAt),
		// A run's result is posted once in each thread it goes to: the routine's, and perhaps a pod's chat.
		uniqueIndex("message_routine_execution_idx")
			.on(table.routineExecutionId, table.threadId)
			.where(sql`${table.routineExecutionId} is not null`),
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

/** One person's emoji reaction to a message. A person adds each emoji at most once. */
export const messageReaction = pgTable(
	"message_reaction",
	{
		id: primaryKey(),
		messageId: uuid("message_id")
			.notNull()
			.references(() => message.id, { onDelete: "cascade" }),
		userId: uuid("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		emoji: text("emoji").notNull(),
		createdAt: stamp("created_at"),
	},
	(table) => [
		uniqueIndex("message_reaction_message_user_emoji_idx").on(
			table.messageId,
			table.userId,
			table.emoji,
		),
	],
);

/**
 * A message's parts as stored. A collaboration is kept by reference: its status and
 * answer live on the `collaboration` row and are composed in on read, so the reply's
 * writer and the collaborator's completing turn never write the same row. A tool
 * call is kept by reference for the same reason in the other direction: its
 * output lands on the `tool_call` row without rewriting the reply's parts.
 */
export type StoredMessagePart =
	| { type: "text"; text: string }
	| { type: "collaboration"; collaborationId: string }
	| { type: "tool_call"; toolCallId: string };

/**
 * One agent asking another for help mid-reply. The reply is `parentMessage`;
 * the collaborator answers in `childThread`. See `tools/collaborate/collaborations.ts`.
 */
export const collaboration = pgTable(
	"collaboration",
	{
		id: primaryKey(),
		parentThreadId: uuid("parent_thread_id")
			.notNull()
			.references(() => thread.id, { onDelete: "cascade" }),
		parentMessageId: uuid("parent_message_id")
			.notNull()
			.references(() => message.id, { onDelete: "cascade" }),
		/** The asking agent's turn, which bounds collaborations per turn. */
		turnId: uuid("turn_id")
			.notNull()
			.references(() => turn.id, { onDelete: "cascade" }),
		childThreadId: uuid("child_thread_id")
			.notNull()
			.references(() => thread.id, { onDelete: "cascade" }),
		collaboratorAgentId: uuid("collaborator_agent_id")
			.notNull()
			.references(() => agent.id, { onDelete: "cascade" }),
		brief: text("brief").notNull(),
		status: text("status").$type<CollaborationStatus>().notNull().default("waiting"),
		answer: text("answer"),
		/** Where in the reply's text the call was made. */
		atOffset: integer("at_offset").notNull(),
		createdAt: stamp("created_at"),
		updatedAt: updatedStamp("updated_at"),
	},
	(table) => [
		index("collaboration_parent_message_idx").on(table.parentMessageId),
		uniqueIndex("collaboration_child_thread_idx").on(table.childThreadId),
		index("collaboration_collaborator_created_at_idx").on(
			table.collaboratorAgentId,
			table.createdAt,
		),
		index("collaboration_turn_idx").on(table.turnId),
	],
);

export type CollaborationRow = typeof collaboration.$inferSelect;

/**
 * One call an agent's reply made to a built-in tool: what it was given, what
 * came back, and where in the reply it happened. See `tools/calls/repository.ts`.
 *
 * `thread_id` is here as well as on the message so the table can be filtered
 * by thread without a join. `input` and `output` are truncated to
 * `MAX_STORED_JSON_CHARACTERS` before they are written; the model saw the
 * whole result.
 */
export const toolCall = pgTable(
	"tool_call",
	{
		id: primaryKey(),
		threadId: uuid("thread_id")
			.notNull()
			.references(() => thread.id, { onDelete: "cascade" }),
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

/**
 * Where a thread's file came from: a tool's result too large to hand a model
 * whole, a person's upload, or a file an agent attached to its own reply.
 */
export type ThreadFileKind = "tool_result" | "upload" | "agent_attachment";

/**
 * A file in a thread, which its agents can read. Its bytes are in the blob
 * store, under the thread's folder (see `thread-files/thread-files.ts`).
 */
export const threadFile = pgTable(
	"thread_file",
	{
		id: primaryKey(),
		threadId: uuid("thread_id")
			.notNull()
			.references(() => thread.id, { onDelete: "cascade" }),
		kind: text("kind").$type<ThreadFileKind>().notNull(),
		/** For a tool result: the call whose result this is. */
		toolCallId: uuid("tool_call_id").references(() => toolCall.id, { onDelete: "set null" }),
		/** For an upload, the file's name as the person's computer had it; for an agent's attachment, the name it gave. */
		name: text("name"),
		/** For an upload: who uploaded it, the only one who may attach it while it is unsent. */
		uploaderId: uuid("uploader_id").references(() => user.id, { onDelete: "set null" }),
		/**
		 * For an upload, the message it is attached to, unset until that message
		 * is sent; for an agent's attachment, the reply it was attached to.
		 */
		messageId: uuid("message_id").references(() => message.id, { onDelete: "cascade" }),
		/** For a file on a message: its place among the message's files, from 0. */
		position: integer("position"),
		contentType: text("content_type").notNull(),
		/** In bytes. */
		size: integer("size").notNull(),
		createdAt: stamp("created_at"),
	},
	(table) => [
		index("thread_file_thread_idx").on(table.threadId),
		index("thread_file_message_idx").on(table.messageId),
		check(
			"thread_file_kind_valid",
			sql`${table.kind} in ('tool_result', 'upload', 'agent_attachment')`,
		),
		check(
			"thread_file_source_valid",
			sql`case ${table.kind}
				when 'upload' then ${table.name} is not null and ${table.toolCallId} is null
					and (${table.messageId} is null) = (${table.position} is null)
				when 'agent_attachment' then ${table.name} is not null and ${table.toolCallId} is null
					and ${table.uploaderId} is null and ${table.messageId} is not null
					and ${table.position} is not null
				else ${table.name} is null and ${table.uploaderId} is null and ${table.messageId} is null
					and ${table.position} is null
			end`,
		),
	],
);

export const threadSummary = pgTable("thread_summary", {
	threadId: uuid("thread_id")
		.primaryKey()
		.references(() => thread.id, { onDelete: "cascade" }),
	content: text("content").notNull(),
	sourceMessageId: uuid("source_message_id")
		.notNull()
		.references(() => message.id, { onDelete: "cascade" }),
	updatedAt: updatedStamp("updated_at"),
});

/**
 * What a bot reads in place of a long thread's older messages, written by the
 * Compaction agent. The bot reads `summary`, then every message from `keptFrom` on word
 * for word. The summary covers the messages from `historyStartsAt` to `keptFrom`;
 * anything earlier is left out, and the bot searches for it when it needs it.
 */
export const threadCompaction = pgTable("thread_compaction", {
	threadId: uuid("thread_id")
		.primaryKey()
		.references(() => thread.id, { onDelete: "cascade" }),
	summary: text("summary").notNull(),
	historyStartsAt: timestamp("history_starts_at", { withTimezone: true }).notNull(),
	keptFrom: timestamp("kept_from", { withTimezone: true }).notNull(),
	updatedAt: updatedStamp("updated_at"),
});

export type ThreadCompactionRow = typeof threadCompaction.$inferSelect;

/**
 * How far one person has read a thread: every message there up to
 * `readThrough` has been on their screen. No row means they never opened it.
 *
 * A message is stamped when its transaction begins, so one that began before
 * a read was recorded and committed after it counts as read. The window is a
 * transaction long, and the next message moves the chat on.
 */
export const threadRead = pgTable(
	"thread_read",
	{
		id: primaryKey(),
		threadId: uuid("thread_id")
			.notNull()
			.references(() => thread.id, { onDelete: "cascade" }),
		userId: uuid("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		readThrough: timestamp("read_through", { withTimezone: true }).notNull(),
		createdAt: stamp("created_at"),
		updatedAt: updatedStamp("updated_at"),
	},
	(table) => [uniqueIndex("thread_read_user_thread_idx").on(table.userId, table.threadId)],
);

export type ThreadRow = typeof thread.$inferSelect;
export type RoutineRow = typeof routine.$inferSelect;
export type RoutineTriggerRow = typeof routineTrigger.$inferSelect;
/** What a trigger is, by kind: a trigger as the API shows it, without what the row keeps apart. */
export type RoutineTriggerSettings = RoutineTrigger extends infer T
	? T extends RoutineTrigger
		? Omit<T, "id" | "nextScheduledAt">
		: never
	: never;
export type RoutineExecutionRow = typeof routineExecution.$inferSelect;
export type MessageRow = typeof message.$inferSelect;
export type TurnRow = typeof turn.$inferSelect;
export type ThreadSummaryRow = typeof threadSummary.$inferSelect;
