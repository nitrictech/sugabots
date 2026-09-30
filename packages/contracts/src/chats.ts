import { Effect, Schema } from "effect";
import { agentSchema } from "./agents.ts";
import {
	routineExecutionStateSchema,
	routineExecutionSummarySchema,
	routineExecutionTriggerKindSchema,
} from "./routines.ts";
import { agentParticipantSchema, messageSchema, threadParticipantSchema } from "./threads.ts";
import { isoTimestampSchema } from "./timestamps.ts";
import { uuidSchema } from "./uuid.ts";

export const DEFAULT_CHAT_PAGE_LIMIT = 50;
export const MAX_CHAT_PAGE_LIMIT = 100;

export const chatPageQuerySchema = Schema.Struct({
	cursor: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
	limit: Schema.String.check(Schema.isPattern(/^\d+$/)).pipe(
		Schema.decodeTo(Schema.FiniteFromString),
		Schema.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: MAX_CHAT_PAGE_LIMIT })),
		Schema.withDecodingDefault(Effect.succeed(String(DEFAULT_CHAT_PAGE_LIMIT))),
	),
});

export type ChatPageQuery = typeof chatPageQuerySchema.Type;

export const chatSchema = Schema.Struct({
	id: uuidSchema,
	workspaceId: uuidSchema,
	podId: uuidSchema,
	hostAgentId: uuidSchema,
	mainThreadId: uuidSchema,
	createdAt: isoTimestampSchema,
	updatedAt: isoTimestampSchema,
});

export type Chat = typeof chatSchema.Type;

/** The pod whose chats a list covers. */
export const chatListQuerySchema = Schema.Struct({ pod: uuidSchema });

/**
 * One row of the conversation list: a bot, since each bot has one chat in its
 * pod. `chatId` and `lastMessage` are null until somebody first messages it.
 */
export const chatListItemSchema = Schema.Struct({
	agent: agentSchema,
	chatId: Schema.NullOr(uuidSchema),
	lastMessage: Schema.NullOr(
		Schema.Struct({
			/** The message's first line, shortened for a one-line row. */
			preview: Schema.String,
			/** The person who wrote it, or null when the bot did. */
			authorUserId: Schema.NullOr(uuidSchema),
			at: isoTimestampSchema,
		}),
	),
	/**
	 * The tool the chat's newest reply waiting for approval would run first, or
	 * null. Such a reply may have written nothing at all, so this stands in for
	 * a preview.
	 */
	waitingOn: Schema.NullOr(Schema.String),
	/** Somebody else finished a message after the person last read the chat. */
	unread: Schema.Boolean,
	/** A tool call in the chat is waiting for a decision the person may make. */
	needsApproval: Schema.Boolean,
});

export type ChatListItem = typeof chatListItemSchema.Type;

/**
 * How each pod the person reaches stands for them, for the rail: how many of
 * its chats are unread, and whether any waits for a decision they may make.
 * Pods with neither are left out.
 */
export const podChatMarkersSchema = Schema.Struct({
	pods: Schema.Record(
		uuidSchema,
		Schema.Struct({
			unreadChats: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
			needsApproval: Schema.Boolean,
		}),
	),
});

export type PodChatMarkers = typeof podChatMarkersSchema.Type;

/** Most recent message first; bots nobody has messaged come last, by name. */
export const chatListSchema = Schema.Struct({
	items: Schema.mutable(Schema.Array(chatListItemSchema)),
});

export type ChatList = typeof chatListSchema.Type;

export const getOrCreateChatSchema = Schema.Struct({
	podId: uuidSchema,
	hostAgentId: uuidSchema,
});

export type GetOrCreateChat = typeof getOrCreateChatSchema.Type;

export const customerThreadTypeSchema = Schema.Literals(["collaboration", "routine"]);

/**
 * How a collaboration or routine run in a chat stands. A run's own state is
 * used as it is, so the two are one set; a collaboration uses some of them.
 */
export const chatActivityStatusSchema = routineExecutionStateSchema;

export type ChatActivityStatus = typeof chatActivityStatusSchema.Type;

export const chatMessageItemSchema = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("message"),
		message: messageSchema,
	}),
	Schema.Struct({
		kind: Schema.Literal("collaboration"),
		id: uuidSchema,
		threadId: uuidSchema,
		initiator: agentParticipantSchema,
		status: chatActivityStatusSchema,
		createdAt: isoTimestampSchema,
	}),
	Schema.Struct({
		kind: Schema.Literal("routine"),
		id: uuidSchema,
		threadId: uuidSchema,
		routineName: Schema.String,
		triggerKind: routineExecutionTriggerKindSchema,
		status: chatActivityStatusSchema,
		createdAt: isoTimestampSchema,
	}),
]);

export type ChatMessageItem = typeof chatMessageItemSchema.Type;

export const chatMessagesPageSchema = Schema.Struct({
	items: Schema.mutable(Schema.Array(chatMessageItemSchema)),
	nextCursor: Schema.NullOr(Schema.String),
});

export type ChatMessagesPage = typeof chatMessagesPageSchema.Type;

export const chatHistoryEntrySchema = Schema.Struct({
	threadId: uuidSchema,
	parentThreadId: Schema.NullOr(uuidSchema),
	type: customerThreadTypeSchema,
	title: Schema.String,
	participants: Schema.mutable(Schema.Array(threadParticipantSchema)),
	status: chatActivityStatusSchema,
	routineExecution: Schema.NullOr(routineExecutionSummarySchema),
	latestActivityAt: isoTimestampSchema,
});

export type ChatHistoryEntry = typeof chatHistoryEntrySchema.Type;

export const chatHistoryPageSchema = Schema.Struct({
	items: Schema.mutable(Schema.Array(chatHistoryEntrySchema)),
	nextCursor: Schema.NullOr(Schema.String),
});

export type ChatHistoryPage = typeof chatHistoryPageSchema.Type;
