import { Effect, Schema } from "effect";
import {
	automationListStatusSchema,
	automationStateSchema,
	listedRunSchema,
	runStateSchema,
	runTriggerKindSchema,
} from "./automations.ts";
import {
	botParticipantSchema,
	MESSAGE_MAX_LENGTH,
	messageSchema,
	participantSchema,
	toolCallPartSchema,
} from "./messages.ts";
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

/** What every kind of chat has. */
const chatFields = {
	id: uuidSchema,
	workspaceId: uuidSchema,
	title: Schema.String,
	createdAt: isoTimestampSchema,
	updatedAt: isoTimestampSchema,
};

/**
 * One of a project's chats, where its members and bots talk. A bot's chats
 * are the chats of its default project: chats with that one bot.
 */
export const projectChatSchema = Schema.Struct({
	kind: Schema.Literal("project_chat"),
	...chatFields,
	projectId: uuidSchema,
	/**
	 * On one of a bot's chats, in its default project: the bot. Null in a
	 * project members made.
	 */
	botId: Schema.NullOr(uuidSchema),
	/** When somebody marked it resolved; null while it is open. */
	resolvedAt: Schema.NullOr(isoTimestampSchema),
});

export type ProjectChat = typeof projectChatSchema.Type;

/** An automation's feed, where each of its runs posts, in the automation's project. */
export const automationFeedSchema = Schema.Struct({
	kind: Schema.Literal("automation_feed"),
	...chatFields,
	projectId: uuidSchema,
	/** When the project is a bot's default project: the bot. Null in a project members made. */
	botId: Schema.NullOr(uuidSchema),
	automationId: uuidSchema,
});

export type AutomationFeed = typeof automationFeedSchema.Type;

/** Something members open and post in: a project's chat or an automation's feed. */
const chatSchema = Schema.Union([projectChatSchema, automationFeedSchema]);

export type Chat = typeof chatSchema.Type;

/**
 * A chat's status, how it stands in a list: a bot's
 * turn is `working` on a reply, or `waiting` on an approval, each `since` the
 * turn started or the tool call asked; or a bot `replied` `at` the time its
 * reply was finished, and the member has not read it yet. Not whether the
 * chat is resolved, which a member sets.
 */
const chatStatusSchema = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("working"), since: isoTimestampSchema }),
	Schema.Struct({ kind: Schema.Literal("waiting"), since: isoTimestampSchema }),
	Schema.Struct({ kind: Schema.Literal("replied"), at: isoTimestampSchema }),
]);

export type ChatStatus = typeof chatStatusSchema.Type;

/**
 * One of a project's chats as its list shows it. `chat` is the
 * whole chat, so opening it needs no request of its own.
 */
const listedChatSchema = Schema.Struct({
	chat: projectChatSchema,
	/** When its newest message was written; null until one is. */
	lastMessageAt: Schema.NullOr(isoTimestampSchema),
	/** Who has written in it lately, most recently active first, as its own details list them. */
	participants: Schema.Array(participantSchema),
	/** How many messages it holds, members' and the bot's alike. */
	messageCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	/**
	 * How many messages somebody else finished since the member last read the
	 * chat or last wrote in it, whichever came later.
	 */
	unreadMessages: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	/** A tool call in the chat is waiting for a decision the member may make. */
	needsApproval: Schema.Boolean,
	/** A message the member has not read mentions them. */
	mentionsYou: Schema.Boolean,
	/** What its bots are doing now, or a reply not read yet; null when neither. */
	status: Schema.NullOr(chatStatusSchema),
});

export type ListedChat = typeof listedChatSchema.Type;

/**
 * How a project stands for the member, over its chats and automation
 * feeds: their unread messages, whether any waits for a decision they may
 * make, and how many of its automations are failing unseen.
 */
const attentionMarkSchema = Schema.Struct({
	unreadMessages: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	needsApproval: Schema.Boolean,
	/** How many of its automations are failing and the member has not opened since. */
	failedAutomations: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export type AttentionMark = typeof attentionMarkSchema.Type;

/**
 * How each project the member reaches stands for them, for the sidebar, by
 * the project's id. A bot's attention mark is its default project's. Projects with
 * nothing to mark are left out.
 */
export const attentionMarksSchema = Schema.Struct({
	projects: Schema.Record(uuidSchema, attentionMarkSchema),
});

export type AttentionMarks = typeof attentionMarksSchema.Type;

/**
 * A tool call somebody was asked to approve, with where it was asked: the
 * bot that asked, the project if it was asked in one, and the chat to
 * open it in.
 */
const approvalRequestSchema = Schema.Struct({
	/** The call, its approval included. */
	call: toolCallPartSchema,
	/** The bot that asked. */
	bot: botParticipantSchema,
	/** The reached chat's listed project, or the computer's project when the chat is out of reach. */
	projectId: Schema.NullOr(uuidSchema),
	/** The computer's project name, for a request from a chat out of reach. */
	projectName: Schema.optional(Schema.String),
	/** The chat the call was made in, when the member reaches it. */
	chatId: Schema.NullOr(uuidSchema),
	/** The chat members open that it is in. */
	rootChatId: Schema.NullOr(uuidSchema),
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
 * The approvals across a workspace as the member sees them: those waiting on
 * a decision they may make, oldest first, and the latest ones answered in the
 * projects they reach, newest first.
 */
export const workspaceApprovalsSchema = Schema.Struct({
	waiting: Schema.mutable(Schema.Array(approvalRequestSchema)),
	answered: Schema.mutable(Schema.Array(answeredApprovalSchema)),
});

export type WorkspaceApprovals = typeof workspaceApprovalsSchema.Type;

/**
 * What the chat members open is, and so where it is listed: a chat or
 * automation feed in a project members made, or one in a bot's default project,
 * which is listed under the bot.
 */
const chatLocationSchema = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("project"), projectId: uuidSchema }),
	Schema.Struct({ kind: Schema.Literal("bot"), botId: uuidSchema }),
]);

export type ChatLocation = typeof chatLocationSchema.Type;

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
	chat: Schema.NullOr(automationFeedSchema),
	/** A message in its feed the member has not read mentions them. */
	mentionsYou: Schema.Boolean,
	/** Its latest run and whether it is failing: whoever reads the project reads its automations' runs. */
	status: automationListStatusSchema,
});

export type ListedAutomation = typeof listedAutomationSchema.Type;

/**
 * A project's chats, resolved ones among them, the newest message
 * first, each with how it stands for the member, and its automations, by
 * name. A bot's are its default project's.
 */
export const projectChatListSchema = Schema.Struct({
	chats: Schema.mutable(Schema.Array(listedChatSchema)),
	automations: Schema.mutable(Schema.Array(listedAutomationSchema)),
});

export type ProjectChatList = typeof projectChatListSchema.Type;

/**
 * How much in the workspace waits for the member: what the app's badge
 * counts. Mentions are counted over the last 30 days, past which a message
 * is old news, read or not.
 */
export const attentionCountsSchema = Schema.Struct({
	/** Approvals waiting on a decision the member may make. */
	waitingApprovals: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	/** Unread messages and automation results that mention the member. */
	unreadForYou: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export type AttentionCounts = typeof attentionCountsSchema.Type;

/**
 * The first message of a new chat in a project: a bot's chat is started
 * in its default project.
 */
export const firstChatMessageSchema = Schema.Struct({
	retryKey: uuidSchema,
	message: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(MESSAGE_MAX_LENGTH)),
});

export type FirstChatMessage = typeof firstChatMessageSchema.Type;

export const CHAT_NAME_MAX_LENGTH = 64;

/** What one of a project's chats is renamed to. */
export const chatNameSchema = Schema.Struct({
	name: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(CHAT_NAME_MAX_LENGTH)),
});

/** A chat started from its first message, and that message. */
export const startedChatSchema = Schema.Struct({
	chat: projectChatSchema,
	message: messageSchema,
}).annotate({ identifier: "StartedChat" });

export type StartedChat = typeof startedChatSchema.Type;

const chatMessageItemSchema = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("message"),
		message: messageSchema,
	}),
	Schema.Struct({
		kind: Schema.Literal("run"),
		id: uuidSchema,
		chatId: uuidSchema,
		automationName: Schema.String,
		triggerKind: runTriggerKindSchema,
		/** How far the run has got, and, once it failed, why, in words fit for members. */
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

/** A chat a chat lists among its messages and opens beside it: an automation's run. */
const chatHistoryEntrySchema = Schema.Struct({
	chatId: uuidSchema,
	kind: Schema.Literal("run"),
	title: Schema.String,
	participants: Schema.mutable(Schema.Array(participantSchema)),
	status: Schema.Literals(["queued", "running", "completed", "failed", "cancelled"]),
	automationRun: Schema.NullOr(listedRunSchema),
});

export type ChatHistoryEntry = typeof chatHistoryEntrySchema.Type;

export const chatHistoryPageSchema = Schema.Struct({
	items: Schema.mutable(Schema.Array(chatHistoryEntrySchema)),
	nextCursor: Schema.NullOr(Schema.String),
});

export type ChatHistoryPage = typeof chatHistoryPageSchema.Type;
