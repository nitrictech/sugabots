import type { ProviderPresetId } from "@sugabots/contracts";
import { sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	numeric,
	pgTable,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";
import { primaryKey } from "../database/sql.ts";
import type { ModelRequests } from "./model-requests.ts";

/**
 * One request sent to a model provider: what it was for, what it used, and
 * what it cost.
 *
 * The ledger outlives what it describes. The bot, conversation, turn and
 * provider are copied here without foreign keys, so deleting any of them
 * neither erases what was spent nor is blocked by it: they say who a request
 * was made for, not whether that still exists.
 */
export const modelRequest = pgTable(
	"model_request",
	{
		id: primaryKey(),
		workspaceId: uuid("workspace_id").notNull(),
		purpose: text("purpose").$type<ModelRequests.Purpose>().notNull(),
		botId: uuid("bot_id"),
		/** The conversation the request served, never a system bot's own conversation. */
		conversationId: uuid("conversation_id"),
		turnId: uuid("turn_id"),
		/** Which of its stream's requests this was, from zero: a turn that calls tools makes several. */
		step: integer("step").notNull(),
		providerId: uuid("provider_id").notNull(),
		preset: text("preset").$type<ProviderPresetId>(),
		model: text("model").notNull(),
		outcome: text("outcome").$type<ModelRequests.Outcome>().notNull(),
		/** Every input token, cached or not. Null wherever the provider did not say. */
		inputTokens: integer("input_tokens"),
		cacheReadTokens: integer("cache_read_tokens"),
		cacheWriteTokens: integer("cache_write_tokens"),
		/** Every output token, reasoning included. */
		outputTokens: integer("output_tokens"),
		reasoningTokens: integer("reasoning_tokens"),
		/** In US dollars. Null when the request could not be priced, which is not the same as free. */
		costUsd: numeric("cost_usd", { precision: 18, scale: 10, mode: "number" }),
		costSource: text("cost_source"),
		startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
		/** Null while the request is out, and for good if the process stopped before it came back. */
		endedAt: timestamp("ended_at", { withTimezone: true }),
	},
	(table) => [
		index("model_request_workspace_started_at_idx").on(table.workspaceId, table.startedAt),
		index("model_request_conversation_idx")
			.on(table.conversationId)
			.where(sql`${table.conversationId} is not null`),
		check(
			"model_request_purpose_valid",
			sql`${table.purpose} in ('bot-turn', 'facilitation', 'compaction', 'trial', 'provider-check')`,
		),
		check(
			"model_request_outcome_valid",
			sql`${table.outcome} in ('started', 'completed', 'failed', 'aborted')`,
		),
		check(
			"model_request_ended_valid",
			sql`(${table.outcome} = 'started') = (${table.endedAt} is null)`,
		),
		check(
			"model_request_cost_valid",
			sql`(${table.costUsd} is null) = (${table.costSource} is null) and (${table.costUsd} is null or ${table.costUsd} >= 0)`,
		),
	],
);
