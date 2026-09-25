import { Schema } from "effect";
import { type AttemptLedger, reduceAttempt } from "./lifecycle.ts";
import {
	AttemptIntent,
	AttemptObservation,
	PricingSnapshot,
	Timestamp,
	UsageEvidence,
} from "./schemas.ts";

export const decodeIntent = Schema.decodeUnknownSync(AttemptIntent);
export const decodeObservation = Schema.decodeUnknownSync(AttemptObservation);
export const decodeSnapshot = Schema.decodeUnknownSync(PricingSnapshot);
export const timestamp = Timestamp.make;

export const successfulAttempt = decodeIntent({
	attemptId: "attempt-success",
	executionId: "execution-success",
	startedAt: "2026-09-18T00:00:00.000Z",
	attribution: { workspaceId: "workspace-1", workspaceName: "Example workspace" },
	provider: {
		connectionId: "connection-1",
		provider: "anthropic",
		requestedModel: "claude-sonnet-4-5",
	},
});

export const completeUsageEvidence = Schema.decodeSync(UsageEvidence)({
	normalizationVersion: 1,
	source: { kind: "provider", name: "anthropic" },
	counters: {
		inputTokens: 1_000,
		uncachedInputTokens: 800,
		cacheReadInputTokens: 150,
		cacheWriteInputTokens: 50,
		outputTokens: 200,
		reasoningTokens: 40,
	},
});

export const partialUsageEvidence = Schema.decodeSync(UsageEvidence)({
	normalizationVersion: 1,
	source: { kind: "provider", name: "anthropic" },
	counters: { inputTokens: 1_000 },
});

export function intentFor(attemptId: string): AttemptIntent {
	return decodeIntent({ ...successfulAttempt, attemptId, executionId: `execution-${attemptId}` });
}

export function usageObservation(
	intent: AttemptIntent,
	observationId: string,
	evidence: UsageEvidence = completeUsageEvidence,
	supersedesObservationId?: string,
): AttemptObservation {
	return decodeObservation({
		observationId,
		attemptId: intent.attemptId,
		observedAt: "2026-09-18T10:00:01.000Z",
		...(supersedesObservationId === undefined ? {} : { supersedesObservationId }),
		payload: { type: "usage", evidence },
	});
}

export function ledgerWithUsage(
	intent: AttemptIntent,
	evidence: UsageEvidence = completeUsageEvidence,
): AttemptLedger {
	return reduceAttempt(intent, [usageObservation(intent, `${intent.attemptId}:usage:1`, evidence)]);
}

export function snapshot(overrides: Record<string, unknown> = {}): PricingSnapshot {
	return decodeSnapshot({
		snapshotId: "rates-1",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
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
		...overrides,
	});
}
