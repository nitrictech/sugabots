export * as NotificationDeliveryRepository from "./delivery-repository.ts";

import {
	defaultNotificationDelivery,
	type NotificationDelivery,
	type UpdateNotificationDelivery,
} from "@sugabots/contracts";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { query, serviceOperations, writtenRow } from "../database/database.ts";
import { notificationDelivery } from "../database/schema.ts";

/**
 * The only writer of `notification_delivery`: how each person chose to be
 * told. Somebody who has chosen nothing reads as `defaultNotificationDelivery`.
 */
export interface Interface {
	/** How `userId` is told. */
	readonly forUser: (userId: string) => Effect.Effect<NotificationDelivery>;
	/** Records the settings in `change` for `userId`, and returns them all. */
	readonly set: (
		userId: string,
		change: UpdateNotificationDelivery,
	) => Effect.Effect<NotificationDelivery>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/NotificationDeliveryRepository",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("NotificationDeliveryRepository");
	const forUser = (userId: string) =>
		Effect.map(
			query((db) =>
				db
					.select(deliveryColumns)
					.from(notificationDelivery)
					.where(eq(notificationDelivery.userId, userId))
					.limit(1),
			),
			([chosen]): NotificationDelivery => chosen ?? defaultNotificationDelivery,
		);

	return Service.of({
		forUser: (userId) => operation("forUser", forUser(userId)),

		set: (userId, change) =>
			operation(
				"set",
				Effect.gen(function* () {
					const changed = Object.fromEntries(
						Object.entries(change).filter(([, value]) => value !== undefined),
					) as UpdateNotificationDelivery;
					if (Object.keys(changed).length === 0) return yield* forUser(userId);
					return yield* query((db) =>
						db
							.insert(notificationDelivery)
							.values({ userId, ...defaultNotificationDelivery, ...changed })
							.onConflictDoUpdate({ target: notificationDelivery.userId, set: changed })
							.returning(deliveryColumns),
					).pipe(Effect.flatMap(writtenRow("notification_delivery")));
				}),
			),
	});
});

export const layer = Layer.effect(Service, make);

const deliveryColumns = {
	desktop: notificationDelivery.desktop,
	quietOnWeekends: notificationDelivery.quietOnWeekends,
};
