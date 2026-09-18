import type { AttemptIntent, AttemptObservation, UsageEvidence } from "./types.ts";

const startedAt = "2026-09-18T00:00:00.000Z";
const attribution = { workspaceId: "workspace-1", workspaceName: "Example workspace" };
const provider = {
	connectionId: "connection-1",
	provider: "anthropic",
	requestedModel: "claude-sonnet-4-5",
};

export const successfulAttempt: AttemptIntent = {
	attemptId: "attempt-success",
	executionId: "execution-success",
	startedAt,
	attribution,
	provider,
};

export const failedAttempt: AttemptIntent = {
	...successfulAttempt,
	attemptId: "attempt-failed",
	executionId: "execution-failed",
};

export const cancelledAttempt: AttemptIntent = {
	...successfulAttempt,
	attemptId: "attempt-cancelled",
	executionId: "execution-cancelled",
};

export const retriedAttempt: AttemptIntent = {
	...successfulAttempt,
	attemptId: "attempt-retry",
	retryOfAttemptId: failedAttempt.attemptId,
	executionId: failedAttempt.executionId,
};

export const completeUsageEvidence: UsageEvidence = {
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
};

export const partialUsageEvidence: UsageEvidence = {
	normalizationVersion: 1,
	source: { kind: "provider", name: "anthropic" },
	counters: { inputTokens: 1_000 },
};

export const representativeObservations: readonly AttemptObservation[] = [
	{
		observationId: "attempt-success:usage",
		attemptId: successfulAttempt.attemptId,
		observedAt: "2026-09-18T10:00:01.000Z",
		payload: { type: "usage", evidence: completeUsageEvidence },
	},
	{
		observationId: "attempt-success:terminal",
		attemptId: successfulAttempt.attemptId,
		observedAt: "2026-09-18T10:00:02.000Z",
		payload: {
			type: "terminal",
			endedAt: "2026-09-18T10:00:02.000Z",
			outcome: "succeeded",
		},
	},
	{
		observationId: "attempt-failed:terminal",
		attemptId: failedAttempt.attemptId,
		observedAt: "2026-09-18T10:00:02.000Z",
		payload: {
			type: "terminal",
			endedAt: "2026-09-18T10:00:02.000Z",
			outcome: "failed",
			errorCode: "provider_error",
		},
	},
	{
		observationId: "attempt-cancelled:usage",
		attemptId: cancelledAttempt.attemptId,
		observedAt: "2026-09-18T10:00:01.000Z",
		payload: { type: "usage", evidence: partialUsageEvidence },
	},
	{
		observationId: "attempt-cancelled:terminal",
		attemptId: cancelledAttempt.attemptId,
		observedAt: "2026-09-18T10:00:02.000Z",
		payload: {
			type: "terminal",
			endedAt: "2026-09-18T10:00:02.000Z",
			outcome: "cancelled",
		},
	},
];

export const representativeAccountingRecords = {
	successful: { intent: successfulAttempt, usage: completeUsageEvidence },
	failed: { intent: failedAttempt, usage: undefined },
	cancelled: { intent: cancelledAttempt, usage: partialUsageEvidence },
	retried: { intent: retriedAttempt, usage: completeUsageEvidence },
	unpriced: { intent: successfulAttempt, usage: completeUsageEvidence, pricingSnapshot: undefined },
	partiallyMeasured: { intent: cancelledAttempt, usage: partialUsageEvidence },
} as const;
