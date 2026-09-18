import { Effect, Tracer } from "effect";
import { describe, expect, it } from "vitest";
import { AttemptAggregationError, aggregateAttempts } from "./aggregation.ts";
import { completeUsageEvidence } from "./examples.ts";
import { createAttemptLedgerSync } from "./lifecycle.ts";
import { normalizeUsage } from "./normalization.ts";
import { aggregateEstimates, estimateCost, PricingCalculationError } from "./pricing.ts";
import type { PricingSnapshot, ProviderIdentity } from "./types.ts";

describe("Effect API", () => {
	it("creates named spans for accounting operations", async () => {
		const spans: Tracer.NativeSpan[] = [];
		const tracer = Tracer.make({
			span: (options) => {
				const span = new Tracer.NativeSpan(options);
				spans.push(span);
				return span;
			},
		});
		const program = Effect.gen(function* () {
			const usage = yield* normalizeUsage(completeUsageEvidence);
			return yield* estimateCost(
				usage,
				provider,
				snapshot,
				"2026-09-18T10:00:00.000Z",
				"2026-09-18T11:00:00.000Z",
			);
		}).pipe(
			Effect.withSpan("accounting.test-parent"),
			Effect.provideService(Tracer.Tracer, tracer),
		);

		await Effect.runPromise(program);

		expect(spans.map((span) => span.name)).toEqual([
			"accounting.test-parent",
			"accounting.normalizeUsage",
			"accounting.estimateCost",
		]);
	});

	it("reports calculation exceptions through the typed failure channel", async () => {
		const result = await Effect.runPromise(
			Effect.flip(
				aggregateEstimates([
					{
						calculationVersion: 1,
						snapshotId: "invalid",
						currency: "USD",
						calculatedAt: "2026-09-18T11:00:00.000Z",
						lines: [],
						total: { currency: "USD", amount: "-1" },
						completeness: "complete",
						issues: [],
					},
				]),
			),
		);

		expect(result).toBeInstanceOf(PricingCalculationError);
	});

	it("reports duplicate attempt aggregation through the typed failure channel", async () => {
		const ledger = createAttemptLedgerSync({
			attemptId: "attempt-1",
			executionId: "execution-1",
			startedAt: "2026-09-18T10:00:00.000Z",
			attribution: { workspaceId: "workspace-1" },
			provider,
		});
		const error = await Effect.runPromise(Effect.flip(aggregateAttempts([ledger, ledger])));

		expect(error).toBeInstanceOf(AttemptAggregationError);
	});
});

const provider: ProviderIdentity = {
	connectionId: "connection-1",
	provider: "anthropic",
	requestedModel: "model-1",
};

const snapshot: PricingSnapshot = {
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
