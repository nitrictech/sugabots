/**
 * How a message joins a bot's turn rather than get one of its own. Recording
 * it writes a message by id with no proof, so it is not part of the Turns
 * module's entrypoint: within core, only the floor, which proved the poster
 * reaches the chat, calls it. The package does not export this file.
 */

import type { JoinedTurn } from "@sugabots/contracts";
import { eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import { query } from "../../database/database.ts";
import { message } from "../../database/schema.ts";

/**
 * Records that the message `messageId` joined the turn of `joined.botId` on
 * `joined.triggerMessageId`, rather than get one of its own, so that turn
 * reads up to it (see `Collaboration.readingLimitOf`). The turns own
 * this write, as it is part of how a turn reads the chat.
 */
export const recordJoin = (messageId: string, joined: JoinedTurn) =>
	query((db) =>
		db
			.update(message)
			.set({ joinedTurns: sql`${message.joinedTurns} || ${JSON.stringify([joined])}::jsonb` })
			.where(eq(message.id, messageId)),
	).pipe(Effect.asVoid);

