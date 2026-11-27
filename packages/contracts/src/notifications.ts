import { Schema } from "effect";
import { timeZoneSchema } from "./time-zones.ts";
import { isoTimestampSchema } from "./timestamps.ts";
import { uuidSchema } from "./uuid.ts";

/**
 * How much a member is notified about, as Slack offers it:
 * `all`: every message somebody else finishes in a chat they reach,
 * and approvals they may decide.
 * `mentions`: messages that mention them, a bot's answers to them, messages in
 * chats they take part in, and approvals they may decide.
 * `nothing`: no notifications.
 */
const notificationLevelSchema = Schema.Literals(["all", "mentions", "nothing"]);

export type NotificationLevel = typeof notificationLevelSchema.Type;

/** A time of day on a 24-hour clock, `HH:MM`. */
const timeOfDaySchema = Schema.String.check(
	Schema.isPattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/, { message: "Expected a time as HH:MM" }),
);

/**
 * The hours of each day a member is not notified, in their time zone. `from`
 * after `to` spans midnight.
 */
const quietHoursSchema = Schema.Struct({
	from: timeOfDaySchema,
	to: timeOfDaySchema,
	timeZone: timeZoneSchema,
});

export type QuietHours = typeof quietHoursSchema.Type;

/** Which of a member's automations' runs they hear the end of: failed ones, every one, or none. */
const automationRunNotificationsSchema = Schema.Literals(["failures", "all", "none"]);

export type AutomationRunNotifications = typeof automationRunNotificationsSchema.Type;

/**
 * What a member hears of besides messages, at any level but `nothing`: a
 * bot's reply to them that failed, and the runs of automations they made or
 * started.
 */
const otherNotificationsFields = {
	turnFailures: Schema.Boolean,
	automationRuns: automationRunNotificationsSchema,
};

/** Where a member chooses in place of the level above: a project, or a bot. */
export const notificationPlaceKindSchema = Schema.Literals(["project", "bot"]);

export type NotificationPlaceKind = typeof notificationPlaceKindSchema.Type;

/** The level chosen for a project or bot, or null to follow the one above it, which also ends a mute. */
export const notificationLevelChoiceSchema = Schema.Struct({
	level: Schema.NullOr(notificationLevelSchema),
});

/** Mutes a project or bot until `until`, whatever its level, or with null, or a time passed, ends its mute. */
export const notificationMuteSchema = Schema.Struct({ until: Schema.NullOr(isoTimestampSchema) });

/** What the member is notified about, and when not. */
export const notificationSettingsSchema = Schema.Struct({
	level: notificationLevelSchema,
	/** No notifications until then; null when not paused. */
	pausedUntil: Schema.NullOr(isoTimestampSchema),
	quietHours: Schema.NullOr(quietHoursSchema),
	...otherNotificationsFields,
	/** Levels chosen for projects, by project id. */
	projects: Schema.Record(uuidSchema, notificationLevelSchema),
	/** Levels chosen for bots, by bot id, which win over their project's. */
	bots: Schema.Record(uuidSchema, notificationLevelSchema),
	/**
	 * Projects and bots muted for a while, by id, with when each mute ends. While
	 * it lasts, a place is at `nothing` whatever level it has.
	 */
	mutedUntil: Schema.Struct({
		projects: Schema.Record(uuidSchema, isoTimestampSchema),
		bots: Schema.Record(uuidSchema, isoTimestampSchema),
	}),
});

export type NotificationSettings = typeof notificationSettingsSchema.Type;

export const notificationPreferencesSchema = Schema.Struct({
	level: notificationLevelSchema,
	pausedUntil: Schema.NullOr(isoTimestampSchema),
	quietHours: Schema.NullOr(quietHoursSchema),
	...otherNotificationsFields,
});

export type NotificationPreferences = typeof notificationPreferencesSchema.Type;

/**
 * Which chat a browser tab shows while it has focus, which the server
 * passes to the member's other tabs, so none of them notifies them of what
 * they are looking at. `clientId` tells one tab from another; a null
 * chat means the tab shows none, or lost focus.
 */
export const presenceSchema = Schema.Struct({
	clientId: uuidSchema,
	chatId: Schema.NullOr(uuidSchema),
	/** Counts up with each report from the tab, so one that arrives late cannot undo a newer one. */
	sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export type Presence = typeof presenceSchema.Type;

/** How long a tab is taken to show a chat after it last said so, which it says again well within. */
export const PRESENCE_LIFETIME_MS = 90_000;

/** A notification as the browser shows it, sent to the member's open tabs. */
export const notificationContentSchema = Schema.Struct({
	title: Schema.String,
	body: Schema.String,
	/**
	 * Notifications with one tag replace each other, so a busy chat
	 * shows as one notification rather than a stack.
	 */
	tag: Schema.String,
	/** The path in the web app the notification opens. */
	path: Schema.String,
	/** The chat it is about, which a tab showing it holds back; null for one about none. */
	chatId: Schema.NullOr(uuidSchema),
});

export type NotificationContent = typeof notificationContentSchema.Type;

/** The tag a chat's notifications share, so each replaces the last. */
export function chatNotificationTag(chatId: string): string {
	return `chat:${chatId}`;
}
