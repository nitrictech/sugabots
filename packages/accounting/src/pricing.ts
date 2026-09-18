import { Data, Effect } from "effect";
import { addDecimalAmounts, multiplyRate, validateMoneyAmount, validateRate } from "./decimal.ts";
import type {
	CostEstimate,
	CostLine,
	EstimateCompleteness,
	NormalizedUsage,
	PricingIssue,
	PricingSnapshot,
	PricingTier,
	ProviderIdentity,
	RateCategory,
	TokenRate,
} from "./types.ts";

export class PricingCalculationError extends Data.TaggedError("PricingCalculationError")<{
	readonly cause: unknown;
}> {}

export const estimateCost = Effect.fn("accounting.estimateCost")(function* (
	usage: NormalizedUsage,
	provider: ProviderIdentity,
	snapshot: PricingSnapshot,
	occurredAt: string,
	calculatedAt: string,
) {
	yield* Effect.annotateCurrentSpan({
		"accounting.provider": provider.provider,
		"accounting.model": provider.returnedModel ?? provider.requestedModel,
		"accounting.pricing.snapshot_id": snapshot.snapshotId,
		"accounting.currency": snapshot.currency,
	});
	return yield* Effect.try({
		try: () => estimateCostSync(usage, provider, snapshot, occurredAt, calculatedAt),
		catch: (cause) => new PricingCalculationError({ cause }),
	});
});

export function estimateCostSync(
	usage: NormalizedUsage,
	provider: ProviderIdentity,
	snapshot: PricingSnapshot,
	occurredAt: string,
	calculatedAt: string,
): CostEstimate {
	const issues = validateSnapshot(snapshot);
	validateEffectivePeriod(snapshot, occurredAt, issues);
	const model = provider.returnedModel ?? provider.requestedModel;
	if (snapshot.provider !== provider.provider || snapshot.model !== model) {
		issues.push({
			code: "model-mismatch",
			message: `Snapshot ${snapshot.provider}/${snapshot.model} does not match ${provider.provider}/${model}`,
		});
	}
	if (snapshot.connectionId !== undefined && snapshot.connectionId !== provider.connectionId) {
		issues.push({
			code: "model-mismatch",
			message: `Snapshot connection ${snapshot.connectionId} does not match ${provider.connectionId}`,
		});
	}
	if (usage.issues.length > 0) {
		issues.push({
			code: "inconsistent-usage",
			message: "Usage evidence is inconsistent and cannot produce a complete estimate",
		});
	}
	if (
		issues.some(
			(issue) =>
				issue.code === "invalid-snapshot" ||
				issue.code === "model-mismatch" ||
				issue.code === "outside-effective-period",
		) ||
		usage.issues.length > 0
	) {
		return {
			calculationVersion: 1,
			snapshotId: snapshot.snapshotId,
			currency: snapshot.currency,
			calculatedAt,
			lines: [],
			completeness: "unavailable",
			issues,
		};
	}

	const tier = selectTier(snapshot.tiers, usage.input.total, issues);
	const lines = tier ? calculateLines(usage, tier, snapshot.currency, issues) : [];
	const total =
		lines.length > 0
			? {
					currency: snapshot.currency,
					amount: addDecimalAmounts(lines.map((line) => line.amount.amount)),
				}
			: undefined;
	const completeness =
		issues.length === 0 && usage.completeness === "complete"
			? "complete"
			: lines.length > 0
				? "partial"
				: "unavailable";

	return {
		calculationVersion: 1,
		snapshotId: snapshot.snapshotId,
		currency: snapshot.currency,
		calculatedAt,
		lines,
		total,
		completeness,
		issues,
	};
}

export interface CostEstimateAggregate {
	readonly currency: string;
	readonly amount?: string;
	readonly completeness: EstimateCompleteness;
}

export const aggregateEstimates = Effect.fn("accounting.aggregateEstimates")(function* (
	estimates: readonly CostEstimate[],
) {
	return yield* Effect.try({
		try: () => aggregateEstimatesSync(estimates),
		catch: (cause) => new PricingCalculationError({ cause }),
	});
});

export function aggregateEstimatesSync(
	estimates: readonly CostEstimate[],
): readonly CostEstimateAggregate[] {
	const currencies = new Map<string, { amounts: string[]; complete: boolean }>();
	for (const estimate of estimates) {
		if (estimate.total?.currency !== undefined && estimate.total.currency !== estimate.currency) {
			throw new Error("Estimate total currency does not match estimate currency");
		}
		if (estimate.total && validateMoneyAmount(estimate.total.amount)) {
			throw new Error("Estimate total has an invalid amount");
		}
		const aggregate = currencies.get(estimate.currency) ?? { amounts: [], complete: true };
		if (estimate.total) aggregate.amounts.push(estimate.total.amount);
		aggregate.complete &&= estimate.completeness === "complete";
		currencies.set(estimate.currency, aggregate);
	}
	return [...currencies.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([currency, aggregate]) => ({
			currency,
			amount: aggregate.amounts.length > 0 ? addDecimalAmounts(aggregate.amounts) : undefined,
			completeness:
				aggregate.amounts.length === 0
					? "unavailable"
					: aggregate.complete
						? "complete"
						: "partial",
		}));
}

export type ResolvePricingSnapshotResult =
	| { status: "resolved"; snapshot: PricingSnapshot }
	| { status: "unavailable"; issue: PricingIssue };

export const resolvePricingSnapshot = Effect.fn("accounting.resolvePricingSnapshot")(function* (
	provider: ProviderIdentity,
	occurredAt: string,
	candidates: readonly PricingSnapshot[],
) {
	return yield* Effect.succeed(resolvePricingSnapshotSync(provider, occurredAt, candidates));
});

export function resolvePricingSnapshotSync(
	provider: ProviderIdentity,
	occurredAt: string,
	candidates: readonly PricingSnapshot[],
): ResolvePricingSnapshotResult {
	const timestamp = Date.parse(occurredAt);
	if (!Number.isFinite(timestamp)) {
		return {
			status: "unavailable",
			issue: { code: "invalid-snapshot", message: `Invalid attempt timestamp: ${occurredAt}` },
		};
	}
	const model = provider.returnedModel ?? provider.requestedModel;
	const matching = candidates.filter(
		(snapshot) =>
			snapshot.provider === provider.provider &&
			snapshot.model === model &&
			(snapshot.connectionId === undefined || snapshot.connectionId === provider.connectionId) &&
			isEffective(snapshot, timestamp),
	);
	const connectionSpecific = matching.filter(
		(snapshot) => snapshot.connectionId === provider.connectionId,
	);
	const eligible = connectionSpecific.length > 0 ? connectionSpecific : matching;
	const latestEffectiveFrom = Math.max(
		...eligible.map((snapshot) => Date.parse(snapshot.effectiveFrom)),
	);
	const latest = eligible.filter(
		(snapshot) => Date.parse(snapshot.effectiveFrom) === latestEffectiveFrom,
	);
	if (latest.length === 0) {
		return {
			status: "unavailable",
			issue: { code: "missing-measurement", message: "No effective pricing snapshot was found" },
		};
	}
	if (latest.length > 1) {
		return {
			status: "unavailable",
			issue: {
				code: "ambiguous-snapshot",
				message: `Multiple pricing snapshots are effective for ${provider.provider}/${model}`,
			},
		};
	}
	return { status: "resolved", snapshot: latest[0] as PricingSnapshot };
}

function validateSnapshot(snapshot: PricingSnapshot): PricingIssue[] {
	const issues: PricingIssue[] = [];
	if (!/^[A-Z]{3}$/.test(snapshot.currency)) {
		issues.push({ code: "invalid-snapshot", message: "Currency must be an ISO 4217 code" });
	}
	if (snapshot.tiers.length === 0 || snapshot.tiers[0]?.minimumContextTokens !== 0) {
		issues.push({ code: "invalid-snapshot", message: "Pricing tiers must start at zero" });
	}
	let previousMinimum = -1;
	for (const tier of snapshot.tiers) {
		if (
			!Number.isSafeInteger(tier.minimumContextTokens) ||
			tier.minimumContextTokens < 0 ||
			tier.minimumContextTokens <= previousMinimum
		) {
			issues.push({
				code: "invalid-snapshot",
				message: "Pricing tiers must be strictly ascending",
			});
		}
		previousMinimum = tier.minimumContextTokens;
		const categories = new Set<RateCategory>();
		for (const rate of tier.rates) {
			if (categories.has(rate.category)) {
				issues.push({
					code: "invalid-snapshot",
					category: rate.category,
					message: `Tier contains duplicate ${rate.category} rates`,
				});
			}
			categories.add(rate.category);
			const error = validateRate(rate.price, rate.unitTokens);
			if (error) {
				issues.push({
					code: "invalid-snapshot",
					category: rate.category,
					message: error,
				});
			}
		}
	}
	return issues;
}

function validateEffectivePeriod(
	snapshot: PricingSnapshot,
	occurredAt: string,
	issues: PricingIssue[],
): void {
	const timestamp = Date.parse(occurredAt);
	if (!Number.isFinite(timestamp) || !isEffective(snapshot, timestamp)) {
		issues.push({
			code: "outside-effective-period",
			message: `Snapshot ${snapshot.snapshotId} was not effective at ${occurredAt}`,
		});
	}
}

function isEffective(snapshot: PricingSnapshot, timestamp: number): boolean {
	const start = Date.parse(snapshot.effectiveFrom);
	const end =
		snapshot.effectiveUntil === undefined
			? Number.POSITIVE_INFINITY
			: Date.parse(snapshot.effectiveUntil);
	return (
		Number.isFinite(start) &&
		(snapshot.effectiveUntil === undefined || Number.isFinite(end)) &&
		timestamp >= start &&
		timestamp < end
	);
}

function selectTier(
	tiers: readonly PricingTier[],
	contextTokens: number | undefined,
	issues: PricingIssue[],
): PricingTier | undefined {
	if (tiers.length === 0) return undefined;
	if (tiers.length > 1 && contextTokens === undefined) {
		issues.push({
			code: "missing-measurement",
			message: "Input total is required to select a context-length pricing tier",
		});
		return undefined;
	}
	return tiers.findLast((tier) => tier.minimumContextTokens <= (contextTokens ?? 0));
}

function calculateLines(
	usage: NormalizedUsage,
	tier: PricingTier,
	currency: string,
	issues: PricingIssue[],
): CostLine[] {
	const rates = new Map(tier.rates.map((rate) => [rate.category, rate]));
	return [
		...inputLines(usage, rates, currency, issues),
		...outputLines(usage, rates, currency, issues),
	];
}

function inputLines(
	usage: NormalizedUsage,
	rates: ReadonlyMap<RateCategory, TokenRate>,
	currency: string,
	issues: PricingIssue[],
): CostLine[] {
	if (usage.input.total === undefined) {
		missing("input", issues);
		return [];
	}
	const hasCacheRates = rates.has("cache-read-input") || rates.has("cache-write-input");
	if (!hasCacheRates) return lineFor("input", usage.input.total, rates, currency, issues);

	const lines: CostLine[] = [];
	if (usage.input.uncached === undefined) missing("input", issues);
	else lines.push(...lineFor("input", usage.input.uncached, rates, currency, issues));
	lines.push(
		...cacheLine("cache-read-input", usage.input.cacheRead, rates, currency, issues),
		...cacheLine("cache-write-input", usage.input.cacheWrite, rates, currency, issues),
	);
	return lines;
}

function outputLines(
	usage: NormalizedUsage,
	rates: ReadonlyMap<RateCategory, TokenRate>,
	currency: string,
	issues: PricingIssue[],
): CostLine[] {
	if (usage.output.total === undefined) {
		missing("output", issues);
		return [];
	}
	if (!rates.has("reasoning")) {
		return lineFor("output", usage.output.total, rates, currency, issues);
	}
	if (usage.output.reasoning === undefined) {
		missing("reasoning", issues);
		return [];
	}
	if (usage.output.reasoning > usage.output.total) return [];
	return [
		...lineFor("output", usage.output.total - usage.output.reasoning, rates, currency, issues),
		...lineFor("reasoning", usage.output.reasoning, rates, currency, issues),
	];
}

function cacheLine(
	category: "cache-read-input" | "cache-write-input",
	quantity: number | undefined,
	rates: ReadonlyMap<RateCategory, TokenRate>,
	currency: string,
	issues: PricingIssue[],
): CostLine[] {
	if (rates.has(category)) {
		if (quantity === undefined) {
			missing(category, issues);
			return [];
		}
		return lineFor(category, quantity, rates, currency, issues);
	}
	if (quantity !== undefined && quantity > 0) {
		issues.push({
			code: "unsupported-category",
			category,
			message: `No ${category} rate is available for ${quantity} measured tokens`,
		});
	}
	return [];
}

function lineFor(
	category: RateCategory,
	quantity: number,
	rates: ReadonlyMap<RateCategory, TokenRate>,
	currency: string,
	issues: PricingIssue[],
): CostLine[] {
	const rate = rates.get(category);
	if (!rate) {
		if (quantity > 0) {
			issues.push({
				code: "unsupported-category",
				category,
				message: `No ${category} rate is available for ${quantity} measured tokens`,
			});
		}
		return [];
	}
	return [
		{
			category,
			quantity,
			rate: { ...rate },
			amount: { currency, amount: multiplyRate(quantity, rate.price, rate.unitTokens) },
		},
	];
}

function missing(category: RateCategory, issues: PricingIssue[]): void {
	issues.push({
		code: "missing-measurement",
		category,
		message: `${category} usage is not measured`,
	});
}
