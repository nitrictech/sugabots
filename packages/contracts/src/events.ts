import { Schema } from "effect";
import {
	collaborationPartSchema,
	conversationReadSchema,
	filePartSchema,
	messageReactionsSchema,
	messageSchema,
	messageStatusSchema,
	personParticipantSchema,
	toolCallPartSchema,
} from "./conversations.ts";
import { notificationContentSchema, presenceSchema } from "./notifications.ts";
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

const conversationId = uuidSchema;
const messageId = Schema.String.check(Schema.isMinLength(1));
/** Events that carry nothing agreed yet. Open, so a payload can be added without a version bump. */
const nothing = Schema.StructWithRest(Schema.Struct({}), [
	Schema.Record(Schema.String, Schema.Unknown),
]);

/**
 * What each known event carries, beyond the envelope. The one place a payload
 * is described: the TypeScript types below and the parsers clients use are
 * both derived from these.
 */
export const eventPayloadSchemas = {
	"message.created": Schema.Struct({ conversationId, message: messageSchema }),
	/** `offset` is how much of the message came before this text, so a client can tell a duplicate from a gap. */
	"message.delta": Schema.Struct({
		conversationId,
		messageId,
		offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		text: Schema.String,
	}),
	"message.completed": Schema.Struct({
		conversationId,
		messageId,
		content: Schema.String,
		status: messageStatusSchema,
	}),
	"message.failed": Schema.Struct({
		conversationId,
		messageId,
		turnId: uuidSchema,
		error: Schema.String,
	}),
	/** Somebody reacted to the message or took a reaction back; `reactions` is all it has now. */
	"message.reactions_changed": Schema.Struct({
		conversationId,
		messageId,
		reactions: messageReactionsSchema,
	}),
	/**
	 * A bot attached a file to its reply; `files` is all the reply carries
	 * now. A reply that starts again comes with `turn.started`, without them.
	 */
	"message.files_changed": Schema.Struct({
		conversationId,
		messageId,
		files: Schema.Array(filePartSchema),
	}),
	/** A bot's reply called a built-in tool; the part is `running`. */
	"tool_call.started": Schema.Struct({ conversationId, messageId, toolCall: toolCallPartSchema }),
	/** The tool returned or failed; the part carries its output or error. */
	"tool_call.completed": Schema.Struct({ conversationId, messageId, toolCall: toolCallPartSchema }),
	"tool_call.updated": Schema.Struct({ conversationId, messageId, toolCall: toolCallPartSchema }),
	"turn.started": Schema.Struct({
		conversationId,
		turnId: uuidSchema,
		botId: uuidSchema,
	}),
	/** Somebody asked a running turn to stop; `turn.completed` follows once it has. */
	"turn.cancel_requested": Schema.Struct({ conversationId, turnId: uuidSchema }),
	"turn.completed": Schema.Struct({
		conversationId,
		turnId: uuidSchema,
		status: Schema.Literals(["done", "cancelled"]),
	}),
	/**
	 * What people watching the conversation should know that no message in it
	 * records, such as why a bot they asked did not reply. `notice` is
	 * written for people; it is not kept in the conversation's history.
	 */
	"conversation.notice": Schema.Struct({ conversationId, notice: Schema.String }),
	/**
	 * `person` is writing in the conversation's composer. Sent again every few
	 * seconds while they keep typing, and never to say they stopped: a
	 * watcher stops showing them when these stop coming, or when their
	 * message arrives.
	 */
	"person.typing": Schema.Struct({ conversationId, person: personParticipantSchema }),
	/** Someone read further into the conversation. A read never moves anyone back. */
	"conversation.read": Schema.Struct({ conversationId, ...conversationReadSchema.fields }),
	"conversation.created": Schema.Struct({ conversationId }),
	/**
	 * Something about the conversation no more specific event describes. On
	 * the conversation's stream it means refetch the conversation; on
	 * its workspace's, that what lists show of it may be out of date.
	 */
	"conversation.changed": Schema.Struct({ conversationId }),
	/**
	 * A conversation opened beside `rootConversationId` changed: an automation
	 * run or collaboration in it.
	 */
	"conversation.item_changed": Schema.Struct({ rootConversationId: uuidSchema, conversationId }),
	/** Something to tell the person about, which their open tabs show. */
	notification: notificationContentSchema,
	/** One of the person's tabs says what it is looking at, so their other tabs hold back notifications about it. */
	presence: presenceSchema,
	/** A collaboration in `messageId` changed: opened, gave up waiting, answered, failed. */
	"collaboration.updated": Schema.Struct({
		conversationId,
		messageId,
		collaboration: collaborationPartSchema,
	}),
	"bot.updated": nothing,
	"project.updated": nothing,
	/**
	 * The one control event. Sent when the server cannot give the client a
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
 * State changes. Written to the `event` table, and their `seq` is the SSE `id`,
 * so a client that reconnects with `Last-Event-ID` gets every one it missed.
 */
export const durableEventTypeSchema = Schema.Literals([
	"message.created",
	"message.completed",
	"message.failed",
	"message.reactions_changed",
	"message.files_changed",
	"tool_call.started",
	"tool_call.completed",
	"tool_call.updated",
	"turn.started",
	"turn.cancel_requested",
	"turn.completed",
	"conversation.notice",
	"conversation.read",
	"conversation.created",
	"conversation.changed",
	"conversation.item_changed",
	"collaboration.updated",
	"bot.updated",
	"project.updated",
] satisfies KnownEventType[]);

export type DurableEventType = typeof durableEventTypeSchema.Type;

/**
 * What only matters while it is happening: progress within a state change, or
 * somebody typing. Sent to live subscribers only and carry no `id`, which per
 * the SSE spec means they do not advance the client's last-event-id: a delta
 * lost to a disconnect is recovered from the message row a running turn saves
 * every second, not from a replay.
 */
export const ephemeralEventTypeSchema = Schema.Literals([
	"message.delta",
	"person.typing",
	"notification",
	"presence",
] satisfies KnownEventType[]);

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

/** Everything a conversation's stream can carry. */
export const conversationUpdateEventSchema = Schema.Union([
	withEnvelope("message.created", P["message.created"]),
	withEnvelope("message.delta", P["message.delta"]),
	withEnvelope("message.completed", P["message.completed"]),
	withEnvelope("message.failed", P["message.failed"]),
	withEnvelope("message.reactions_changed", P["message.reactions_changed"]),
	withEnvelope("message.files_changed", P["message.files_changed"]),
	withEnvelope("tool_call.started", P["tool_call.started"]),
	withEnvelope("tool_call.completed", P["tool_call.completed"]),
	withEnvelope("tool_call.updated", P["tool_call.updated"]),
	withEnvelope("turn.started", P["turn.started"]),
	withEnvelope("turn.cancel_requested", P["turn.cancel_requested"]),
	withEnvelope("turn.completed", P["turn.completed"]),
	withEnvelope("conversation.changed", P["conversation.changed"]),
	withEnvelope("conversation.notice", P["conversation.notice"]),
	withEnvelope("conversation.read", P["conversation.read"]),
	withEnvelope("person.typing", P["person.typing"]),
	withEnvelope("conversation.item_changed", P["conversation.item_changed"]),
	withEnvelope("collaboration.updated", P["collaboration.updated"]),
	withEnvelope("reset", P.reset.schema),
]);

/** Everything a workspace's stream can carry. */
export const workspaceUpdateEventSchema = Schema.Union([
	withEnvelope("conversation.changed", P["conversation.changed"]),
	withEnvelope("conversation.item_changed", P["conversation.item_changed"]),
	withEnvelope("reset", P.reset.schema),
]);

/** Everything a person's own stream can carry. */
export const personUpdateEventSchema = Schema.Union([
	withEnvelope("notification", P.notification),
	withEnvelope("presence", P.presence),
	withEnvelope("reset", P.reset.schema),
]);

/**
 * The name of an event stream, which a client subscribes to and the event
 * store keeps events under. There are three kinds: a
 * workspace, a conversation, and a person, which only that person hears. A
 * conversation's system bots work in conversations of their own but publish on
 * the one they act on, so a client watching a conversation holds one
 * connection.
 */
export type EventStream = `workspace:${string}` | `conversation:${string}` | `person:${string}`;

export const workspaceStream = (workspaceId: string): EventStream => `workspace:${workspaceId}`;

export const conversationStream = (conversationId: string): EventStream =>
	`conversation:${conversationId}`;

export const personStream = (userId: string): EventStream => `person:${userId}`;
