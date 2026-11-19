import { Effect, Schema } from "effect";
import {
	automationListStatusSchema,
	automationStateSchema,
	runStateSchema,
	runSummarySchema,
	runTriggerKindSchema,
} from "./automations.ts";
import {
	botParticipantSchema,
	collaborationStatusSchema,
	MESSAGE_MAX_LENGTH,
	messageSchema,
	participantSchema,
	personParticipantSchema,
	toolCallPartSchema,
} from "./conversations.ts";
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
	title: Schema.String,
	createdAt: isoTimestampSchema,
	updatedAt: isoTimestampSchema,
};

/**
 * One of a project's threads, where its people and bots talk. A bot's threads
 * are the threads of its default project: conversations with that one bot.
 * The collaborations and runs a thread leads to are opened beside it.
 */
export const projectThreadSchema = Schema.Struct({
	kind: Schema.Literal("project_thread"),
	...conversationFields,
	projectId: uuidSchema,
	/**
	 * On one of a bot's threads, in its default project: the bot. Null in a
	 * project people made.
	 */
	botId: Schema.NullOr(uuidSchema),
	/** When somebody archived it; null while it is listed. */
	archivedAt: Schema.NullOr(isoTimestampSchema),
	/** When somebody marked it done; null while it is open. */
	doneAt: Schema.NullOr(isoTimestampSchema),
});

export type ProjectThread = typeof projectThreadSchema.Type;

/** An automation's feed, where each of its runs posts, in the automation's project. */
export const automationFeedSchema = Schema.Struct({
	kind: Schema.Literal("automation_feed"),
	...conversationFields,
	projectId: uuidSchema,
	/** When the project is a bot's default project: the bot. Null in a project people made. */
	botId: Schema.NullOr(uuidSchema),
	automationId: uuidSchema,
});

export type AutomationFeed = typeof automationFeedSchema.Type;

/** The most people a direct message between people may have, its sender included. */
export const MAX_DIRECT_MESSAGE_PEOPLE = 9;

/**
 * A direct message between two people, or a group of them, which nobody else
 * sees. It is in no project, and has no bots. Its people never change: a
 * different set of people is a different one.
 */
const directMessageSchema = Schema.Struct({
	kind: Schema.Literal("direct_message"),
	...conversationFields,
});

export type DirectMessage = typeof directMessageSchema.Type;

/** Something people open and post in: a project's thread, an automation's feed, or a direct message. */
const conversationSchema = Schema.Union([
	projectThreadSchema,
	automationFeedSchema,
	directMessageSchema,
]);

export type Conversation = typeof conversationSchema.Type;

/**
 * One of a project's threads as its list shows it. `conversation` is the
 * whole thread, so opening it needs no request of its own. `lastMessage` is
 * null until a message is written.
 */
const listedThreadSchema = Schema.Struct({
	conversation: projectThreadSchema,
	lastMessage: Schema.NullOr(
		Schema.Struct({
			/** The message's first line, shortened for a one-line row. */
			preview: Schema.String,
			/** The person who wrote it, or null when the bot did. */
			authorUserId: Schema.NullOr(uuidSchema),
			at: isoTimestampSchema,
		}),
	),
	/** Who has written in it lately, most recently active first, as its own details list them. */
	participants: Schema.Array(participantSchema),
	/** How many messages it holds, people's and the bot's alike. */
	messageCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
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

export type ListedThread = typeof listedThreadSchema.Type;

/**
 * How a project stands for the person, over its threads and automation
 * feeds: their unread messages, whether any waits for a decision they may
 * make, and how many of its automations are failing unseen.
 */
const projectMarkerSchema = Schema.Struct({
	unreadMessages: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	needsApproval: Schema.Boolean,
	/** How many of its automations are failing and the person has not opened since. */
	failedAutomations: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export type ProjectMarker = typeof projectMarkerSchema.Type;

/**
 * How each project the person reaches stands for them, for the sidebar, by
 * the project's id. A bot's marker is its default project's. Projects with
 * nothing to mark are left out.
 */
export const projectThreadMarkersSchema = Schema.Struct({
	projects: Schema.Record(uuidSchema, projectMarkerSchema),
});

export type ProjectThreadMarkers = typeof projectThreadMarkersSchema.Type;

/**
 * A tool call somebody was asked to approve, with where it was asked: the
 * bot that asked, the project if it was asked in one, and the conversation to
 * open it in.
 */
const approvalRequestSchema = Schema.Struct({
	/** The call, its approval included. */
	call: toolCallPartSchema,
	/** The bot that asked. */
	bot: botParticipantSchema,
	/** The project it was asked in; null in a bot's thread, which is in the bot's default project. */
	projectId: Schema.NullOr(uuidSchema),
	/** The conversation the call was made in: the one people open, or one opened beside it. */
	conversationId: uuidSchema,
	/** The conversation people open that it is in. */
	rootConversationId: Schema.NullOr(uuidSchema),
});

export type ApprovalRequest = typeof approvalRequestSchema.Type;

/** An approval request somebody answered: how, by whom, and when. */
const answeredApprovalSchema = Schema.Struct({
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
 * projects they reach, newest first.
 */
export const approvalInboxSchema = Schema.Struct({
	waiting: Schema.mutable(Schema.Array(approvalRequestSchema)),
	answered: Schema.mutable(Schema.Array(answeredApprovalSchema)),
});

export type ApprovalInbox = typeof approvalInboxSchema.Type;

/**
 * What the conversation people open is, and so where it is listed: a thread or
 * automation feed in a project people made, one in a bot's default project,
 * which is listed under the bot, or a direct message, which is in no project.
 */
export const conversationPlaceSchema = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("project"), projectId: uuidSchema }),
	Schema.Struct({ kind: Schema.Literal("bot"), botId: uuidSchema }),
	Schema.Struct({ kind: Schema.Literal("direct_message") }),
]);

export type ConversationPlace = typeof conversationPlaceSchema.Type;

/** Where something in the inbox happened, and whether the person has caught up with it. */
const inboxPlaceFields = {
	/** The conversation people open that it is in. */
	rootConversationId: uuidSchema,
	/** What `rootConversationId` is: a project's or a bot's thread or automation feed, or a direct message. */
	place: conversationPlaceSchema,
	at: isoTimestampSchema,
	/**
	 * It happened after the person last read the conversation or last wrote in
	 * it, and, for an automation run or collaboration, they have not opened it.
	 */
	unread: Schema.Boolean,
};

/**
 * Something in one of the person's conversations worth their attention: a message
 * that mentions them or that they have not read, an automation run that did not
 * end with nothing to report, or a collaboration one bot opened with another.
 * A run is unread only once it posted a result or failed.
 */
const inboxItemSchema = Schema.Union([
	Schema.Struct({
		/** Whether it names the person, or is only something new. */
		kind: Schema.Literals(["mention", "message"]),
		messageId: uuidSchema,
		author: participantSchema,
		/** The start of what it says. */
		preview: Schema.String,
		...inboxPlaceFields,
	}),
	Schema.Struct({
		kind: Schema.Literal("run"),
		/** The run's own conversation. */
		conversationId: uuidSchema,
		automationName: Schema.String,
		state: runStateSchema,
		/** What started it: its routine, its webhook, its GitHub event, or somebody by hand. */
		triggerKind: runTriggerKindSchema,
		/** The bot that ran it. */
		bot: botParticipantSchema,
		/** The start of the run's last reply, or null while it has written nothing. */
		preview: Schema.NullOr(Schema.String),
		/** Whether the result it posted mentions the person, asking something of them. */
		mentionsYou: Schema.Boolean,
		...inboxPlaceFields,
	}),
	Schema.Struct({
		kind: Schema.Literal("collaboration"),
		/** The conversation the asked bot answers in. */
		conversationId: uuidSchema,
		initiator: botParticipantSchema,
		recipient: botParticipantSchema,
		status: collaborationStatusSchema,
		/** What the asking bot asked. */
		brief: Schema.String,
		...inboxPlaceFields,
	}),
]);

export type InboxItem = typeof inboxItemSchema.Type;

/** What is new for the person across the workspace's conversations, newest first. */
export const inboxFeedSchema = Schema.Struct({
	items: Schema.mutable(Schema.Array(inboxItemSchema)),
});

export type InboxFeed = typeof inboxFeedSchema.Type;

/**
 * One of a project's automations, with the feed its runs post in: null until
 * it first runs or somebody opens it.
 */
const listedAutomationSchema = Schema.Struct({
	automation: Schema.Struct({
		id: uuidSchema,
		name: Schema.String,
		state: automationStateSchema,
		/** It paused itself after runs in a row failed, rather than somebody pausing it. */
		pausedAfterFailures: Schema.Boolean,
	}),
	conversation: Schema.NullOr(automationFeedSchema),
	/** A message in its feed the person has not read mentions them. */
	mentionsYou: Schema.Boolean,
	/** Its latest run and whether it is failing: whoever reads the project reads its automations' runs. */
	status: automationListStatusSchema,
});

export type ListedAutomation = typeof listedAutomationSchema.Type;

/**
 * A project's threads not archived, done ones among them, the newest message
 * first, each with how it stands for the person, and its automations, by
 * name. A bot's are its default project's.
 */
export const projectThreadListSchema = Schema.Struct({
	threads: Schema.mutable(Schema.Array(listedThreadSchema)),
	automations: Schema.mutable(Schema.Array(listedAutomationSchema)),
});

export type ProjectThreadList = typeof projectThreadListSchema.Type;

/** One of a bot's threads, as a list of threads across bots shows it: always with its bot. */
const botThreadSchema = Schema.Struct({
	...listedThreadSchema.fields,
	conversation: Schema.Struct({
		...projectThreadSchema.fields,
		/** The bot whose default project it is in. */
		botId: uuidSchema,
	}),
});

export type BotThread = typeof botThreadSchema.Type;

export const RECENT_THREADS_MAX_LIMIT = 50;

/** How many recent threads to list. */
export const recentThreadsQuerySchema = Schema.Struct({
	limit: Schema.String.check(Schema.isPattern(/^\d+$/)).pipe(
		Schema.decodeTo(Schema.FiniteFromString),
		Schema.check(
			Schema.isInt(),
			Schema.isBetween({ minimum: 1, maximum: RECENT_THREADS_MAX_LIMIT }),
		),
	),
});

/**
 * The threads the person has been working on most lately, newest message
 * first: those not done that they take part in, of the bots they pinned and
 * of their Personal Assistant.
 */
export const recentThreadsSchema = Schema.Struct({
	threads: Schema.mutable(Schema.Array(botThreadSchema)),
});

export type RecentThreads = typeof recentThreadsSchema.Type;

/**
 * How much in the workspace waits for the person, counted over the same
 * window as the inbox, but not only its latest items.
 */
export const attentionCountsSchema = Schema.Struct({
	/** Everything in the inbox the person has not read: messages, runs and collaborations. */
	unreadInInbox: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	/** Approvals waiting on a decision the person may make. */
	waitingApprovals: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	/**
	 * Unread messages that mention the person outside their direct messages,
	 * automation results that mention them, and every unread message in their
	 * direct messages.
	 */
	unreadForYou: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export type AttentionCounts = typeof attentionCountsSchema.Type;

/**
 * One of the person's direct messages, with one other person or a group.
 * `people` leaves out the person themselves, and anybody who has left the
 * workspace; `formerMembers` counts those.
 */
export const directMessageListItemSchema = Schema.Struct({
	conversation: directMessageSchema,
	/** The others in it, by name. */
	people: Schema.mutable(Schema.Array(personParticipantSchema)),
	/** How many others in it have left the workspace. */
	formerMembers: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	/** Its newest message with words in it, or null until one is written. */
	lastMessage: Schema.NullOr(
		Schema.Struct({
			/** The message's first line, shortened for a one-line row. */
			preview: Schema.String,
			/** Who wrote it; null once their account is gone. */
			authorUserId: Schema.NullOr(uuidSchema),
			at: isoTimestampSchema,
		}),
	),
	/** How many messages the others finished since the person last read it or wrote in it. */
	unreadMessages: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export type DirectMessageListItem = typeof directMessageListItemSchema.Type;

/** The person's direct messages in a workspace, the most recent message first. */
export const directMessageListSchema = Schema.Struct({
	items: Schema.mutable(Schema.Array(directMessageListItemSchema)),
});

export type DirectMessageList = typeof directMessageListSchema.Type;

/**
 * A message to one person or a group: it goes to the direct message between
 * the sender and them, which is opened if they have none. Naming the sender
 * too changes nothing, so up to the whole group may be named.
 */
export const newDirectMessageSchema = Schema.Struct({
	/** The others it is to, by id. */
	userIds: Schema.Array(uuidSchema).check(
		Schema.isMinLength(1),
		Schema.isMaxLength(MAX_DIRECT_MESSAGE_PEOPLE),
	),
	/** The message's id, so sending it again does not send it twice. */
	id: uuidSchema,
	message: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(MESSAGE_MAX_LENGTH)),
});

export type NewDirectMessage = typeof newDirectMessageSchema.Type;

/** The direct message a new message went to, and the message. */
export const sentDirectMessageSchema = Schema.Struct({
	conversation: directMessageSchema,
	message: messageSchema,
}).annotate({ identifier: "SentDirectMessage" });

/**
 * The first message of a new thread in a project: a bot's thread is started
 * in its default project.
 */
export const firstThreadMessageSchema = Schema.Struct({
	id: uuidSchema,
	message: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(MESSAGE_MAX_LENGTH)),
});

export type FirstThreadMessage = typeof firstThreadMessageSchema.Type;

export const THREAD_NAME_MAX_LENGTH = 64;

/** What one of a project's threads is renamed to. */
export const threadNameSchema = Schema.Struct({
	name: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(THREAD_NAME_MAX_LENGTH)),
});

/** A thread started from its first message, and that message. */
export const startedThreadSchema = Schema.Struct({
	conversation: projectThreadSchema,
	message: messageSchema,
}).annotate({ identifier: "StartedThread" });

export type StartedThread = typeof startedThreadSchema.Type;

/** The conversations a conversation lists among its messages, opened beside it: collaborations and runs. */
const itemConversationKindSchema = Schema.Literals(["collaboration", "run"]);

const chatMessageItemSchema = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("message"),
		message: messageSchema,
	}),
	Schema.Struct({
		kind: Schema.Literal("run"),
		id: uuidSchema,
		conversationId: uuidSchema,
		automationName: Schema.String,
		triggerKind: runTriggerKindSchema,
		/** How far the run has got, and, once it failed, why, in words fit for people. */
		state: runStateSchema,
		error: Schema.NullOr(Schema.String),
		/** What the run's bot last said in it, or null while it has said nothing. */
		report: Schema.NullOr(Schema.String),
		createdAt: isoTimestampSchema,
	}),
	/** In an automation's feed: the automation, by its id, paused itself after failing twice in a row. */
	Schema.Struct({
		kind: Schema.Literal("automation_paused"),
		id: uuidSchema,
		createdAt: isoTimestampSchema,
	}),
]);

export type ChatMessageItem = typeof chatMessageItemSchema.Type;

export const chatMessagesPageSchema = Schema.Struct({
	items: Schema.mutable(Schema.Array(chatMessageItemSchema)),
	nextCursor: Schema.NullOr(Schema.String),
});

export type ChatMessagesPage = typeof chatMessagesPageSchema.Type;

const chatHistoryEntrySchema = Schema.Struct({
	conversationId: uuidSchema,
	parentConversationId: Schema.NullOr(uuidSchema),
	kind: itemConversationKindSchema,
	title: Schema.String,
	participants: Schema.mutable(Schema.Array(participantSchema)),
	status: Schema.Literals(["queued", "running", "completed", "failed", "cancelled"]),
	automationRun: Schema.NullOr(runSummarySchema),
});

export type ChatHistoryEntry = typeof chatHistoryEntrySchema.Type;

export const chatHistoryPageSchema = Schema.Struct({
	items: Schema.mutable(Schema.Array(chatHistoryEntrySchema)),
	nextCursor: Schema.NullOr(Schema.String),
});

export type ChatHistoryPage = typeof chatHistoryPageSchema.Type;
