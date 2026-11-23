import { type SQLWrapper, sql } from "drizzle-orm";
import { chat, collaboration, placedChat } from "../../database/schema.ts";

/**
 * Chats hang off one another: a collaboration off the chat it
 * was asked from, and a system bot's chat off the one it serves.
 * These are the two walks of that tree, as relations to select from.
 */

/**
 * The chat `chatId` and every chat above it, as a
 * relation of `(id, depth)`: depth 0 is the chat itself, 1
 * its parent, and so on.
 */
export const lineageOf = (chatId: SQLWrapper) => sql`(
	with recursive lineage as (
		select id, parent_chat_id, 0 as depth
		from ${placedChat} where id = ${chatId}
		union all
		select parent.id, parent.parent_chat_id, child.depth + 1
		from ${placedChat} parent
		join lineage child on child.parent_chat_id = parent.id
	)
	select id, depth from lineage
)`;

/**
 * The chat `rootChatId` and the collaborations under it, as a
 * relation of `(id)`: where an automation run's work happens. A system bot's
 * chat (the Compaction bot's) hangs off the one it serves but is
 * not part of the work, so it and whatever hangs off it are left out.
 */
export const workingChatsOf = (rootChatId: SQLWrapper) => sql`(
	with recursive tree as (
		select id from ${chat} where id = ${rootChatId}
		union all
		select asked.chat_id from ${collaboration} asked
		join tree parent on asked.parent_chat_id = parent.id
	)
	select id from tree
)`;
