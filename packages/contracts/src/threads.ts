import { Effect, Schema } from "effect";
import { agentColorSchema, agentFaceSchema } from "./agents.ts";
import { routineExecutionSchema, routineTriggerAuthorSchema } from "./routines.ts";
import { isoTimestampSchema } from "./timestamps.ts";
import { uuidSchema } from "./uuid.ts";

export const MAX_THREAD_TITLE_CHARACTERS = 80;
export const DEFAULT_THREAD_HISTORY_LIMIT = 50;
export const MAX_THREAD_HISTORY_LIMIT = 100;

export const threadTypeSchema = Schema.Literals([
	"chat",
	"collaboration",
	"routine",
	"system_agent",
]);

export type ThreadType = typeof threadTypeSchema.Type;

export const threadHistoryQuerySchema = Schema.Struct({
	cursor: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
	limit: Schema.String.check(Schema.isPattern(/^\d+$/)).pipe(
		Schema.decodeTo(Schema.FiniteFromString),
		Schema.check(
			Schema.isInt(),
			Schema.isBetween({ minimum: 1, maximum: MAX_THREAD_HISTORY_LIMIT }),
		),
		Schema.withDecodingDefault(Effect.succeed(String(DEFAULT_THREAD_HISTORY_LIMIT))),
	),
});

export type ThreadHistoryQuery = typeof threadHistoryQuerySchema.Type;

export const threadSchema = Schema.Struct({
	id: uuidSchema,
	workspaceId: uuidSchema,
	podId: uuidSchema,
	hostAgentId: uuidSchema,
	chatId: Schema.NullOr(uuidSchema),
	type: threadTypeSchema,
	title: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_THREAD_TITLE_CHARACTERS)),
	/** `running` while a turn is queued or in progress for the thread. */
	status: Schema.Literals(["running", "done"]),
	/** Set on a thread one agent opened to collaborate with another; the parent holds the collaboration card. */
	parentThreadId: Schema.NullOr(uuidSchema),
	initiatorUserId: Schema.NullOr(uuidSchema),
	createdAt: isoTimestampSchema,
	updatedAt: isoTimestampSchema,
});

export type Thread = typeof threadSchema.Type;

export const personParticipantSchema = Schema.Struct({
	kind: Schema.Literal("person"),
	id: uuidSchema,
	name: Schema.String,
	/** Derived from the name; how the person is mentioned. */
	handle: Schema.String,
	image: Schema.NullOr(Schema.String),
});

export type PersonParticipant = typeof personParticipantSchema.Type;

export const agentParticipantSchema = Schema.Struct({
	kind: Schema.Literal("agent"),
	id: uuidSchema,
	name: Schema.String,
	handle: Schema.String,
	color: agentColorSchema,
	face: agentFaceSchema,
});

export type AgentParticipant = typeof agentParticipantSchema.Type;

export const threadParticipantSchema = Schema.Union([
	personParticipantSchema,
	agentParticipantSchema,
]);

export type ThreadParticipant = typeof threadParticipantSchema.Type;

export const messageAuthorSchema = Schema.Union([
	personParticipantSchema,
	agentParticipantSchema,
	routineTriggerAuthorSchema,
]);

export type MessageAuthor = typeof messageAuthorSchema.Type;

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

/** The handles mentioned in a message, in order, without duplicates. */
export function mentionedHandles(content: string): string[] {
	const found = new Set<string>();
	for (const match of content.matchAll(MENTION)) {
		if (match[1]) found.add(match[1].toLowerCase());
	}
	return [...found];
}

/**
 * How a collaboration stands. `waiting`: the asking agent's turn is blocked
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
 * One agent asking another for help, in the middle of a reply. Sits between
 * the text parts at the point the agent made the call; the collaborator answers
 * in `threadId`, a thread of its own under this one.
 */
export const collaborationPartSchema = Schema.Struct({
	type: Schema.Literal("collaboration"),
	id: uuidSchema,
	/** The collaborator. */
	agentId: uuidSchema,
	agentName: Schema.String,
	/** The thread the collaborator answers in. */
	threadId: uuidSchema,
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
 * One call an agent made to a built-in tool, in the middle of a reply. Sits
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
	/** Present only when this mutating connection call passed through approval policy. */
	approval: Schema.optional(
		Schema.NullOr(
			Schema.Struct({
				status: toolApprovalStatusSchema,
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

export const messagePartSchema = Schema.Union([
	textPartSchema,
	collaborationPartSchema,
	toolCallPartSchema,
]);

export type MessagePart = typeof messagePartSchema.Type;

/**
 * Whether the part at `index` is narration: text that comes straight before a
 * tool call, such as "Let me check:", which a thread leaves out. Takes a
 * message's parts as the API sends them or as they are stored.
 */
export function isNarration(parts: readonly { type: string }[], index: number): boolean {
	return parts[index]?.type === "text" && parts[index + 1]?.type === "tool_call";
}

/** The longest `messagePreview` gives. */
export const MESSAGE_PREVIEW_CHARACTERS = 140;

/**
 * A message shortened for one line, as a chat list row shows it: its first
 * line with words in it, runs of spaces closed up, cut at a word to fit
 * `MESSAGE_PREVIEW_CHARACTERS`.
 */
export function messagePreview(content: string): string {
	const firstLine =
		content
			.split("\n")
			.map((line) => line.replace(/\s+/g, " ").trim())
			.find((line) => line !== "") ?? "";
	if (firstLine.length <= MESSAGE_PREVIEW_CHARACTERS) return firstLine;
	const cut = firstLine.slice(0, MESSAGE_PREVIEW_CHARACTERS - 1);
	const atWord = cut.lastIndexOf(" ");
	return `${(atWord > 0 ? cut.slice(0, atWord) : cut).trimEnd()}…`;
}

/** A message's text as a thread shows it: every text part but its narration. */
export function textWithoutNarration<Part extends { type: string; text?: string }>(
	parts: readonly Part[],
): string {
	return parts
		.map((part, index) => (part.type === "text" && !isNarration(parts, index) ? part.text : ""))
		.join("");
}

/** A part that sits in the reply's text at an offset: everything but text. */
export type PlacedPart = Extract<MessagePart, { atOffset: number }>;

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

export const messageSchema = Schema.Struct({
	id: uuidSchema,
	threadId: uuidSchema,
	author: messageAuthorSchema,
	kind: Schema.Literal("text"),
	status: messageStatusSchema,
	parts: Schema.mutable(Schema.Array(messagePartSchema)),
	content: Schema.String,
	/** Why a `failed` reply failed, in the provider's words where it had any. */
	error: Schema.optional(Schema.String),
	createdAt: isoTimestampSchema,
}).check(
	Schema.makeFilter(({ content, parts }) =>
		content === parts.map((part) => (part.type === "text" ? part.text : "")).join("")
			? undefined
			: { issue: "Content must equal the combined text parts", path: ["content"] },
	),
);

export type Message = typeof messageSchema.Type;

export const MAX_THREAD_SUMMARY_CHARACTERS = 4_000;

export const threadSummarySchema = Schema.Struct({
	content: Schema.Trim.check(
		Schema.isMinLength(1),
		Schema.isMaxLength(MAX_THREAD_SUMMARY_CHARACTERS),
	),
	sourceMessageId: uuidSchema,
	updatedAt: isoTimestampSchema,
});

export type ThreadSummary = typeof threadSummarySchema.Type;

/**
 * How far a person has read a thread: every message created at or before
 * `readThrough`, as of `readAt`. Recorded only for a Chat's main thread.
 */
export const threadReadSchema = Schema.Struct({
	person: personParticipantSchema,
	readThrough: isoTimestampSchema,
	/** When they last read further. */
	readAt: isoTimestampSchema,
});

export type ThreadRead = typeof threadReadSchema.Type;

/** A conversation as it is read: the thread, a page of its messages, and who is in it. */
export const threadDetailsSchema = Schema.Struct({
	thread: threadSchema,
	capabilities: Schema.optional(
		Schema.Struct({
			approveToolCalls: Schema.Boolean,
		}),
	),
	routineExecution: Schema.NullOr(routineExecutionSchema),
	participants: Schema.mutable(Schema.Array(threadParticipantSchema)),
	/**
	 * The pod's agents, whether or not they have spoken. Who a mention can name,
	 * which is wider than who has joined.
	 */
	crew: Schema.mutable(Schema.Array(threadParticipantSchema)),
	messages: Schema.mutable(Schema.Array(messageSchema)),
	olderMessagesCursor: Schema.NullOr(Schema.String),
	/**
	 * When an agent's turn was asked for while the agent was still answering,
	 * so it waits to start. Everything posted since, from the message that
	 * asked for it on, waits for that turn. Null when no turn waits.
	 */
	queuedSince: Schema.NullOr(isoTimestampSchema),
	/** How far each person who has opened the thread has read it, the caller included. */
	reads: Schema.mutable(Schema.Array(threadReadSchema)),
});

export type ThreadDetails = typeof threadDetailsSchema.Type;

/** How much of a bot's context window the thread fills, and where compaction starts. */
export const threadContextSchema = Schema.Struct({
	/** How many tokens the latest reply's prompt took, as its provider counted them. */
	usedTokens: Schema.Int,
	/** When that reply was measured. A compaction since then makes the count out of date. */
	measuredAt: isoTimestampSchema,
	windowTokens: Schema.Int,
	/** Past this many tokens, the thread is compacted after the reply. */
	compactionLineTokens: Schema.Int,
	/** When the thread was last compacted, or null if it never has been. */
	compactedAt: Schema.NullOr(isoTimestampSchema),
});

export type ThreadContext = typeof threadContextSchema.Type;

/** What a thread's sidebar shows about it. */
export const threadActivitySchema = Schema.Struct({
	summary: Schema.NullOr(threadSummarySchema),
	/** Null until a reply in the thread has been measured. */
	context: Schema.NullOr(threadContextSchema),
	/**
	 * Who has written in the thread in the last week, or in its last 100
	 * messages when that reaches further back, most recently active first.
	 */
	recentParticipants: Schema.mutable(Schema.Array(threadParticipantSchema)),
});

export type ThreadActivity = typeof threadActivitySchema.Type;

export const newMessageSchema = Schema.Struct({
	id: uuidSchema,
	message: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)),
});

export type NewMessage = typeof newMessageSchema.Type;
