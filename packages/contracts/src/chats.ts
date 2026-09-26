import { Effect, Schema } from "effect";
import { agentSchema } from "./agents.ts";
import { routineExecutionSummarySchema, routineExecutionTriggerKindSchema } from "./routines.ts";
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

/**
 * Which chats a list covers: one pod, or `all`, every shared pod the person
 * can reach. Personal is left out of `all` because it is private and has its
 * own place on the rail.
 */
export const chatListScopeSchema = Schema.Union([uuidSchema, Schema.Literal("all")]);

export type ChatListScope = typeof chatListScopeSchema.Type;

export const chatListQuerySchema = Schema.Struct({ pod: chatListScopeSchema });

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
	 * Whether a tool call in the chat, or in a collaboration or routine run it
	 * holds, is waiting on a decision this person may make.
	 */
	needsApproval: Schema.Boolean,
});

export type ChatListItem = typeof chatListItemSchema.Type;

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
		createdAt: isoTimestampSchema,
	}),
	Schema.Struct({
		kind: Schema.Literal("routine"),
		id: uuidSchema,
		threadId: uuidSchema,
		routineName: Schema.String,
		triggerKind: routineExecutionTriggerKindSchema,
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
	status: Schema.Literals(["queued", "running", "completed", "failed", "cancelled"]),
	routineExecution: Schema.NullOr(routineExecutionSummarySchema),
	latestActivityAt: isoTimestampSchema,
});

export type ChatHistoryEntry = typeof chatHistoryEntrySchema.Type;

export const chatHistoryPageSchema = Schema.Struct({
	items: Schema.mutable(Schema.Array(chatHistoryEntrySchema)),
	nextCursor: Schema.NullOr(Schema.String),
});

export type ChatHistoryPage = typeof chatHistoryPageSchema.Type;
