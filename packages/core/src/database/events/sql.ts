import type { StreamEvent } from "@sugabots/contracts";
import { bigserial, index, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { stamp } from "../sql.ts";

export const event = pgTable(
	"event",
	{
		seq: bigserial("seq", { mode: "number" }).primaryKey(),
		stream: text("stream").notNull(),
		type: text("type").notNull(),
		payload: jsonb("payload").$type<StreamEvent>().notNull(),
		createdAt: stamp("created_at"),
	},
	(table) => [
		// Every read is "this stream, after this seq", in that order.
		index("event_stream_seq_idx").on(table.stream, table.seq),
		// The nightly prune, which is the only query that ignores the stream.
		index("event_created_at_idx").on(table.createdAt),
	],
);
