import type { DecimalAmount } from "./decimal.ts";
import type {
	Currency,
	EstimateId,
	ExecutionOutcome,
	ObservationId,
	ProviderRequest,
	RateCategory,
	SnapshotId,
	Timestamp,
	TokenRate,
	UsageCounterField,
	UsageCounters,
} from "./schemas.ts";

/**
 * `complete` means the input and output totals were both measured and agree with their
 * breakdowns. Breakdowns such as cache or reasoning tokens may still be absent; pricing reports
 * any that a rate needs.
 */
export type MeasurementCompleteness = "unmeasured" | "partial" | "complete";
export type EstimateCompleteness = "unavailable" | "partial" | "complete";
export type AttemptState = "intended" | "dispatched" | ExecutionOutcome;

export type UsageIssueCode =
	| "invalid-counter"
	| "input-components-exceed-total"
	| "input-components-incomplete"
	| "reasoning-exceeds-output"
	| "unsupported-provider-evidence";

export interface UsageIssue {
	readonly code: UsageIssueCode;
	readonly field?: UsageCounterField;
	readonly message: string;
}

export interface NormalizedUsage {
	readonly counters: UsageCounters;
	readonly completeness: MeasurementCompleteness;
	readonly issues: readonly UsageIssue[];
}

/** The requested provider and model, plus what the provider's response said it used. */
export interface ProviderIdentity extends ProviderRequest {
	readonly returnedModel?: string;
	readonly providerRequestId?: string;
}

export type LedgerIssueCode =
	| "attempt-mismatch"
	| "observed-before-start"
	| "conflicting-id"
	| "missing-correction-target"
	| "correction-type-mismatch"
	| "conflicting-usage"
	| "conflicting-response-metadata"
	| "conflicting-terminal-state";

export interface LedgerIssue {
	readonly code: LedgerIssueCode;
	readonly observationId: ObservationId;
	readonly message: string;
}

export interface CostLine {
	readonly category: RateCategory;
	readonly quantity: number;
	readonly rate: TokenRate;
	readonly amount: DecimalAmount;
}

export type PricingIssueCode =
	| "missing-measurement"
	| "unsupported-category"
	| "inconsistent-usage"
	| "no-snapshot"
	| "ambiguous-snapshot";

export interface PricingIssue {
	readonly code: PricingIssueCode;
	readonly category?: RateCategory;
	readonly message: string;
}

interface CostEstimateBase {
	readonly calculationVersion: 1;
	readonly calculatedAt: Timestamp;
	readonly issues: readonly PricingIssue[];
}

/** An estimate never reports unpriced usage as zero: without a priced line it is `unavailable`. */
export type CostEstimate =
	| (CostEstimateBase & {
			readonly completeness: "unavailable";
			readonly snapshotId?: SnapshotId;
	  })
	| (CostEstimateBase & {
			readonly completeness: "partial" | "complete";
			readonly snapshotId: SnapshotId;
			readonly currency: Currency;
			readonly lines: readonly CostLine[];
			readonly total: DecimalAmount;
	  });

export interface CostEstimateRevisionMetadata {
	readonly estimateId: EstimateId;
	/** What produced this estimate, such as a job or request ID. */
	readonly provenance: string;
	readonly correction?: {
		readonly supersedesEstimateId: EstimateId;
		readonly reason: string;
	};
}

/** A stored estimate. A correction is a new revision that names the one it replaces. */
export type CostEstimateRevision = CostEstimate & CostEstimateRevisionMetadata;
