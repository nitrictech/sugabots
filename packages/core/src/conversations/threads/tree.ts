import { type SQLWrapper, sql } from "drizzle-orm";
import { thread } from "../../database/schema.ts";

/**
 * Threads hang off one another: a collaboration or a system agent's thread
 * off the thread it serves. These are the two walks of that tree, as
 * relations to select from.
 */

/**
 * The thread `threadId` and every thread above it, as a relation of
 * `(id, host_agent_id, depth)`: depth 0 is the thread itself, 1 its parent,
 * and so on.
 */
export const lineageOf = (threadId: SQLWrapper) => sql`(
	with recursive lineage as (
		select id, parent_thread_id, host_agent_id, 0 as depth from ${thread} where id = ${threadId}
		union all
		select parent.id, parent.parent_thread_id, parent.host_agent_id, child.depth + 1
		from ${thread} parent
		join lineage child on child.parent_thread_id = parent.id
	)
	select id, host_agent_id, depth from lineage
)`;

/**
 * The thread `rootThreadId` and the collaborations under it, as a relation of
 * `(id)`: where a routine run's work happens. A system agent's thread (the
 * Scribe's summaries) hangs off the thread it serves but is not part of the
 * work, so it and whatever hangs off it are left out.
 */
export const workingThreadsOf = (rootThreadId: SQLWrapper) => sql`(
	with recursive tree as (
		select id from ${thread} where id = ${rootThreadId}
		union all
		select child.id from ${thread} child
		join tree parent on child.parent_thread_id = parent.id
		where child.type <> 'system_agent'
	)
	select id from tree
)`;
