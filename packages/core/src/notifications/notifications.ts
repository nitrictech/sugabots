export * as Notifications from "./notifications.ts";

import {
	memberStream,
	messageAuthorName,
	type NotificationLevel,
	type NotificationPlaceKind,
	type NotificationPreferences,
	type NotificationSettings,
	type Presence,
	streamEvent,
} from "@sugabots/contracts";
import type { UserText } from "@sugabots/errors";
import { and, eq, gt, inArray, isNotNull, isNull, lt, lte, or, type SQL } from "drizzle-orm";
import { Context, DateTime, Duration, Effect, Layer, Schedule } from "effect";
import type { ChatEvent } from "../chats/events.ts";
import {
	afterCommit,
	Database,
	type Executor,
	query,
	serviceOperations,
	transaction,
} from "../database/database.ts";
import { Audience } from "../database/events/audience.ts";
import { EventBus } from "../database/events/bus.ts";
import type { DomainEvents } from "../database/events/domain-events.ts";
import { EventOutbox } from "../database/events/outbox.ts";
import {
	notificationDelivery,
	notificationOverride,
	notificationSettings,
	pendingNotification,
} from "../database/schema.ts";
import type { IsMember } from "../proofs/is-member.ts";
import type { ReachesBot } from "../proofs/reaches-bot.ts";
import type { ReachesProject } from "../proofs/reaches-project.ts";
import { processLayer, Tier } from "../tiers.ts";
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
	mayStillBeTold,
	type WrittenMessage,
} from "./recipients.ts";

/**
 * Browser notifications, as Slack's web app shows them: what each member
 * chose to hear of, sent on their own event stream for their open tabs to
 * show. With no tab open, nothing reaches them. Their tabs also say there
 * which chat each is showing, so none notifies them of what they are
 * reading.
 *
 * What a member chooses is theirs alone: each method on it takes the proof
 * that a member is signed in, and acts for that member.
 */
export interface Interface {
	readonly settings: <P>(isMember: IsMember<P>) => Effect.Effect<NotificationSettings>;
	readonly updatePreferences: <P>(
		isMember: IsMember<P>,
		preferences: NotificationPreferences,
	) => Effect.Effect<NotificationSettings>;
	/** Sets the member's level for a project or bot they reach, which ends its mute. */
	readonly setLevel: <P, X>(
		isMember: IsMember<P>,
		reached: PlaceReached<P, X>,
		level: NotificationLevel,
	) => Effect.Effect<void>;
	/**
	 * Goes back to the level above `place`, which also ends its mute. It
	 * removes only the member's own choice, so it needs no reach.
	 */
	readonly clearLevel: <P>(isMember: IsMember<P>, place: Place) => Effect.Effect<void>;
	/** Mutes a project or bot the member reaches until `until`. */
	readonly mute: <P, X>(
		isMember: IsMember<P>,
		reached: PlaceReached<P, X>,
		until: Date,
	) => Effect.Effect<void>;
	/** Ends the member's mute of `place`, which needs no reach, as clearing a level doesn't. */
	readonly unmute: <P>(isMember: IsMember<P>, place: Place) => Effect.Effect<void>;
	/** Notifies every open tab of the member's, whatever they chose, so they can see it works. */
	readonly sendTest: <P>(isMember: IsMember<P>) => Effect.Effect<void>;
	/** Tells the member's other tabs what one of theirs is looking at. */
	readonly reportPresence: <P>(isMember: IsMember<P>, presence: Presence) => Effect.Effect<void>;
	/**
	 * Notifies members of finished messages and of approvals waiting on them:
	 * records what to send with the change, and sends it once that commits.
	 */
	readonly handler: DomainEvents.Handler<ChatEvent>;
	/** Sends what a process that stopped, or a send that failed, left unsent, while it is still news. */
	readonly sendLeftBehind: Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Notifications") {
	declare readonly [Tier]: "process";
}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("Notifications");
	const bus = yield* EventBus.Service;
	const outbox = yield* EventOutbox.Service;
	// Sending outlives the transaction that asked for it, and must not hold up its commit.
	const sending = yield* Effect.scope;
	const runInBackground = <E>(work: Effect.Effect<void, E, Database>) =>
		operation("handler", work).pipe(
			Effect.catchCause((cause) => Effect.logWarning("Sending notifications failed", cause)),
			Effect.forkIn(sending),
			Effect.asVoid,
		);

	const deliver = (addressed: readonly Addressed[]) =>
		outbox.publish(
			addressed.map(({ memberId, notification }) => ({
				stream: memberStream(memberId),
				event: streamEvent("notification", notification),
			})),
		);

	/**
	 * Sends the unsent deliveries `which` picks for `delivery`'s member if they
	 * may still be told it, and forgets them if not. Marking them sent and
	 * storing their notifications, for the outbox to publish once the
	 * transaction commits, happen in one transaction, so whichever process
	 * marks one sent is the only one to publish it. Each stored notification
	 * names its chat or approval so the member's stream can check its audience
	 * again on replay.
	 */
	const sendIfStillTold = (delivery: DeliveryToSend, which: SQL | undefined) =>
		transaction(
			Effect.gen(function* () {
				const audience = deliveryAudience(delivery);
				const told = yield* query((db) => mayStillBeTold(db, delivery.memberId, audience));
				if (!told) {
					yield* query((db) =>
						db.delete(notificationDelivery).where(and(which, isNull(notificationDelivery.sentAt))),
					);
					return;
				}
				const sentAt = yield* DateTime.nowAsDate;
				const sent = yield* query((db) =>
					db
						.update(notificationDelivery)
						.set({ sentAt })
						.where(and(which, isNull(notificationDelivery.sentAt)))
						.returning({ notification: notificationDelivery.notification }),
				);
				yield* outbox.publish(
					sent.map(({ notification }) => ({
						stream: memberStream(delivery.memberId),
						event: Audience.addressedTo(audience, streamEvent("notification", notification)),
					})),
				);
			}),
		);

	const recordDelivery = (chatId: string, deliveryId: string, addressed: Addressed) =>
		Effect.gen(function* () {
			const [recorded] = yield* query((db) =>
				db
					.insert(notificationDelivery)
					.values({
						chatId,
						deliveryId,
						memberId: addressed.memberId,
						notification: addressed.notification,
						approvalCallId: addressed.approval?.callId,
						approvalId: addressed.approval?.approvalId,
					})
					.onConflictDoNothing()
					.returning({ id: notificationDelivery.deliveryId }),
			);
			if (!recorded) return;
			// On the service's own database: the transaction's Postgres session is
			// another's once it commits.
			yield* afterCommit(
				operation(
					"handler",
					sendIfStillTold(
						{
							...addressed,
							chatId,
							approvalCallId: addressed.approval?.callId ?? null,
							approvalId: addressed.approval?.approvalId ?? null,
						},
						and(
							eq(notificationDelivery.chatId, chatId),
							eq(notificationDelivery.deliveryId, deliveryId),
							eq(notificationDelivery.memberId, addressed.memberId),
						),
					).pipe(
						Effect.catchCause((cause) =>
							Effect.logWarning("Sending a notification failed; the sweep sends it again", cause),
						),
					),
				),
			);
		});

	/**
	 * Records `addressed`, each in a transaction of its own, to send once it
	 * commits. Whether each member may still be told is checked as it is sent.
	 */
	const recordDeliveries = (chatId: string, deliveryId: string, addressed: readonly Addressed[]) =>
		Effect.forEach(addressed, (one) => transaction(recordDelivery(chatId, deliveryId, one)), {
			discard: true,
		});

	/** Sends a pending notification's notifications, then forgets it. */
	const send = (pending: PendingNotification) =>
		Effect.gen(function* () {
			const now = yield* DateTime.nowAsDate;
			const { cause, chatId, deliveryId } = pending;
			const addressed = yield* query((db) =>
				cause.kind === "approval" ? forApprovals(db, cause, now) : notificationsFor(db, cause, now),
			);
			yield* recordDeliveries(chatId, deliveryId, addressed);
			yield* query((db) =>
				db.delete(pendingNotification).where(eq(pendingNotification.id, pending.id)),
			);
		});

	/**
	 * What a process that stopped, or a send that failed, left: pending
	 * notifications that have come due, and notifications recorded but never
	 * sent, while they are still news. Older ones are dropped.
	 */
	const sendLeftBehind = Effect.gen(function* () {
		const now = yield* DateTime.now;
		const stillNews = DateTime.toDateUtc(DateTime.subtractDuration(now, NEWS_FOR));
		yield* query((db) =>
			db.delete(pendingNotification).where(lt(pendingNotification.createdAt, stillNews)),
		);
		// Claimed by moving each on, so another process's sweep skips it.
		const due = yield* query((db) =>
			db
				.update(pendingNotification)
				.set({ dueAt: DateTime.toDateUtc(DateTime.addDuration(now, SEND_GRACE)) })
				.where(
					inArray(
						pendingNotification.id,
						db
							.select({ id: pendingNotification.id })
							.from(pendingNotification)
							.where(lte(pendingNotification.dueAt, DateTime.toDateUtc(now)))
							.limit(SWEEP_BATCH)
							.for("update", { skipLocked: true }),
					),
				)
				.returning(),
		);
		for (const pending of due) {
			yield* send(pending).pipe(
				Effect.catchCause((cause) =>
					Effect.logWarning("Sending a pending notification failed; trying again later", cause),
				),
			);
		}
		const resendingAt = yield* DateTime.now;
		const sendAgainBefore = DateTime.toDateUtc(DateTime.subtractDuration(resendingAt, SEND_GRACE));
		const claimedUntil = DateTime.toDateUtc(DateTime.addDuration(resendingAt, SEND_GRACE));
		// Claimed, so another process's sweep skips each until its claim runs out.
		const unsent = yield* query((db) =>
			db
				.update(notificationDelivery)
				.set({ claimedUntil })
				.where(
					and(
						isNull(notificationDelivery.sentAt),
						lt(notificationDelivery.createdAt, sendAgainBefore),
						gt(notificationDelivery.createdAt, stillNews),
						or(
							isNull(notificationDelivery.claimedUntil),
							lte(notificationDelivery.claimedUntil, DateTime.toDateUtc(resendingAt)),
						),
					),
				)
				.returning(),
		);
		for (const delivery of unsent) {
			yield* sendAgain(delivery, claimedUntil).pipe(
				Effect.catchCause((cause) =>
					Effect.logWarning("Sending a notification again failed; trying again later", cause),
				),
			);
		}
	});

	/**
	 * Sends `delivery`, claimed until `claimedUntil`, to its member's tabs, if
	 * they may still be told it and no other sweep has claimed it since; one
	 * they may no longer be told is forgotten.
	 */
	const sendAgain = (delivery: NotificationDeliveryRow, claimedUntil: Date) =>
		sendIfStillTold(
			delivery,
			and(
				eq(notificationDelivery.chatId, delivery.chatId),
				eq(notificationDelivery.deliveryId, delivery.deliveryId),
				eq(notificationDelivery.memberId, delivery.memberId),
				eq(notificationDelivery.claimedUntil, claimedUntil),
			),
		);

	const settingsOf = (memberId: string) =>
		Effect.gen(function* () {
			const [own] = yield* query((db) =>
				db.select().from(notificationSettings).where(eq(notificationSettings.memberId, memberId)),
			);
			const overrides = yield* query((db) =>
				db.select().from(notificationOverride).where(eq(notificationOverride.memberId, memberId)),
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
		settings: (isMember) => operation("settings", settingsOf(isMember.member)),

		updatePreferences: (isMember, preferences) =>
			operation(
				"updatePreferences",
				Effect.gen(function* () {
					const memberId = isMember.member;
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
							.values({ memberId, ...values })
							.onConflictDoUpdate({ target: notificationSettings.memberId, set: values }),
					);
					return yield* settingsOf(memberId);
				}),
			),

		setLevel: (isMember, reached, level) =>
			operation(
				"setLevel",
				Effect.gen(function* () {
					const override = overrideOf(isMember.member, placeOf(reached));
					yield* query((db) =>
						db
							.insert(notificationOverride)
							.values({ ...override.row, level })
							.onConflictDoUpdate({ ...override.conflict, set: { level, mutedUntil: null } }),
					);
				}),
			),

		clearLevel: (isMember, place) =>
			operation(
				"clearLevel",
				query((db) =>
					db.delete(notificationOverride).where(overrideOf(isMember.member, place).where),
				).pipe(Effect.asVoid),
			),

		mute: (isMember, reached, until) =>
			operation(
				"mute",
				Effect.gen(function* () {
					const override = overrideOf(isMember.member, placeOf(reached));
					yield* query((db) =>
						db
							.insert(notificationOverride)
							.values({ ...override.row, mutedUntil: until })
							.onConflictDoUpdate({ ...override.conflict, set: { mutedUntil: until } }),
					);
				}),
			),

		unmute: (isMember, place) =>
			operation(
				"unmute",
				Effect.gen(function* () {
					const override = overrideOf(isMember.member, place);
					// A row that only held the mute has nothing left to say.
					yield* query((db) =>
						db
							.delete(notificationOverride)
							.where(and(override.where, isNull(notificationOverride.level))),
					);
					yield* query((db) =>
						db.update(notificationOverride).set({ mutedUntil: null }).where(override.where),
					);
				}),
			),

		sendTest: (isMember) =>
			operation(
				"sendTest",
				deliver([
					{
						memberId: isMember.member,
						notification: {
							title: "Notifications are on",
							body: "This is how Sugabots will tell you when something needs you.",
							tag: "test",
							path: "/",
							chatId: null,
						},
					},
				]),
			),

		reportPresence: (isMember, reported) =>
			operation(
				"reportPresence",
				Effect.promise(() =>
					bus.publish(memberStream(isMember.member), streamEvent("presence", reported)),
				),
			),

		handler: (events) =>
			Effect.gen(function* () {
				const now = yield* DateTime.now;
				const dueAt = DateTime.toDateUtc(DateTime.addDuration(now, SEND_GRACE));
				const causes = events.filter(isNotifying).flatMap((event) => {
					const deliveryId = deliveryIdOf(event);
					return deliveryId === undefined
						? []
						: [{ chatId: event.chatId, deliveryId, cause: causeOf(event), dueAt }];
				});
				if (causes.length === 0) return;
				// Written with the change, so its notifications outlive this process.
				const pending = yield* query((db) =>
					db.insert(pendingNotification).values(causes).returning(),
				).pipe(Effect.orDie);
				yield* afterCommit(runInBackground(Effect.forEach(pending, send, { discard: true })));
			}),

		sendLeftBehind: operation("sendLeftBehind", sendLeftBehind),
	});
});

export const layer = processLayer(Layer.effect(Service, make));

type NotificationDeliveryRow = typeof notificationDelivery.$inferSelect;

type DeliveryToSend = Pick<
	NotificationDeliveryRow,
	"chatId" | "memberId" | "notification" | "approvalCallId" | "approvalId"
>;

/** How long the process that wrote a notification has to send it before the sweep does. */
const SEND_GRACE = Duration.seconds(30);

/** How long a notification is still worth sending; past it, one left unsent is dropped. */
const NEWS_FOR = Duration.minutes(10);

/** How often the sweep looks for notifications left unsent. */
const SWEEP_INTERVAL = Duration.seconds(30);

/** How many pending notifications one sweep sends at most. */
const SWEEP_BATCH = 100;

/**
 * Sends the notifications a process that stopped left unsent, every
 * {@link SWEEP_INTERVAL} for as long as the layer's scope is open.
 */
export const sweepLayer = Layer.effectDiscard(
	Effect.gen(function* () {
		const notifications = yield* Service;
		const database = yield* Effect.service(Database);
		yield* Effect.forkScoped(
			notifications.sendLeftBehind.pipe(
				Effect.provideService(Database, database),
				Effect.catchCause((cause) =>
					Effect.logError("Sending notifications left behind failed", cause),
				),
				Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)),
			),
		);
	}),
).pipe(processLayer);

/** What a notifying event says about whom to notify, kept as JSON until its notifications are sent. */
export type NotificationCause =
	| { readonly kind: "message"; readonly written: WrittenMessage }
	| {
			readonly kind: "reply";
			readonly chatId: string;
			readonly turnId: string;
			readonly messageId: string;
			readonly content: string;
	  }
	| {
			readonly kind: "approval";
			readonly workspaceId: string;
			readonly chatId: string;
			readonly turnId: string;
			readonly approvalCallIds: readonly string[];
			readonly approvalIds?: readonly string[];
	  }
	| {
			readonly kind: "failure";
			readonly chatId: string;
			readonly turnId: string;
			readonly messageId: string;
			readonly userMessage: UserText;
	  }
	| { readonly kind: "run"; readonly chatId: string; readonly rootChatId: string };

type PendingNotification = typeof pendingNotification.$inferSelect;

/** What `event` says about whom to notify. */
function causeOf(event: NotifyingEvent): NotificationCause {
	switch (event._tag) {
		case "MessagePosted": {
			const { author } = event.message;
			return {
				kind: "message",
				written: {
					chatId: event.chatId,
					messageId: event.message.id,
					author:
						author.kind === "member"
							? { kind: "member", memberId: author.id }
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
						event.message.replyTo?.author.kind === "member"
							? event.message.replyTo.author.id
							: null,
					resultOf: event.message.automationResultOf ?? null,
				},
			};
		}
		case "TurnCompleted":
			return {
				kind: "reply",
				chatId: event.chatId,
				turnId: event.turnId,
				messageId: event.messageId,
				content: event.content,
			};
		case "TurnSuspended":
			return {
				kind: "approval",
				workspaceId: event.workspaceId,
				chatId: event.chatId,
				turnId: event.turnId,
				approvalCallIds: event.approvalCallIds,
				...(event.approvalIds ? { approvalIds: event.approvalIds } : {}),
			};
		case "TurnFailed":
			return {
				kind: "failure",
				chatId: event.chatId,
				turnId: event.turnId,
				messageId: event.messageId,
				userMessage: event.userMessage,
			};
		case "RunSettled":
			return { kind: "run", chatId: event.chatId, rootChatId: event.rootChatId };
	}
}

type NotifyingEvent = Extract<
	ChatEvent,
	{
		_tag: "MessagePosted" | "TurnCompleted" | "TurnSuspended" | "TurnFailed" | "RunSettled";
	}
>;

function deliveryIdOf(event: NotifyingEvent): string | undefined {
	switch (event._tag) {
		case "MessagePosted":
			return `message:${event.message.id}`;
		case "TurnCompleted":
			return `reply:${event.turnId}`;
		case "TurnSuspended":
			return approvalDeliveryId(event.approvalIds?.[0] ?? event.approvalCallIds[0]);
		case "TurnFailed":
			return `failure:${event.turnId}`;
		case "RunSettled":
			return `run:${event.chatId}`;
	}
}

function approvalDeliveryId(id: string | undefined) {
	return id === undefined ? undefined : `approval:${id}`;
}

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
	cause: Exclude<NotificationCause, { kind: "approval" }>,
	now: Date,
) {
	switch (cause.kind) {
		case "message":
			return yield* forMessage(db, cause.written, now);
		case "reply":
			return yield* forReply(db, cause, now);
		case "failure":
			return yield* forFailedReply(db, cause, now);
		case "run":
			return yield* forAutomationRun(db, cause, now);
	}
});

/**
 * Whom a delivery's notification is for: those who can still decide its
 * approval, or else those who reach the chat it shows or is about.
 */
function deliveryAudience(delivery: DeliveryToSend): Audience.Group {
	const { approvalCallId, approvalId, notification } = delivery;
	return approvalCallId && approvalId
		? {
				kind: "approval",
				toolCall: approvalCallId,
				approval: approvalId,
				showsChat: notification.chatId !== null,
			}
		: { kind: "chat", chat: notification.chatId ?? delivery.chatId };
}

/** A project or a bot, where a member chooses in place of the level above. */
export interface Place {
	kind: NotificationPlaceKind;
	id: string;
}

/**
 * A project or bot the member reaches, as a place: proved reached, so their
 * choice there can be set.
 */
export type PlaceReached<P, X> = ReachesProject<P, X> | ReachesBot<P, X>;

/** The place `reached` is. */
function placeOf<P, X>(reached: PlaceReached<P, X>): Place {
	return reached.kind === "ReachesProject"
		? { kind: "project", id: reached.project.value }
		: { kind: "bot", id: reached.bot.value };
}

/** The member's override row for `place`: how to find it, make it, and update it in place. */
function overrideOf(memberId: string, place: Place) {
	const column =
		place.kind === "project" ? notificationOverride.projectId : notificationOverride.botId;
	return {
		where: and(eq(notificationOverride.memberId, memberId), eq(column, place.id)),
		row:
			place.kind === "project" ? { memberId, projectId: place.id } : { memberId, botId: place.id },
		conflict: { target: [notificationOverride.memberId, column], targetWhere: isNotNull(column) },
	};
}
