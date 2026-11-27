import { Schema } from "effect";
import {
	chatReadSchema,
	filePartSchema,
	memberParticipantSchema,
	messageReactionsSchema,
	messageSchema,
	messageStatusSchema,
	stepThinkingSchema,
	toolCallPartSchema,
} from "./messages.ts";
import { notificationContentSchema, presenceSchema } from "./notifications.ts";
import { isoTimestampSchema } from "./timestamps.ts";
import { uuidSchema } from "./uuid.ts";

/**
 * The live-update wire format, shared by the event bus, the SSE routes and
 * every client.
 *
 * Two things are settled here and nowhere else: what each event carries, and
 * which events are durable. Durability is a decision per type, not a property
 * of a payload: a state change is replayable after a reconnect, a token delta
 * is not worth a row.
 */

/** Bumped only for a change no existing client could read. */
export const EVENT_VERSION = 1;

const chatId = uuidSchema;
const messageId = Schema.String.check(Schema.isMinLength(1));
/**
 * What a change of who reaches what was about: a membership (a role, someone
 * joining, leaving or being removed, ownership handed over), a project's
 * members or bots, a bot (one made public, one deleted, or a private bot's new
 * members), or the whole workspace (deleted, or a bot made private or a
 * private bot's member taken out, which names no bot to those who don't reach
 * it).
 */
const reachChangeSchema = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("membership"), memberId: uuidSchema }),
	Schema.Struct({ kind: Schema.Literal("project"), projectId: uuidSchema }),
	Schema.Struct({ kind: Schema.Literal("bot"), botId: uuidSchema }),
	Schema.Struct({ kind: Schema.Literal("workspace") }),
]);

export type ReachChange = typeof reachChangeSchema.Type;

/** Events that carry nothing agreed yet. Open, so a payload can be added without a version bump. */
const nothing = Schema.StructWithRest(Schema.Struct({}), [
	Schema.Record(Schema.String, Schema.Unknown),
]);

const execution = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * What each known event carries, beyond the envelope. The one place a payload
 * is described: the TypeScript types below and the parsers clients use are
 * both derived from these.
 */
const eventPayloadSchemas = {
	"message.created": Schema.Struct({ chatId, message: messageSchema }),
	"message.execution_started": Schema.Struct({
		chatId,
		messageId,
		execution,
		content: Schema.String,
		thinking: Schema.optional(Schema.Array(stepThinkingSchema)),
	}),
	/** `offset` is how much of the message came before this text, so a client can tell a duplicate from a gap. */
	"message.delta": Schema.Struct({
		chatId,
		messageId,
		offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		text: Schema.String,
		/**
		 * Which execution of its turn wrote the text: a turn resumed elsewhere
		 * writes its step again, so an older execution's deltas still arriving
		 * are stale, and a client drops them.
		 */
		execution,
	}),
	"message.thinking_delta": Schema.Struct({
		chatId,
		messageId,
		execution,
		step: stepThinkingSchema.fields.step,
		offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		text: Schema.String,
	}),
	"message.completed": Schema.Struct({
		chatId,
		messageId,
		/**
		 * Which execution of its turn ended the reply: a client ignores an
		 * older one's end arriving after a newer one began writing it again.
		 * Absent from events stored before it was sent.
		 */
		execution: Schema.optional(execution),
		content: Schema.String,
		status: messageStatusSchema,
		finishedAt: isoTimestampSchema,
	}),
	/** `execution` is as on `message.completed`. */
	"message.failed": Schema.Struct({
		chatId,
		messageId,
		execution: Schema.optional(execution),
		error: Schema.String,
	}),
	/** Somebody reacted to the message or took a reaction back; `reactions` is all it has now. */
	"message.reactions_changed": Schema.Struct({
		chatId,
		messageId,
		reactions: messageReactionsSchema,
	}),
	/**
	 * A bot attached a file to its reply; `files` is all the reply carries
	 * now. A reply that starts again comes with `turn.started`, without them.
	 */
	"message.files_changed": Schema.Struct({
		chatId,
		messageId,
		files: Schema.Array(filePartSchema),
	}),
	/** A bot's reply called a tool; the part is `running`. */
	"tool_call.started": Schema.Struct({ chatId, messageId, toolCall: toolCallPartSchema }),
	/** The tool returned or failed; the part carries its output or error. */
	"tool_call.completed": Schema.Struct({ chatId, messageId, toolCall: toolCallPartSchema }),
	"tool_call.updated": Schema.Struct({ chatId, messageId, toolCall: toolCallPartSchema }),
	"turn.started": Schema.Struct({ chatId }),
	/** A running turn was asked to stop, as its automation run ended; `turn.completed` follows once it has. The turn itself listens for it, so it is on the stream. */
	"turn.interrupt_requested": Schema.Struct({ chatId, turnId: uuidSchema }),
	"turn.completed": Schema.Struct({ chatId }),
	/**
	 * What members watching the chat should know that no message in it
	 * records, such as why a bot they asked did not reply. `notice` is
	 * written for members; it is not kept in the chat's history.
	 */
	"chat.notice": Schema.Struct({ chatId, notice: Schema.String }),
	/**
	 * `member` is writing in the chat's composer. Sent again every few
	 * seconds while they keep typing, and never to say they stopped: a
	 * watcher stops showing them when these stop coming, or when their
	 * message arrives.
	 */
	"member.typing": Schema.Struct({ chatId, member: memberParticipantSchema }),
	/** Someone read further into the chat. A read never moves anyone back. */
	"chat.read": Schema.Struct({ chatId, ...chatReadSchema.fields }),
	/**
	 * Something about the chat no more specific event describes. On
	 * the chat's stream it means refetch the chat; on
	 * its workspace's, that what lists show of it may be out of date.
	 */
	"chat.changed": Schema.Struct({ chatId }),
	/** A chat nested under `rootChatId` changed: an automation run in it. */
	"chat.nested_chat_changed": Schema.Struct({ rootChatId: uuidSchema, chatId }),
	/**
	 * Who reaches what in the workspace changed: `about` names what changed,
	 * so a client refetches what it shows of it. Every stream in the workspace
	 * proves again on hearing one, whoever it was sent to.
	 */
	"reach.changed": Schema.Struct({ about: reachChangeSchema }),
	/**
	 * The member `memberId` changed how others see them, such as their name,
	 * which makes their handle; sent on the stream of each workspace they are
	 * in, to everyone in it, so a client refetches what shows them.
	 */
	"member.changed": Schema.Struct({ memberId: uuidSchema }),
	/**
	 * The session `sessionId` ended: its member signed out, or it was revoked.
	 * Every stream and desktop viewer opened with it ends; no client is sent it.
	 */
	"session.ended": Schema.Struct({ sessionId: Schema.String }),
	/** Something to tell the member about, which their open tabs show. */
	notification: notificationContentSchema,
	"approvals.changed": Schema.Struct({ toolCallId: uuidSchema }),
	/** One of the member's tabs says what it is looking at, so their other tabs hold back notifications about it. */
	presence: presenceSchema,
	/**
	 * Marks where live events begin when the client has no resume point or
	 * replay ends with events the client cannot hear. Its cursor lets the
	 * client resume from there. The client fetches its view over REST and
	 * holds the events after `ready` until that view arrives.
	 */
	ready: nothing,
	/**
	 * The control event that restarts a view. Sent when the server cannot give the client a
	 * continuous history: the resume point was pruned, the replay is too long
	 * to be worth sending, or the subscriber fell too far behind. It means
	 * "refetch this view over REST, then keep listening".
	 */
	reset: nothing,
};

type EventPayloadSchemas = typeof eventPayloadSchemas;

type KnownEventType = keyof EventPayloadSchemas;

const RESET_EVENT_TYPE = "reset" satisfies KnownEventType;

/**
 * State changes, and notifications. Written to the `event` table, and their
 * `seq` is the SSE `id`, so a client that reconnects with `Last-Event-ID` gets
 * every one it missed. A notification is stored in the transaction that
 * records it sent, so it is published once however many processes try.
 *
 * Every other type (a reply's delta, somebody typing, presence) only matters
 * while it is happening: it is sent to live subscribers only and carries no `id`, which per the SSE spec does not
 * advance the client's last-event-id. A delta lost to a disconnect is
 * recovered from the message row a running turn saves every second, not from
 * a replay.
 */
const durableEventTypeSchema = Schema.Literals([
	"message.created",
	"message.execution_started",
	"message.completed",
	"message.failed",
	"message.reactions_changed",
	"message.files_changed",
	"tool_call.started",
	"tool_call.completed",
	"tool_call.updated",
	"turn.started",
	"turn.interrupt_requested",
	"turn.completed",
	"chat.notice",
	"chat.read",
	"chat.changed",
	"chat.nested_chat_changed",
	"reach.changed",
	"member.changed",
	"session.ended",
	"notification",
	"approvals.changed",
] satisfies KnownEventType[]);

export type DurableEventType = typeof durableEventTypeSchema.Type;

/** The known types sent to live subscribers only, never stored. */
export type EphemeralEventType = Exclude<KnownEventType, DurableEventType>;

/**
 * `string & {}` keeps the known types in autocomplete while still accepting an
 * unknown one. A client is often older than the server, and a type it has never
 * heard of should be ignored, not treated as a broken stream.
 */
export type EventType = KnownEventType | (string & {});

const durableEventTypes = new Set<string>(durableEventTypeSchema.literals);

/** Whether an event of this type is persisted and replayable. */
export function isDurableEventType(type: string): type is DurableEventType {
	return durableEventTypes.has(type);
}

/**
 * Every event on every stream. `type` is a bare string rather than the enum
 * above for the forward-compatibility reason given on `EventType`, and the
 * object is open for the same reason.
 */
export const streamEventSchema = Schema.StructWithRest(
	Schema.Struct({
		v: Schema.Literal(EVENT_VERSION),
		type: Schema.String.check(Schema.isMinLength(1)),
	}),
	[Schema.Record(Schema.String, Schema.Unknown)],
);

export type StreamEvent = typeof streamEventSchema.Type & { type: EventType };

type EventPayload<T extends EventType> = T extends KnownEventType
	? EventPayloadSchemas[T]["Type"]
	: Record<string, unknown>;

/** Events whose payload has no required field may be built with none. */
type EventsWithOptionalPayload = {
	[T in KnownEventType]: Record<string, never> extends EventPayload<T> ? T : never;
}[KnownEventType];

type EventPayloadArgument<T extends EventType> = T extends EventsWithOptionalPayload
	? [data?: NoInfer<EventPayload<T>>]
	: T extends KnownEventType
		? [data: NoInfer<EventPayload<T>>]
		: [data?: Record<string, unknown>];

type BuiltStreamEvent<T extends EventType> = StreamEvent & EventPayload<T> & { type: T };

/** Builds an envelope, so no caller has to remember the version field. */
export function streamEvent<const T extends EventType>(
	type: T,
	...args: EventPayloadArgument<T>
): BuiltStreamEvent<T> {
	const data = args[0] ?? {};
	return { ...data, v: EVENT_VERSION, type } as unknown as BuiltStreamEvent<T>;
}

export const resetEvent = (): StreamEvent => streamEvent(RESET_EVENT_TYPE);

/** An event of one known type with its payload, as a parser. Open to fields it has not seen. */
function withEnvelope<T extends KnownEventType, Fields extends Schema.Struct.Fields>(
	type: T,
	payload: { readonly fields: Fields },
) {
	return Schema.StructWithRest(
		Schema.Struct({
			v: Schema.Literal(EVENT_VERSION),
			type: Schema.Literal(type),
			...payload.fields,
		}),
		[Schema.Record(Schema.String, Schema.Unknown)],
	);
}

const P = eventPayloadSchemas;

/** Everything a chat's stream can carry. */
export const chatUpdateEventSchema = Schema.Union([
	withEnvelope("message.created", P["message.created"]),
	withEnvelope("message.execution_started", P["message.execution_started"]),
	withEnvelope("message.delta", P["message.delta"]),
	withEnvelope("message.thinking_delta", P["message.thinking_delta"]),
	withEnvelope("message.completed", P["message.completed"]),
	withEnvelope("message.failed", P["message.failed"]),
	withEnvelope("message.reactions_changed", P["message.reactions_changed"]),
	withEnvelope("message.files_changed", P["message.files_changed"]),
	withEnvelope("tool_call.started", P["tool_call.started"]),
	withEnvelope("tool_call.completed", P["tool_call.completed"]),
	withEnvelope("tool_call.updated", P["tool_call.updated"]),
	withEnvelope("turn.started", P["turn.started"]),
	withEnvelope("turn.interrupt_requested", P["turn.interrupt_requested"]),
	withEnvelope("turn.completed", P["turn.completed"]),
	withEnvelope("chat.changed", P["chat.changed"]),
	withEnvelope("chat.notice", P["chat.notice"]),
	withEnvelope("chat.read", P["chat.read"]),
	withEnvelope("member.typing", P["member.typing"]),
	withEnvelope("chat.nested_chat_changed", P["chat.nested_chat_changed"]),
	withEnvelope("ready", P.ready.schema),
	withEnvelope("reset", P.reset.schema),
]);

/** Everything a workspace's stream can carry. */
export const workspaceUpdateEventSchema = Schema.Union([
	withEnvelope("chat.changed", P["chat.changed"]),
	withEnvelope("chat.nested_chat_changed", P["chat.nested_chat_changed"]),
	withEnvelope("reach.changed", P["reach.changed"]),
	withEnvelope("member.changed", P["member.changed"]),
	withEnvelope("ready", P.ready.schema),
	withEnvelope("reset", P.reset.schema),
]);

/** Everything a member's own stream can carry. */
export const memberUpdateEventSchema = Schema.Union([
	withEnvelope("notification", P.notification),
	withEnvelope("approvals.changed", P["approvals.changed"]),
	withEnvelope("presence", P.presence),
	withEnvelope("ready", P.ready.schema),
	withEnvelope("reset", P.reset.schema),
]);

/**
 * The name of an event stream, which a client subscribes to and the event
 * store keeps events under. There are three kinds: a
 * workspace, a chat, and a member, which only that member hears. A
 * chat's system bots work in chats of their own but publish on
 * the one they act on, so a client watching a chat holds one
 * connection to the event stream.
 */
export type EventStream = `workspace:${string}` | `chat:${string}` | `member:${string}`;

export const workspaceStream = (workspaceId: string): EventStream => `workspace:${workspaceId}`;

export const chatStream = (chatId: string): EventStream => `chat:${chatId}`;

export const memberStream = (memberId: string): EventStream => `member:${memberId}`;
