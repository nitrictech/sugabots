import type { StreamEvent } from "@sugabots/contracts";
import { bigserial, index, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { stamp } from "../sql.ts";

export const event = pgTable(
	"event",
	{
		seq: bigserial("seq", { mode: "number" }).primaryKey(),
		channel: text("channel").notNull(),
		type: text("type").notNull(),
		payload: jsonb("payload").$type<StreamEvent>().notNull(),
		createdAt: stamp("created_at"),
	},
	(table) => [
		// Every read is "this channel, after this seq", in that order.
		index("event_channel_seq_idx").on(table.channel, table.seq),
		// The nightly prune, which is the only query that ignores the channel.
		index("event_created_at_idx").on(table.createdAt),
	],
);
