import { Data, Effect } from "effect";
import { normalizeUsageSync } from "./normalization.ts";
import type { AttemptLedger, MeasurementCompleteness, UsageCounters } from "./types.ts";

export interface CounterAggregate {
	readonly knownTotal: string;
	readonly measuredAttempts: number;
	readonly disputedAttempts: number;
	readonly totalAttempts: number;
	readonly completeness: MeasurementCompleteness;
}

export interface AttemptAggregate {
	readonly attempts: number;
	readonly unresolvedAttempts: number;
	readonly disputedAttempts: number;
	readonly counters: { readonly [Key in keyof UsageCounters]: CounterAggregate };
}

export class AttemptAggregationError extends Data.TaggedError("AttemptAggregationError")<{
	readonly cause: unknown;
}> {}

export const aggregateAttempts = Effect.fn("accounting.aggregateAttempts")(function* (
	ledgers: readonly AttemptLedger[],
) {
	yield* Effect.annotateCurrentSpan("accounting.attempt.count", ledgers.length);
	return yield* Effect.try({
		try: () => aggregateAttemptsSync(ledgers),
		catch: (cause) => new AttemptAggregationError({ cause }),
	});
});

export function aggregateAttemptsSync(ledgers: readonly AttemptLedger[]): AttemptAggregate {
	const attemptIds = new Set(ledgers.map((ledger) => ledger.intent.attemptId));
	if (attemptIds.size !== ledgers.length)
		throw new Error("Each attempt can only be aggregated once");
	const active = ledgers.map((ledger) => activeCounters(ledger));
	return {
		attempts: ledgers.length,
		unresolvedAttempts: ledgers.filter(
			(ledger) => ledger.state === "intended" || ledger.state === "dispatched",
		).length,
		disputedAttempts: active.filter((attempt) => attempt.disputed).length,
		counters: {
			inputTokens: aggregateCounter(active, "inputTokens"),
			uncachedInputTokens: aggregateCounter(active, "uncachedInputTokens"),
			cacheReadInputTokens: aggregateCounter(active, "cacheReadInputTokens"),
			cacheWriteInputTokens: aggregateCounter(active, "cacheWriteInputTokens"),
			outputTokens: aggregateCounter(active, "outputTokens"),
			reasoningTokens: aggregateCounter(active, "reasoningTokens"),
		},
	};
}

function activeCounters(ledger: AttemptLedger): { counters?: UsageCounters; disputed: boolean } {
	const superseded = new Set(
		ledger.observations.flatMap((observation) =>
			observation.supersedesObservationId ? [observation.supersedesObservationId] : [],
		),
	);
	const usage = ledger.observations.findLast(
		(observation) =>
			observation.payload.type === "usage" && !superseded.has(observation.observationId),
	);
	if (usage?.payload.type !== "usage") return { disputed: ledger.issues.length > 0 };
	const normalized = normalizeUsageSync(usage.payload.evidence);
	if (ledger.issues.length > 0 || normalized.issues.length > 0) return { disputed: true };
	return { counters: usage.payload.evidence.counters, disputed: false };
}

function aggregateCounter(
	attempts: readonly { counters?: UsageCounters; disputed: boolean }[],
	field: keyof UsageCounters,
): CounterAggregate {
	const measured = attempts.flatMap((attempt) => {
		const value = attempt.counters?.[field];
		return value === undefined || !Number.isSafeInteger(value) || value < 0 ? [] : [value];
	});
	const disputedAttempts = attempts.filter((attempt) => attempt.disputed).length;
	return {
		knownTotal: measured.reduce((total, value) => total + BigInt(value), 0n).toString(),
		measuredAttempts: measured.length,
		disputedAttempts,
		totalAttempts: attempts.length,
		completeness:
			measured.length === 0 && disputedAttempts === 0
				? "unmeasured"
				: measured.length === attempts.length && disputedAttempts === 0
					? "complete"
					: "partial",
	};
}
