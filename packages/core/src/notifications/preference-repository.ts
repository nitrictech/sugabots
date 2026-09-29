export * as NotificationPreferenceRepository from "./preference-repository.ts";

import {
	type NotificationKind,
	type NotificationKindPreferences,
	notificationKinds,
} from "@sugabots/contracts";
import { and, eq, inArray } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { query, serviceOperations } from "../database/database.ts";
import { notificationPreference } from "../database/schema.ts";

/**
 * The only writer of `notification_preference`: what each person chose to be
 * told about. A kind somebody has not chosen for reads as its `defaultOn`.
 */
export interface Interface {
	/** Whether `userId` hears about each kind. */
	readonly forUser: (userId: string) => Effect.Effect<NotificationKindPreferences>;
	/** Records whether `userId` hears about `kind`. */
	readonly set: (userId: string, kind: NotificationKind, enabled: boolean) => Effect.Effect<void>;
	/** Those of `userIds` who hear about `kind`, in the order given. */
	readonly whoWant: (
		kind: NotificationKind,
		userIds: readonly string[],
	) => Effect.Effect<readonly string[]>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/NotificationPreferenceRepository",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("NotificationPreferenceRepository");
	return Service.of({
		forUser: (userId) =>
			operation(
				"forUser",
				Effect.gen(function* () {
					const rows = yield* query((db) =>
						db
							.select({
								kind: notificationPreference.kind,
								enabled: notificationPreference.enabled,
							})
							.from(notificationPreference)
							.where(eq(notificationPreference.userId, userId)),
					);
					const chosen = new Map(rows.map(({ kind, enabled }) => [kind, enabled]));
					return Object.fromEntries(
						Object.entries(notificationKinds).map(([kind, { defaultOn }]) => [
							kind,
							chosen.get(kind as NotificationKind) ?? defaultOn,
						]),
					) as NotificationKindPreferences;
				}),
			),

		set: (userId, kind, enabled) =>
			operation(
				"set",
				query((db) =>
					db
						.insert(notificationPreference)
						.values({ userId, kind, enabled })
						.onConflictDoUpdate({
							target: [notificationPreference.userId, notificationPreference.kind],
							set: { enabled },
						}),
				).pipe(Effect.asVoid),
			),

		whoWant: (kind, userIds) =>
			operation(
				"whoWant",
				Effect.gen(function* () {
					if (userIds.length === 0) return [];
					const rows = yield* query((db) =>
						db
							.select({
								userId: notificationPreference.userId,
								enabled: notificationPreference.enabled,
							})
							.from(notificationPreference)
							.where(
								and(
									eq(notificationPreference.kind, kind),
									inArray(notificationPreference.userId, [...userIds]),
								),
							),
					);
					const chosen = new Map(rows.map(({ userId, enabled }) => [userId, enabled]));
					const { defaultOn } = notificationKinds[kind];
					return userIds.filter((userId) => chosen.get(userId) ?? defaultOn);
				}),
			),
	});
});

export const layer = Layer.effect(Service, make);
