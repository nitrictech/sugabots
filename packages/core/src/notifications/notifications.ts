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
import { and, eq, gt, inArray, isNotNull, isNull, lt, lte, or, type SQL, sql } from "drizzle-orm";
import { Context, DateTime, Duration, Effect, Layer, Schedule } from "effect";
import { reachesChatFor } from "../authorization/access.ts";
import type { ChatEvent } from "../chats/events.ts";
import {
	afterCommit,
	Database,
	type Executor,
	query,
	serviceOperations,
	Transaction,
	transaction,
} from "../database/database.ts";
import { EventBus } from "../database/events/bus.ts";
import type { DomainEvents } from "../database/events/domain-events.ts";
import { EventOutbox } from "../database/events/outbox.ts";
import {
	member,
	membership,
	notificationDelivery,
	notificationOverride,
	notificationSettings,
	pendingNotification,
	placedChat,
	workspace,
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
	 * Records the deliveries `which` picks sent, if none is yet, and stores
	 * their notifications in the same transaction, so whichever process marks
	 * one sent is the only one to publish it. The outbox publishes them once
	 * the transaction commits.
	 */
	const markSentAndDeliver = (which: SQL | undefined) =>
		transaction(
			Effect.gen(function* () {
				const sentAt = yield* DateTime.nowAsDate;
				const sent = yield* query((db) =>
					db
						.update(notificationDelivery)
						.set({ sentAt })
						.where(and(which, isNull(notificationDelivery.sentAt)))
						.returning({
							memberId: notificationDelivery.memberId,
							notification: notificationDelivery.notification,
						}),
				);
				yield* deliver(sent);
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
					markSentAndDeliver(
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

	const deliverAbout = (chatId: string, deliveryId: string, addressed: readonly Addressed[]) =>
		Effect.forEach(
			addressed,
			(one) =>
				transaction(
					Effect.gen(function* () {
						if (yield* reachesChatUnderLock(chatId, one.memberId)) {
							yield* recordDelivery(chatId, deliveryId, one);
						}
					}),
				),
			{ discard: true },
		);

	const deliverApproval = (
		waiting: Extract<NotificationCause, { kind: "approval" }>,
		deliveryId: string,
		now: Date,
	) =>
		transaction(
			Effect.gen(function* () {
				yield* shareWorkspaceLock(waiting.workspaceId);
				const addressed = yield* query((db) => forApprovals(db, waiting, now));
				for (const recipient of addressed)
					yield* recordDelivery(waiting.chatId, deliveryId, recipient);
			}),
		);

	/** Sends a pending notification's notifications, then forgets it. */
	const send = (pending: PendingNotification) =>
		Effect.gen(function* () {
			const now = yield* DateTime.nowAsDate;
			const { cause, chatId, deliveryId } = pending;
			if (cause.kind === "approval") {
				yield* deliverApproval(cause, deliveryId, now);
			} else {
				const addressed = yield* query((db) => notificationsFor(db, cause, now));
				yield* deliverAbout(chatId, deliveryId, addressed);
			}
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
		transaction(
			Effect.gen(function* () {
				const ours = and(
					eq(notificationDelivery.chatId, delivery.chatId),
					eq(notificationDelivery.deliveryId, delivery.deliveryId),
					eq(notificationDelivery.memberId, delivery.memberId),
					eq(notificationDelivery.claimedUntil, claimedUntil),
				);
				if (yield* mayStillBeTold(delivery)) {
					yield* markSentAndDeliver(ours);
				} else {
					yield* query((db) =>
						db.delete(notificationDelivery).where(and(ours, isNull(notificationDelivery.sentAt))),
					);
				}
			}),
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

const shareWorkspaceLock = (workspaceId: string) =>
	query((db) =>
		db
			.select({ id: workspace.id })
			.from(workspace)
			.where(eq(workspace.id, workspaceId))
			.for("share"),
	);

/**
 * Whether `memberId` reaches the chat `chatId`, read once a share of its
 * workspace's lock (see `HoldsWorkspaceLock` in `proofs/`) is held until the
 * enclosing transaction ends, so no change to who reaches what commits until
 * then.
 */
const reachesChatUnderLock = (chatId: string, memberId: string) =>
	Effect.gen(function* () {
		yield* Transaction;
		const [placed] = yield* query((db) =>
			db
				.select({ workspaceId: placedChat.workspaceId, projectId: placedChat.projectId })
				.from(placedChat)
				.where(eq(placedChat.id, chatId))
				.limit(1),
		);
		if (!placed?.projectId) return false;
		const { projectId } = placed;
		yield* shareWorkspaceLock(placed.workspaceId);
		// A statement of its own, so it reads what a change that held the lock committed.
		const [reaching] = yield* query((db) =>
			db
				.select({ id: member.id })
				.from(member)
				.where(
					and(
						eq(member.id, memberId),
						reachesChatFor({ projectId: sql`${projectId}::uuid` }, member.id),
					),
				)
				.limit(1),
		);
		return reaching !== undefined;
	});

/**
 * Whether the member `delivery` is for may still be told it: they reach the
 * chat it shows, or, for one that shows none, such as an approval asked of a
 * computer's project's manager, are still in the workspace of the chat it is
 * about. Read under a share of the workspace's lock, as {@link reachesChatUnderLock}.
 */
const mayStillBeTold = (delivery: NotificationDeliveryRow) =>
	Effect.gen(function* () {
		const { memberId, notification } = delivery;
		if (notification.chatId) return yield* reachesChatUnderLock(notification.chatId, memberId);
		const [placed] = yield* query((db) =>
			db
				.select({ workspaceId: placedChat.workspaceId })
				.from(placedChat)
				.where(eq(placedChat.id, delivery.chatId))
				.limit(1),
		);
		if (!placed) return false;
		yield* shareWorkspaceLock(placed.workspaceId);
		const [inWorkspace] = yield* query((db) =>
			db
				.select({ id: membership.id })
				.from(membership)
				.where(
					and(eq(membership.workspaceId, placed.workspaceId), eq(membership.memberId, memberId)),
				)
				.limit(1),
		);
		return inWorkspace !== undefined;
	});

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
