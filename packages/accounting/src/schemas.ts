import { isoTimestampSchema } from "@sugabots/contracts/timestamps";
import { Schema } from "effect";
import { DecimalAmount, RateUnit } from "./decimal.ts";

/*
 * Records that cross the package boundary: built by callers or read back from a store. Decode them
 * with these schemas so identifiers, timestamps, and amounts are validated once, here.
 */

export const AttemptId = Schema.NonEmptyString.pipe(Schema.brand("AttemptId"));
export type AttemptId = typeof AttemptId.Type;
export const ExecutionId = Schema.NonEmptyString.pipe(Schema.brand("ExecutionId"));
export type ExecutionId = typeof ExecutionId.Type;
export const StepId = Schema.NonEmptyString.pipe(Schema.brand("StepId"));
export type StepId = typeof StepId.Type;
export const ObservationId = Schema.NonEmptyString.pipe(Schema.brand("ObservationId"));
export type ObservationId = typeof ObservationId.Type;
export const WorkspaceId = Schema.NonEmptyString.pipe(Schema.brand("WorkspaceId"));
export type WorkspaceId = typeof WorkspaceId.Type;
export const ConnectionId = Schema.NonEmptyString.pipe(Schema.brand("ConnectionId"));
export type ConnectionId = typeof ConnectionId.Type;
export const SnapshotId = Schema.NonEmptyString.pipe(Schema.brand("SnapshotId"));
export type SnapshotId = typeof SnapshotId.Type;
export const EstimateId = Schema.NonEmptyString.pipe(Schema.brand("EstimateId"));
export type EstimateId = typeof EstimateId.Type;
export const ChargeId = Schema.NonEmptyString.pipe(Schema.brand("ChargeId"));
export type ChargeId = typeof ChargeId.Type;

export const Timestamp = isoTimestampSchema.pipe(Schema.brand("Timestamp"));
export type Timestamp = typeof Timestamp.Type;

export function epochMilliseconds(timestamp: Timestamp): number {
	return Date.parse(timestamp);
}

/** An ISO 4217 currency code, such as `USD`. */
export const Currency = Schema.String.check(
	Schema.isPattern(/^[A-Z]{3}$/, { message: "An ISO 4217 code such as USD" }),
).pipe(Schema.brand("Currency"));
export type Currency = typeof Currency.Type;

export const Money = Schema.Struct({ currency: Currency, amount: DecimalAmount });
export type Money = typeof Money.Type;

const TokenCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const AttributionSnapshot = Schema.Struct({
	workspaceId: WorkspaceId,
	workspaceName: Schema.optionalKey(Schema.String),
	podId: Schema.optionalKey(Schema.String),
	podName: Schema.optionalKey(Schema.String),
	agentId: Schema.optionalKey(Schema.String),
	agentName: Schema.optionalKey(Schema.String),
	threadId: Schema.optionalKey(Schema.String),
	chatId: Schema.optionalKey(Schema.String),
	activityPurpose: Schema.optionalKey(Schema.String),
});
export type AttributionSnapshot = typeof AttributionSnapshot.Type;

/** The provider connection and model an attempt asked for. */
export const ProviderRequest = Schema.Struct({
	connectionId: ConnectionId,
	provider: Schema.NonEmptyString,
	requestedModel: Schema.NonEmptyString,
});
export type ProviderRequest = typeof ProviderRequest.Type;

export const AttemptIntent = Schema.Struct({
	attemptId: AttemptId,
	executionId: ExecutionId,
	stepId: Schema.optionalKey(StepId),
	retryOfAttemptId: Schema.optionalKey(AttemptId),
	startedAt: Timestamp,
	attribution: AttributionSnapshot,
	provider: ProviderRequest,
}).check(
	Schema.makeFilter((intent) => intent.retryOfAttemptId !== intent.attemptId, {
		expected: "an attempt that does not retry itself",
	}),
);
export type AttemptIntent = typeof AttemptIntent.Type;

export const USAGE_COUNTER_FIELDS = [
	"inputTokens",
	"uncachedInputTokens",
	"cacheReadInputTokens",
	"cacheWriteInputTokens",
	"outputTokens",
	"reasoningTokens",
] as const;
export type UsageCounterField = (typeof USAGE_COUNTER_FIELDS)[number];

/**
 * Token counts as the source reported them. They are deliberately unvalidated so that evidence is
 * kept verbatim; `normalizeUsage` reports counters that are not non-negative integers.
 */
export const UsageCounters = Schema.Struct({
	inputTokens: Schema.optionalKey(Schema.Finite),
	uncachedInputTokens: Schema.optionalKey(Schema.Finite),
	cacheReadInputTokens: Schema.optionalKey(Schema.Finite),
	cacheWriteInputTokens: Schema.optionalKey(Schema.Finite),
	outputTokens: Schema.optionalKey(Schema.Finite),
	reasoningTokens: Schema.optionalKey(Schema.Finite),
});
export type UsageCounters = typeof UsageCounters.Type;

export const UsageEvidence = Schema.Struct({
	normalizationVersion: Schema.Literal(1),
	source: Schema.Struct({
		kind: Schema.Literals(["ai-sdk", "provider", "manual"]),
		name: Schema.String,
		version: Schema.optionalKey(Schema.String),
	}),
	counters: UsageCounters,
	/**
	 * The counters cover several model calls made inside one provider request, such as Anthropic
	 * advisor iterations, so they cannot be priced against a single model's rates.
	 */
	containsProviderSubrequests: Schema.optionalKey(Schema.Boolean),
	raw: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
});
export type UsageEvidence = typeof UsageEvidence.Type;

export const ExecutionOutcome = Schema.Literals(["succeeded", "failed", "cancelled"]);
export type ExecutionOutcome = typeof ExecutionOutcome.Type;

export const ObservationPayload = Schema.Union([
	Schema.Struct({ type: Schema.Literal("usage"), evidence: UsageEvidence }),
	Schema.Struct({ type: Schema.Literal("dispatched"), dispatchedAt: Timestamp }),
	Schema.Struct({
		type: Schema.Literal("response-metadata"),
		returnedModel: Schema.NonEmptyString,
		providerRequestId: Schema.optionalKey(Schema.String),
	}),
	Schema.Struct({
		type: Schema.Literal("terminal"),
		endedAt: Timestamp,
		outcome: ExecutionOutcome,
		errorCode: Schema.optionalKey(Schema.String),
	}),
]);
export type ObservationPayload = typeof ObservationPayload.Type;

export const AttemptObservation = Schema.Struct({
	observationId: ObservationId,
	attemptId: AttemptId,
	observedAt: Timestamp,
	supersedesObservationId: Schema.optionalKey(ObservationId),
	payload: ObservationPayload,
});
export type AttemptObservation = typeof AttemptObservation.Type;

export const RateCategory = Schema.Literals([
	"input",
	"cache-read-input",
	"cache-write-input",
	"output",
	"reasoning",
]);
export type RateCategory = typeof RateCategory.Type;

export const TokenRate = Schema.Struct({
	category: RateCategory,
	price: DecimalAmount,
	unitTokens: RateUnit,
});
export type TokenRate = typeof TokenRate.Type;

export const PricingTier = Schema.Struct({
	minimumContextTokens: TokenCount,
	rates: Schema.Array(TokenRate),
}).check(
	Schema.makeFilter(
		(tier) => new Set(tier.rates.map((rate) => rate.category)).size === tier.rates.length,
		{ expected: "at most one rate per category" },
	),
);
export type PricingTier = typeof PricingTier.Type;

/** Rates for one model, valid from `effectiveFrom` up to but excluding `effectiveUntil`. */
export const PricingSnapshot = Schema.Struct({
	snapshotId: SnapshotId,
	provider: Schema.NonEmptyString,
	model: Schema.NonEmptyString,
	/** Limits the snapshot to one connection, such as a negotiated rate. */
	connectionId: Schema.optionalKey(ConnectionId),
	currency: Currency,
	source: Schema.Struct({
		name: Schema.String,
		url: Schema.optionalKey(Schema.String),
		version: Schema.optionalKey(Schema.String),
		retrievedAt: Timestamp,
	}),
	effectiveFrom: Timestamp,
	effectiveUntil: Schema.optionalKey(Timestamp),
	/** Context-length tiers: the first starts at zero and each later one starts higher. */
	tiers: Schema.Array(PricingTier),
}).check(
	Schema.makeFilter((snapshot) => startsAtZeroAndAscends(snapshot.tiers), {
		expected: "tiers that start at zero and strictly ascend",
	}),
);
export type PricingSnapshot = typeof PricingSnapshot.Type;

function startsAtZeroAndAscends(tiers: readonly PricingTier[]): boolean {
	return (
		tiers[0]?.minimumContextTokens === 0 &&
		tiers.every(
			(tier, index) =>
				index === 0 || tier.minimumContextTokens > (tiers[index - 1]?.minimumContextTokens ?? 0),
		)
	);
}

/** A charge the provider reported, kept separate from our estimates until reconciled. */
export const ProviderReportedCharge = Schema.Struct({
	chargeId: ChargeId,
	scope: Schema.Literals(["attempt", "response", "execution"]),
	scopeId: Schema.NonEmptyString,
	amount: Money,
	source: Schema.NonEmptyString,
	reportedAt: Timestamp,
	reconciliationStatus: Schema.Literals(["unreconciled", "matched", "adjusted", "disputed"]),
});
export type ProviderReportedCharge = typeof ProviderReportedCharge.Type;
