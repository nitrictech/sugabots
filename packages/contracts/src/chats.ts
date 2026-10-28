import { Effect, Schema } from "effect";
import { agentSchema } from "./agents.ts";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "./attachments.ts";
import { podSlugSchema } from "./pods.ts";
import {
	routineExecutionStateSchema,
	routineExecutionSummarySchema,
	routineExecutionTriggerKindSchema,
	routineStateSchema,
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

/** What every kind of conversation has. */
const conversationFields = {
	id: uuidSchema,
	workspaceId: uuidSchema,
	podId: uuidSchema,
	title: Schema.String,
	createdAt: isoTimestampSchema,
	updatedAt: isoTimestampSchema,
};

/** One of a shared pod's chats, where its people talk and start threads. */
export const podChatSchema = Schema.Struct({
	kind: Schema.Literal("pod_chat"),
	...conversationFields,
	/** Whether it is the pod's first chat, which is never archived. */
	main: Schema.Boolean,
	/** When somebody archived it; null while it is listed. */
	archivedAt: Schema.NullOr(isoTimestampSchema),
});

export type PodChat = typeof podChatSchema.Type;

/**
 * A thread in a pod, with a bot or between people, and perhaps started from a
 * message in one of the pod's chats. The collaborations and routine runs it
 * leads to are opened beside it.
 */
export const conversationThreadSchema = Schema.Struct({
	kind: Schema.Literal("thread"),
	...conversationFields,
	/** The bot it is with; null when it is between people. */
	hostAgentId: Schema.NullOr(uuidSchema),
	/** The pod's chat it was started from, by its id; null when it was started with a bot directly. */
	startedInChatId: Schema.NullOr(uuidSchema),
	/** When somebody marked it done; null while it is open. */
	doneAt: Schema.NullOr(isoTimestampSchema),
});

export type ConversationThread = typeof conversationThreadSchema.Type;

/**
 * A bot's channel in a pod: one long conversation with the bot, shared by
 * everyone in the pod, which threads branch off.
 */
export const botChannelSchema = Schema.Struct({
	kind: Schema.Literal("bot_channel"),
	...conversationFields,
	/** The bot the channel is with. */
	hostAgentId: uuidSchema,
});

export type BotChannel = typeof botChannelSchema.Type;

/** A routine's own thread, where each of its runs posts. */
export const routineFeedSchema = Schema.Struct({
	kind: Schema.Literal("routine_feed"),
	...conversationFields,
	/** The bot that runs the routine. */
	hostAgentId: uuidSchema,
	routineId: uuidSchema,
});

export type RoutineFeed = typeof routineFeedSchema.Type;

/** Something people open and post in: a pod's chat, a bot's channel, a thread, or a routine's thread. */
export const conversationSchema = Schema.Union([
	podChatSchema,
	botChannelSchema,
	conversationThreadSchema,
	routineFeedSchema,
]);

export type Conversation = typeof conversationSchema.Type;

/**
 * The pod whose chats a list covers, by its id or, as an address names it,
 * its slug.
 */
export const chatListQuerySchema = Schema.Struct({
	pod: Schema.Union([uuidSchema, podSlugSchema]),
});

/**
 * One thread in the conversation list, with the bot it is with, or null when
 * it is between people. `conversation` is the whole thread, so opening it
 * needs no request of its own. `lastMessage` is null until a message is
 * written.
 */
export const chatListItemSchema = Schema.Struct({
	agent: Schema.NullOr(agentSchema),
	conversation: conversationThreadSchema,
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
	/** A message the person has not read mentions them. */
	mentionsYou: Schema.Boolean,
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
			/** How many of its routines' latest runs failed. */
			failedRoutines: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
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
 * One of a pod's routines in its conversation list, with the thread its runs
 * post in: null until it first runs or somebody opens it.
 */
export const listedRoutineSchema = Schema.Struct({
	routine: Schema.Struct({
		id: uuidSchema,
		name: Schema.String,
		state: routineStateSchema,
		/** Its latest run failed, and nothing has run it since. */
		failed: Schema.Boolean,
	}),
	/** The bot that runs it. */
	agent: agentSchema,
	conversation: Schema.NullOr(routineFeedSchema),
	/** A message in its thread the person has not read mentions them. */
	mentionsYou: Schema.Boolean,
});

export type ListedRoutine = typeof listedRoutineSchema.Type;

/**
 * A pod's conversation list: its chats not archived, the first one first and
 * the rest in the order they were started, each with how many of its messages
 * the person has not read, and none until somebody first opens one; its bots'
 * channels; its threads, most recent message first; and its routines.
 */
export const chatListSchema = Schema.Struct({
	chats: Schema.mutable(
		Schema.Array(
			Schema.Struct({
				conversation: podChatSchema,
				unreadMessages: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
			}),
		),
	),
	/** Its bots' channels, none until somebody first opens one. */
	channels: Schema.mutable(
		Schema.Array(
			Schema.Struct({
				/** The bot it is with, so the list can show it before the pod's bots load. */
				agent: agentSchema,
				conversation: botChannelSchema,
				unreadMessages: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
				/** A tool call in the channel is waiting for a decision the person may make. */
				needsApproval: Schema.Boolean,
				/** A message in the channel the person has not read mentions them. */
				mentionsYou: Schema.Boolean,
			}),
		),
	),
	threads: Schema.mutable(Schema.Array(chatListItemSchema)),
	/** Its bots' routines, by name. */
	routines: Schema.mutable(Schema.Array(listedRoutineSchema)),
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

export const CHAT_NAME_MAX_LENGTH = 64;

/** What a pod's first chat is called until somebody renames it. */
export const FIRST_CHAT_NAME = "General";

/** What a pod's chat is called. */
export const chatNameSchema = Schema.Trim.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(CHAT_NAME_MAX_LENGTH),
);

/** Another chat in a pod: what it is called. */
export const newChatSchema = Schema.Struct({ name: chatNameSchema });

export type NewChat = typeof newChatSchema.Type;

/** A thread started from a pod's chat, and the message it was started with. */
export const startedThreadSchema = Schema.Struct({
	conversation: conversationThreadSchema,
	message: messageSchema,
});

export type StartedThread = typeof startedThreadSchema.Type;

/** The bot whose channel to open, and the pod it is in. */
export const openBotChannelSchema = Schema.Struct({
	podId: uuidSchema,
	hostAgentId: uuidSchema,
});

export type OpenBotChannel = typeof openBotChannelSchema.Type;

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
		/** How far the run has got, and, once it failed, why, in words fit for people. */
		state: routineExecutionStateSchema,
		error: Schema.NullOr(Schema.String),
		/** What the run's bot last said in it, or null while it has said nothing. */
		report: Schema.NullOr(Schema.String),
		createdAt: isoTimestampSchema,
	}),
	/** In a routine's thread: the routine, by its id, paused itself after failing twice in a row. */
	Schema.Struct({
		kind: Schema.Literal("routine_paused"),
		id: uuidSchema,
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
