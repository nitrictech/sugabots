import type { ConversationKind } from "@sugabots/contracts";
import type { Brand } from "effect";

/**
 * A bot's conversations and the rest, told apart. A bot's conversations are
 * every one but the threads of projects people made: the threads of its
 * default project, automation feeds, runs, collaborations and system
 * conversations. These are summarised and retitled from their summary. A
 * thread of a project people made keeps the name people gave it, and is not
 * summarised. Work that only makes sense on a bot's conversation takes its id,
 * which only `isBotConversation` makes: an id read from a request or an event
 * is a plain `string` until its row's kind has been checked.
 */

/** The id of a conversation with a bot: any that is not a thread of a project people made. */
export type BotConversationId = Brand.Branded<string, "BotConversationId">;

/** What telling conversations apart needs from a row. */
interface KindRow {
	id: string;
	kind: ConversationKind;
	/** The bot it is with, as `placedConversation` reads it: set on a thread of a bot's default project. */
	botId: string | null;
}

export type BotConversation<Row extends KindRow = KindRow> = Row & { id: BotConversationId };

export function isBotConversation<Row extends KindRow>(row: Row): row is BotConversation<Row> {
	return row.kind !== "project_thread" || row.botId !== null;
}
