import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import type { Executor } from "../../database/database.ts";
import { thread } from "../../database/schema.ts";
import { isUuid } from "../../ids/ids.ts";
import { reachesPod } from "../../workspaces/access.ts";

/**
 * Returns a thread only when the caller reaches the pod it is in.
 *
 * `reachesPod` is the same rule a direct pod or agent request is decided by,
 * so what a conversation shows, what its live events deliver and what the REST
 * routes allow cannot drift apart. It already requires workspace membership,
 * which is why there is no separate check for it here.
 */
export const visibleThread = Effect.fn("ThreadVisibility.visibleThread")(function* (
	db: Executor,
	threadId: string,
	userId: string,
) {
	if (!isUuid(threadId)) {
		return undefined;
	}

	const [row] = yield* db
		.select({ thread })
		.from(thread)
		.where(and(eq(thread.id, threadId), reachesPod(thread.podId, userId)))
		.limit(1);

	return row?.thread;
});
