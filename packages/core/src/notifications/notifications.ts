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
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { Context, DateTime, Effect, Layer } from "effect";
import { reachesChatFor } from "../authorization/access.ts";
import type { ChatEvent } from "../chats/events.ts";
import {
	afterCommit,
	type Database,
	type Executor,
	query,
	serviceOperations,
	Transaction,
	transaction,
} from "../database/database.ts";
import { EventBus } from "../database/events/bus.ts";
import type { DomainEvents } from "../database/events/domain-events.ts";
import {
	member,
	notificationDelivery,
	notificationOverride,
	notificationSettings,
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
	/** Notifies members of finished messages and of approvals waiting on them, once they commit. */
	readonly handler: DomainEvents.Handler<ChatEvent>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Notifications") {
	declare readonly [Tier]: "process";
}

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
			({ memberId, notification }) =>
				Effect.promise(() =>
					bus.publish(memberStream(memberId), streamEvent("notification", notification)),
				),
			{ discard: true },
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
			if (recorded) yield* afterCommit(deliver([addressed]));
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
		event: Extract<ChatEvent, { _tag: "TurnSuspended" }>,
		deliveryId: string,
		now: Date,
	) =>
		transaction(
			Effect.gen(function* () {
				yield* shareWorkspaceLock(event.workspaceId);
				const addressed = yield* query((db) => forApprovals(db, event, now));
				for (const recipient of addressed)
					yield* recordDelivery(event.chatId, deliveryId, recipient);
			}),
		);

	const notifyOf = (events: ReadonlyArray<NotifyingEvent>) =>
		Effect.gen(function* () {
			const now = yield* DateTime.nowAsDate;
			for (const event of events) {
				const deliveryId = deliveryIdOf(event);
				if (deliveryId === undefined) continue;
				if (event._tag === "TurnSuspended") {
					yield* deliverApproval(event, deliveryId, now);
					continue;
				}
				const addressed = yield* query((db) => notificationsFor(db, event, now));
				yield* deliverAbout(event.chatId, deliveryId, addressed);
			}
		});

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

		handler: (events) => {
			const notifying = events.filter(isNotifying);
			return notifying.length === 0
				? Effect.void
				: afterCommit(runInBackground(notifyOf(notifying)));
		},
	});
});

export const layer = processLayer(Layer.effect(Service, make));

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
	event: Exclude<NotifyingEvent, { _tag: "TurnSuspended" }>,
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
				now,
			);
		}
		case "TurnCompleted":
			return yield* forReply(db, event, now);
		case "TurnFailed":
			return yield* forFailedReply(db, event, now);
		case "RunSettled":
			return yield* forAutomationRun(db, event, now);
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
