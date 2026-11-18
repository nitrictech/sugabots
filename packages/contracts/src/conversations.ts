import { Effect, Schema, SchemaGetter } from "effect";
import { fromMarkdown } from "mdast-util-from-markdown";
import { toString as mdastToString } from "mdast-util-to-string";
import {
	attachmentNameSchema,
	MAX_ATTACHMENTS_PER_MESSAGE,
	mediaTypeSchema,
} from "./attachments.ts";
import {
	automationResultOfSchema,
	automationStateSchema,
	automationTriggerAuthorSchema,
	runSchema,
} from "./automations.ts";
import { botColorSchema, botFaceSchema, botShapeSchema } from "./bots.ts";
import { emailSchema } from "./email.ts";
import { FILE_WRITING_TOOLS, fileWrittenSchema } from "./files.ts";
import { isoTimestampSchema } from "./timestamps.ts";
import { uuidSchema } from "./uuid.ts";

export const MAX_CONVERSATION_TITLE_CHARACTERS = 80;
export const DEFAULT_CONVERSATION_HISTORY_LIMIT = 50;
export const MAX_CONVERSATION_HISTORY_LIMIT = 100;

/**
 * What kind of conversation it is: a task with a bot, a channel's main chat
 * or conversation, a direct message between people, a collaboration a bot asked
 * for, an automation's run or feed, or a system bot's conversation.
 */
export const conversationKindSchema = Schema.Literals([
	"task",
	"channel_conversation",
	"collaboration",
	"run",
	"automation_feed",
	"system",
	"direct_message",
]);

export type ConversationKind = typeof conversationKindSchema.Type;

/** The conversations whose messages notify people: not an automation's feed, nor those bots work in. */
export const NOTIFYING_CONVERSATION_KINDS: ReadonlySet<ConversationKind> = new Set([
	"task",
	"channel_conversation",
	"direct_message",
]);

export const conversationHistoryQuerySchema = Schema.Struct({
	cursor: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
	limit: Schema.String.check(Schema.isPattern(/^\d+$/)).pipe(
		Schema.decodeTo(Schema.FiniteFromString),
		Schema.check(
			Schema.isInt(),
			Schema.isBetween({ minimum: 1, maximum: MAX_CONVERSATION_HISTORY_LIMIT }),
		),
		Schema.withDecodingDefault(Effect.succeed(String(DEFAULT_CONVERSATION_HISTORY_LIMIT))),
	),
});

export type ConversationHistoryQuery = typeof conversationHistoryQuerySchema.Type;

/**
 * A conversation of any kind, with where it is placed: its channel, its bot,
 * the conversation people open that it is in, and the one it was opened under.
 */
export const placedConversationSchema = Schema.Struct({
	id: uuidSchema,
	workspaceId: uuidSchema,
	/** The channel it is in; only a channel's own conversations are in one. */
	channelId: Schema.NullOr(uuidSchema),
	/** The bot it is with; null on a channel's conversation and a direct message. */
	botId: Schema.NullOr(uuidSchema),
	/**
	 * The conversation people open that it is in: its own id on a task, a
	 * channel's conversation, a direct message and an automation's feed; the
	 * one it hangs under on a collaboration; the automation's feed on a run.
	 * Null on a system bot's conversation.
	 */
	rootConversationId: Schema.NullOr(uuidSchema),
	kind: conversationKindSchema,
	title: Schema.Trim.check(
		Schema.isMinLength(1),
		Schema.isMaxLength(MAX_CONVERSATION_TITLE_CHARACTERS),
	),
	/** `running` while a turn is queued or in progress in it. */
	status: Schema.Literals(["running", "done"]),
	/**
	 * The conversation this one was opened under: the asking conversation of a
	 * collaboration, which holds the card for it, or the one a system bot serves.
	 */
	parentConversationId: Schema.NullOr(uuidSchema),
	/** When somebody marked the task done; null while it is open, and on any other kind. */
	doneAt: Schema.NullOr(isoTimestampSchema),
	/** Who started a task, channel conversation or direct message. */
	startedById: Schema.NullOr(uuidSchema),
	createdAt: isoTimestampSchema,
	updatedAt: isoTimestampSchema,
});

export type PlacedConversation = typeof placedConversationSchema.Type;

export const personParticipantSchema = Schema.Struct({
	kind: Schema.Literal("person"),
	id: uuidSchema,
	name: Schema.String,
	email: emailSchema,
	/** Derived from the name; how the person is mentioned. */
	handle: Schema.String,
	image: Schema.NullOr(Schema.String),
});

export type PersonParticipant = typeof personParticipantSchema.Type;

export const botParticipantSchema = Schema.Struct({
	kind: Schema.Literal("bot"),
	id: uuidSchema,
	name: Schema.String,
	handle: Schema.String,
	color: botColorSchema,
	face: botFaceSchema,
	shape: botShapeSchema,
});

export type BotParticipant = typeof botParticipantSchema.Type;

export const participantSchema = Schema.Union([personParticipantSchema, botParticipantSchema]);

export type Participant = typeof participantSchema.Type;

export const messageAuthorSchema = Schema.Union([
	personParticipantSchema,
	botParticipantSchema,
	automationTriggerAuthorSchema,
]);

export type MessageAuthor = typeof messageAuthorSchema.Type;

/** Who wrote a message, by name: an automation's trigger goes by the automation's. */
export function messageAuthorName(author: MessageAuthor): string {
	return author.kind === "automation_trigger" ? author.automationName : author.name;
}

export const textPartSchema = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });

/**
 * What may not come just before a mention's `@`: a word character, so an email
 * address is not a mention, and a `.` or `@`, so neither is a domain or `@@`.
 */
const NOT_BEFORE_MENTION = /[\w.@]/;

const MENTION = new RegExp(`(?<!${NOT_BEFORE_MENTION.source})@([a-z0-9]+(?:-[a-z0-9]+)*)`, "gi");

/** Whether the `@` at `index` in `content` can start a mention, handle or not. */
export function canStartMention(content: string, index: number): boolean {
	return content[index] === "@" && !NOT_BEFORE_MENTION.test(content[index - 1] ?? "");
}

/**
 * `content` split around its mentions: text at even indexes and, between them,
 * each mentioned handle as written, without its `@`.
 */
export function splitAroundMentions(content: string): string[] {
	return content.split(MENTION);
}

/**
 * A pattern matching a mention of `handle` or any of `more` as
 * `mentionedHandles` reads one, in syntax that JavaScript and Postgres regular
 * expressions both accept. Match it case-insensitively. Handles are lowercase
 * letters, digits and hyphens, so none needs escaping.
 */
export function mentionPattern(handle: string, ...more: string[]): string {
	return `(?<!${NOT_BEFORE_MENTION.source})@(?:${[handle, ...more].join("|")})(?![a-z0-9]|-[a-z0-9])`;
}

/**
 * Handles that address everyone in a conversation instead of one participant,
 * as `@here` and `@channel` do in Slack. Nothing tells who is active, so
 * both reach everyone who can see the conversation. They never give a bot a
 * turn: only a bot's own handle does.
 */
export const GROUP_MENTION_HANDLES = ["here", "channel"] as const;

export type GroupMentionHandle = (typeof GROUP_MENTION_HANDLES)[number];

export function isGroupMentionHandle(handle: string): handle is GroupMentionHandle {
	return (GROUP_MENTION_HANDLES as readonly string[]).includes(handle);
}

/** Whether a message addresses everyone, with `@here` or `@channel`. */
export function mentionsEveryone(content: string): boolean {
	return mentionedHandles(content).some(isGroupMentionHandle);
}

/**
 * Whether a message's mentioned `handles` address only people: at least one
 * is a person's or `@here`/`@channel`, and none is a bot's. A handle that is
 * nobody's, as when a name is written out rather than picked, is only text
 * and counts for neither. A bot replying wherever it is not named keeps out
 * of such a message, as it is meant for the people.
 */
export function mentionsOnlyPeople(
	handles: readonly string[],
	known: { botHandles: ReadonlySet<string>; peopleHandles: ReadonlySet<string> },
): boolean {
	const mentionsPeople = handles.some(
		(handle) => isGroupMentionHandle(handle) || known.peopleHandles.has(handle),
	);
	return mentionsPeople && !handles.some((handle) => known.botHandles.has(handle));
}

/** `content` without its mentions, the text around them kept as it is. */
export function withoutMentions(content: string): string {
	return splitAroundMentions(content)
		.filter((_, index) => index % 2 === 0)
		.join("");
}

/** The handles mentioned in a message, in order, without duplicates. */
export function mentionedHandles(content: string): string[] {
	const found = new Set<string>();
	for (const match of content.matchAll(MENTION)) {
		if (match[1]) found.add(match[1].toLowerCase());
	}
	return [...found];
}

/**
 * How a collaboration stands. `waiting`: the asking bot's turn is blocked
 * on the answer. `pending`: it gave up waiting and will be resumed when the
 * answer arrives. `answered` and `failed` are final.
 */
export const collaborationStatusSchema = Schema.Literals([
	"waiting",
	"pending",
	"answered",
	"failed",
]);

export type CollaborationStatus = typeof collaborationStatusSchema.Type;

/**
 * One bot asking another for help, in the middle of a reply. Sits between
 * the text parts at the point the bot made the call; the collaborator answers
 * in `conversationId`, a conversation of its own under this one.
 */
export const collaborationPartSchema = Schema.Struct({
	type: Schema.Literal("collaboration"),
	id: uuidSchema,
	/** The collaborator. */
	botId: uuidSchema,
	botName: Schema.String,
	/** The conversation the collaborator answers in. */
	conversationId: uuidSchema,
	brief: Schema.String,
	status: collaborationStatusSchema,
	answer: Schema.NullOr(Schema.String),
	/** How many characters of the reply's text had been written when the call was made. */
	atOffset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export type CollaborationPart = typeof collaborationPartSchema.Type;
/**
 * How a tool call stands. `running` while the tool executes; `completed` with
 * its output, or `failed` with the error the model was shown, once it returns.
 */
export const toolCallStatusSchema = Schema.Literals([
	"awaiting_approval",
	"running",
	"completed",
	"failed",
]);

export type ToolCallStatus = typeof toolCallStatusSchema.Type;

export const toolApprovalStatusSchema = Schema.Literals([
	"pending",
	"allowed",
	"denied",
	"automatic",
]);

export type ToolApprovalStatus = typeof toolApprovalStatusSchema.Type;

/**
 * Who may decide a tool call's approval: `conversation`, those who decide
 * approvals in the conversation it was raised in; `computer-managers`, those
 * who decide what the bot's computer may reach and has installed, for a bot's
 * request to change that.
 */
export const toolApprovalDecidersSchema = Schema.Literals(["conversation", "computer-managers"]);

export type ToolApprovalDeciders = typeof toolApprovalDecidersSchema.Type;

/**
 * jsonValueSchema validates JSON recursively but exposes shallow types, so the
 * recursive message-part types built on it stay within TypeScript's
 * instantiation depth.
 */
export const jsonValueSchema = Schema.Unknown.check(
	Schema.makeFilter(Schema.is(Schema.Json), { expected: "a JSON value" }),
).pipe(
	Schema.decodeTo(
		Schema.Union([
			Schema.String,
			Schema.Finite,
			Schema.Boolean,
			Schema.Null,
			Schema.mutable(Schema.Array(Schema.Unknown)),
			Schema.Record(Schema.String, Schema.Unknown),
		]),
	),
);

export type JsonValue = typeof jsonValueSchema.Type;

/**
 * One call a bot made to a built-in tool, in the middle of a reply. Sits
 * between the text parts at the point the call was made, like a collaboration.
 * `input` and `output` are whatever the tool took and returned, truncated by
 * the server when large.
 */
export const toolCallPartSchema = Schema.Struct({
	type: Schema.Literal("tool_call"),
	id: uuidSchema,
	/** The tool's key: `web_fetch`, `web_search`. */
	tool: Schema.String,
	input: jsonValueSchema,
	/** Null until the tool returns, and after it fails. */
	output: Schema.NullOr(jsonValueSchema),
	status: toolCallStatusSchema,
	/** Present only when the call passed through approval: a mutating connection call, or a request a person decides. */
	approval: Schema.optional(
		Schema.NullOr(
			Schema.Struct({
				status: toolApprovalStatusSchema,
				/** Absent: `conversation`. */
				deciders: Schema.optional(toolApprovalDecidersSchema),
				decidedByName: Schema.NullOr(Schema.String),
				decidedAt: Schema.NullOr(isoTimestampSchema),
			}),
		),
	),
	error: Schema.NullOr(Schema.String),
	/** Whether the tool may have changed something at the other end. */
	mutating: Schema.Boolean,
	/** How many characters of the reply's text had been written when the call was made. */
	atOffset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	startedAt: isoTimestampSchema,
	finishedAt: Schema.NullOr(isoTimestampSchema),
});

export type ToolCallPart = typeof toolCallPartSchema.Type;

/** The tool a bot starts a task with, for the person it is answering. */
export const START_TASK_TOOL = "start_task";

/** A task a bot started with `start_task`: what the tool returns, and what the chat links to. */
export const botStartedTaskSchema = Schema.Struct({
	id: uuidSchema,
	title: Schema.String,
	/** The bot it is with, by name, when that is another bot. */
	with: Schema.optional(Schema.String),
	/** That bot's id, which the chat finds it by. Absent from tasks started before it was recorded. */
	withBotId: Schema.optional(uuidSchema),
});

export type BotStartedTask = typeof botStartedTaskSchema.Type;

/** A file attached to the message, served by the conversation it was sent in. */
export const filePartSchema = Schema.Struct({
	type: Schema.Literal("file"),
	id: uuidSchema,
	name: attachmentNameSchema,
	contentType: mediaTypeSchema,
	/** In bytes. */
	size: Schema.Int,
});

export type FilePart = typeof filePartSchema.Type;

/** A file as written: which one, and the version the write left it at. */
const { status: _, ...writtenFileFields } = fileWrittenSchema.fields;

/**
 * A file the automation run behind a posted result wrote, at the version
 * the run left it at. The result carries it because the calls that wrote it
 * stay in the run's own conversation.
 */
export const writtenFilePartSchema = Schema.Struct({
	type: Schema.Literal("written_file"),
	...writtenFileFields,
});

export type WrittenFilePart = typeof writtenFilePartSchema.Type;

/**
 * Each file the calls wrote, once, at the last version they wrote, in the
 * order they first wrote them. Calls that wrote nothing, such as a refused
 * write or another tool's call, are skipped.
 */
export function filesWrittenBy(
	calls: Iterable<{ tool: string; status: string; output: unknown }>,
): WrittenFilePart[] {
	const latest = new Map<string, WrittenFilePart>();
	for (const call of calls) {
		if (call.status !== "completed" || !FILE_WRITING_TOOLS.has(call.tool)) continue;
		const written = Schema.decodeUnknownResult(fileWrittenSchema)(call.output);
		if (written._tag === "Failure") continue;
		const { status: _, ...file } = written.success;
		latest.set(file.fileId, { type: "written_file", ...file });
	}
	return [...latest.values()];
}

export const messagePartSchema = Schema.Union([
	textPartSchema,
	collaborationPartSchema,
	toolCallPartSchema,
	filePartSchema,
	writtenFilePartSchema,
]);

export type MessagePart = typeof messagePartSchema.Type;

/**
 * Whether the part at `index` is narration: text that comes straight before a
 * tool call, such as "Let me check:", which a conversation leaves out. Takes a
 * message's parts as the API sends them or as they are stored.
 */
export function isNarration(parts: readonly { type: string }[], index: number): boolean {
	return parts[index]?.type === "text" && parts[index + 1]?.type === "tool_call";
}

/** The longest `messagePreview` gives. */
export const MESSAGE_PREVIEW_CHARACTERS = 140;

/**
 * A message shortened for one line, as a conversation list row shows it: its first
 * line with words in it, markdown unwrapped to text, runs of spaces closed up,
 * cut at a word to fit `MESSAGE_PREVIEW_CHARACTERS`.
 */
export function messagePreview(content: string): string {
	const firstLine =
		content
			.split("\n")
			.values()
			.map((line) => markdownText(line).replace(/\s+/g, " ").trim())
			.find((line) => line !== "") ?? "";
	if (firstLine.length <= MESSAGE_PREVIEW_CHARACTERS) return firstLine;
	const cut = firstLine.slice(0, MESSAGE_PREVIEW_CHARACTERS - 1);
	const atWord = cut.lastIndexOf(" ");
	return `${(atWord > 0 ? cut.slice(0, atWord) : cut).trimEnd()}…`;
}

/** A message as a reply quotes it: its spoken text, without narration, by `messagePreview`. */
export function quotedPreview(message: {
	parts: readonly { type: string; text?: string }[];
	content: string;
}): string {
	return messagePreview(textWithoutNarration(message.parts) || message.content);
}

/** The text `markdown` reads as once rendered, without its syntax. */
function markdownText(markdown: string): string {
	return mdastToString(fromMarkdown(markdown));
}

/** A message's text as a conversation shows it: every text part but its narration. */
export function textWithoutNarration<Part extends { type: string; text?: string }>(
	parts: readonly Part[],
): string {
	return parts
		.map((part, index) => (part.type === "text" && !isNarration(parts, index) ? part.text : ""))
		.join("");
}

/** A part that sits in the reply's text at an offset: everything but text. */
export type PlacedPart = Extract<MessagePart, { atOffset: number }>;

/** A part attached to a message after its text rather than placed in it: a file, or an automation result's file. */
export type AttachedPart = Extract<MessagePart, { type: "file" | "written_file" }>;

export function isAttached(part: MessagePart): part is AttachedPart {
	return part.type === "file" || part.type === "written_file";
}

/** The collaborations and tool calls in a message, as they were placed in its text. */
export function placedParts(message: { parts: readonly MessagePart[] }): PlacedPart[] {
	return message.parts.filter((part): part is PlacedPart => "atOffset" in part);
}

/**
 * The parts of a message whose text is `content` and whose collaborations and
 * tool calls happened at the given offsets: text, a placed part, more text.
 * Shared by the server, which stores it, and the client, which rebuilds it as
 * text streams in.
 */
export function messagePartsFor<Placed extends { atOffset: number }>(
	content: string,
	placed: readonly Placed[],
): Array<{ type: "text"; text: string } | Placed> {
	const parts: Array<{ type: "text"; text: string } | Placed> = [];
	let written = 0;
	for (const part of [...placed].sort((a, b) => a.atOffset - b.atOffset)) {
		const at = Math.min(Math.max(part.atOffset, written), content.length);
		if (at > written) {
			parts.push({ type: "text", text: content.slice(written, at) });
		}
		parts.push(part);
		written = at;
	}
	if (written < content.length || parts.length === 0) {
		parts.push({ type: "text", text: content.slice(written) });
	}
	return parts;
}

export const messageStatusSchema = Schema.Literals([
	"complete",
	"streaming",
	"failed",
	"cancelled",
]);

export type MessageStatus = typeof messageStatusSchema.Type;

/** The message a reply quotes, as the reply shows it. */
export const messageReplyToSchema = Schema.Struct({
	id: uuidSchema,
	author: messageAuthorSchema,
	/** The quoted message shortened to one line, by `quotedPreview`. */
	preview: Schema.String,
});

export type MessageReplyTo = typeof messageReplyToSchema.Type;

/**
 * Exactly one emoji, by the regex `v` flag's `\p{RGI_Emoji}`. Some browsers the
 * web app runs in have no `v` flag (Safari before 17), and a literal using it
 * fails as its module loads, so it is built on first use. Without it, any one
 * character is taken: such a browser only reads emoji the API has already
 * checked, or sends them to the API, which checks them.
 */
function isSingleEmoji(text: string): boolean {
	if (rgiEmoji === undefined) {
		try {
			// biome-ignore lint/complexity/useRegexLiterals: a literal would fail where the flag is unknown, before this could catch it.
			rgiEmoji = new RegExp("^\\p{RGI_Emoji}$", "v");
		} catch {
			rgiEmoji = null;
		}
	}
	// A lone regional indicator, such as 🇦, is half a flag rather than an emoji of
	// its own, but pickers offer the 26 of them, so they are taken too.
	if (/^\p{Regional_Indicator}$/u.test(text)) return true;
	if (rgiEmoji) return rgiEmoji.test(text);
	return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length === 1;
}

let rgiEmoji: RegExp | null | undefined;

/** The most different emoji a message can have, so its reactions fit under it. */
export const MAX_REACTION_EMOJI_PER_MESSAGE = 20;

/**
 * A variation selector (U+FE0F) after a character shown as an emoji anyway.
 * Some emoji data writes one there, as Emojibase writes 👍, and with it the
 * emoji is not one Unicode recommends. One a character needs, as in ❤️, is kept.
 */
const SPARE_VARIATION_SELECTOR = /(\p{Emoji_Presentation})\uFE0F/gu;

/**
 * Exactly one emoji, as a keyboard or picker gives it: skin tones, flags and
 * families included. Decoding drops spare variation selectors, so the same
 * emoji written two ways is one reaction.
 */
export const reactionEmojiSchema = Schema.String.pipe(
	Schema.decodeTo(
		Schema.String.check(Schema.makeFilter(isSingleEmoji, { message: "Must be a single emoji" })),
		{
			decode: SchemaGetter.transform((emoji) => emoji.replace(SPARE_VARIATION_SELECTOR, "$1")),
			encode: SchemaGetter.passthrough(),
		},
	),
);

/** One emoji on a message, with the people who reacted with it, earliest first. */
export const messageReactionSchema = Schema.Struct({
	emoji: reactionEmojiSchema,
	people: Schema.mutable(
		Schema.Array(Schema.Struct({ id: uuidSchema, name: Schema.String, at: isoTimestampSchema })),
	),
});

export type MessageReaction = typeof messageReactionSchema.Type;

export const messageReactionsSchema = Schema.mutable(Schema.Array(messageReactionSchema));

export const messageSchema = Schema.Struct({
	id: uuidSchema,
	conversationId: uuidSchema,
	author: messageAuthorSchema,
	kind: Schema.Literal("text"),
	status: messageStatusSchema,
	parts: Schema.mutable(Schema.Array(messagePartSchema)),
	content: Schema.String,
	/** Why a `failed` reply failed, in the provider's words where it had any. */
	error: Schema.optional(Schema.String),
	/** Set on an automation run's result, posted in the bot's conversation when the run completed. */
	automationResultOf: Schema.optional(automationResultOfSchema),
	/** The message this one quotes and answers, in the same conversation. */
	replyTo: Schema.optional(messageReplyToSchema),
	/** People's reactions, in the order each emoji was first used. Absent when there are none. */
	reactions: Schema.optional(messageReactionsSchema),
	createdAt: isoTimestampSchema,
})
	.check(
		Schema.makeFilter(({ content, parts }) =>
			content === parts.map((part) => (part.type === "text" ? part.text : "")).join("")
				? undefined
				: { issue: "Content must equal the combined text parts", path: ["content"] },
		),
	)
	.annotate({ identifier: "Message" });

export type Message = typeof messageSchema.Type;

export const MAX_SUMMARY_CHARACTERS = 4_000;

/** The most a bot's summary of what it has been doing may say. */
export const MAX_BOT_SUMMARY_CHARACTERS = 1_000;

/** What a bot has been doing lately, written by the Summariser from its tasks' summaries. */
export const botSummarySchema = Schema.Struct({
	content: Schema.String,
	updatedAt: isoTimestampSchema,
});

export type BotSummary = typeof botSummarySchema.Type;

export const conversationSummarySchema = Schema.Struct({
	content: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_SUMMARY_CHARACTERS)),
	sourceMessageId: uuidSchema,
	updatedAt: isoTimestampSchema,
});

export type ConversationSummary = typeof conversationSummarySchema.Type;

/**
 * How far a person has read a conversation: every message created at or before
 * `readThrough`, as of `readAt`. Recorded only for a conversation.
 */
export const conversationReadSchema = Schema.Struct({
	person: personParticipantSchema,
	readThrough: isoTimestampSchema,
	/** When they last read further. */
	readAt: isoTimestampSchema,
});

export type ConversationRead = typeof conversationReadSchema.Type;

/** A conversation as it is read: where it is, a page of its messages, and who is in it. */
export const conversationDetailsSchema = Schema.Struct({
	conversation: placedConversationSchema,
	capabilities: Schema.optional(
		Schema.Struct({
			approveToolCalls: Schema.Boolean,
			/**
			 * The bots in the conversation whose requests to change their computers this
			 * person may decide: each bot's creator or an admin decides its own.
			 */
			approveComputerRequestsOf: Schema.optional(Schema.Array(uuidSchema)),
		}),
	),
	automationRun: Schema.NullOr(runSchema),
	/** On an automation's feed: the automation, how it stands, and the bot that runs it. */
	automation: Schema.optional(
		Schema.Struct({
			id: uuidSchema,
			botId: uuidSchema,
			state: automationStateSchema,
			/** Its latest run failed, and nothing has run it since. */
			failed: Schema.Boolean,
			/** It paused itself after failing twice in a row. */
			pausedAfterFailures: Schema.Boolean,
		}),
	),
	participants: Schema.mutable(Schema.Array(participantSchema)),
	/**
	 * The channel's bots, whether or not they have spoken. Who a mention can name,
	 * which is wider than who has joined.
	 */
	channelBots: Schema.mutable(Schema.Array(participantSchema)),
	/** The channel's people, whether or not they have written here: the people a mention can name. */
	members: Schema.mutable(Schema.Array(personParticipantSchema)),
	messages: Schema.mutable(Schema.Array(messageSchema)),
	olderMessagesCursor: Schema.NullOr(Schema.String),
	/**
	 * When a bot's turn was asked for while the bot was still answering,
	 * so it waits to start. Everything posted since, from the message that
	 * asked for it on, waits for that turn. Null when no turn waits.
	 */
	queuedSince: Schema.NullOr(isoTimestampSchema),
	/** How far each person who has opened the conversation has read it, the caller included. */
	reads: Schema.mutable(Schema.Array(conversationReadSchema)),
});

export type ConversationDetails = typeof conversationDetailsSchema.Type;

/** How much of a bot's context window the conversation fills, and where compaction starts. */
export const conversationContextSchema = Schema.Struct({
	/** How many tokens the latest reply's prompt took, as its provider counted them. */
	usedTokens: Schema.Int,
	/** When that reply was measured. A compaction since then makes the count out of date. */
	measuredAt: isoTimestampSchema,
	windowTokens: Schema.Int,
	/** Past this many tokens, the conversation is compacted after the reply. */
	compactionLineTokens: Schema.Int,
	/** When the conversation was last compacted, or null if it never has been. */
	compactedAt: Schema.NullOr(isoTimestampSchema),
});

export type ConversationContext = typeof conversationContextSchema.Type;

/** What a conversation's details show about it. */
export const conversationActivitySchema = Schema.Struct({
	summary: Schema.NullOr(conversationSummarySchema),
	/** Null until a reply in the conversation has been measured. */
	context: Schema.NullOr(conversationContextSchema),
	/**
	 * Who has written in the conversation in the last week, or in its last 100
	 * messages when that reaches further back, most recently active first.
	 */
	recentParticipants: Schema.mutable(Schema.Array(participantSchema)),
});

export type ConversationActivity = typeof conversationActivitySchema.Type;

/** How long a message may be. */
export const MESSAGE_MAX_LENGTH = 20_000;

export const newMessageSchema = Schema.Struct({
	id: uuidSchema,
	/** May be empty when the message carries files. */
	message: Schema.Trim.check(Schema.isMaxLength(MESSAGE_MAX_LENGTH)),
	/** Files the sender uploaded to the conversation and has not sent yet. They show in the order listed. */
	attachments: Schema.optional(
		Schema.Array(uuidSchema).check(Schema.isMaxLength(MAX_ATTACHMENTS_PER_MESSAGE)),
	),
	/** The id of the message in the same conversation that this one quotes and answers. */
	replyTo: Schema.optional(uuidSchema),
}).check(
	Schema.makeFilter(({ message, attachments }) =>
		message !== "" || (attachments?.length ?? 0) > 0
			? undefined
			: { issue: "A message needs text or a file", path: ["message"] },
	),
);

export type NewMessage = typeof newMessageSchema.Type;
