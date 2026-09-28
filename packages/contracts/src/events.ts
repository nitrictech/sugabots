import { Schema } from "effect";
import { customerThreadTypeSchema } from "./chats.ts";
import {
	collaborationPartSchema,
	messageSchema,
	messageStatusSchema,
	toolCallPartSchema,
} from "./threads.ts";
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

const threadId = uuidSchema;
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
	"message.created": Schema.Struct({ threadId, message: messageSchema }),
	/** `offset` is how much of the message came before this text, so a client can tell a duplicate from a gap. */
	"message.delta": Schema.Struct({
		threadId,
		messageId,
		offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		text: Schema.String,
	}),
	"message.completed": Schema.Struct({
		threadId,
		messageId,
		content: Schema.String,
		status: messageStatusSchema,
	}),
	"message.failed": Schema.Struct({
		threadId,
		messageId,
		turnId: uuidSchema,
		willRetry: Schema.Boolean,
		error: Schema.String,
	}),
	/** An agent's reply called a built-in tool; the part is `running`. */
	"tool_call.started": Schema.Struct({ threadId, messageId, toolCall: toolCallPartSchema }),
	/** The tool returned or failed; the part carries its output or error. */
	"tool_call.completed": Schema.Struct({ threadId, messageId, toolCall: toolCallPartSchema }),
	"tool_call.updated": Schema.Struct({ threadId, messageId, toolCall: toolCallPartSchema }),
	"turn.started": Schema.Struct({
		threadId,
		turnId: uuidSchema,
		agentId: uuidSchema,
	}),
	/** Somebody asked a running turn to stop; `turn.completed` follows once it has. */
	"turn.cancel_requested": Schema.Struct({ threadId, turnId: uuidSchema }),
	"turn.completed": Schema.Struct({
		threadId,
		turnId: uuidSchema,
		status: Schema.Literals(["done", "cancelled"]),
		usage: Schema.optional(Schema.Unknown),
		reportedCost: Schema.optional(Schema.Finite),
	}),
	/**
	 * What people watching the thread should know that no message in it
	 * records, such as why an agent they asked did not reply. `notice` is
	 * written for people; it is not kept in the thread's history.
	 */
	"thread.notice": Schema.Struct({ threadId, notice: Schema.String }),
	"thread.created": Schema.Struct({ threadId }),
	/**
	 * Something about the thread no more specific event describes. On the
	 * thread's channel it means refetch the thread; on its workspace's channel,
	 * that what lists show of the thread may be out of date.
	 */
	"thread.changed": Schema.Struct({ threadId }),
	"chat.thread_changed": Schema.Struct({
		chatId: uuidSchema,
		threadId,
		threadType: customerThreadTypeSchema,
	}),
	/** A collaboration in `messageId` changed: opened, gave up waiting, answered, failed. */
	"collaboration.updated": Schema.Struct({
		threadId,
		messageId,
		collaboration: collaborationPartSchema,
	}),
	"agent.updated": nothing,
	"pod.updated": nothing,
	/**
	 * The one control event. Sent when the server cannot give the client a
	 * continuous history: the resume point was pruned, the replay is too long
	 * to be worth sending, or the subscriber fell too far behind. It means
	 * "refetch this view over REST, then keep listening".
	 */
	reset: nothing,
};

type EventPayloadSchemas = typeof eventPayloadSchemas;

export type KnownEventType = keyof EventPayloadSchemas;

export const RESET_EVENT_TYPE = "reset" satisfies KnownEventType;

/**
 * State changes. Written to the `event` table, and their `seq` is the SSE `id`,
 * so a client that reconnects with `Last-Event-ID` gets every one it missed.
 */
export const durableEventTypeSchema = Schema.Literals([
	"message.created",
	"message.completed",
	"message.failed",
	"tool_call.started",
	"tool_call.completed",
	"tool_call.updated",
	"turn.started",
	"turn.cancel_requested",
	"turn.completed",
	"thread.notice",
	"thread.created",
	"thread.changed",
	"chat.thread_changed",
	"collaboration.updated",
	"agent.updated",
	"pod.updated",
] satisfies KnownEventType[]);

export type DurableEventType = typeof durableEventTypeSchema.Type;

/**
 * Progress within a state change. Sent to live subscribers only and carry no
 * `id`, which per the SSE spec means they do not advance the client's
 * last-event-id: a delta lost to a disconnect is recovered from the message row
 * a running turn saves every second, not from a replay.
 */
export const ephemeralEventTypeSchema = Schema.Literals([
	"message.delta",
] satisfies KnownEventType[]);

export type EphemeralEventType = typeof ephemeralEventTypeSchema.Type;

export const eventTypeSchema = Schema.Union([
	durableEventTypeSchema,
	ephemeralEventTypeSchema,
	Schema.Literal(RESET_EVENT_TYPE),
]);

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

export type EventPayload<T extends EventType> = T extends KnownEventType
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

export type BuiltStreamEvent<T extends EventType> = StreamEvent & EventPayload<T> & { type: T };

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

/** Everything a thread channel can carry. */
export const threadUpdateEventSchema = Schema.Union([
	withEnvelope("message.created", P["message.created"]),
	withEnvelope("message.delta", P["message.delta"]),
	withEnvelope("message.completed", P["message.completed"]),
	withEnvelope("message.failed", P["message.failed"]),
	withEnvelope("tool_call.started", P["tool_call.started"]),
	withEnvelope("tool_call.completed", P["tool_call.completed"]),
	withEnvelope("tool_call.updated", P["tool_call.updated"]),
	withEnvelope("turn.started", P["turn.started"]),
	withEnvelope("turn.cancel_requested", P["turn.cancel_requested"]),
	withEnvelope("turn.completed", P["turn.completed"]),
	withEnvelope("thread.changed", P["thread.changed"]),
	withEnvelope("thread.notice", P["thread.notice"]),
	withEnvelope("chat.thread_changed", P["chat.thread_changed"]),
	withEnvelope("collaboration.updated", P["collaboration.updated"]),
	withEnvelope("reset", P.reset.schema),
]);

export type ThreadUpdateEvent = typeof threadUpdateEventSchema.Type;

/** Everything a workspace channel can carry. */
export const workspaceUpdateEventSchema = Schema.Union([
	withEnvelope("thread.changed", P["thread.changed"]),
	withEnvelope("chat.thread_changed", P["chat.thread_changed"]),
	withEnvelope("reset", P.reset.schema),
]);

export type WorkspaceUpdateEvent = typeof workspaceUpdateEventSchema.Type;

/**
 * A stream carries exactly one channel, and there are two kinds: a workspace,
 * and a thread. A thread's system agents work in child threads but publish on the
 * thread they act on, so a client watching a thread holds one connection.
 */
export type Channel = `workspace:${string}` | `thread:${string}`;

export const workspaceChannel = (workspaceId: string): Channel => `workspace:${workspaceId}`;

export const threadChannel = (threadId: string): Channel => `thread:${threadId}`;
