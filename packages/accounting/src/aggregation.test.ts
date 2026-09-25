import { Result } from "effect";
import { describe, expect, it } from "vitest";
import { aggregateAttempts, DuplicateAttemptError } from "./aggregation.ts";
import { reduceAttempt } from "./lifecycle.ts";
import {
	completeUsageEvidence,
	intentFor,
	ledgerWithUsage,
	partialUsageEvidence,
} from "./test-fixtures.ts";

describe("attempt aggregation", () => {
	it("sums known counters while retaining coverage and unresolved attempts", () => {
		const complete = ledgerWithUsage(intentFor("attempt-1"), completeUsageEvidence);
		const partial = ledgerWithUsage(intentFor("attempt-2"), partialUsageEvidence);
		const unresolved = reduceAttempt(intentFor("attempt-3"), []);

		const result = Result.getOrThrow(aggregateAttempts([complete, partial, unresolved]));

		expect(result.attempts).toBe(3);
		expect(result.unresolvedAttempts).toBe(3);
		expect(result.disputedAttempts).toBe(0);
		expect(result.counters.inputTokens).toEqual({
			knownTotal: "2000",
			measuredAttempts: 2,
			disputedAttempts: 0,
			totalAttempts: 3,
			completeness: "partial",
		});
		expect(result.counters.cacheReadInputTokens).toEqual({
			knownTotal: "150",
			measuredAttempts: 1,
			disputedAttempts: 0,
			totalAttempts: 3,
			completeness: "partial",
		});
	});

	it("rejects duplicate attempts instead of double-counting them", () => {
		const ledger = ledgerWithUsage(intentFor("attempt-1"));
		const result = aggregateAttempts([ledger, ledger]);

		expect(Result.isFailure(result) && result.failure).toBeInstanceOf(DuplicateAttemptError);
	});

	it("excludes inconsistent evidence and exposes the dispute", () => {
		const invalid = ledgerWithUsage(intentFor("attempt-invalid"), {
			...completeUsageEvidence,
			counters: { ...completeUsageEvidence.counters, reasoningTokens: 500 },
		});

		const result = Result.getOrThrow(aggregateAttempts([invalid]));

		expect(result.disputedAttempts).toBe(1);
		expect(result.counters.outputTokens).toEqual({
			knownTotal: "0",
			measuredAttempts: 0,
			disputedAttempts: 1,
			totalAttempts: 1,
			completeness: "partial",
		});
	});
});
