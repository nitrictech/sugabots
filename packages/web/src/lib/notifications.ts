import {
	chatNotificationTag,
	memberUpdateEventSchema,
	type NotificationContent,
	type NotificationLevel,
	type NotificationPreferences,
	type NotificationSettings,
	PRESENCE_LIFETIME_MS,
	type Presence,
} from "@sugabots/contracts";
import { isApiFailure } from "@sugabots/sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Effect, Schema } from "effect";
import { useEffect, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import { client } from "@/api.ts";
import { MUTE_LENGTHS, type MuteLength } from "@/lib/notification-choices.ts";
import { useSession } from "@/lib/session.ts";
import { refreshEveryWorkspaceApprovals } from "./chats.ts";

/*
 * Browser notifications, shown by Sugabots' open tabs as Slack's web app
 * shows them: what the member chose to be notified about, turning them on in
 * this browser, and telling the server which chat this tab shows, so
 * it does not notify them of what they are reading.
 */

/**
 * Set in a browser whose notifications the member turned on, so they can turn
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

/**
 * Changes some of the member's notification preferences. The API takes them
 * all at once, so the rest are sent as last saved. Changes are sent one at a
 * time, in the order made, each once the one before has been saved, so a quick
 * second change never sends the first one's old value back. Only for a page
 * that has the settings loaded.
 */
export function useChangeNotificationPreferences() {
	const queries = useQueryClient();
	const update = useMutation({
		scope: { id: "notification-preferences" },
		mutationFn: (change: Partial<NotificationPreferences>) => {
			const saved = queries.getQueryData<NotificationSettings>(settingsKey);
			if (!saved) return Promise.reject(new Error("Notification settings aren't loaded"));
			const preferences: NotificationPreferences = {
				level: saved.level,
				pausedUntil: saved.pausedUntil,
				quietHours: saved.quietHours,
				turnFailures: saved.turnFailures,
				automationRuns: saved.automationRuns,
				...change,
			};
			return Effect.runPromise(
				client.api.notifications.updatePreferences({ payload: preferences }),
			);
		},
		onSuccess: (saved) => queries.setQueryData(settingsKey, saved),
	});
	return (change: Partial<NotificationPreferences>) => update.mutate(change);
}

/** Where a level applies in place of the member's own: a project, or a bot. */
export type NotificationPlace = { kind: "project"; id: string } | { kind: "bot"; id: string };

/** Sets the level for a place, or with null goes back to the one above it. */
export function useSetNotificationLevel() {
	const queries = useQueryClient();
	return useMutation({
		mutationFn: ({ place, level }: { place: NotificationPlace; level: NotificationLevel | null }) =>
			Effect.runPromise(client.api.notifications.setLevel({ params: place, payload: { level } })),
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
					params: place,
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

/** Where a place's own choices are kept in the settings, and its id there. */
function fieldOf(place: NotificationPlace) {
	return [place.kind === "project" ? "projects" : "bots", place.id] as const;
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
type BrowserNotifications =
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
 * Shows the current user's notifications from this tab, while their
 * notifications are on in this browser, except those about a chat one
 * of their tabs is looking at, and opens what a clicked one is about here.
 */
export function useNotificationsInThisBrowser() {
	const router = useRouter();
	const queries = useQueryClient();
	const { refresh: refreshSession } = useSession();

	useEffect(() => {
		const stream = client.events.me();
		const looking: LookingTabs = new Map();
		void (async () => {
			for await (const event of stream) {
				const parsed = Schema.decodeUnknownResult(memberUpdateEventSchema)(event);
				if (parsed._tag === "Failure") continue;
				const update = parsed.success;
				// Before the stream started, or across a reset, approvals may have changed unheard.
				if (
					update.type === "approvals.changed" ||
					update.type === "ready" ||
					update.type === "reset"
				) {
					void refreshEveryWorkspaceApprovals(queries);
				} else if (update.type === "presence") {
					rememberLooking(looking, update, Date.now());
					// Every tab showed it, so each closes its own.
					if (update.chatId) closeNotificationsAbout(update.chatId);
				} else if (
					update.type === "notification" &&
					"Notification" in window &&
					(update.chatId === null || update.chatId !== lookingHere) &&
					!someTabLooksAt(looking, update, Date.now())
				) {
					showFromThisTab(update, (path) => router.history.push(path));
				}
			}
			// A stream that ends or fails only costs the notifications it would have
			// carried, unless it ended with the member's session, which is asked about again.
		})().catch((refusal) => {
			if (isApiFailure(refusal) && refusal._tag === "Unauthorized") {
				void refreshSession().catch(() => {});
			}
		});
		return () => stream.close();
	}, [queries, router, refreshSession]);
}

/**
 * The chat each of the member's tabs is looking at, if any, from any
 * browser or device, by tab: as of its latest report, and until when that
 * counts if the tab says no more.
 */
type LookingTabs = Map<string, { chatId: string | null; sequence: number; until: number }>;

function rememberLooking(tabs: LookingTabs, { clientId, chatId, sequence }: Presence, now: number) {
	const latest = tabs.get(clientId);
	if (latest && latest.sequence >= sequence) return;
	tabs.set(clientId, { chatId, sequence, until: now + PRESENCE_LIFETIME_MS });
}

/** Whether one of the member's tabs is looking at what `notification` is about. */
function someTabLooksAt(tabs: LookingTabs, { chatId }: NotificationContent, now: number): boolean {
	return (
		chatId !== null && [...tabs.values()].some((tab) => tab.chatId === chatId && tab.until > now)
	);
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

/** Tells this tab apart from the member's others, for as long as it is open. */
const TAB_ID = uuidv4();

/** How many presence reports this tab has made. */
let presenceReports = 0;

/**
 * The chat this tab is looking at, known here at once, before its
 * report comes back over the member's stream.
 */
let lookingHere: string | null = null;

function reportPresence(chatId: string | null) {
	lookingHere = chatId;
	presenceReports += 1;
	void Effect.runPromise(
		client.api.notifications.reportPresence({
			payload: { clientId: TAB_ID, chatId, sequence: presenceReports },
		}),
		// Best effort: a lost report only means one notification the member did not need.
	).catch(() => {});
}

/** How often a tab showing a chat says so again, well inside `PRESENCE_LIFETIME_MS`. */
const PRESENCE_INTERVAL_MS = PRESENCE_LIFETIME_MS / 3;

/**
 * Tells the server this tab shows `chatId` while the tab has focus,
 * so the member is not notified of what they are reading, and closes the
 * notifications already shown for it.
 */
export function usePresence(chatId: string | undefined) {
	useEffect(() => {
		const report = () => {
			const looking = document.visibilityState === "visible" && document.hasFocus();
			const showing = looking && chatId ? chatId : null;
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
	}, [chatId]);

	useEffect(() => () => reportPresence(null), []);
}

function closeNotificationsAbout(chatId: string) {
	shownByThisTab.get(chatNotificationTag(chatId))?.close();
}

/** When the place's mute ends, or null when it is not muted for a while. */
export function mutedUntilFor(
	settings: NotificationSettings,
	place: NotificationPlace,
): Date | null {
	const [field, id] = fieldOf(place);
	const until = settings.mutedUntil[field][id];
	return until && new Date(until) > new Date() ? new Date(until) : null;
}

/** How long a pause or a mute lasts, as Slack offers them, with when it ends if started `now`. */
export const MUTE_DURATIONS = MUTE_LENGTHS.map(({ label, length }) => ({
	label,
	until: (now: Date) => muteEnd(length, now),
}));

function muteEnd(length: MuteLength, now: Date): Date {
	if ("minutes" in length) return new Date(now.getTime() + length.minutes * 60_000);
	const morning = new Date(now);
	morning.setDate(morning.getDate() + 1);
	morning.setHours(length.tomorrowAtHour, 0, 0, 0);
	return morning;
}

/**
 * When a pause or mute ends: its time if `until` is on `now`'s day, else its
 * weekday and time, written in `locale`, by default the browser's.
 */
export function formatUntil(
	until: Date,
	{ now = new Date(), locale }: { now?: Date; locale?: string } = {},
): string {
	const sameDay = until.toDateString() === now.toDateString();
	return until.toLocaleString(locale, {
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

/** The level a place follows when none is chosen for it: the member's own. */
export function levelAbove(settings: NotificationSettings): NotificationLevel {
	return settings.level;
}
