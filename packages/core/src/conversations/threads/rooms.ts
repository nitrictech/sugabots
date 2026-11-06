import { type ChannelType, isChannelType, type ThreadType } from "@sugabots/contracts";
import type { Brand } from "effect";

/**
 * Channels and threads, told apart. Every room people talk in is a row of the
 * `thread` table, but a channel (a pod's chat or a bot's channel) lasts and
 * goes by the name people or its bot gave it, while a thread is one piece of
 * work, often started from a message in a channel. Work that only makes sense
 * on one of them takes its id, which only `isChannel` and `isThread` make: an
 * id read from a request or an event is a plain `string` until its row's type
 * has been checked.
 */

/** The id of a channel: a pod's chat or a bot's channel. */
export type ChannelId = Brand.Branded<string, "ChannelId">;

/** The id of a thread: any room that is not a channel. */
export type ThreadId = Brand.Branded<string, "ThreadId">;

/** What telling a room apart needs from its row. */
interface RoomRow {
	id: string;
	type: ThreadType;
}

export type Channel<Row extends RoomRow = RoomRow> = Row & { id: ChannelId; type: ChannelType };

export type Thread<Row extends RoomRow = RoomRow> = Row & {
	id: ThreadId;
	type: Exclude<ThreadType, ChannelType>;
};

export function isChannel<Row extends RoomRow>(row: Row): row is Channel<Row> {
	return isChannelType(row.type);
}

export function isThread<Row extends RoomRow>(row: Row): row is Thread<Row> {
	return !isChannelType(row.type);
}
