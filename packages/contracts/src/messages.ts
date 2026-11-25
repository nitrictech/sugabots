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
import { type Bot, botColorSchema, botEyesSchema, botShapeSchema } from "./bots.ts";
import { emailSchema } from "./email.ts";
import { FILE_WRITING_TOOLS, fileWrittenSchema } from "./files.ts";
import { anyJsonSchema } from "./json.ts";
import { isoTimestampSchema } from "./timestamps.ts";
import { uuidSchema } from "./uuid.ts";

export const MAX_CHAT_TITLE_CHARACTERS = 80;
export const DEFAULT_CHAT_HISTORY_LIMIT = 50;
export const MAX_CHAT_HISTORY_LIMIT = 100;

/**
 * What kind of chat it is: a project's chat (a bot's chats being
 * its default project's), an automation's run or feed, or a system bot's chat.
 */
const chatKindSchema = Schema.Literals(["project_chat", "run", "automation_feed", "system_chat"]);

export type ChatKind = typeof chatKindSchema.Type;

/**
 * Whether ordinary messages in a chat of `kind` notify members: only a
 * chat's, not an automation feed's or those of the chats bots work
 * in. One exception: an automation's result posted only in its feed notifies
 * the members it mentions, which the notifications check separately.
 */
export const notifiesMembers = (kind: ChatKind): kind is "project_chat" => kind === "project_chat";

export const chatHistoryQuerySchema = Schema.Struct({
	cursor: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
	limit: Schema.String.check(Schema.isPattern(/^\d+$/)).pipe(
		Schema.decodeTo(Schema.FiniteFromString),
		Schema.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: MAX_CHAT_HISTORY_LIMIT })),
		Schema.withDecodingDefault(Effect.succeed(String(DEFAULT_CHAT_HISTORY_LIMIT))),
	),
});

export type ChatHistoryQuery = typeof chatHistoryQuerySchema.Type;

/**
 * A chat of any kind, with where it is placed: its project, its bot, and
 * the chat members open that it is in.
 */
export const placedChatSchema = Schema.Struct({
	id: uuidSchema,
	workspaceId: uuidSchema,
	/** The project it is in; only a project's own chats are in one. */
	projectId: Schema.NullOr(uuidSchema),
	/** The bot it is with; null in a project members made. */
	botId: Schema.NullOr(uuidSchema),
	/**
	 * The chat members open that it is in: its own id on a bot's chat,
	 * a project's chat and an automation's feed; the automation's feed on a run.
	 * Null on a system bot's chat.
	 */
	rootChatId: Schema.NullOr(uuidSchema),
	kind: chatKindSchema,
	title: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_CHAT_TITLE_CHARACTERS)),
	/** True while a bot's turn is queued or working in it. */
	working: Schema.Boolean,
	/** When somebody marked the chat resolved; null while it is open, and on any other kind. */
	resolvedAt: Schema.NullOr(isoTimestampSchema),
	createdAt: isoTimestampSchema,
	updatedAt: isoTimestampSchema,
});

export type PlacedChat = typeof placedChatSchema.Type;

export const memberParticipantSchema = Schema.Struct({
	kind: Schema.Literal("member"),
	id: uuidSchema,
	name: Schema.String,
	email: emailSchema,
	/** Derived from the name; how the member is mentioned. */
	handle: Schema.String,
	image: Schema.NullOr(Schema.String),
});

export type MemberParticipant = typeof memberParticipantSchema.Type;

export const botParticipantSchema = Schema.Struct({
	kind: Schema.Literal("bot"),
	id: uuidSchema,
	name: Schema.String,
	handle: Schema.String,
	color: botColorSchema,
	eyes: botEyesSchema,
	shape: botShapeSchema,
});

export type BotParticipant = typeof botParticipantSchema.Type;

/** A bot as a chat's participants and mentions name it. */
export function botParticipantOf(bot: Bot): BotParticipant {
	return {
		kind: "bot",
		id: bot.id,
		name: bot.name,
		handle: bot.handle,
		color: bot.color,
		eyes: bot.eyes,
		shape: bot.shape,
	};
}

export const participantSchema = Schema.Union([memberParticipantSchema, botParticipantSchema]);

export type Participant = typeof participantSchema.Type;

const messageAuthorSchema = Schema.Union([
	memberParticipantSchema,
	botParticipantSchema,
	automationTriggerAuthorSchema,
]);

export type MessageAuthor = typeof messageAuthorSchema.Type;

/** Who wrote a message, by name: an automation's trigger goes by the automation's. */
export function messageAuthorName(author: MessageAuthor): string {
	return author.kind === "automation_trigger" ? author.automationName : author.name;
}

const textPartSchema = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });

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
 * Handles that address everyone in a chat instead of one participant,
 * as `@here` and `@channel` do in Slack. Nothing tells who is active, so
 * both reach everyone who can see the chat. They address members, never
 * a bot, so a message whose only mentions are these mentions only members, and
 * follows the floor's rule for that (see `decideFloor`): in a project's chat
 * the lead bot may still take a turn it can decline.
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
 * Whether a message's mentioned `handles` address only members: at least one
 * is a member's or `@here`/`@channel`, and none is a bot's. A handle that is
 * nobody's, as when a name is written out rather than picked, is only text
 * and counts for neither. A bot replying wherever it is not named keeps out
 * of such a message, as it is meant for the members.
 */
export function mentionsOnlyMembers(
	handles: readonly string[],
	known: { botHandles: ReadonlySet<string>; membersHandles: ReadonlySet<string> },
): boolean {
	const mentionsMembers = handles.some(
		(handle) => isGroupMentionHandle(handle) || known.membersHandles.has(handle),
	);
	return mentionsMembers && !handles.some((handle) => known.botHandles.has(handle));
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
 * How a tool call stands. `running` while the tool executes; `completed` with
 * its output, or `failed` with the error the model was shown, once it returns.
 */
const toolCallStatusSchema = Schema.Literals([
	"awaiting_approval",
	"running",
	"completed",
	"failed",
]);

export type ToolCallStatus = typeof toolCallStatusSchema.Type;

const toolApprovalStatusSchema = Schema.Literals(["pending", "allowed", "denied", "automatic"]);

export type ToolApprovalStatus = typeof toolApprovalStatusSchema.Type;

/**
 * Who may decide a tool call's approval: `chat`, the approvers of the turn
 * that made it (see `chatDetailsSchema`'s `approveToolCallsIn`);
 * `computer-managers`, for a bot's request to change the computer its turn
 * works on, such as what it may reach, those who manage that computer's
 * project, the chat's project.
 */
const toolApproversSchema = Schema.Literals(["chat", "computer-managers"]);

export type ToolApprovers = typeof toolApproversSchema.Type;

/**
 * jsonValueSchema validates JSON recursively but exposes shallow types, so the
 * recursive message-part types built on it stay within TypeScript's
 * instantiation depth.
 */
export const jsonValueSchema = anyJsonSchema.pipe(
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
 * One call a bot made to a tool, in the middle of a reply. Sits
 * between the text parts at the point the call was made.
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
	/** Null unless the call asked for approval: a write/delete connector tool call, or a request a member decides. */
	approval: Schema.NullOr(
		Schema.Struct({
			status: toolApprovalStatusSchema,
			approvers: toolApproversSchema,
			decidedByName: Schema.NullOr(Schema.String),
			decidedAt: Schema.NullOr(isoTimestampSchema),
		}),
	),
	error: Schema.NullOr(Schema.String),
	/** How many characters of the reply's text had been written when the call was made. */
	atOffset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	startedAt: isoTimestampSchema,
	finishedAt: Schema.NullOr(isoTimestampSchema),
});

export type ToolCallPart = typeof toolCallPartSchema.Type;

/** The tool a bot starts a chat with, for the member it is answering. */
export const START_CHAT_TOOL = "start_chat";

/** A chat a bot started with `start_chat`: what the tool returns, and what the chat links to. */
export const botStartedChatSchema = Schema.Struct({
	id: uuidSchema,
	title: Schema.String,
	/** The bot it is with, by name, when that is another bot; absent when it is the bot that started it. */
	with: Schema.optional(Schema.String),
	/** That bot's id, which the chat finds it by; present exactly when `with` is. */
	withBotId: Schema.optional(uuidSchema),
});

export type BotStartedChat = typeof botStartedChatSchema.Type;

/** A file attached to the message, served by the chat it was sent in. */
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
 * stay in the run's own chat.
 */
const writtenFilePartSchema = Schema.Struct({
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

const messagePartSchema = Schema.Union([
	textPartSchema,
	toolCallPartSchema,
	filePartSchema,
	writtenFilePartSchema,
]);

export type MessagePart = typeof messagePartSchema.Type;

/**
 * Whether the part at `index` is narration: text that comes straight before a
 * tool call, such as "Let me check:", which a chat leaves out. Takes a
 * message's parts as the API sends them or as they are stored.
 */
export function isNarration(parts: readonly { type: string }[], index: number): boolean {
	return parts[index]?.type === "text" && parts[index + 1]?.type === "tool_call";
}

/** The longest `messagePreview` gives. */
export const MESSAGE_PREVIEW_CHARACTERS = 140;

/**
 * A message shortened for one line, as a chat list row shows it: its first
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

/** A message's text as a chat shows it: every text part but its narration. */
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
type AttachedPart = Extract<MessagePart, { type: "file" | "written_file" }>;

export function isAttached(part: MessagePart): part is AttachedPart {
	return part.type === "file" || part.type === "written_file";
}

/** The tool calls in a message, as they were placed in its text. */
export function placedParts(message: { parts: readonly MessagePart[] }): PlacedPart[] {
	return message.parts.filter((part): part is PlacedPart => "atOffset" in part);
}

/**
 * The parts of a message whose text is `content` and whose tool calls
 * happened at the given offsets: text, a placed part, more text.
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

export const messageStatusSchema = Schema.Literals(["complete", "writing", "failed", "cancelled"]);

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

/** Who reacted with an emoji, and when. */
const reactorSchema = Schema.Struct({
	id: uuidSchema,
	name: Schema.String,
	at: isoTimestampSchema,
});

/**
 * One emoji on a message, with the members who reacted with it and the bots,
 * each earliest first. A bot reacts only with 👀, to a message it read and
 * chose not to answer.
 */
const messageReactionSchema = Schema.Struct({
	emoji: reactionEmojiSchema,
	members: Schema.mutable(Schema.Array(reactorSchema)),
	/** Absent when no bot reacted with it. */
	bots: Schema.optional(Schema.mutable(Schema.Array(reactorSchema))),
});

export type MessageReaction = typeof messageReactionSchema.Type;

export const messageReactionsSchema = Schema.mutable(Schema.Array(messageReactionSchema));

export const stepThinkingSchema = Schema.Struct({
	step: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	text: Schema.String,
});

export type StepThinking = typeof stepThinkingSchema.Type;

export const messageSchema = Schema.Struct({
	id: uuidSchema,
	retryKey: Schema.optional(uuidSchema),
	chatId: uuidSchema,
	author: messageAuthorSchema,
	status: messageStatusSchema,
	parts: Schema.mutable(Schema.Array(messagePartSchema)),
	thinking: Schema.optional(Schema.Array(stepThinkingSchema)),
	content: Schema.String,
	/**
	 * Which execution of its turn a bot's reply is as of. While it is written,
	 * the one that wrote its text and thinking so far, once one has begun a
	 * step: a turn resumed elsewhere writes its step again, so a client merges
	 * a delta only into text its own execution wrote. Once it has ended, the
	 * one that ended it: a turn that runs again reopens its reply under a
	 * newer one, whose writing replaces it.
	 */
	execution: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
	/** Why a `failed` reply failed, in the provider's words where it had any. */
	error: Schema.optional(Schema.String),
	/** Set on an automation run's result, posted in the automation's feed when the run completed. */
	automationResultOf: Schema.optional(automationResultOfSchema),
	/** The message this one quotes and answers, in the same chat. */
	replyTo: Schema.optional(messageReplyToSchema),
	/** Members' and bots' reactions, in the order each emoji was first used. Absent when there are none. */
	reactions: Schema.optional(messageReactionsSchema),
	createdAt: isoTimestampSchema,
	/** When the bot's turn that wrote this reply ended. Absent on members' messages and replies still being written. */
	finishedAt: Schema.optional(isoTimestampSchema),
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

/**
 * How far a member has read a chat: every message created at or before
 * `readThrough`, as of `readAt`. Recorded only for a chat.
 */
export const chatReadSchema = Schema.Struct({
	member: memberParticipantSchema,
	readThrough: isoTimestampSchema,
	/** When they last read further. */
	readAt: isoTimestampSchema,
});

export type ChatRead = typeof chatReadSchema.Type;

/** A chat as it is read: where it is, a page of its messages, and who is in it. */
export const chatDetailsSchema = Schema.Struct({
	chat: placedChatSchema,
	/** What this member may decide of the approvals the chat raises, and which turns they may interrupt. */
	permissions: Schema.optional(
		Schema.Struct({
			/**
			 * The replies of the chat's turns not yet ended, or still waiting on
			 * an approval, whose tool calls this member approves: a Personal
			 * Assistant's for its member, a run's for admins and its bot's
			 * managers, and any other turn's for its asker alone. A request to
			 * change the computer is `approveComputerRequests`'s instead.
			 */
			approveToolCallsIn: Schema.mutable(Schema.Array(uuidSchema)),
			/**
			 * Whether this member may decide the bots' requests to change the
			 * computer their turns work on: those who manage that computer's
			 * project, the chat's.
			 */
			approveComputerRequests: Schema.Boolean,
			/**
			 * The replies being written whose turns this member may interrupt, each
			 * with its turn: those they asked for, every one in a project they may
			 * manage, and in a run, those whose calls they approve.
			 */
			interruptTurns: Schema.mutable(
				Schema.Array(Schema.Struct({ replyId: uuidSchema, turnId: uuidSchema })),
			),
		}),
	),
	automationRun: Schema.NullOr(runSchema),
	/** On an automation's feed: the automation, how it stands, and the project it belongs to. */
	automation: Schema.optional(
		Schema.Struct({
			id: uuidSchema,
			projectId: uuidSchema,
			state: automationStateSchema,
			/** It is failing: it paused itself after failing, or it is enabled and its latest run failed. */
			failed: Schema.Boolean,
			/** It paused itself after failing twice in a row. */
			pausedAfterFailures: Schema.Boolean,
		}),
	),
	participants: Schema.mutable(Schema.Array(participantSchema)),
	/**
	 * The project's bots, whether or not they have spoken. Who a mention can name,
	 * which is wider than who has joined.
	 */
	projectBots: Schema.mutable(Schema.Array(botParticipantSchema)),
	/**
	 * The members who reach the project, whether or not they have written here:
	 * with the chat's participants, those a mention can name. In a project
	 * members made, its members; in a bot's default project, whoever reaches the bot.
	 */
	membersReachingProject: Schema.mutable(Schema.Array(memberParticipantSchema)),
	messages: Schema.mutable(Schema.Array(messageSchema)),
	olderMessagesCursor: Schema.NullOr(Schema.String),
	/**
	 * When a bot's turn was asked for while the bot was still answering,
	 * so it waits to start. Everything posted since, from the message that
	 * asked for it on, waits for that turn. Null when no turn waits.
	 */
	queuedSince: Schema.NullOr(isoTimestampSchema),
	/** How far each member who has opened the chat has read it, the caller included. */
	reads: Schema.mutable(Schema.Array(chatReadSchema)),
});

export type ChatDetails = typeof chatDetailsSchema.Type;

/** How much of a bot's context window the chat fills, and where compaction starts. */
export const chatContextSchema = Schema.Struct({
	/** How many tokens the latest reply's prompt took, as its provider counted them. */
	usedTokens: Schema.Int,
	/** When that reply was measured. A compaction since then makes the count out of date. */
	measuredAt: isoTimestampSchema,
	windowTokens: Schema.Int,
	/** Past this many tokens, the chat is compacted after the reply. */
	compactionLineTokens: Schema.Int,
	/** When the chat was last compacted, or null if it never has been. */
	compactedAt: Schema.NullOr(isoTimestampSchema),
});

export type ChatContext = typeof chatContextSchema.Type;

/** How long a message may be. */
export const MESSAGE_MAX_LENGTH = 20_000;

export const newMessageSchema = Schema.Struct({
	retryKey: uuidSchema,
	/** May be empty when the message carries files. */
	message: Schema.Trim.check(Schema.isMaxLength(MESSAGE_MAX_LENGTH)),
	/** Files the author uploaded to the chat and has not sent yet. They show in the order listed. */
	attachments: Schema.optional(
		Schema.Array(uuidSchema).check(Schema.isMaxLength(MAX_ATTACHMENTS_PER_MESSAGE)),
	),
	/** The id of the message in the same chat that this one quotes and answers. */
	replyTo: Schema.optional(uuidSchema),
}).check(
	Schema.makeFilter(({ message, attachments }) =>
		message !== "" || (attachments?.length ?? 0) > 0
			? undefined
			: { issue: "A message needs text or a file", path: ["message"] },
	),
);

export type NewMessage = typeof newMessageSchema.Type;
