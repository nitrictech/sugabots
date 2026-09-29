export * as NotificationRepository from "./repository.ts";

import type { Notification, NotificationSubject } from "@sugabots/contracts";
import { Context, Effect, Layer } from "effect";
import { query, serviceOperations } from "../database/database.ts";
import { type NotificationRow, notification } from "../database/schema.ts";

/** The only writer of `notification`: what each person has been told. */
export interface Interface {
	/** Tells each of `userIds`, members of the workspace `workspaceId`, about `subject`. */
	readonly insert: (input: {
		workspaceId: string;
		userIds: readonly string[];
		subject: NotificationSubject;
	}) => Effect.Effect<ReadonlyArray<{ userId: string; notification: Notification }>>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/NotificationRepository",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("NotificationRepository");
	return Service.of({
		insert: ({ workspaceId, userIds, subject }) =>
			operation(
				"insert",
				Effect.gen(function* () {
					if (userIds.length === 0) return [];
					const rows = yield* query((db) =>
						db
							.insert(notification)
							.values(
								userIds.map((userId) => ({ workspaceId, userId, kind: subject.kind, subject })),
							)
							.returning(),
					);
					return rows.map((row) => ({ userId: row.userId, notification: toNotification(row) }));
				}),
			),
	});
});

export const layer = Layer.effect(Service, make);

function toNotification(row: NotificationRow): Notification {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		subject: row.subject,
		createdAt: row.createdAt.toISOString(),
	};
}
