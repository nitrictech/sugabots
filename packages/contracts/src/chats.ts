import { Effect, Schema } from "effect";
import { agentSchema } from "./agents.ts";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "./attachments.ts";
import { podSlugSchema } from "./pods.ts";
import {
	routineExecutionStateSchema,
	routineExecutionSummarySchema,
	routineExecutionTriggerKindSchema,
} from "./routines.ts";
import {
	agentParticipantSchema,
	collaborationStatusSchema,
	messageSchema,
	threadParticipantSchema,
	toolCallPartSchema,
} from "./threads.ts";
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

/**
 * A conversation: a thread people talk to a bot in, in a pod, which the
 * collaborations and routine runs it leads to are opened beside.
 */
export const conversationSchema = Schema.Struct({
	id: uuidSchema,
	workspaceId: uuidSchema,
	podId: uuidSchema,
	/** The bot it is with; null on the pod's chat, which is the pod's people's. */
	hostAgentId: Schema.NullOr(uuidSchema),
	title: Schema.String,
	createdAt: isoTimestampSchema,
	updatedAt: isoTimestampSchema,
});

export type Conversation = typeof conversationSchema.Type;

/**
 * The pod whose chats a list covers, by its id or, as an address names it,
 * its slug.
 */
export const chatListQuerySchema = Schema.Struct({
	pod: Schema.Union([uuidSchema, podSlugSchema]),
});

/**
 * One row of the conversation list: a thread in the pod, with the bot it is
 * with, or null when it is between people. `conversation` is the whole
 * thread, so opening it needs no request of its own. `lastMessage` is null
 * until a message is written.
 */
export const chatListItemSchema = Schema.Struct({
	agent: Schema.NullOr(agentSchema),
	conversation: conversationSchema,
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
	 * The tool the conversation's newest reply waiting for approval would run first, or
	 * null. Such a reply may have written nothing at all, so this stands in for
	 * a preview.
	 */
	waitingOn: Schema.NullOr(Schema.String),
	/**
	 * How many messages somebody else finished since the person last read the
	 * conversation or last wrote in it, whichever came later.
	 */
	unreadMessages: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	/** A tool call in the conversation is waiting for a decision the person may make. */
	needsApproval: Schema.Boolean,
});

export type ChatListItem = typeof chatListItemSchema.Type;

/**
 * How each pod the person reaches stands for them, for the rail: how many
 * unread messages its conversations hold, and whether any waits for a decision they
 * may make.
 * Pods with neither are left out.
 */
export const podChatMarkersSchema = Schema.Struct({
	pods: Schema.Record(
		uuidSchema,
		Schema.Struct({
			unreadMessages: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
			needsApproval: Schema.Boolean,
		}),
	),
});

export type PodChatMarkers = typeof podChatMarkersSchema.Type;

/**
 * A tool call somebody was asked to approve, with where it was asked: the
 * bot that asked, its pod, and the conversation to open it in.
 */
export const approvalRequestSchema = Schema.Struct({
	/** The call, its approval included. */
	call: toolCallPartSchema,
	/** The bot that asked. */
	agent: agentParticipantSchema,
	podId: uuidSchema,
	/** The thread the call was made in: the conversation itself, or a thread opened beside it. */
	threadId: uuidSchema,
	/** The conversation the thread is in, which opens it. */
	conversationId: Schema.NullOr(uuidSchema),
});

export type ApprovalRequest = typeof approvalRequestSchema.Type;

/** An approval request somebody answered: how, by whom, and when. */
export const answeredApprovalSchema = Schema.Struct({
	...approvalRequestSchema.fields,
	answer: Schema.Struct({
		status: Schema.Literals(["allowed", "denied"]),
		decidedByName: Schema.NullOr(Schema.String),
		decidedAt: isoTimestampSchema,
	}),
});

export type AnsweredApproval = typeof answeredApprovalSchema.Type;

/**
 * The approvals across a workspace as the person sees them: those waiting on
 * a decision they may make, oldest first, and the latest ones answered in the
 * pods they reach, newest first.
 */
export const approvalInboxSchema = Schema.Struct({
	waiting: Schema.mutable(Schema.Array(approvalRequestSchema)),
	answered: Schema.mutable(Schema.Array(answeredApprovalSchema)),
});

export type ApprovalInbox = typeof approvalInboxSchema.Type;

/** Where something in the activity feed happened, and whether the person has caught up with it. */
const activityPlaceFields = {
	podId: uuidSchema,
	/** The conversation it is in, which opens it. */
	conversationId: uuidSchema,
	at: isoTimestampSchema,
	/** It happened after the person last read the conversation or last wrote in it. */
	unread: Schema.Boolean,
};

/**
 * Something in one of the person's conversations worth their attention: a message
 * that mentions them or that they have not read, a routine run, or a
 * collaboration one bot opened with another.
 */
export const activityItemSchema = Schema.Union([
	Schema.Struct({
		/** Whether it names the person, or is only something new. */
		kind: Schema.Literals(["mention", "message"]),
		messageId: uuidSchema,
		author: threadParticipantSchema,
		/** The start of what it says. */
		preview: Schema.String,
		...activityPlaceFields,
	}),
	Schema.Struct({
		kind: Schema.Literal("routine"),
		/** The run's own thread. */
		threadId: uuidSchema,
		routineName: Schema.String,
		state: routineExecutionStateSchema,
		/** What started it: its schedule, its webhook, or somebody by hand. */
		triggerKind: routineExecutionTriggerKindSchema,
		/** The bot that ran it. */
		agent: agentParticipantSchema,
		/** The start of the run's last reply, or null while it has written nothing. */
		preview: Schema.NullOr(Schema.String),
		...activityPlaceFields,
	}),
	Schema.Struct({
		kind: Schema.Literal("collaboration"),
		/** The thread the asked bot answers in. */
		threadId: uuidSchema,
		initiator: agentParticipantSchema,
		recipient: agentParticipantSchema,
		status: collaborationStatusSchema,
		/** What the asking bot asked. */
		brief: Schema.String,
		...activityPlaceFields,
	}),
]);

export type ActivityItem = typeof activityItemSchema.Type;

/** What is new for the person across the workspace's conversations, newest first. */
export const activityFeedSchema = Schema.Struct({
	items: Schema.mutable(Schema.Array(activityItemSchema)),
});

export type ActivityFeed = typeof activityFeedSchema.Type;

/**
 * A pod's conversation list: its chat, null until somebody first opens it,
 * with how many of its messages the person has not read; and its bots, most
 * recent message first, those nobody has messaged last, by name.
 */
export const chatListSchema = Schema.Struct({
	podChat: Schema.NullOr(
		Schema.Struct({
			conversation: conversationSchema,
			unreadMessages: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		}),
	),
	items: Schema.mutable(Schema.Array(chatListItemSchema)),
});

export type ChatList = typeof chatListSchema.Type;

/** A message that starts a thread from a pod's chat, and the bot it is for, if one. */
export const newThreadSchema = Schema.Struct({
	id: uuidSchema,
	message: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)),
	/** Files the sender uploaded to the pod's chat and has not sent yet, which move to the thread. */
	attachments: Schema.optional(
		Schema.Array(uuidSchema).check(Schema.isMaxLength(MAX_ATTACHMENTS_PER_MESSAGE)),
	),
	/** The bot the thread is with; a thread between people when absent. */
	hostAgentId: Schema.optional(uuidSchema),
	/** The id of the message in the pod's chat that this one quotes and answers. */
	replyTo: Schema.optional(uuidSchema),
});

export type NewThread = typeof newThreadSchema.Type;

/** A thread started from a pod's chat, and the message it was started with. */
export const startedThreadSchema = Schema.Struct({
	conversation: conversationSchema,
	message: messageSchema,
});

export type StartedThread = typeof startedThreadSchema.Type;

/** The bot to open a conversation with, and the pod it is in. */
export const openConversationSchema = Schema.Struct({
	podId: uuidSchema,
	hostAgentId: uuidSchema,
});

export type OpenConversation = typeof openConversationSchema.Type;

export const customerThreadTypeSchema = Schema.Literals(["collaboration", "routine"]);

export const chatMessageItemSchema = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("message"),
		message: messageSchema,
	}),
	Schema.Struct({
		kind: Schema.Literal("routine"),
		id: uuidSchema,
		threadId: uuidSchema,
		routineName: Schema.String,
		triggerKind: routineExecutionTriggerKindSchema,
		createdAt: isoTimestampSchema,
	}),
	/** In a pod's chat: a thread somebody started from one of its messages, which it links to. */
	Schema.Struct({
		kind: Schema.Literal("thread"),
		id: uuidSchema,
		threadId: uuidSchema,
		/** The message in the chat it was started from, which it is shown under. */
		originMessageId: Schema.NullOr(uuidSchema),
		title: Schema.String,
		/** The bot it is with, or null when it is between people. */
		agent: Schema.NullOr(agentParticipantSchema),
		/** How many messages it has. */
		replies: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		/** When its newest message was written; null until it has one. */
		lastReplyAt: Schema.NullOr(isoTimestampSchema),
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
