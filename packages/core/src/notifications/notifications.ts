export * as Notifications from "./notifications.ts";

import {
	type ApnsEnvironment,
	messageAuthorName,
	type NotificationContent,
	type NotificationLevel,
	type NotificationPlaceKind,
	type NotificationPreferences,
	type NotificationSettings,
	type Presence,
	type PushDevice,
	type PushRegistration,
	type PushService,
	personChannel,
	streamEvent,
} from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { and, eq, gt, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { Context, Data, DateTime, Effect, Layer } from "effect";
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
	transaction,
} from "../database/database.ts";
import { EventBus } from "../database/events/bus.ts";
import type { DomainEvents } from "../database/events/domain-events.ts";
import { notificationOverride, notificationSettings, session } from "../database/schema.ts";
import { Push } from "../push/push.ts";
import type { UserFacing } from "../user-message.ts";
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
 * Notifications, as Slack shows them: what each person chose to hear of, sent
 * on their own event channel for their open tabs to show, and pushed to the
 * phones they are signed in on and turned them on for, which show them while
 * the app is closed.
 * Their tabs also say on that channel which conversation each is showing, so
 * none notifies them of what they are reading.
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
	/** Notifies every open tab and phone of the actor's, whatever they chose, so they can see it works. */
	readonly sendTest: Effect.Effect<void, never, CurrentActor.Service>;
	/** Tells the actor's other tabs what one of theirs is looking at. */
	readonly reportPresence: (presence: Presence) => Effect.Effect<void, never, CurrentActor.Service>;
	/**
	 * Notifies the actor on `device` while the app is closed, for as long as
	 * their session `sessionId` lasts, taking the phone from any session that
	 * had it before. Keeps nothing when this installation can't push to the
	 * phone's platform, and refuses a token its push service refuses.
	 *
	 * Once the service has taken the token, the session lasts at least
	 * `PHONE_SESSION_LIFETIME` from now, though never past
	 * `PHONE_SESSION_LIMIT` from signing in: a phone shows notifications
	 * without the app being opened, and would otherwise stop when a browser's
	 * session would. The service is asked only about a token the session
	 * doesn't already hold, so registering again on each launch costs no push.
	 */
	readonly registerDevice: (
		sessionId: string,
		device: PushDevice,
	) => Effect.Effect<PushRegistration, PushDeviceRefused, CurrentActor.Service>;
	/** Stops notifying the actor on the phone their session `sessionId` is signed in on. */
	readonly unregisterDevice: (
		sessionId: string,
	) => Effect.Effect<void, never, CurrentActor.Service>;
	/** Notifies people of finished messages and of approvals waiting on them, once they commit. */
	readonly handler: DomainEvents.Handler<ConversationEvent>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/Notifications",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("Notifications");
	const bus = yield* EventBus.Service;
	const push = yield* Push.Service;
	// Sending outlives the transaction that asked for it, and must not hold up its commit.
	const sending = yield* Effect.scope;
	const runInBackground = <E>(work: Effect.Effect<void, E, Database>) =>
		operation("handler", work).pipe(
			Effect.catchCause((cause) => Effect.logWarning("Sending notifications failed", cause)),
			Effect.forkIn(sending),
			Effect.asVoid,
		);

	/** Pushes `notification` to the phone session `sessionId` is signed in on, forgetting it once its app is gone. */
	const pushTo = (sessionId: string, device: PushDevice, notification: NotificationContent) =>
		push.send(device, notification).pipe(
			Effect.catchTags({
				// By session and token, so a phone registered again since keeps its new registration.
				PushDeviceGone: () =>
					query((db) =>
						db
							.update(session)
							.set(NO_PUSH_DEVICE)
							.where(and(eq(session.id, sessionId), eq(session.pushToken, device.token))),
					),
				// Kept: a token the service checked when it was registered is refused for a reason of ours.
				PushTokenRefused: (refusal) =>
					Effect.logError(
						"A push service refused a token it had taken; check APNS_TOPIC and the build's environment",
						refusal,
					),
				PushDeliveryFailed: (failure) =>
					Effect.logWarning("Pushing a notification failed", failure),
			}),
		);

	const deliver = (addressed: readonly Addressed[]) =>
		Effect.gen(function* () {
			yield* Effect.forEach(
				addressed,
				({ userId, notification }) =>
					Effect.promise(() =>
						bus.publish(personChannel(userId), streamEvent("notification", notification)),
					),
				{ discard: true },
			);
			const userIds = [...new Set(addressed.map(({ userId }) => userId))];
			if (userIds.length === 0) return;
			const now = yield* DateTime.nowAsDate;
			const devices = yield* query((db) =>
				db
					.select({
						sessionId: session.id,
						userId: session.userId,
						service: session.pushService,
						token: session.pushToken,
						environment: session.pushEnvironment,
					})
					.from(session)
					.where(
						and(
							inArray(session.userId, userIds),
							isNotNull(session.pushToken),
							gt(session.expiresAt, now),
						),
					),
			);
			const pushes = addressed.flatMap(({ userId, notification }) =>
				devices.flatMap((row) => {
					const device = row.userId === userId ? pushDeviceOf(row) : undefined;
					return device ? [pushTo(row.sessionId, device, notification)] : [];
				}),
			);
			yield* Effect.all(pushes, { concurrency: PUSH_CONCURRENCY, discard: true });
		});

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

		registerDevice: (sessionId, device) =>
			operation(
				"registerDevice",
				Effect.gen(function* () {
					const { userId } = yield* CurrentActor.Service;
					if (!push.reaches(device.service)) return { available: false };
					const [held] = yield* query((db) =>
						db
							.select({
								service: session.pushService,
								token: session.pushToken,
								environment: session.pushEnvironment,
							})
							.from(session)
							.where(and(eq(session.id, sessionId), eq(session.userId, userId))),
					);
					// Checked when it was first registered, or kept through an outage; `PHONE_SESSION_LIMIT` bounds either.
					const alreadyHeld = held !== undefined && sameDevice(pushDeviceOf(held), device);
					const checked =
						alreadyHeld ||
						(yield* push.check(device).pipe(
							Effect.as(true),
							Effect.catchTags({
								PushDeviceGone: (gone) =>
									Effect.fail(new PushDeviceRefused({ reason: gone.reason })),
								PushTokenRefused: (refusal) =>
									Effect.fail(new PushDeviceRefused({ reason: refusal.reason })),
								// Kept unchecked, and the session not lengthened, until a later launch checks it.
								PushDeliveryFailed: (failure) =>
									Effect.logWarning("Checking a phone's push token failed", failure).pipe(
										Effect.as(false),
									),
							}),
						));
					const lastsUntil = DateTime.toDate(
						DateTime.add(yield* DateTime.now, PHONE_SESSION_LIFETIME),
					);
					const limit = sql`${session.createdAt} + make_interval(days => ${PHONE_SESSION_LIMIT.days})`;
					yield* transaction(
						Effect.gen(function* () {
							// One registration of a token at a time, or two sessions taking it at once both find it free.
							yield* query((db) =>
								db.execute(
									sql`select pg_advisory_xact_lock(hashtextextended(${`push-token:${device.token}`}, 0))`,
								),
							);
							// A session left behind on the phone, by a sign-out that never reached here, stops notifying.
							yield* query((db) =>
								db
									.update(session)
									.set(NO_PUSH_DEVICE)
									.where(and(eq(session.pushToken, device.token), ne(session.id, sessionId))),
							);
							yield* query((db) =>
								db
									.update(session)
									.set({
										pushService: device.service,
										pushToken: device.token,
										pushEnvironment: device.service === "apns" ? device.environment : null,
										// Only for a token its service took, so a made-up one can't lengthen a session.
										// Never shortened: better-auth renews only a session with six days or less left.
										...(checked
											? {
													expiresAt: sql`greatest(${session.expiresAt}, least(${limit}, ${lastsUntil}))`,
												}
											: {}),
									})
									.where(and(eq(session.id, sessionId), eq(session.userId, userId))),
							);
						}),
					);
					return { available: true };
				}),
			),

		unregisterDevice: (sessionId) =>
			operation(
				"unregisterDevice",
				Effect.gen(function* () {
					const { userId } = yield* CurrentActor.Service;
					yield* query((db) =>
						db
							.update(session)
							.set(NO_PUSH_DEVICE)
							.where(and(eq(session.id, sessionId), eq(session.userId, userId))),
					);
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

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide(Push.layer));

const NO_PUSH_DEVICE = { pushService: null, pushToken: null, pushEnvironment: null };

/**
 * How long a session registered from a phone lasts, renewed each time the
 * app registers. A browser's lasts better-auth's week.
 */
const PHONE_SESSION_LIFETIME = { days: 60 };

/**
 * The furthest from signing in that registering lengthens a session to. The
 * server can't tell the app from a script holding a stolen session and some
 * real token, so this bounds how long registering keeps such a session alive.
 */
const PHONE_SESSION_LIMIT = { days: 90 };

/** The phone a session's columns describe, if they describe a whole one. */
function pushDeviceOf({
	service,
	token,
	environment,
}: {
	service: PushService | null;
	token: string | null;
	environment: ApnsEnvironment | null;
}): PushDevice | undefined {
	if (!token) return undefined;
	if (service === "apns" && environment) return { service, token, environment };
	if (service === "fcm") return { service, token };
	return undefined;
}

function sameDevice(held: PushDevice | undefined, device: PushDevice): boolean {
	return (
		held?.service === device.service &&
		held.token === device.token &&
		(held.service !== "apns" ||
			device.service !== "apns" ||
			held.environment === device.environment)
	);
}

/** The phone's push service refused its token: made up, for another app, or for the build's other environment. */
export class PushDeviceRefused
	extends Data.TaggedError("PushDeviceRefused")<{ readonly reason: string }>
	implements UserFacing
{
	override get message() {
		return `The push service refused the token: ${this.reason}`;
	}
	get userMessage() {
		return userText`This build of the app can't be notified by this server.`;
	}
}

/** How many pushes are in flight at once, over the one connection to Apple. */
const PUSH_CONCURRENCY = 16;

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
					artifactTitles: event.message.parts.flatMap((part) =>
						part.type === "artifact" ? [part.title] : [],
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
