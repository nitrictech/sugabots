export * as ThreadReadRepository from "./read-repository.ts";

import { and, eq, lt, max, ne } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { query, serviceOperations } from "../../database/database.ts";
import { message, threadRead } from "../../database/schema.ts";

/** The only writer of `thread_read`: how far each person has read each thread. */
export interface Interface {
	/**
	 * Records that `userId` has read the thread `threadId` up to its newest
	 * finished message, and returns whether that moved them on. A reply still
	 * streaming is not yet read, so it is news once it is done. Never moves
	 * anyone back.
	 */
	readonly markRead: (userId: string, threadId: string) => Effect.Effect<boolean>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/ThreadReadRepository",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ThreadReadRepository");
	return Service.of({
		markRead: (userId, threadId) =>
			operation(
				"markRead",
				Effect.gen(function* () {
					// The newest message's own time rather than this server's clock, so
					// one written in the same instant is not counted as read.
					const [newest] = yield* query((db) =>
						db
							.select({ at: max(message.createdAt) })
							.from(message)
							.where(and(eq(message.threadId, threadId), ne(message.status, "streaming"))),
					);
					const readThrough = newest?.at;
					if (!readThrough) return false;
					const moved = yield* query((db) =>
						db
							.insert(threadRead)
							.values({ userId, threadId, readThrough })
							.onConflictDoUpdate({
								target: [threadRead.userId, threadRead.threadId],
								set: { readThrough },
								setWhere: lt(threadRead.readThrough, readThrough),
							})
							.returning({ id: threadRead.id }),
					);
					return moved.length > 0;
				}),
			),
	});
});

export const layer = Layer.effect(Service, make);
