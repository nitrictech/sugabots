import { Schema } from "effect";
import { botColorSchema, botEyesSchema, botShapeSchema } from "./bots.ts";
import { builtInProviderIdSchema } from "./built-in-providers.ts";

/**
 * What a workspace's models cost over one month: each request's cost as its
 * model provider reported it, or else an estimate from its model's price.
 *
 * Every amount is in US dollars. A request whose cost could not be known is
 * left out of every amount and counted in `unknownCostRequests` instead, so an
 * unknown is never shown as free.
 */

/** A calendar month, as `YYYY-MM`. */
const usageMonthSchema = Schema.String.check(Schema.isPattern(/^\d{4}-(0[1-9]|1[0-2])$/));
export type UsageMonth = typeof usageMonthSchema.Type;

export const usageQuerySchema = Schema.Struct({
	/** In the workspace's time zone. */
	month: usageMonthSchema,
});

const usdSchema = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const countSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** What a slice of the month cost, and how many of its requests had no price. */
const usageFields = {
	usd: usdSchema,
	unknownCostRequests: countSchema,
};

const usageDaySchema = Schema.Struct({
	/** `YYYY-MM-DD`, in the query's time zone. */
	date: Schema.String,
	usd: usdSchema,
});

/** A bot's usage: the requests its own turns made. */
const botUsageSchema = Schema.Struct({
	botId: Schema.String,
	/** Null for a bot that has since been deleted. */
	name: Schema.NullOr(Schema.String),
	color: Schema.NullOr(botColorSchema),
	eyes: Schema.NullOr(botEyesSchema),
	shape: Schema.NullOr(botShapeSchema),
	...usageFields,
});

/** A model's usage through one provider, the bots' and the system bots' together. */
const modelUsageSchema = Schema.Struct({
	/** The model id sent to the provider. */
	model: Schema.String,
	displayName: Schema.NullOr(Schema.String),
	/** The provider's name now; null for one that has since been removed. */
	providerName: Schema.NullOr(Schema.String),
	builtIn: Schema.NullOr(builtInProviderIdSchema),
	...usageFields,
});

export const workspaceUsageSchema = Schema.Struct({
	month: usageMonthSchema,
	/** The workspace's IANA time zone, which the month and its days are in, as `Workspace.timeZone` gives it. */
	timeZone: Schema.String,
	...usageFields,
	/** Every day of the month, first to last, including those still to come. */
	days: Schema.Array(usageDaySchema),
	/** Most expensive first, but for the Personal Assistants, in `personalAssistants`. */
	bots: Schema.Array(botUsageSchema),
	models: Schema.Array(modelUsageSchema),
	/**
	 * What the system bots spent: compaction, and model tests.
	 */
	systemBots: Schema.Struct(usageFields),
	/**
	 * What every member's Personal Assistant spent, together: each is its
	 * member's alone, so none is named.
	 */
	personalAssistants: Schema.Struct(usageFields),
});
export type WorkspaceUsage = typeof workspaceUsageSchema.Type;
