import { Data, Result } from "effect";
import type { AttemptLedger } from "./lifecycle.ts";
import {
	type AttemptId,
	USAGE_COUNTER_FIELDS,
	type UsageCounterField,
	type UsageCounters,
} from "./schemas.ts";
import type { MeasurementCompleteness } from "./types.ts";

export interface CounterAggregate {
	/** The sum over attempts that measured this counter, as a decimal integer string. */
	readonly knownTotal: string;
	readonly measuredAttempts: number;
	readonly disputedAttempts: number;
	readonly totalAttempts: number;
	readonly completeness: MeasurementCompleteness;
}

export interface AttemptAggregate {
	readonly attempts: number;
	/** Attempts without a terminal outcome yet. */
	readonly unresolvedAttempts: number;
	/** Attempts whose usage is excluded because their evidence is inconsistent or conflicting. */
	readonly disputedAttempts: number;
	readonly counters: { readonly [Field in UsageCounterField]: CounterAggregate };
}

export class DuplicateAttemptError extends Data.TaggedError("DuplicateAttemptError")<{
	readonly attemptId: AttemptId;
}> {}

export function aggregateAttempts(
	ledgers: readonly AttemptLedger[],
): Result.Result<AttemptAggregate, DuplicateAttemptError> {
	const seen = new Set<AttemptId>();
	for (const { intent } of ledgers) {
		if (seen.has(intent.attemptId)) {
			return Result.fail(new DuplicateAttemptError({ attemptId: intent.attemptId }));
		}
		seen.add(intent.attemptId);
	}
	const attempts = ledgers.map(countableUsage);
	const counters = Object.fromEntries(
		USAGE_COUNTER_FIELDS.map((field) => [field, aggregateCounter(attempts, field)]),
	) as AttemptAggregate["counters"];
	return Result.succeed({
		attempts: ledgers.length,
		unresolvedAttempts: ledgers.filter(
			(ledger) => ledger.state === "intended" || ledger.state === "dispatched",
		).length,
		disputedAttempts: attempts.filter((attempt) => attempt.disputed).length,
		counters,
	});
}

type CountableUsage =
	| { readonly disputed: true }
	| { readonly disputed: false; readonly counters?: UsageCounters };

function countableUsage(ledger: AttemptLedger): CountableUsage {
	const disputed = ledger.issues.length > 0 || (ledger.usage?.issues.length ?? 0) > 0;
	return disputed ? { disputed } : { disputed, counters: ledger.usage?.counters };
}

function aggregateCounter(
	attempts: readonly CountableUsage[],
	field: UsageCounterField,
): CounterAggregate {
	const measured = attempts.flatMap((attempt) => {
		const value = attempt.disputed ? undefined : attempt.counters?.[field];
		return value === undefined ? [] : [value];
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
				: measured.length === attempts.length
					? "complete"
					: "partial",
	};
}
