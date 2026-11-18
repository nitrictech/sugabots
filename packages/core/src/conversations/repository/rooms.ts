import type { ConversationKind } from "@sugabots/contracts";
import type { Brand } from "effect";

/**
 * A bot's conversations and the rest, told apart. A channel's conversation,
 * its main chat or one of its threads, lasts and goes by the name people gave
 * it, while a bot's conversations are each one piece of work, such as a task.
 * A direct message between people is neither: it lasts and goes by its
 * people's names, as a channel's conversation does, but nothing is started
 * from it. Work that only makes sense on a bot's conversation takes its id,
 * which only `isBotConversation` makes: an id read from a request or an event
 * is a plain `string` until its row's kind has been checked.
 */

/** The id of a conversation with a bot: any that is not a channel's or a direct message. */
export type BotConversationId = Brand.Branded<string, "BotConversationId">;

/** What telling conversations apart needs from a row. */
interface KindRow {
	id: string;
	kind: ConversationKind;
}

export type BotConversation<Row extends KindRow = KindRow> = Row & {
	id: BotConversationId;
	kind: Exclude<ConversationKind, "channel_conversation" | "direct_message">;
};

export function isBotConversation<Row extends KindRow>(row: Row): row is BotConversation<Row> {
	return row.kind !== "channel_conversation" && row.kind !== "direct_message";
}
