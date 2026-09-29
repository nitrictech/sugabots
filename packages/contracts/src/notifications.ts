import { Schema } from "effect";
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

/** A bot's reply stopped until somebody decides the tool calls it asked to make. */
export const approveSubjectSchema = Schema.Struct({
	kind: Schema.Literal("approve"),
	podId: uuidSchema,
	/** The chat to open. Null for a thread in no chat, such as a collaboration's. */
	chatId: Schema.NullOr(uuidSchema),
	threadId: uuidSchema,
	agentId: uuidSchema,
	agentName: Schema.String,
	/** The tools the calls waiting for a decision would run, in the order the reply asked. */
	tools: Schema.Array(Schema.String),
});

export const notificationSubjectSchema = Schema.Union([approveSubjectSchema]);

export type NotificationSubject = typeof notificationSubjectSchema.Type;

export type NotificationKind = NotificationSubject["kind"];

/** Every kind, with what the settings call it and whether a person hears about it before choosing. */
export const notificationKinds: Record<NotificationKind, { label: string; defaultOn: boolean }> = {
	approve: { label: "A bot needs my approval", defaultOn: true },
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
