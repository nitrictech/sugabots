import type {
	AttemptIntent,
	AttemptObservation,
	CostEstimate,
	PricingSnapshot,
} from "@sugabots/accounting";
import { sql } from "drizzle-orm";
import {
	foreignKey,
	index,
	jsonb,
	numeric,
	pgTable,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";
import { stamp } from "../database/sql.ts";

/**
 * One request sent to a model provider, and what it cost.
 *
 * The ledger outlives what it describes. Workspace, pod, agent and thread are
 * copied here without foreign keys, so deleting any of them neither erases what
 * was spent nor is blocked by it. They record who the request was made for, not
 * whether that still exists.
 */
export const modelAttempt = pgTable(
	"model_attempt",
	{
		attemptId: text("attempt_id").primaryKey(),
		/** One `TurnModel.stream` call; its steps are separate attempts. */
		executionId: text("execution_id").notNull(),
		retryOfAttemptId: text("retry_of_attempt_id"),
		workspaceId: uuid("workspace_id").notNull(),
		activity: text("activity"),
		podId: uuid("pod_id"),
		agentId: uuid("agent_id"),
		threadId: uuid("thread_id"),
		connectionId: text("connection_id").notNull(),
		provider: text("provider").notNull(),
		requestedModel: text("requested_model").notNull(),
		startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
		/** The intent as recorded, which a replay must match exactly. */
		intent: jsonb("intent").$type<AttemptIntent>().notNull(),
		/** Set once, by the claim that lets the request go out. */
		dispatch: jsonb("dispatch").$type<AttemptObservation>(),
		pricingSnapshot: jsonb("pricing_snapshot").$type<PricingSnapshot>(),
		costEstimate: jsonb("cost_estimate").$type<CostEstimate>(),
		/** `cost_estimate`'s total, when it has one, for summing in SQL. */
		estimatedCost: numeric("estimated_cost", { precision: 18, scale: 10 }),
		createdAt: stamp("created_at"),
	},
	(table) => [
		index("model_attempt_workspace_started_at_idx").on(table.workspaceId, table.startedAt),
		index("model_attempt_thread_idx").on(table.threadId).where(sql`${table.threadId} is not null`),
		index("model_attempt_execution_idx").on(table.executionId),
	],
);

/** What was learned about an attempt after its intent: usage, response, outcome. */
export const modelAttemptObservation = pgTable(
	"model_attempt_observation",
	{
		observationId: text("observation_id").primaryKey(),
		attemptId: text("attempt_id").notNull(),
		type: text("type").$type<AttemptObservation["payload"]["type"]>().notNull(),
		observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
		supersedesObservationId: text("supersedes_observation_id"),
		/** The observation as recorded, which a replay must match exactly. */
		observation: jsonb("observation").$type<AttemptObservation>().notNull(),
		createdAt: stamp("created_at"),
	},
	(table) => [
		foreignKey({
			name: "model_attempt_observation_attempt_fk",
			columns: [table.attemptId],
			foreignColumns: [modelAttempt.attemptId],
		}),
		index("model_attempt_observation_attempt_idx").on(table.attemptId, table.type),
	],
);

export type ModelAttemptRow = typeof modelAttempt.$inferSelect;
