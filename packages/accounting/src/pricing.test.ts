import { describe, expect, it } from "vitest";
import { normalizeUsageSync as normalizeUsage } from "./normalization.ts";
import {
	aggregateEstimatesSync as aggregateEstimates,
	estimateCostSync as estimateCost,
	resolvePricingSnapshotSync as resolvePricingSnapshot,
} from "./pricing.ts";
import { costEstimateRevisionSync as costEstimateRevision } from "./revisions.ts";
import type { PricingSnapshot, ProviderIdentity, UsageEvidence } from "./types.ts";

const provider: ProviderIdentity = {
	connectionId: "connection-1",
	provider: "anthropic",
	requestedModel: "model-1",
};
const occurredAt = "2026-09-18T10:00:00.000Z";
const calculatedAt = "2026-09-18T11:00:00.000Z";

const completeEvidence: UsageEvidence = {
	normalizationVersion: 1,
	source: { kind: "provider", name: "fixture" },
	counters: {
		inputTokens: 1_000,
		uncachedInputTokens: 800,
		cacheReadInputTokens: 150,
		cacheWriteInputTokens: 50,
		outputTokens: 200,
		reasoningTokens: 40,
	},
};

describe("pricing", () => {
	it("calculates exact category amounts without double-charging overlaps", () => {
		const result = estimateCost(
			normalizeUsage(completeEvidence),
			provider,
			snapshot(),
			occurredAt,
			calculatedAt,
		);

		expect(result.completeness).toBe("complete");
		expect(
			result.lines.map(({ category, quantity, amount }) => ({ category, quantity, amount })),
		).toEqual([
			{ category: "input", quantity: 800, amount: { currency: "USD", amount: "0.0024" } },
			{
				category: "cache-read-input",
				quantity: 150,
				amount: { currency: "USD", amount: "0.000045" },
			},
			{
				category: "cache-write-input",
				quantity: 50,
				amount: { currency: "USD", amount: "0.0001875" },
			},
			{ category: "output", quantity: 160, amount: { currency: "USD", amount: "0.0024" } },
			{ category: "reasoning", quantity: 40, amount: { currency: "USD", amount: "0.0008" } },
		]);
		expect(result.total).toEqual({ currency: "USD", amount: "0.0058325" });
	});

	it("selects a context tier at its exact per-request boundary", () => {
		const evidence = {
			...completeEvidence,
			counters: {
				...completeEvidence.counters,
				inputTokens: 200_000,
				uncachedInputTokens: 199_800,
			},
		};
		const base = snapshot();
		const tiered: PricingSnapshot = {
			...base,
			tiers: [
				...base.tiers,
				{
					minimumContextTokens: 200_000,
					rates: [
						{ category: "input", price: "6", unitTokens: 1_000_000 },
						{ category: "cache-read-input", price: "0.6", unitTokens: 1_000_000 },
						{ category: "cache-write-input", price: "7.5", unitTokens: 1_000_000 },
						{ category: "output", price: "30", unitTokens: 1_000_000 },
						{ category: "reasoning", price: "40", unitTokens: 1_000_000 },
					],
				},
			],
		};

		const result = estimateCost(
			normalizeUsage(evidence),
			provider,
			tiered,
			occurredAt,
			calculatedAt,
		);

		expect(result.lines[0]?.rate.price).toBe("6");
	});

	it("keeps a known subset while exposing missing cache measurements", () => {
		const partial = {
			...completeEvidence,
			counters: { inputTokens: 1_000, outputTokens: 200 },
		};

		const result = estimateCost(
			normalizeUsage(partial),
			provider,
			snapshot(),
			occurredAt,
			calculatedAt,
		);

		expect(result.completeness).toBe("unavailable");
		expect(result.lines.map((line) => line.category)).toEqual([]);
		expect(result.issues.map((issue) => issue.category)).toEqual([
			"input",
			"cache-read-input",
			"cache-write-input",
			"reasoning",
		]);
	});

	it("refuses a mismatched model instead of applying a plausible rate", () => {
		const result = estimateCost(
			normalizeUsage(completeEvidence),
			provider,
			{ ...snapshot(), model: "other-model" },
			occurredAt,
			calculatedAt,
		);

		expect(result.completeness).toBe("unavailable");
		expect(result.lines).toEqual([]);
		expect(result.issues[0]?.code).toBe("model-mismatch");
	});

	it("sums exact values separately by currency", () => {
		const usd = estimateCost(
			normalizeUsage(completeEvidence),
			provider,
			snapshot(),
			occurredAt,
			calculatedAt,
		);
		const eur = {
			...usd,
			currency: "EUR",
			total: { currency: "EUR", amount: "0.1" },
		};

		expect(aggregateEstimates([usd, usd, eur])).toEqual([
			{ currency: "EUR", amount: "0.1", completeness: "complete" },
			{ currency: "USD", amount: "0.011665", completeness: "complete" },
		]);
	});

	it("marks known spend partial when another estimate in that currency is unavailable", () => {
		const complete = estimateCost(
			normalizeUsage(completeEvidence),
			provider,
			snapshot(),
			occurredAt,
			calculatedAt,
		);
		const unavailable = estimateCost(
			normalizeUsage(completeEvidence),
			provider,
			{ ...snapshot(), model: "unknown" },
			occurredAt,
			calculatedAt,
		);

		expect(aggregateEstimates([complete, unavailable])).toEqual([
			{ currency: "USD", amount: "0.0058325", completeness: "partial" },
		]);
	});

	it("does not represent entirely unavailable spend as zero", () => {
		const unavailable = estimateCost(
			normalizeUsage(completeEvidence),
			provider,
			{ ...snapshot(), model: "unknown" },
			occurredAt,
			calculatedAt,
		);

		expect(aggregateEstimates([unavailable])).toEqual([
			{ currency: "USD", amount: undefined, completeness: "unavailable" },
		]);
	});

	it("rejects a snapshot outside its half-open effective period", () => {
		const result = estimateCost(
			normalizeUsage(completeEvidence),
			provider,
			{ ...snapshot(), effectiveUntil: occurredAt },
			occurredAt,
			calculatedAt,
		);

		expect(result.completeness).toBe("unavailable");
		expect(result.issues).toContainEqual(
			expect.objectContaining({ code: "outside-effective-period" }),
		);
	});

	it("prefers an effective connection override and rejects ambiguous rates", () => {
		const generic = snapshot();
		const override = { ...snapshot(), snapshotId: "override", connectionId: "connection-1" };
		expect(resolvePricingSnapshot(provider, occurredAt, [generic, override])).toEqual({
			status: "resolved",
			snapshot: override,
		});
		expect(resolvePricingSnapshot(provider, occurredAt, [generic, { ...generic }])).toEqual({
			status: "unavailable",
			issue: expect.objectContaining({ code: "ambiguous-snapshot" }),
		});
	});

	it("is deterministic for the same evidence and snapshot", () => {
		const usage = normalizeUsage(completeEvidence);
		const rates = snapshot();
		expect(estimateCost(usage, provider, rates, occurredAt, calculatedAt)).toEqual(
			estimateCost(usage, provider, rates, occurredAt, calculatedAt),
		);
	});

	it("refuses inconsistent or invalid counters without throwing", () => {
		const invalid = normalizeUsage({
			...completeEvidence,
			counters: { ...completeEvidence.counters, outputTokens: -1 },
		});
		const result = estimateCost(invalid, provider, snapshot(), occurredAt, calculatedAt);

		expect(result.completeness).toBe("unavailable");
		expect(result.lines).toEqual([]);
		expect(result.issues).toContainEqual(expect.objectContaining({ code: "inconsistent-usage" }));
	});

	it("rejects internally inconsistent estimate currencies during aggregation", () => {
		const estimate = estimateCost(
			normalizeUsage(completeEvidence),
			provider,
			snapshot(),
			occurredAt,
			calculatedAt,
		);
		expect(() =>
			aggregateEstimates([
				{ ...estimate, total: { currency: "EUR", amount: estimate.total?.amount ?? "0" } },
			]),
		).toThrow("currency");
	});

	it("records corrections as explicit immutable revisions", () => {
		const estimate = estimateCost(
			normalizeUsage(completeEvidence),
			provider,
			snapshot(),
			occurredAt,
			calculatedAt,
		);
		const revision = costEstimateRevision(estimate, {
			estimateId: "estimate-2",
			supersedesEstimateId: "estimate-1",
			revisionReason: "Provider corrected token evidence",
			provenance: "reconciliation-job-1",
		});

		expect(Object.isFrozen(revision)).toBe(true);
		expect(revision.supersedesEstimateId).toBe("estimate-1");
	});
});

function snapshot(): PricingSnapshot {
	return {
		snapshotId: "rates-1",
		provider: "anthropic",
		model: "model-1",
		currency: "USD",
		source: { name: "fixture", retrievedAt: "2026-09-18T00:00:00.000Z" },
		effectiveFrom: "2026-09-01T00:00:00.000Z",
		tiers: [
			{
				minimumContextTokens: 0,
				rates: [
					{ category: "input", price: "3", unitTokens: 1_000_000 },
					{ category: "cache-read-input", price: "0.3", unitTokens: 1_000_000 },
					{ category: "cache-write-input", price: "3.75", unitTokens: 1_000_000 },
					{ category: "output", price: "15", unitTokens: 1_000_000 },
					{ category: "reasoning", price: "20", unitTokens: 1_000_000 },
				],
			},
		],
	};
}
