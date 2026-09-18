export type MeasurementCompleteness = "unmeasured" | "partial" | "complete";
export type EstimateCompleteness = "unavailable" | "partial" | "complete";
export type ExecutionOutcome = "succeeded" | "failed" | "cancelled" | "unknown";
export type AttemptState =
	| "intended"
	| "dispatched"
	| "succeeded"
	| "failed"
	| "cancelled"
	| "unknown";
export type ReconciliationStatus = "unreconciled" | "matched" | "adjusted" | "disputed";

export interface AccountingExecution {
	readonly executionId: string;
	readonly startedAt: string;
	readonly endedAt?: string;
	readonly outcome?: ExecutionOutcome;
	readonly attribution: AttributionSnapshot;
}

export interface ModelStep {
	readonly stepId: string;
	readonly executionId: string;
	readonly sequence: number;
}

export interface AttributionSnapshot {
	workspaceId: string;
	workspaceName?: string;
	podId?: string;
	podName?: string;
	agentId?: string;
	agentName?: string;
	threadId?: string;
	chatId?: string;
	activityPurpose?: string;
}

export interface ProviderIdentity {
	readonly connectionId: string;
	readonly provider: string;
	readonly requestedModel: string;
	readonly returnedModel?: string;
	readonly providerRequestId?: string;
}

export interface AttemptIntent {
	attemptId: string;
	executionId: string;
	stepId?: string;
	retryOfAttemptId?: string;
	startedAt: string;
	attribution: AttributionSnapshot;
	provider: ProviderIdentity;
}

export interface UsageCounters {
	inputTokens?: number;
	uncachedInputTokens?: number;
	cacheReadInputTokens?: number;
	cacheWriteInputTokens?: number;
	outputTokens?: number;
	reasoningTokens?: number;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface UsageEvidence {
	normalizationVersion: 1;
	source: {
		kind: "ai-sdk" | "provider" | "manual";
		name: string;
		version?: string;
	};
	counters: UsageCounters;
	raw?: { [key: string]: JsonValue };
}

export type UsageIssueCode =
	| "invalid-counter"
	| "input-components-exceed-total"
	| "reasoning-exceeds-output"
	| "input-components-incomplete"
	| "unsupported-provider-evidence";

export interface UsageIssue {
	code: UsageIssueCode;
	field?: keyof UsageCounters;
	message: string;
}

export interface NormalizedUsage {
	input: {
		total?: number;
		uncached?: number;
		cacheRead?: number;
		cacheWrite?: number;
	};
	output: {
		total?: number;
		reasoning?: number;
	};
	completeness: MeasurementCompleteness;
	issues: UsageIssue[];
}

export interface UsageObservationPayload {
	type: "usage";
	evidence: UsageEvidence;
}

export interface DispatchedObservationPayload {
	type: "dispatched";
	dispatchedAt: string;
}

export interface TerminalObservationPayload {
	type: "terminal";
	endedAt: string;
	outcome: ExecutionOutcome;
	errorCode?: string;
}

export interface ResponseMetadataObservationPayload {
	type: "response-metadata";
	returnedModel: string;
	providerRequestId?: string;
}

export type ObservationPayload =
	| UsageObservationPayload
	| DispatchedObservationPayload
	| ResponseMetadataObservationPayload
	| TerminalObservationPayload;

export interface AttemptObservation {
	observationId: string;
	attemptId: string;
	observedAt: string;
	supersedesObservationId?: string;
	payload: ObservationPayload;
}

export interface AttemptLedger {
	intent: AttemptIntent;
	observations: readonly AttemptObservation[];
	state: AttemptState;
	measurementCompleteness: MeasurementCompleteness;
	issues: readonly LedgerIssue[];
}

export type LedgerIssueCode =
	| "duplicate"
	| "conflicting-id"
	| "missing-correction-target"
	| "correction-attempt-mismatch"
	| "superseded-observation"
	| "conflicting-terminal-state"
	| "conflicting-usage"
	| "invalid-record";

export interface LedgerIssue {
	code: LedgerIssueCode;
	observationId: string;
	message: string;
}

export interface Money {
	currency: string;
	amount: string;
}

export interface ProviderReportedCharge {
	chargeId: string;
	scope: "attempt" | "response" | "execution";
	scopeId: string;
	amount: Money;
	source: string;
	reportedAt: string;
	reconciliationStatus: ReconciliationStatus;
}

export type RateCategory =
	| "input"
	| "cache-read-input"
	| "cache-write-input"
	| "output"
	| "reasoning";

export interface TokenRate {
	readonly category: RateCategory;
	readonly price: string;
	readonly unitTokens: number;
}

export interface PricingTier {
	readonly minimumContextTokens: number;
	readonly rates: readonly TokenRate[];
}

export interface PricingSnapshot {
	readonly snapshotId: string;
	readonly provider: string;
	readonly model: string;
	readonly connectionId?: string;
	readonly currency: string;
	readonly source: {
		readonly name: string;
		readonly url?: string;
		readonly version?: string;
		readonly retrievedAt: string;
	};
	readonly effectiveFrom: string;
	readonly effectiveUntil?: string;
	readonly tiers: readonly PricingTier[];
}

export interface CostLine {
	category: RateCategory;
	quantity: number;
	rate: TokenRate;
	amount: Money;
}

export type PricingIssueCode =
	| "invalid-snapshot"
	| "model-mismatch"
	| "missing-measurement"
	| "unsupported-category"
	| "inconsistent-usage"
	| "outside-effective-period"
	| "ambiguous-snapshot";

export interface PricingIssue {
	code: PricingIssueCode;
	category?: RateCategory;
	message: string;
}

export interface CostEstimate {
	readonly calculationVersion: 1;
	readonly snapshotId: string;
	readonly currency: string;
	readonly calculatedAt: string;
	readonly lines: readonly CostLine[];
	readonly total?: Money;
	readonly completeness: EstimateCompleteness;
	readonly issues: readonly PricingIssue[];
}

export interface CostEstimateRevision extends CostEstimate {
	readonly estimateId: string;
	readonly supersedesEstimateId?: string;
	readonly revisionReason?: string;
	readonly provenance: string;
}
