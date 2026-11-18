import { Schema } from "effect";
import { botColorSchema, botFaceSchema, botShapeSchema } from "./bots.ts";
import { providerPresetIdSchema } from "./provider-catalog.ts";

/**
 * What a workspace's models cost over one month, estimated from each
 * provider's published prices.
 *
 * Every amount is in US dollars. A request whose cost could not be known is
 * left out of every amount and counted in `unpricedRequests` instead, so an
 * unknown is never shown as free.
 */

/** A calendar month, as `YYYY-MM`. */
export const usageMonthSchema = Schema.String.check(Schema.isPattern(/^\d{4}-(0[1-9]|1[0-2])$/));
export type UsageMonth = typeof usageMonthSchema.Type;

export const usageQuerySchema = Schema.Struct({
	/** In the workspace's time zone. */
	month: usageMonthSchema,
});
export type UsageQuery = typeof usageQuerySchema.Type;

const usdSchema = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const countSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** What a slice of the month cost, and how many of its requests had no price. */
const spendFields = {
	usd: usdSchema,
	unpricedRequests: countSchema,
};

export const usageDaySchema = Schema.Struct({
	/** `YYYY-MM-DD`, in the query's time zone. */
	date: Schema.String,
	usd: usdSchema,
});

/** A bot's spend: the requests its own turns made. */
export const botUsageSchema = Schema.Struct({
	botId: Schema.String,
	/** Null for a bot that has since been deleted. */
	name: Schema.NullOr(Schema.String),
	color: Schema.NullOr(botColorSchema),
	face: Schema.NullOr(botFaceSchema),
	shape: Schema.NullOr(botShapeSchema),
	...spendFields,
});

/** A model's spend through one provider, the bots' and the system bots' together. */
export const modelUsageSchema = Schema.Struct({
	/** The model id sent to the provider. */
	model: Schema.String,
	displayName: Schema.NullOr(Schema.String),
	/** The provider's name now; null for one that has since been removed. */
	providerName: Schema.NullOr(Schema.String),
	preset: Schema.NullOr(providerPresetIdSchema),
	...spendFields,
});

export const workspaceUsageSchema = Schema.Struct({
	month: usageMonthSchema,
	/** The workspace's IANA time zone, which the month and its days are in, as `Workspace.timeZone` gives it. */
	timeZone: Schema.String,
	...spendFields,
	/** Every day of the month, first to last, including those still to come. */
	days: Schema.Array(usageDaySchema),
	/** Most expensive first, but for the Personal Assistants, in `personalAssistants`. */
	bots: Schema.Array(botUsageSchema),
	models: Schema.Array(modelUsageSchema),
	/**
	 * What the system bots spent: routing, summaries and titles,
	 * compaction, and trying models out from settings.
	 */
	systemBots: Schema.Struct(spendFields),
	/**
	 * What every person's Personal Assistant spent, together: each is its
	 * person's alone, so none is named.
	 */
	personalAssistants: Schema.Struct(spendFields),
});
export type WorkspaceUsage = typeof workspaceUsageSchema.Type;
