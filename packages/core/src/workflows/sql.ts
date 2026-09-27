import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { primaryKey, stamp, updatedStamp } from "../database/sql.ts";

export type LaneState = "idle" | "starting" | "running";

/**
 * A lane runs one workflow execution at a time for its key (for example one
 * agent's turns in one thread) and holds the requests waiting behind it. See
 * `workflows/lanes.ts`.
 */
export const lane = pgTable(
	"lane",
	{
		key: text("key").primaryKey(),
		state: text("state").$type<LaneState>().notNull().default("idle"),
		/** The workflow starting or running in the lane, and what it was started with. */
		workflow: text("workflow"),
		executionId: text("execution_id"),
		payload: jsonb("payload").$type<unknown>(),
		updatedAt: updatedStamp("updated_at"),
	},
	(table) => [
		check("lane_state_check", sql`${table.state} in ('idle', 'starting', 'running')`),
		check("lane_execution_check", sql`(${table.state} = 'idle') = (${table.executionId} is null)`),
		index("lane_busy_idx").on(table.state, table.updatedAt).where(sql`${table.state} <> 'idle'`),
	],
);

/** A request waiting for its lane, oldest first. */
export const laneRequest = pgTable(
	"lane_request",
	{
		id: primaryKey(),
		laneKey: text("lane_key")
			.notNull()
			.references(() => lane.key, { onDelete: "cascade" }),
		workflow: text("workflow").notNull(),
		payload: jsonb("payload").$type<unknown>().notNull(),
		createdAt: stamp("created_at"),
	},
	(table) => [index("lane_request_order_idx").on(table.laneKey, table.createdAt, table.id)],
);

export type OutboxKind = "signal" | "interrupt";

/**
 * Messages for a workflow engine that follow a domain write: recorded in the
 * write's transaction, sent once it commits, and removed when delivered. See
 * `workflows/outbox.ts`.
 */
export const workflowOutbox = pgTable(
	"workflow_outbox",
	{
		id: primaryKey(),
		kind: text("kind").$type<OutboxKind>().notNull(),
		workflow: text("workflow").notNull(),
		executionId: text("execution_id").notNull(),
		/** For a signal: the deferred's name, and its exit encoded with the deferred's own schema. */
		deferred: text("deferred"),
		exit: jsonb("exit").$type<unknown>(),
		createdAt: stamp("created_at"),
	},
	(table) => [
		check("workflow_outbox_kind_check", sql`${table.kind} in ('signal', 'interrupt')`),
		check(
			"workflow_outbox_signal_check",
			sql`(${table.kind} = 'signal') = (${table.deferred} is not null and ${table.exit} is not null)`,
		),
		index("workflow_outbox_age_idx").on(table.createdAt),
	],
);
