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
 * One of a project's chats, where its people and bots talk. A bot's chats
 * are the chats of its default project: chats with that one bot.
 * The collaborations and runs a chat leads to are opened beside it.
 */
export const projectChatSchema = Schema.Struct({
	kind: Schema.Literal("project_chat"),
	...chatFields,
	projectId: uuidSchema,
	/**
	 * On one of a bot's chats, in its default project: the bot. Null in a
	 * project people made.
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
	/** When the project is a bot's default project: the bot. Null in a project people made. */
	botId: Schema.NullOr(uuidSchema),
	automationId: uuidSchema,
});

export type AutomationFeed = typeof automationFeedSchema.Type;

/** Something people open and post in: a project's chat or an automation's feed. */
const chatSchema = Schema.Union([projectChatSchema, automationFeedSchema]);

export type Chat = typeof chatSchema.Type;

/**
 * A chat's status, how it stands in a list: a bot's
 * turn is `working` on a reply, or `waiting` on an approval, each `since` the
 * turn started or the tool call asked; or a bot `replied` `at` the time its
 * reply was finished, and the person has not read it yet. Not whether the
 * chat is resolved, which a person sets.
 */
const chatStatusSchema = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("working"), since: isoTimestampSchema }),
	Schema.Struct({ kind: Schema.Literal("waiting"), since: isoTimestampSchema }),
	Schema.Struct({ kind: Schema.Literal("replied"), at: isoTimestampSchema }),
]);

export type ChatStatus = typeof chatStatusSchema.Type;

/**
 * One of a project's chats as its list shows it. `chat` is the
 * whole chat, so opening it needs no request of its own. `lastMessage` is
 * null until a message is written.
 */
const listedChatSchema = Schema.Struct({
	chat: projectChatSchema,
	lastMessage: Schema.NullOr(
		Schema.Struct({
			/** The message's first line, shortened for a one-line row. */
			preview: Schema.String,
			/** The person who wrote it, or null when the bot did. */
			authorPersonId: Schema.NullOr(uuidSchema),
			at: isoTimestampSchema,
		}),
	),
	/** Who has written in it lately, most recently active first, as its own details list them. */
	participants: Schema.Array(participantSchema),
	/** How many messages it holds, people's and the bot's alike. */
	messageCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	/**
	 * How many messages somebody else finished since the person last read the
	 * chat or last wrote in it, whichever came later.
	 */
	unreadMessages: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	/** A tool call in the chat is waiting for a decision the person may make. */
	needsApproval: Schema.Boolean,
	/** A message the person has not read mentions them. */
	mentionsYou: Schema.Boolean,
	/** What its bots are doing now, or a reply not read yet; null when neither. */
	status: Schema.NullOr(chatStatusSchema),
});

export type ListedChat = typeof listedChatSchema.Type;

/**
 * How a project stands for the person, over its chats and automation
 * feeds: their unread messages, whether any waits for a decision they may
 * make, and how many of its automations are failing unseen.
 */
const attentionMarkSchema = Schema.Struct({
	unreadMessages: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	needsApproval: Schema.Boolean,
	/** How many of its automations are failing and the person has not opened since. */
	failedAutomations: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export type AttentionMark = typeof attentionMarkSchema.Type;

/**
 * How each project the person reaches stands for them, for the sidebar, by
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
	/** The project it was asked in; null in a bot's chat, which is in the bot's default project. */
	projectId: Schema.NullOr(uuidSchema),
	/** The chat the call was made in: the one people open, or one opened beside it. */
	chatId: uuidSchema,
	/** The chat people open that it is in. */
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
 * The approvals across a workspace as the person sees them: those waiting on
 * a decision they may make, oldest first, and the latest ones answered in the
 * projects they reach, newest first.
 */
export const workspaceApprovalsSchema = Schema.Struct({
	waiting: Schema.mutable(Schema.Array(approvalRequestSchema)),
	answered: Schema.mutable(Schema.Array(answeredApprovalSchema)),
});

export type WorkspaceApprovals = typeof workspaceApprovalsSchema.Type;

/**
 * What the chat people open is, and so where it is listed: a chat or
 * automation feed in a project people made, or one in a bot's default project,
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
	/** A message in its feed the person has not read mentions them. */
	mentionsYou: Schema.Boolean,
	/** Its latest run and whether it is failing: whoever reads the project reads its automations' runs. */
	status: automationListStatusSchema,
});

export type ListedAutomation = typeof listedAutomationSchema.Type;

/**
 * A project's chats, resolved ones among them, the newest message
 * first, each with how it stands for the person, and its automations, by
 * name. A bot's are its default project's.
 */
export const projectChatListSchema = Schema.Struct({
	chats: Schema.mutable(Schema.Array(listedChatSchema)),
	automations: Schema.mutable(Schema.Array(listedAutomationSchema)),
});

export type ProjectChatList = typeof projectChatListSchema.Type;

/**
 * How much in the workspace waits for the person: what the app's badge
 * counts. Mentions are counted over the last 30 days, past which a message
 * is old news, read or not.
 */
export const attentionCountsSchema = Schema.Struct({
	/** Approvals waiting on a decision the person may make. */
	waitingApprovals: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	/** Unread messages and automation results that mention the person. */
	unreadForYou: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export type AttentionCounts = typeof attentionCountsSchema.Type;

/**
 * The first message of a new chat in a project: a bot's chat is started
 * in its default project.
 */
export const firstChatMessageSchema = Schema.Struct({
	id: uuidSchema,
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

/** The chats a chat lists among its messages, opened beside it: collaborations and runs. */
const nestedChatKindSchema = Schema.Literals(["collaboration", "run"]);

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
	chatId: uuidSchema,
	parentChatId: Schema.NullOr(uuidSchema),
	kind: nestedChatKindSchema,
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
