import { Schema } from "effect";
import { threadTypeSchema } from "./threads.ts";
import { isoTimestampSchema } from "./timestamps.ts";
import { uuidSchema } from "./uuid.ts";

/**
 * Telling one person that something needs them or has happened.
 *
 * A kind is what a notification is about. Each has a subject, which is what a
 * client needs to describe it and open what it is about, and an entry in
 * `notificationKinds`. A person who has not chosen whether to hear about a kind
 * gets its `defaultOn`, so adding a kind needs nothing stored for anyone.
 */

/**
 * Where a notification is about, which is what opening it shows: the bot
 * `agentId`'s chat, and beside it the thread when that is not the chat's own,
 * such as a routine run's.
 */
const placeFields = {
	podId: uuidSchema,
	/** The chat to open. Null for a thread in no chat, such as a collaboration's. */
	chatId: Schema.NullOr(uuidSchema),
	threadId: uuidSchema,
	threadType: threadTypeSchema,
	agentId: uuidSchema,
	agentName: Schema.String,
};

/** A bot's reply stopped until somebody decides the tool calls it asked to make. */
export const approveSubjectSchema = Schema.Struct({
	kind: Schema.Literal("approve"),
	...placeFields,
	/** The tools the calls waiting for a decision would run, in the order the reply asked. */
	tools: Schema.Array(Schema.String),
});

/** The longest `preview` of a message a subject carries. */
export const NOTIFICATION_PREVIEW_CHARACTERS = 140;

/**
 * A bot replied to the person: in their Personal pod, to a message of theirs,
 * or mentioning them.
 */
export const dmSubjectSchema = Schema.Struct({
	kind: Schema.Literal("dm"),
	...placeFields,
	messageId: uuidSchema,
	/** The start of the reply. */
	preview: Schema.String,
});

/** Somebody mentioned the person in a message. `agentId` is the bot whose chat it was in. */
export const mentionSubjectSchema = Schema.Struct({
	kind: Schema.Literal("mention"),
	...placeFields,
	messageId: uuidSchema,
	authorName: Schema.String,
	/** The start of the message. */
	preview: Schema.String,
});

/** A run of a routine the person made ended. `threadId` is the run's own thread. */
export const routineSubjectSchema = Schema.Struct({
	kind: Schema.Literal("routine"),
	...placeFields,
	routineName: Schema.String,
	outcome: Schema.Literals(["completed", "failed", "cancelled"]),
});

/**
 * A bot asked another for help in a thread the person started, and that
 * ended. The place is the asking bot's; `threadId` is the thread it asked in.
 */
export const collabSubjectSchema = Schema.Struct({
	kind: Schema.Literal("collab"),
	...placeFields,
	collaboratorName: Schema.String,
	outcome: Schema.Literals(["answered", "failed"]),
});

export const notificationSubjectSchema = Schema.Union([
	approveSubjectSchema,
	dmSubjectSchema,
	mentionSubjectSchema,
	routineSubjectSchema,
	collabSubjectSchema,
]);

export type NotificationSubject = typeof notificationSubjectSchema.Type;

export type NotificationKind = NotificationSubject["kind"];

/**
 * Every kind, with what the settings call it and whether a person hears about
 * it before choosing, in the order the settings list them.
 */
export const notificationKinds: Record<NotificationKind, { label: string; defaultOn: boolean }> = {
	approve: { label: "A bot needs my approval", defaultOn: true },
	dm: { label: "A bot messages me directly", defaultOn: true },
	mention: { label: "Someone mentions me in a pod", defaultOn: true },
	routine: { label: "A routine finishes", defaultOn: false },
	collab: { label: "A collaboration finishes", defaultOn: false },
};

export const notificationKindSchema = Schema.Literals(
	Object.keys(notificationKinds) as [NotificationKind, ...NotificationKind[]],
);

export const notificationSchema = Schema.Struct({
	id: uuidSchema,
	workspaceId: uuidSchema,
	subject: notificationSubjectSchema,
	createdAt: isoTimestampSchema,
});

export type Notification = typeof notificationSchema.Type;

/** Whether the person hears about each kind. */
export const notificationKindPreferencesSchema = Schema.Record(
	notificationKindSchema,
	Schema.Boolean,
);

export type NotificationKindPreferences = typeof notificationKindPreferencesSchema.Type;

/** How a person is told, in every workspace they belong to. */
export const notificationDeliverySchema = Schema.Struct({
	/** Shown by the browser while a Sugabots tab is open. */
	desktop: Schema.Boolean,
	/** No desktop notices on Saturday or Sunday, in the browser's time zone. */
	quietOnWeekends: Schema.Boolean,
});

export type NotificationDelivery = typeof notificationDeliverySchema.Type;

/** How a person who has chosen nothing is told. */
export const defaultNotificationDelivery: NotificationDelivery = {
	desktop: true,
	quietOnWeekends: false,
};

/** What the person hears about, and how. */
export const notificationPreferencesSchema = Schema.Struct({
	kinds: notificationKindPreferencesSchema,
	delivery: notificationDeliverySchema,
});

export type NotificationPreferences = typeof notificationPreferencesSchema.Type;

export const updateNotificationPreferenceSchema = Schema.Struct({
	kind: notificationKindSchema,
	enabled: Schema.Boolean,
});

export type UpdateNotificationPreference = typeof updateNotificationPreferenceSchema.Type;

/** The delivery settings to change; the rest stay as they are. */
export const updateNotificationDeliverySchema = Schema.Struct({
	desktop: Schema.optional(Schema.Boolean),
	quietOnWeekends: Schema.optional(Schema.Boolean),
});

export type UpdateNotificationDelivery = typeof updateNotificationDeliverySchema.Type;
