import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { isUuid } from "../../database/ids.ts";
import type * as schema from "../../database/schema.ts";
import { thread } from "../../database/schema.ts";
import { reachesPod } from "../../workspaces/access.ts";

/**
 * Returns a thread only when the caller reaches the pod it is in.
 *
 * `reachesPod` is the same rule a direct pod or agent request is decided by,
 * so what a conversation shows, what its live events deliver and what the REST
 * routes allow cannot drift apart. It already requires workspace membership,
 * which is why there is no separate check for it here.
 */
export async function visibleThread(
	db: Pick<NodePgDatabase, "select">,
	threadId: string,
	userId: string,
): Promise<schema.ThreadRow | undefined> {
	if (!isUuid(threadId)) {
		return undefined;
	}

	const [row] = await db
		.select({ thread })
		.from(thread)
		.where(and(eq(thread.id, threadId), reachesPod(thread.podId, userId)))
		.limit(1);

	return row?.thread;
}
