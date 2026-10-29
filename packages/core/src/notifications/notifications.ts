export * as Notifications from "./notifications.ts";

import {
	messageAuthorName,
	type NotificationLevel,
	type NotificationPlaceKind,
	type NotificationPreferences,
	type NotificationSettings,
	type Presence,
	personChannel,
	streamEvent,
} from "@sugabots/contracts";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { Context, DateTime, Effect, Layer } from "effect";
import {
	agentStandingFor,
	podStandingFor,
	type ResourceHidden,
	requireReach,
} from "../authorization/access.ts";
import { CurrentActor } from "../authorization/current-actor.ts";
import type { ConversationEvent } from "../conversations/events.ts";
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
	DEFAULT_LEVEL,
	DEFAULT_ROUTINE_RUNS,
	DEFAULT_TURN_FAILURES,
	forApprovals,
	forFailedReply,
	forMessage,
	forReply,
	forRoutineRun,
} from "./recipients.ts";

/**
 * Browser notifications, as Slack's web app shows them: what each person
 * chose to hear of, sent on their own event channel for their open tabs to
 * show. With no tab open, nothing reaches them. Their tabs also say there
 * which conversation each is showing, so none notifies them of what they are
 * reading.
 */
export interface Interface {
	readonly settings: Effect.Effect<NotificationSettings, never, CurrentActor.Service>;
	readonly updatePreferences: (
		preferences: NotificationPreferences,
	) => Effect.Effect<NotificationSettings, never, CurrentActor.Service>;
	/**
	 * Sets the actor's level for a pod or bot they reach, or with null goes
	 * back to the one above it, which also ends its mute.
	 */
	readonly setLevel: (
		place: Place,
		level: NotificationLevel | null,
	) => Effect.Effect<void, ResourceHidden, CurrentActor.Service>;
	/** Mutes a pod or bot the actor reaches until `until`, or with null, or a time passed, ends its mute. */
	readonly mute: (
		place: Place,
		until: Date | null,
	) => Effect.Effect<void, ResourceHidden, CurrentActor.Service>;
	/** Notifies every open tab of the actor's, whatever they chose, so they can see it works. */
	readonly sendTest: Effect.Effect<void, never, CurrentActor.Service>;
	/** Tells the actor's other tabs what one of theirs is looking at. */
	readonly reportPresence: (presence: Presence) => Effect.Effect<void, never, CurrentActor.Service>;
	/** Notifies people of finished messages and of approvals waiting on them, once they commit. */
	readonly handler: DomainEvents.Handler<ConversationEvent>;
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
			({ userId, notification }) =>
				Effect.promise(() =>
					bus.publish(personChannel(userId), streamEvent("notification", notification)),
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

	const settingsOf = (userId: string) =>
		Effect.gen(function* () {
			const [own] = yield* query((db) =>
				db.select().from(notificationSettings).where(eq(notificationSettings.userId, userId)),
			);
			const overrides = yield* query((db) =>
				db.select().from(notificationOverride).where(eq(notificationOverride.userId, userId)),
			);
			const now = yield* DateTime.nowAsDate;
			const levels = {
				pods: {} as Record<string, NotificationLevel>,
				bots: {} as Record<string, NotificationLevel>,
			};
			const mutedUntil = { pods: {} as Record<string, string>, bots: {} as Record<string, string> };
			for (const override of overrides) {
				const [kind, id] = override.podId
					? (["pods", override.podId] as const)
					: (["bots", override.agentId] as const);
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
				routineRuns: own?.routineRuns ?? DEFAULT_ROUTINE_RUNS,
				...levels,
				mutedUntil,
			} satisfies NotificationSettings;
		});

	return Service.of({
		settings: operation(
			"settings",
			Effect.flatMap(CurrentActor.Service, ({ userId }) => settingsOf(userId)),
		),

		updatePreferences: (preferences) =>
			operation(
				"updatePreferences",
				Effect.gen(function* () {
					const { userId } = yield* CurrentActor.Service;
					const values = {
						level: preferences.level,
						pausedUntil: preferences.pausedUntil
							? DateTime.toDate(DateTime.makeUnsafe(preferences.pausedUntil))
							: null,
						quietHours: preferences.quietHours,
						turnFailures: preferences.turnFailures,
						routineRuns: preferences.routineRuns,
					};
					yield* query((db) =>
						db
							.insert(notificationSettings)
							.values({ userId, ...values })
							.onConflictDoUpdate({ target: notificationSettings.userId, set: values }),
					);
					return yield* settingsOf(userId);
				}),
			),

		setLevel: (place, level) =>
			operation(
				"setLevel",
				Effect.gen(function* () {
					const { userId } = yield* CurrentActor.Service;
					const override = overrideOf(userId, place);
					// Clearing removes only the actor's own choice, so it needs no reach.
					if (level === null) {
						yield* query((db) => db.delete(notificationOverride).where(override.where));
						return;
					}
					yield* requireReachOf(userId, place);
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
					const { userId } = yield* CurrentActor.Service;
					const override = overrideOf(userId, place);
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
					yield* requireReachOf(userId, place);
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
				const { userId } = yield* CurrentActor.Service;
				yield* deliver([
					{
						userId,
						notification: {
							title: "Notifications are on",
							body: "This is how Sugabots will tell you when something needs you.",
							tag: "test",
							path: "/",
							conversationId: null,
						},
					},
				]);
			}),
		),

		reportPresence: (reported) =>
			operation(
				"reportPresence",
				Effect.flatMap(CurrentActor.Service, ({ userId }) =>
					Effect.promise(() =>
						bus.publish(personChannel(userId), streamEvent("presence", reported)),
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
	ConversationEvent,
	{
		_tag:
			| "MessagePosted"
			| "TurnCompleted"
			| "TurnSuspended"
			| "TurnFailed"
			| "RoutineExecutionSettled";
	}
>;

function isNotifying(event: ConversationEvent): event is NotifyingEvent {
	switch (event._tag) {
		case "MessagePosted":
		case "TurnCompleted":
		case "TurnSuspended":
		case "RoutineExecutionSettled":
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
					threadId: event.threadId,
					messageId: event.message.id,
					author:
						author.kind === "person"
							? { kind: "person", userId: author.id }
							: author.kind === "agent"
								? { kind: "bot", agentId: author.id }
								: { kind: "routine" },
					authorName: messageAuthorName(author),
					content: event.message.content,
					fileNames: event.message.parts.flatMap((part) =>
						part.type === "file" ? [part.name] : [],
					),
					repliesTo:
						event.message.replyTo?.author.kind === "person"
							? event.message.replyTo.author.id
							: null,
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
		case "RoutineExecutionSettled":
			return yield* forRoutineRun(db, event, now);
	}
});

/** A pod, or one of its bots, where a person chooses in place of the level above. */
export interface Place {
	kind: NotificationPlaceKind;
	id: string;
}

/** The person's override row for `place`: how to find it, make it, and update it in place. */
function overrideOf(userId: string, place: Place) {
	const column = place.kind === "pod" ? notificationOverride.podId : notificationOverride.agentId;
	return {
		where: and(eq(notificationOverride.userId, userId), eq(column, place.id)),
		row: place.kind === "pod" ? { userId, podId: place.id } : { userId, agentId: place.id },
		conflict: { target: [notificationOverride.userId, column], targetWhere: isNotNull(column) },
	};
}

const requireReachOf = (userId: string, place: Place) =>
	place.kind === "pod"
		? query((db) => podStandingFor(db, place.id, userId)).pipe(
				Effect.flatMap((standing) => requireReach(standing, "pod")),
			)
		: query((db) => agentStandingFor(db, place.id, userId)).pipe(
				Effect.flatMap((standing) => requireReach(standing, "agent")),
			);
