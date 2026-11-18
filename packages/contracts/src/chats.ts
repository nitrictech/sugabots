import { Effect, Schema } from "effect";
import {
	automationStateSchema,
	runStateSchema,
	runSummarySchema,
	runTriggerKindSchema,
} from "./automations.ts";
import { botSchema } from "./bots.ts";
import { slugSchema } from "./channels.ts";
import {
	botParticipantSchema,
	botSummarySchema,
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

/** A channel's main chat or one of its threads, where its people and bots talk. */
export const channelConversationSchema = Schema.Struct({
	kind: Schema.Literal("channel_conversation"),
	...conversationFields,
	channelId: uuidSchema,
	/** Whether it is the channel's main chat, which is never archived. */
	main: Schema.Boolean,
	/** When somebody archived it; null while it is listed. */
	archivedAt: Schema.NullOr(isoTimestampSchema),
});

export type ChannelConversation = typeof channelConversationSchema.Type;

/**
 * A task: a conversation with one bot about one piece of work. The
 * collaborations and runs it leads to are opened beside it.
 */
export const taskSchema = Schema.Struct({
	kind: Schema.Literal("task"),
	...conversationFields,
	/** The bot it is with. */
	botId: uuidSchema,
	/** When somebody marked it done; null while it is open. */
	doneAt: Schema.NullOr(isoTimestampSchema),
});

export type Task = typeof taskSchema.Type;

/** An automation's feed, where each of its runs posts. */
export const automationFeedSchema = Schema.Struct({
	kind: Schema.Literal("automation_feed"),
	...conversationFields,
	/** The bot that runs the automation. */
	botId: uuidSchema,
	automationId: uuidSchema,
});

export type AutomationFeed = typeof automationFeedSchema.Type;

/** The most people a direct message between people may have, its sender included. */
export const MAX_DIRECT_MESSAGE_PEOPLE = 9;

/**
 * A direct message between two people, or a group of them, which nobody else
 * sees. It is in no channel, and has no bots. Its people never change: a
 * different set of people is a different one.
 */
const directMessageSchema = Schema.Struct({
	kind: Schema.Literal("direct_message"),
	...conversationFields,
});

export type DirectMessage = typeof directMessageSchema.Type;

/** Something people open and post in: a channel's conversation, a task, an automation's feed, or a direct message. */
const conversationSchema = Schema.Union([
	channelConversationSchema,
	taskSchema,
	automationFeedSchema,
	directMessageSchema,
]);

export type Conversation = typeof conversationSchema.Type;

/**
 * The channel whose conversations a list covers, by its id or, as an address
 * names it, its slug.
 */
export const chatListQuerySchema = Schema.Struct({
	channel: Schema.Union([uuidSchema, slugSchema]),
});

/**
 * One of a bot's tasks, with the bot. `conversation` is the whole task, so
 * opening it needs no request of its own. `lastMessage` is null until a
 * message is written.
 */
const chatListItemSchema = Schema.Struct({
	bot: botSchema,
	conversation: taskSchema,
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

/** How a channel stands for the person: its main chat's and threads' unread messages, and approvals. */
const channelMarkerSchema = Schema.Struct({
	unreadMessages: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	needsApproval: Schema.Boolean,
});

export type ChannelMarker = typeof channelMarkerSchema.Type;

/** How a bot stands for the person: as a channel does, over its tasks and automations' feeds, and its failed automations. */
const botMarkerSchema = Schema.Struct({
	...channelMarkerSchema.fields,
	/** How many of its automations' latest runs failed since the person last opened them. */
	failedAutomations: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export type BotMarker = typeof botMarkerSchema.Type;

/**
 * How each channel the person is in, and each bot they see, stands for them,
 * for the sidebar: how many unread messages its conversations hold, whether
 * any waits for a decision they may make, and for a bot, how many of its
 * automations failed. Those with none of these are left out.
 */
export const channelConversationMarkersSchema = Schema.Struct({
	channels: Schema.Record(uuidSchema, channelMarkerSchema),
	bots: Schema.Record(uuidSchema, botMarkerSchema),
});

export type ChannelConversationMarkers = typeof channelConversationMarkersSchema.Type;

/**
 * A tool call somebody was asked to approve, with where it was asked: the
 * bot that asked, the channel if it was asked in one, and the conversation to
 * open it in.
 */
const approvalRequestSchema = Schema.Struct({
	/** The call, its approval included. */
	call: toolCallPartSchema,
	/** The bot that asked. */
	bot: botParticipantSchema,
	/** The channel it was asked in; null in a bot's task. */
	channelId: Schema.NullOr(uuidSchema),
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
 * channels they reach, newest first.
 */
export const approvalInboxSchema = Schema.Struct({
	waiting: Schema.mutable(Schema.Array(approvalRequestSchema)),
	answered: Schema.mutable(Schema.Array(answeredApprovalSchema)),
});

export type ApprovalInbox = typeof approvalInboxSchema.Type;

/** Where something in the inbox happened, and whether the person has caught up with it. */
const inboxPlaceFields = {
	/** The conversation people open that it is in. */
	rootConversationId: uuidSchema,
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
		/** The channel it is in; null in a task or a direct message. */
		channelId: Schema.NullOr(uuidSchema),
		...inboxPlaceFields,
	}),
	Schema.Struct({
		kind: Schema.Literal("run"),
		/** The run's own conversation. */
		conversationId: uuidSchema,
		automationName: Schema.String,
		state: runStateSchema,
		/** What started it: its schedule, its webhook, or somebody by hand. */
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
 * One of a bot's automations, with the feed its runs post in: null until it
 * first runs or somebody opens it.
 */
const listedAutomationSchema = Schema.Struct({
	automation: Schema.Struct({
		id: uuidSchema,
		name: Schema.String,
		state: automationStateSchema,
		/** Its latest run failed, and the person has not opened its feed since. */
		failed: Schema.Boolean,
		/** It paused itself after runs in a row failed, rather than somebody pausing it. */
		pausedAfterFailures: Schema.Boolean,
	}),
	/** The bot that runs it. */
	bot: botSchema,
	conversation: Schema.NullOr(automationFeedSchema),
	/** A message in its feed the person has not read mentions them. */
	mentionsYou: Schema.Boolean,
});

export type ListedAutomation = typeof listedAutomationSchema.Type;

/**
 * A channel's conversations: its main chat first, then its threads not
 * archived in the order they were started, each with how many of its
 * messages the person has not read.
 */
export const chatListSchema = Schema.Struct({
	chats: Schema.mutable(
		Schema.Array(
			Schema.Struct({
				conversation: channelConversationSchema,
				unreadMessages: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
			}),
		),
	),
});

export type ChatList = typeof chatListSchema.Type;

/** A bot's tasks, most recent message first, and its automations, by name. */
export const botTaskListSchema = Schema.Struct({
	tasks: Schema.mutable(Schema.Array(chatListItemSchema)),
	automations: Schema.mutable(Schema.Array(listedAutomationSchema)),
	/** What the bot has been doing lately, at a glance; null until its first task is summarised. */
	summary: Schema.NullOr(botSummarySchema),
});

export type BotTaskList = typeof botTaskListSchema.Type;

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

/** The first message of a new task with a bot. */
export const newTaskSchema = Schema.Struct({
	id: uuidSchema,
	message: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(MESSAGE_MAX_LENGTH)),
});

export type NewTask = typeof newTaskSchema.Type;

export const CHAT_NAME_MAX_LENGTH = 64;

/** What a channel's main chat is called until somebody renames it. */
export const FIRST_CHAT_NAME = "General";

/** What a channel's conversation is called. */
const chatNameSchema = Schema.Trim.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(CHAT_NAME_MAX_LENGTH),
);

/** Another thread in a channel: what it is called. */
export const newChatSchema = Schema.Struct({ name: chatNameSchema });

/** A task started with a bot, and the message it was started with. */
export const startedTaskSchema = Schema.Struct({
	conversation: taskSchema,
	message: messageSchema,
}).annotate({ identifier: "StartedTask" });

export type StartedTask = typeof startedTaskSchema.Type;

/** The conversations a conversation lists among its messages, opened beside it: collaborations and runs. */
export const itemConversationKindSchema = Schema.Literals(["collaboration", "run"]);

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
	latestActivityAt: isoTimestampSchema,
});

export type ChatHistoryEntry = typeof chatHistoryEntrySchema.Type;

export const chatHistoryPageSchema = Schema.Struct({
	items: Schema.mutable(Schema.Array(chatHistoryEntrySchema)),
	nextCursor: Schema.NullOr(Schema.String),
});

export type ChatHistoryPage = typeof chatHistoryPageSchema.Type;
