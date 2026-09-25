import { describe, expect, it } from "vitest";
import { applyObservation } from "./lifecycle.ts";
import { aggregateEstimates, estimateAttempt } from "./pricing.ts";
import type { UsageEvidence } from "./schemas.ts";
import {
	completeUsageEvidence,
	decodeObservation,
	ledgerWithUsage,
	snapshot,
	successfulAttempt,
	timestamp,
} from "./test-fixtures.ts";
import type { CostEstimate } from "./types.ts";

const calculatedAt = timestamp("2026-09-18T11:00:00.000Z");
const completeLedger = ledgerWithUsage(successfulAttempt);

function withCounters(counters: UsageEvidence["counters"]) {
	return ledgerWithUsage(successfulAttempt, { ...completeUsageEvidence, counters });
}

describe("pricing", () => {
	it("calculates exact category amounts without double-charging overlaps", () => {
		const result = estimateAttempt(completeLedger, [snapshot()], calculatedAt);

		if (result.completeness !== "complete") throw new Error("Expected a complete estimate");
		expect(
			result.lines.map(({ category, quantity, amount }) => ({ category, quantity, amount })),
		).toEqual([
			{ category: "input", quantity: 800, amount: "0.0024" },
			{ category: "cache-read-input", quantity: 150, amount: "0.000045" },
			{ category: "cache-write-input", quantity: 50, amount: "0.0001875" },
			{ category: "output", quantity: 160, amount: "0.0024" },
			{ category: "reasoning", quantity: 40, amount: "0.0008" },
		]);
		expect(result.total).toBe("0.0058325");
		expect(result.currency).toBe("USD");
	});

	it("selects a context tier at its exact per-request boundary", () => {
		const ledger = withCounters({
			...completeUsageEvidence.counters,
			inputTokens: 200_000,
			uncachedInputTokens: 199_800,
		});
		const base = snapshot();
		const tiered = snapshot({
			tiers: [
				...base.tiers,
				{
					minimumContextTokens: 200_000,
					rates: base.tiers[0]?.rates.map((rate) => ({
						...rate,
						price: `${Number(rate.price) * 2}`,
					})),
				},
			],
		});

		const result = estimateAttempt(ledger, [tiered], calculatedAt);

		expect(result.completeness !== "unavailable" && result.lines[0]?.rate.price).toBe("6");
	});

	it("prices measured totals and reports the breakdowns a rate needs", () => {
		const result = estimateAttempt(
			withCounters({ inputTokens: 1_000, outputTokens: 200 }),
			[snapshot()],
			calculatedAt,
		);

		expect(result.completeness).toBe("unavailable");
		expect(result.issues.map((issue) => issue.category)).toEqual([
			"input",
			"cache-read-input",
			"cache-write-input",
			"reasoning",
		]);
	});

	it("marks an estimate complete when every rate it applies was measured", () => {
		const withoutReasoning = snapshot({
			tiers: [
				{
					minimumContextTokens: 0,
					rates: [
						{ category: "input", price: "3", unitTokens: 1_000_000 },
						{ category: "output", price: "15", unitTokens: 1_000_000 },
					],
				},
			],
		});

		const result = estimateAttempt(
			withCounters({ inputTokens: 1_000, outputTokens: 200 }),
			[withoutReasoning],
			calculatedAt,
		);

		expect(result).toEqual(expect.objectContaining({ completeness: "complete", total: "0.006" }));
	});

	it("prices the returned model rather than a plausible requested one", () => {
		const metadata = decodeObservation({
			observationId: "metadata-1",
			attemptId: successfulAttempt.attemptId,
			observedAt: "2026-09-18T10:00:02.000Z",
			payload: { type: "response-metadata", returnedModel: "other-model" },
		});
		const ledger = applyObservation(completeLedger, metadata).ledger;

		const result = estimateAttempt(ledger, [snapshot()], calculatedAt);

		expect(result.completeness).toBe("unavailable");
		expect(result.issues[0]?.code).toBe("no-snapshot");
	});

	it("uses a snapshot only within its half-open effective period", () => {
		const result = estimateAttempt(
			completeLedger,
			[snapshot({ effectiveUntil: successfulAttempt.startedAt })],
			calculatedAt,
		);

		expect(result.issues).toContainEqual(expect.objectContaining({ code: "no-snapshot" }));
	});

	it("prefers an effective connection override and rejects ambiguous rates", () => {
		const generic = snapshot();
		const override = snapshot({ snapshotId: "override", connectionId: "connection-1" });

		expect(estimateAttempt(completeLedger, [generic, override], calculatedAt).snapshotId).toBe(
			"override",
		);
		expect(estimateAttempt(completeLedger, [generic, generic], calculatedAt).issues).toContainEqual(
			expect.objectContaining({ code: "ambiguous-snapshot" }),
		);
	});

	it("refuses inconsistent counters without throwing", () => {
		const result = estimateAttempt(
			withCounters({ ...completeUsageEvidence.counters, outputTokens: -1 }),
			[snapshot()],
			calculatedAt,
		);

		expect(result.completeness).toBe("unavailable");
		expect(result.issues).toContainEqual(expect.objectContaining({ code: "inconsistent-usage" }));
	});

	it("sums exact values separately by currency", () => {
		const usd = estimateAttempt(completeLedger, [snapshot()], calculatedAt);
		const eur = estimateAttempt(completeLedger, [snapshot({ currency: "EUR" })], calculatedAt);

		expect(aggregateEstimates([usd, usd, eur])).toEqual({
			totals: [
				{ currency: "EUR", amount: "0.0058325" },
				{ currency: "USD", amount: "0.011665" },
			],
			estimates: 3,
			unavailableEstimates: 0,
			completeness: "complete",
		});
	});

	it("marks known spend partial when another estimate is unavailable", () => {
		const complete = estimateAttempt(completeLedger, [snapshot()], calculatedAt);
		const unavailable = estimateAttempt(completeLedger, [], calculatedAt);

		expect(aggregateEstimates([complete, unavailable])).toEqual(
			expect.objectContaining({
				totals: [{ currency: "USD", amount: "0.0058325" }],
				completeness: "partial",
			}),
		);
	});

	it("does not represent entirely unavailable spend as zero", () => {
		const unavailable: CostEstimate = estimateAttempt(completeLedger, [], calculatedAt);

		expect(aggregateEstimates([unavailable])).toEqual({
			totals: [],
			estimates: 1,
			unavailableEstimates: 1,
			completeness: "unavailable",
		});
	});
});
