export * as Notifications from "./notifications.ts";

import {
	messageAuthorName,
	type NotificationLevel,
	type NotificationPlaceKind,
	type NotificationPreferences,
	type NotificationSettings,
	type Presence,
	personStream,
	streamEvent,
} from "@sugabots/contracts";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { Context, DateTime, Effect, Layer } from "effect";
import {
	botStandingFor,
	projectStandingFor,
	type ResourceHidden,
	requireReach,
} from "../authorization/access.ts";
import { CurrentActor } from "../authorization/current-actor.ts";
import type { ChatEvent } from "../chats/events.ts";
import {
	afterCommit,
	type Database,
	type Executor,
	query,
	serviceOperations,
} from "../database/database.ts";
import { EventBus } from "../database/events/bus.ts";
import type { DomainEvents } from "../database/events/domain-events.ts";
import { notificationOverride, notificationSettings } from "../database/schema.ts";
import {
	type Addressed,
	DEFAULT_AUTOMATION_RUNS,
	DEFAULT_LEVEL,
	DEFAULT_TURN_FAILURES,
	forApprovals,
	forAutomationRun,
	forFailedReply,
	forMessage,
	forReply,
} from "./recipients.ts";

/**
 * Browser notifications, as Slack's web app shows them: what each person
 * chose to hear of, sent on their own event stream for their open tabs to
 * show. With no tab open, nothing reaches them. Their tabs also say there
 * which chat each is showing, so none notifies them of what they are
 * reading.
 */
export interface Interface {
	readonly settings: Effect.Effect<NotificationSettings, never, CurrentActor.Service>;
	readonly updatePreferences: (
		preferences: NotificationPreferences,
	) => Effect.Effect<NotificationSettings, never, CurrentActor.Service>;
	/**
	 * Sets the actor's level for a project or bot they reach, or with null goes
	 * back to the one above it, which also ends its mute.
	 */
	readonly setLevel: (
		place: Place,
		level: NotificationLevel | null,
	) => Effect.Effect<void, ResourceHidden, CurrentActor.Service>;
	/** Mutes a project or bot the actor reaches until `until`, or with null, or a time passed, ends its mute. */
	readonly mute: (
		place: Place,
		until: Date | null,
	) => Effect.Effect<void, ResourceHidden, CurrentActor.Service>;
	/** Notifies every open tab of the actor's, whatever they chose, so they can see it works. */
	readonly sendTest: Effect.Effect<void, never, CurrentActor.Service>;
	/** Tells the actor's other tabs what one of theirs is looking at. */
	readonly reportPresence: (presence: Presence) => Effect.Effect<void, never, CurrentActor.Service>;
	/** Notifies people of finished messages and of approvals waiting on them, once they commit. */
	readonly handler: DomainEvents.Handler<ChatEvent>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/Notifications",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("Notifications");
	const bus = yield* EventBus.Service;
	// Sending outlives the transaction that asked for it, and must not hold up its commit.
	const sending = yield* Effect.scope;
	const runInBackground = <E>(work: Effect.Effect<void, E, Database>) =>
		operation("handler", work).pipe(
			Effect.catchCause((cause) => Effect.logWarning("Sending notifications failed", cause)),
			Effect.forkIn(sending),
			Effect.asVoid,
		);

	const deliver = (addressed: readonly Addressed[]) =>
		Effect.forEach(
			addressed,
			({ personId, notification }) =>
				Effect.promise(() =>
					bus.publish(personStream(personId), streamEvent("notification", notification)),
				),
			{ discard: true },
		);

	const notifyOf = (events: ReadonlyArray<NotifyingEvent>) =>
		Effect.gen(function* () {
			const now = yield* DateTime.nowAsDate;
			for (const event of events) {
				const addressed = yield* query((db) => notificationsFor(db, event, now));
				yield* deliver(addressed);
			}
		});

	const settingsOf = (personId: string) =>
		Effect.gen(function* () {
			const [own] = yield* query((db) =>
				db.select().from(notificationSettings).where(eq(notificationSettings.personId, personId)),
			);
			const overrides = yield* query((db) =>
				db.select().from(notificationOverride).where(eq(notificationOverride.personId, personId)),
			);
			const now = yield* DateTime.nowAsDate;
			const levels = {
				projects: {} as Record<string, NotificationLevel>,
				bots: {} as Record<string, NotificationLevel>,
			};
			const mutedUntil = {
				projects: {} as Record<string, string>,
				bots: {} as Record<string, string>,
			};
			for (const override of overrides) {
				const [kind, id] = override.projectId
					? (["projects", override.projectId] as const)
					: (["bots", override.botId] as const);
				if (!id) continue;
				if (override.level) levels[kind][id] = override.level;
				if (override.mutedUntil && override.mutedUntil > now) {
					mutedUntil[kind][id] = override.mutedUntil.toISOString();
				}
			}
			return {
				level: own?.level ?? DEFAULT_LEVEL,
				pausedUntil: own?.pausedUntil?.toISOString() ?? null,
				quietHours: own?.quietHours ?? null,
				turnFailures: own?.turnFailures ?? DEFAULT_TURN_FAILURES,
				automationRuns: own?.automationRuns ?? DEFAULT_AUTOMATION_RUNS,
				...levels,
				mutedUntil,
			} satisfies NotificationSettings;
		});

	return Service.of({
		settings: operation(
			"settings",
			Effect.flatMap(CurrentActor.Service, ({ personId }) => settingsOf(personId)),
		),

		updatePreferences: (preferences) =>
			operation(
				"updatePreferences",
				Effect.gen(function* () {
					const { personId } = yield* CurrentActor.Service;
					const values = {
						level: preferences.level,
						pausedUntil: preferences.pausedUntil
							? DateTime.toDate(DateTime.makeUnsafe(preferences.pausedUntil))
							: null,
						quietHours: preferences.quietHours,
						turnFailures: preferences.turnFailures,
						automationRuns: preferences.automationRuns,
					};
					yield* query((db) =>
						db
							.insert(notificationSettings)
							.values({ personId, ...values })
							.onConflictDoUpdate({ target: notificationSettings.personId, set: values }),
					);
					return yield* settingsOf(personId);
				}),
			),

		setLevel: (place, level) =>
			operation(
				"setLevel",
				Effect.gen(function* () {
					const { personId } = yield* CurrentActor.Service;
					const override = overrideOf(personId, place);
					// Clearing removes only the actor's own choice, so it needs no reach.
					if (level === null) {
						yield* query((db) => db.delete(notificationOverride).where(override.where));
						return;
					}
					yield* requireReachOf(personId, place);
					yield* query((db) =>
						db
							.insert(notificationOverride)
							.values({ ...override.row, level })
							.onConflictDoUpdate({ ...override.conflict, set: { level, mutedUntil: null } }),
					);
				}),
			),

		mute: (place, until) =>
			operation(
				"mute",
				Effect.gen(function* () {
					const { personId } = yield* CurrentActor.Service;
					const override = overrideOf(personId, place);
					const now = yield* DateTime.nowAsDate;
					if (until === null || until <= now) {
						// A row that only held the mute has nothing left to say.
						yield* query((db) =>
							db
								.delete(notificationOverride)
								.where(and(override.where, isNull(notificationOverride.level))),
						);
						yield* query((db) =>
							db.update(notificationOverride).set({ mutedUntil: null }).where(override.where),
						);
						return;
					}
					yield* requireReachOf(personId, place);
					yield* query((db) =>
						db
							.insert(notificationOverride)
							.values({ ...override.row, mutedUntil: until })
							.onConflictDoUpdate({ ...override.conflict, set: { mutedUntil: until } }),
					);
				}),
			),

		sendTest: operation(
			"sendTest",
			Effect.gen(function* () {
				const { personId } = yield* CurrentActor.Service;
				yield* deliver([
					{
						personId,
						notification: {
							title: "Notifications are on",
							body: "This is how Sugabots will tell you when something needs you.",
							tag: "test",
							path: "/",
							chatId: null,
						},
					},
				]);
			}),
		),

		reportPresence: (reported) =>
			operation(
				"reportPresence",
				Effect.flatMap(CurrentActor.Service, ({ personId }) =>
					Effect.promise(() =>
						bus.publish(personStream(personId), streamEvent("presence", reported)),
					),
				),
			),

		handler: (events) => {
			const notifying = events.filter(isNotifying);
			return notifying.length === 0
				? Effect.void
				: afterCommit(runInBackground(notifyOf(notifying)));
		},
	});
});

export const layer = Layer.effect(Service, make);

type NotifyingEvent = Extract<
	ChatEvent,
	{
		_tag: "MessagePosted" | "TurnCompleted" | "TurnSuspended" | "TurnFailed" | "RunSettled";
	}
>;

function isNotifying(event: ChatEvent): event is NotifyingEvent {
	switch (event._tag) {
		case "MessagePosted":
		case "TurnCompleted":
		case "TurnSuspended":
		case "RunSettled":
			return true;
		// A turn that will run again has not failed yet, as far as anybody waiting on it knows.
		case "TurnFailed":
			return !event.willRetry;
		default:
			return false;
	}
}

const notificationsFor = Effect.fn("Notifications.notificationsFor")(function* (
	db: Executor,
	event: NotifyingEvent,
	now: Date,
) {
	switch (event._tag) {
		case "MessagePosted": {
			const { author } = event.message;
			return yield* forMessage(
				db,
				{
					chatId: event.chatId,
					messageId: event.message.id,
					author:
						author.kind === "person"
							? { kind: "person", personId: author.id }
							: author.kind === "bot"
								? { kind: "bot", botId: author.id }
								: { kind: "automation" },
					authorName: messageAuthorName(author),
					content: event.message.content,
					fileNames: event.message.parts.flatMap((part) =>
						part.type === "file" ? [part.name] : [],
					),
					fileTitles: event.message.parts.flatMap((part) =>
						part.type === "written_file" ? [part.title] : [],
					),
					repliesTo:
						event.message.replyTo?.author.kind === "person"
							? event.message.replyTo.author.id
							: null,
					resultOf: event.message.automationResultOf ?? null,
				},
				now,
			);
		}
		case "TurnCompleted":
			return yield* forReply(db, event, now);
		case "TurnSuspended":
			return yield* forApprovals(db, event, now);
		case "TurnFailed":
			return yield* forFailedReply(db, event, now);
		case "RunSettled":
			return yield* forAutomationRun(db, event, now);
	}
});

/** A project or a bot, where a person chooses in place of the level above. */
export interface Place {
	kind: NotificationPlaceKind;
	id: string;
}

/** The person's override row for `place`: how to find it, make it, and update it in place. */
function overrideOf(personId: string, place: Place) {
	const column =
		place.kind === "project" ? notificationOverride.projectId : notificationOverride.botId;
	return {
		where: and(eq(notificationOverride.personId, personId), eq(column, place.id)),
		row:
			place.kind === "project" ? { personId, projectId: place.id } : { personId, botId: place.id },
		conflict: { target: [notificationOverride.personId, column], targetWhere: isNotNull(column) },
	};
}

const requireReachOf = (personId: string, place: Place) =>
	place.kind === "project"
		? query((db) => projectStandingFor(db, place.id, personId)).pipe(
				Effect.flatMap((standing) => requireReach(standing, "project")),
			)
		: query((db) => botStandingFor(db, place.id, personId)).pipe(
				Effect.flatMap((standing) => requireReach(standing, "bot")),
			);
