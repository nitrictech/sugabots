import {
	conversationNotificationTag,
	type NotificationContent,
	type NotificationLevel,
	type NotificationPreferences,
	type NotificationSettings,
	PRESENCE_LIFETIME_MS,
	type Presence,
	personUpdateEventSchema,
} from "@sugabots/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Effect, Schema } from "effect";
import { useEffect, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import { client } from "@/api.ts";

/**
 * Browser notifications, shown by Sugabots' open tabs as Slack's web app
 * shows them: what the person chose to be notified about, turning them on in
 * this browser, and telling the server which conversation this tab shows, so
 * it does not notify them of what they are reading.
 */

/**
 * Set in a browser whose notifications the person turned on, so they can turn
 * them off here without taking back the browser's permission.
 */
const TURNED_ON_KEY = "sugabots-notifications-on";

const settingsKey = ["notification-settings"];

export function useNotificationSettings() {
	return useQuery({
		queryKey: settingsKey,
		queryFn: ({ signal }) => Effect.runPromise(client.api.notifications.settings(), { signal }),
	});
}

export function useUpdateNotificationPreferences() {
	const queries = useQueryClient();
	return useMutation({
		mutationFn: (preferences: NotificationPreferences) =>
			Effect.runPromise(client.api.notifications.updatePreferences({ payload: preferences })),
		onSuccess: (settings) => queries.setQueryData(settingsKey, settings),
	});
}

/**
 * Where a level applies in place of the one above it: a pod, in place of the
 * person's own, or one of its bots, in place of the pod's.
 */
export type NotificationPlace =
	| { kind: "pod"; id: string }
	| { kind: "bot"; id: string; podId: string };

/** Sets the level for a place, or with null goes back to the one above it. */
export function useSetNotificationLevel() {
	const queries = useQueryClient();
	return useMutation({
		mutationFn: ({ place, level }: { place: NotificationPlace; level: NotificationLevel | null }) =>
			Effect.runPromise(
				client.api.notifications.setLevel({ params: paramsOf(place), payload: { level } }),
			),
		onMutate: ({ place, level }) => {
			queries.setQueryData<NotificationSettings>(settingsKey, (settings) =>
				settings ? withLevel(settings, place, level) : settings,
			);
		},
		onSettled: () => queries.invalidateQueries({ queryKey: settingsKey }),
	});
}

/** Mutes a place until `until`, or with null ends its mute. */
export function useMuteNotifications() {
	const queries = useQueryClient();
	return useMutation({
		mutationFn: ({ place, until }: { place: NotificationPlace; until: Date | null }) =>
			Effect.runPromise(
				client.api.notifications.mute({
					params: paramsOf(place),
					payload: { until: until?.toISOString() ?? null },
				}),
			),
		onMutate: ({ place, until }) => {
			queries.setQueryData<NotificationSettings>(settingsKey, (settings) =>
				settings ? withMute(settings, place, until) : settings,
			);
		},
		onSettled: () => queries.invalidateQueries({ queryKey: settingsKey }),
	});
}

function paramsOf(place: NotificationPlace) {
	return { kind: place.kind, id: place.id };
}

/** Where a place's own choices are kept in the settings, and its id there. */
function fieldOf(place: NotificationPlace) {
	return [place.kind === "pod" ? "pods" : "bots", place.id] as const;
}

/** `record` with `id` set to `value`, or without it when `value` is null. */
function withEntry<T>(record: Record<string, T>, id: string, value: T | null): Record<string, T> {
	const { [id]: _previous, ...others } = record;
	return value === null ? others : { ...others, [id]: value };
}

/** The settings with a level chosen for `place`, which, as on the server, ends its mute. */
function withLevel(
	settings: NotificationSettings,
	place: NotificationPlace,
	level: NotificationLevel | null,
): NotificationSettings {
	const [field, id] = fieldOf(place);
	return {
		...withMute(settings, place, null),
		[field]: withEntry(settings[field], id, level),
	};
}

function withMute(
	settings: NotificationSettings,
	place: NotificationPlace,
	until: Date | null,
): NotificationSettings {
	const [field, id] = fieldOf(place);
	return {
		...settings,
		mutedUntil: {
			...settings.mutedUntil,
			[field]: withEntry(settings.mutedUntil[field], id, until?.toISOString() ?? null),
		},
	};
}

/** Whether this browser can be notified, and whether it is, while Sugabots is open in it. */
export type BrowserNotifications =
	| { state: "unsupported" }
	| { state: "denied" }
	| { state: "off" }
	| { state: "on" };

/**
 * Whether this browser can show Sugabots' notifications, with `enable`, which
 * must run from a click because browsers only ask permission then, and
 * `disable`, which stops them here.
 */
export function useBrowserNotifications() {
	const [status, setStatus] = useState(browserNotifications);
	const refresh = () => setStatus(browserNotifications());

	const enable = useMutation({
		mutationFn: async () => {
			const permission = await Notification.requestPermission();
			writeTurnedOn(permission === "granted");
		},
		onSettled: refresh,
	});

	const disable = useMutation({
		mutationFn: async () => writeTurnedOn(false),
		onSettled: refresh,
	});

	const sendTest = useMutation({
		mutationFn: () => Effect.runPromise(client.api.notifications.sendTest()),
	});

	return { status, enable, disable, sendTest };
}

function browserNotifications(): BrowserNotifications {
	if (!("Notification" in window)) return { state: "unsupported" };
	if (Notification.permission === "denied") return { state: "denied" };
	if (Notification.permission !== "granted") return { state: "off" };
	return readTurnedOn() ? { state: "on" } : { state: "off" };
}

function readTurnedOn(): boolean {
	try {
		return localStorage.getItem(TURNED_ON_KEY) !== null;
	} catch {
		return false;
	}
}

function writeTurnedOn(on: boolean) {
	try {
		if (on) localStorage.setItem(TURNED_ON_KEY, "1");
		else localStorage.removeItem(TURNED_ON_KEY);
	} catch {
		// Storage can be off. Notifications then stay off in this browser.
	}
}

/**
 * Shows the signed-in person's notifications from this tab, while their
 * notifications are on in this browser, except those about a conversation one
 * of their tabs is looking at, and opens what a clicked one is about here.
 */
export function useNotificationsInThisBrowser() {
	const router = useRouter();

	useEffect(() => {
		if (!("Notification" in window)) return;
		const stream = client.events.me();
		const looking: LookingTabs = new Map();
		void (async () => {
			for await (const event of stream) {
				const parsed = Schema.decodeUnknownResult(personUpdateEventSchema)(event);
				if (parsed._tag === "Failure") continue;
				const update = parsed.success;
				if (update.type === "presence") {
					rememberLooking(looking, update, Date.now());
					// Every tab showed it, so each closes its own.
					if (update.conversationId) closeNotificationsAbout(update.conversationId);
				} else if (
					update.type === "notification" &&
					update.conversationId !== lookingHere &&
					!someTabLooksAt(looking, update, Date.now())
				) {
					showFromThisTab(update, (path) => router.history.push(path));
				}
			}
			// A stream that ends or fails only costs the notifications it would have carried.
		})().catch(() => {});
		return () => stream.close();
	}, [router]);
}

/**
 * The conversation each of the person's tabs is looking at, if any, from any
 * browser or device, by tab: as of its latest report, and until when that
 * counts if the tab says no more.
 */
type LookingTabs = Map<string, { conversationId: string | null; sequence: number; until: number }>;

function rememberLooking(
	tabs: LookingTabs,
	{ clientId, conversationId, sequence }: Presence,
	now: number,
) {
	const latest = tabs.get(clientId);
	if (latest && latest.sequence >= sequence) return;
	tabs.set(clientId, { conversationId, sequence, until: now + PRESENCE_LIFETIME_MS });
}

/** Whether one of the person's tabs is looking at what `notification` is about. */
function someTabLooksAt(
	tabs: LookingTabs,
	{ conversationId }: NotificationContent,
	now: number,
): boolean {
	return [...tabs.values()].some((tab) => tab.conversationId === conversationId && tab.until > now);
}

/**
 * Shows `notification` from this tab, when this browser's notifications are
 * on. Every open tab shows it, and each replaces the others' because they
 * share its tag.
 */
function showFromThisTab(notification: NotificationContent, open: (path: string) => void) {
	if (Notification.permission !== "granted" || !readTurnedOn()) return;
	const shown = new Notification(notification.title, {
		body: notification.body,
		tag: notification.tag,
		icon: "/icon-192.png",
	});
	shownByThisTab.set(notification.tag, shown);
	shown.onclose = () => {
		if (shownByThisTab.get(notification.tag) === shown) shownByThisTab.delete(notification.tag);
	};
	shown.onclick = () => {
		shown.close();
		window.focus();
		open(notification.path);
	};
}

/** The notifications this tab is showing, by tag, so it can close them. */
const shownByThisTab = new Map<string, Notification>();

/** Tells this tab apart from the person's others, for as long as it is open. */
const TAB_ID = uuidv4();

/** How many presence reports this tab has made. */
let presenceReports = 0;

/**
 * The conversation this tab is looking at, known here at once, before its
 * report comes back over the person's stream.
 */
let lookingHere: string | null = null;

function reportPresence(conversationId: string | null) {
	lookingHere = conversationId;
	presenceReports += 1;
	void Effect.runPromise(
		client.api.notifications.reportPresence({
			payload: { clientId: TAB_ID, conversationId, sequence: presenceReports },
		}),
		// Best effort: a lost report only means one notification the person did not need.
	).catch(() => {});
}

/** How often a tab showing a conversation says so again, well inside `PRESENCE_LIFETIME_MS`. */
const PRESENCE_INTERVAL_MS = PRESENCE_LIFETIME_MS / 3;

/**
 * Tells the server this tab shows `conversationId` while the tab has focus,
 * so the person is not notified of what they are reading, and closes the
 * notifications already shown for it.
 */
export function usePresence(conversationId: string | undefined) {
	useEffect(() => {
		const report = () => {
			const looking = document.visibilityState === "visible" && document.hasFocus();
			const showing = looking && conversationId ? conversationId : null;
			reportPresence(showing);
			if (showing) closeNotificationsAbout(showing);
		};
		report();
		const timer = setInterval(report, PRESENCE_INTERVAL_MS);
		window.addEventListener("focus", report);
		window.addEventListener("blur", report);
		document.addEventListener("visibilitychange", report);
		return () => {
			clearInterval(timer);
			window.removeEventListener("focus", report);
			window.removeEventListener("blur", report);
			document.removeEventListener("visibilitychange", report);
		};
	}, [conversationId]);

	useEffect(() => () => reportPresence(null), []);
}

function closeNotificationsAbout(conversationId: string) {
	shownByThisTab.get(conversationNotificationTag(conversationId))?.close();
}

/** What each level is called where a person chooses one. */
export const NOTIFICATION_LEVEL_LABELS: Record<NotificationLevel, string> = {
	all: "Everything",
	mentions: "Mentions and replies",
	nothing: "Nothing",
};

/** When the place's mute ends, or null when it is not muted for a while. */
export function mutedUntilFor(
	settings: NotificationSettings,
	place: NotificationPlace,
): Date | null {
	const [field, id] = fieldOf(place);
	const until = settings.mutedUntil[field][id];
	return until && new Date(until) > new Date() ? new Date(until) : null;
}

/** How long a pause or a mute lasts, as Slack offers them. */
export const MUTE_DURATIONS = [
	{ label: "For 30 minutes", until: (now: Date) => new Date(now.getTime() + 30 * 60_000) },
	{ label: "For 1 hour", until: (now: Date) => new Date(now.getTime() + 60 * 60_000) },
	{ label: "For 2 hours", until: (now: Date) => new Date(now.getTime() + 2 * 60 * 60_000) },
	{ label: "Until tomorrow", until: tomorrowMorning },
];

/** The hour a pause or mute until tomorrow ends, on this device's clock. */
const MORNING_HOUR = 9;

function tomorrowMorning(now: Date): Date {
	const morning = new Date(now);
	morning.setDate(morning.getDate() + 1);
	morning.setHours(MORNING_HOUR, 0, 0, 0);
	return morning;
}

/** When a pause or mute ends: its time today, else its day and time. */
export function formatUntil(until: Date): string {
	const sameDay = until.toDateString() === new Date().toDateString();
	return until.toLocaleString(undefined, {
		weekday: sameDay ? undefined : "short",
		hour: "numeric",
		minute: "2-digit",
	});
}

/** The level chosen for a place itself, or null when it follows the one above it. */
export function levelChosenFor(
	settings: NotificationSettings,
	place: NotificationPlace,
): NotificationLevel | null {
	const [field, id] = fieldOf(place);
	return settings[field][id] ?? null;
}

/** The level a place follows when none is chosen for it: its pod's, or the person's own. */
export function levelAbove(
	settings: NotificationSettings,
	place: NotificationPlace,
): NotificationLevel {
	return (place.kind === "bot" ? settings.pods[place.podId] : undefined) ?? settings.level;
}
