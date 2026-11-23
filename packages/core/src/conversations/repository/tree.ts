import { type SQLWrapper, sql } from "drizzle-orm";
import { collaboration, conversation, placedConversation } from "../../database/schema.ts";

/**
 * Conversations hang off one another: a collaboration off the conversation it
 * was asked from, and a system bot's conversation off the one it serves.
 * These are the two walks of that tree, as relations to select from.
 */

/**
 * The conversation `conversationId` and every conversation above it, as a
 * relation of `(id, depth)`: depth 0 is the conversation itself, 1
 * its parent, and so on.
 */
export const lineageOf = (conversationId: SQLWrapper) => sql`(
	with recursive lineage as (
		select id, parent_conversation_id, 0 as depth
		from ${placedConversation} where id = ${conversationId}
		union all
		select parent.id, parent.parent_conversation_id, child.depth + 1
		from ${placedConversation} parent
		join lineage child on child.parent_conversation_id = parent.id
	)
	select id, depth from lineage
)`;

/**
 * The conversation `rootConversationId` and the collaborations under it, as a
 * relation of `(id)`: where an automation run's work happens. A system bot's
 * conversation (the Compaction bot's) hangs off the one it serves but is
 * not part of the work, so it and whatever hangs off it are left out.
 */
export const workingConversationsOf = (rootConversationId: SQLWrapper) => sql`(
	with recursive tree as (
		select id from ${conversation} where id = ${rootConversationId}
		union all
		select asked.conversation_id from ${collaboration} asked
		join tree parent on asked.parent_conversation_id = parent.id
	)
	select id from tree
)`;
