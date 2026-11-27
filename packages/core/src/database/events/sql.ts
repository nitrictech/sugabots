import type { DurableEventType, StreamEvent } from "@sugabots/contracts";
import { type SQLWrapper, sql } from "drizzle-orm";
import {
	bigint,
	bigserial,
	boolean,
	check,
	index,
	jsonb,
	pgTable,
	text,
} from "drizzle-orm/pg-core";
import { stamp } from "../sql.ts";

export const CONTROL_EVENT_TYPES = [
	"reach.changed",
	"session.ended",
] as const satisfies readonly DurableEventType[];

export const isControlEvent = (type: SQLWrapper) =>
	sql`${type} in (${sql.join(
		CONTROL_EVENT_TYPES.map((type) => sql.raw(`'${type}'`)),
		sql`, `,
	)})`;

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
		index("event_control_stream_seq_idx")
			.on(table.stream, table.seq)
			.where(isControlEvent(table.type)),
		// The nightly prune, which is the only query that ignores the stream.
		index("event_created_at_idx").on(table.createdAt),
	],
);

export const eventRetention = pgTable(
	"event_retention",
	{
		singleton: boolean("singleton").primaryKey(),
		prunedThrough: bigint("pruned_through", { mode: "number" }).notNull(),
	},
	(table) => [check("event_retention_singleton", sql`${table.singleton}`)],
);
