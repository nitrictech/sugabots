import type { ConversationKind } from "@sugabots/contracts";
import type { Brand } from "effect";

/**
 * A bot's conversations and the rest, told apart. A thread of a project
 * people made lasts and goes by the name people gave it, while a bot's
 * conversations, such as its threads, in its default project, are each one
 * piece of work.
 * A direct message between people is neither: it lasts and goes by its
 * people's names, as a project's thread does, but nothing is started
 * from it. Work that only makes sense on a bot's conversation takes its id,
 * which only `isBotConversation` makes: an id read from a request or an event
 * is a plain `string` until its row's kind has been checked.
 */

/** The id of a conversation with a bot: any that is not a thread of a project people made or a direct message. */
export type BotConversationId = Brand.Branded<string, "BotConversationId">;

/** What telling conversations apart needs from a row. */
interface KindRow {
	id: string;
	kind: ConversationKind;
	/** The bot it is with, as `placedConversation` reads it: set on a thread of a bot's default project. */
	botId: string | null;
}

export type BotConversation<Row extends KindRow = KindRow> = Row & {
	id: BotConversationId;
	kind: Exclude<ConversationKind, "direct_message">;
};

export function isBotConversation<Row extends KindRow>(row: Row): row is BotConversation<Row> {
	if (row.kind === "direct_message") return false;
	return row.kind !== "project_thread" || row.botId !== null;
}
