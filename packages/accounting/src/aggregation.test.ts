import { describe, expect, it } from "vitest";
import { aggregateAttemptsSync as aggregateAttempts } from "./aggregation.ts";
import { completeUsageEvidence, partialUsageEvidence, successfulAttempt } from "./examples.ts";
import {
	applyObservationSync as applyObservation,
	createAttemptLedgerSync as createAttemptLedger,
} from "./lifecycle.ts";
import type { UsageEvidence } from "./types.ts";

describe("attempt aggregation", () => {
	it("sums known counters while retaining coverage and unresolved attempts", () => {
		const complete = withUsage("attempt-1", completeUsageEvidence);
		const partial = withUsage("attempt-2", partialUsageEvidence);
		const unresolved = createAttemptLedger({
			...successfulAttempt,
			attemptId: "attempt-3",
			executionId: "execution-3",
		});

		const result = aggregateAttempts([complete, partial, unresolved]);

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
		const ledger = withUsage("attempt-1", completeUsageEvidence);
		expect(() => aggregateAttempts([ledger, ledger])).toThrow("only be aggregated once");
	});

	it("excludes inconsistent evidence and exposes the dispute", () => {
		const invalid = withUsage("attempt-invalid", {
			...completeUsageEvidence,
			counters: { ...completeUsageEvidence.counters, reasoningTokens: 500 },
		});

		const result = aggregateAttempts([invalid]);

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

function withUsage(attemptId: string, evidence: UsageEvidence) {
	const intent = { ...successfulAttempt, attemptId, executionId: `execution-${attemptId}` };
	const result = applyObservation(createAttemptLedger(intent), {
		observationId: `${attemptId}:usage:1`,
		attemptId,
		observedAt: "2026-09-18T10:00:01.000Z",
		payload: { type: "usage", evidence },
	});
	return result.ledger;
}
