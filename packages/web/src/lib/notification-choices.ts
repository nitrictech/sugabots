import type { NotificationLevel } from "@sugabots/contracts";

/*
 * The choices a person makes about notifications, as plain data, which the
 * native apps' copies are generated from.
 */

/** What each level is called where a person chooses one. */
export const NOTIFICATION_LEVEL_LABELS: Record<NotificationLevel, string> = {
	all: "Everything",
	mentions: "Mentions and replies",
	nothing: "Nothing",
};

/** What each level notifies about, under the choice of one. */
export const NOTIFICATION_LEVEL_NOTES: Record<NotificationLevel, string> = {
	all: "Every new message in the conversations you can see, and approvals that wait on you.",
	mentions:
		"Messages that mention you, a bot's answers to you, replies in conversations you're part of, and approvals that wait on you.",
	nothing: "No notifications, wherever you are.",
};

/** How long a pause or a mute lasts: some minutes, or until an hour tomorrow on this device's clock. */
export type MuteLength = { minutes: number } | { tomorrowAtHour: number };

/** The pauses and mutes offered, as Slack offers them. */
export const MUTE_LENGTHS: readonly { label: string; length: MuteLength }[] = [
	{ label: "For 30 minutes", length: { minutes: 30 } },
	{ label: "For 1 hour", length: { minutes: 60 } },
	{ label: "For 2 hours", length: { minutes: 120 } },
	{ label: "Until tomorrow", length: { tomorrowAtHour: 9 } },
];
