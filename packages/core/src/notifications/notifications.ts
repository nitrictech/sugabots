export * as Notifications from "./notifications.ts";

import {
	memberChannel,
	type NotificationPreferences,
	streamEvent,
	type UpdateNotificationDelivery,
	type UpdateNotificationPreference,
} from "@sugabots/contracts";
import { Context, Effect, Layer } from "effect";
import { CurrentActor } from "../authorization/current-actor.ts";
import type { ConversationEvent } from "../conversations/events.ts";
import { serviceOperations, transaction } from "../database/database.ts";
import type { DomainEvents } from "../database/events/domain-events.ts";
import { EventOutbox } from "../database/events/outbox.ts";
import { PodAudience } from "../database/events/pod-audience.ts";
import { NotificationDeliveryRepository } from "./delivery-repository.ts";
import { type Notice, noticeFor } from "./notices.ts";
import { NotificationPreferenceRepository } from "./preference-repository.ts";
import { NotificationRepository } from "./repository.ts";

/**
 * Telling people what needs them or has happened, the way they chose.
 *
 * `handler` turns conversation events into notices, inside the transaction
 * that emitted them, and each notice is stored for and published to the people
 * it is for. Being told is never worth losing the change it is about, so a
 * notice that cannot be worked out or stored is logged and skipped.
 */
export interface Interface {
	/** What the current actor hears about, and how. */
	readonly preferences: Effect.Effect<NotificationPreferences, never, CurrentActor.Service>;
	/** Records whether the current actor hears about a kind, and returns all their preferences. */
	readonly setPreference: (
		input: UpdateNotificationPreference,
	) => Effect.Effect<NotificationPreferences, never, CurrentActor.Service>;
	/** Records how the current actor is told, and returns all their preferences. */
	readonly setDelivery: (
		change: UpdateNotificationDelivery,
	) => Effect.Effect<NotificationPreferences, never, CurrentActor.Service>;
	readonly handler: DomainEvents.Handler<ConversationEvent>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/Notifications",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("Notifications");
	const outbox = yield* EventOutbox.Service;
	const notifications = yield* NotificationRepository.Service;
	const preferences = yield* NotificationPreferenceRepository.Service;
	const delivery = yield* NotificationDeliveryRepository.Service;

	const preferencesOf = (userId: string) =>
		Effect.all({ kinds: preferences.forUser(userId), delivery: delivery.forUser(userId) });

	/** Tells the people `notice` is for who want to hear about its kind. */
	const tell = (notice: Notice) =>
		Effect.gen(function* () {
			const candidates = [...new Set(notice.recipients)].filter(
				(userId) => userId !== notice.actorUserId,
			);
			const recipients = yield* preferences.whoWant(notice.subject.kind, candidates);
			const told = yield* notifications.insert({
				workspaceId: notice.workspaceId,
				userIds: recipients,
				subject: notice.subject,
			});
			if (told.length === 0) return;
			// Tagged with the pod, so somebody who stopped reaching it before the
			// stream delivers the notice does not hear about it.
			yield* outbox.publish(
				told.map(({ userId, notification }) => ({
					channel: memberChannel(notice.workspaceId, userId),
					event: PodAudience.forPod(
						notice.podId,
						streamEvent("notification.created", { notification }),
					),
				})),
			);
		});

	return Service.of({
		preferences: operation(
			"preferences",
			Effect.flatMap(CurrentActor.Service, ({ userId }) => preferencesOf(userId)),
		),

		setPreference: ({ kind, enabled }) =>
			operation(
				"setPreference",
				Effect.gen(function* () {
					const { userId } = yield* CurrentActor.Service;
					yield* preferences.set(userId, kind, enabled);
					return yield* preferencesOf(userId);
				}),
			),

		setDelivery: (change) =>
			operation(
				"setDelivery",
				Effect.gen(function* () {
					const { userId } = yield* CurrentActor.Service;
					yield* delivery.set(userId, change);
					return yield* preferencesOf(userId);
				}),
			),

		handler: (events) =>
			Effect.forEach(
				events,
				(event) =>
					// A savepoint, so a notice that fails leaves nothing of itself behind.
					transaction(
						Effect.flatMap(noticeFor(event), (notice) => (notice ? tell(notice) : Effect.void)),
					).pipe(
						Effect.catchCause((cause) =>
							Effect.logWarning(`Could not notify anyone of ${event._tag}`, cause),
						),
					),
				{ discard: true },
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([
		NotificationRepository.layer,
		NotificationPreferenceRepository.layer,
		NotificationDeliveryRepository.layer,
	]),
);
