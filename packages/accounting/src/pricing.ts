import { type DecimalAmount, multiplyRate, sumDecimalAmounts } from "./decimal.ts";
import type { AttemptLedger } from "./lifecycle.ts";
import {
	type Currency,
	epochMilliseconds,
	type PricingSnapshot,
	type PricingTier,
	type RateCategory,
	type Timestamp,
	type TokenRate,
	type UsageCounters,
} from "./schemas.ts";
import type {
	CostEstimate,
	CostLine,
	EstimateCompleteness,
	PricingIssue,
	ProviderIdentity,
} from "./types.ts";

const CALCULATION_VERSION = 1;

/**
 * Prices an attempt's active usage against the snapshot in effect when the attempt started, for
 * the model the provider returned (or requested, if none was returned) and the attempt's connection.
 */
export function estimateAttempt(
	ledger: AttemptLedger,
	candidateSnapshots: readonly PricingSnapshot[],
	calculatedAt: Timestamp,
): CostEstimate {
	const unavailable = (
		issues: readonly PricingIssue[],
		snapshot?: PricingSnapshot,
	): CostEstimate => ({
		calculationVersion: CALCULATION_VERSION,
		calculatedAt,
		completeness: "unavailable",
		snapshotId: snapshot?.snapshotId,
		issues,
	});

	if (!ledger.usage) {
		return unavailable([{ code: "missing-measurement", message: "No usage was recorded" }]);
	}
	if (ledger.usage.issues.length > 0) {
		return unavailable([
			{
				code: "inconsistent-usage",
				message: "Usage evidence is inconsistent and cannot be priced",
			},
		]);
	}
	const resolved = resolveSnapshot(ledger.provider, ledger.intent.startedAt, candidateSnapshots);
	if ("issue" in resolved) return unavailable([resolved.issue]);

	const { snapshot } = resolved;
	const tier = selectTier(snapshot.tiers, ledger.usage.counters.inputTokens);
	if ("issue" in tier) return unavailable([tier.issue], snapshot);

	const rates = new Map(tier.tier.rates.map((rate) => [rate.category, rate]));
	const priced = combine([
		inputLines(ledger.usage.counters, rates),
		outputLines(ledger.usage.counters, rates),
	]);
	if (priced.lines.length === 0) {
		return unavailable(priced.issues.length > 0 ? priced.issues : [noPricedLines], snapshot);
	}
	return {
		calculationVersion: CALCULATION_VERSION,
		calculatedAt,
		snapshotId: snapshot.snapshotId,
		currency: snapshot.currency,
		lines: priced.lines,
		total: sumDecimalAmounts(priced.lines.map((line) => line.amount)),
		completeness: priced.issues.length === 0 ? "complete" : "partial",
		issues: priced.issues,
	};
}

const noPricedLines: PricingIssue = {
	code: "missing-measurement",
	message: "No usage could be priced",
};

export interface CostEstimateAggregate {
	/** Known spend per currency, sorted by currency code. Currencies are never converted. */
	readonly totals: readonly { readonly currency: Currency; readonly amount: DecimalAmount }[];
	readonly estimates: number;
	readonly unavailableEstimates: number;
	readonly completeness: EstimateCompleteness;
}

export function aggregateEstimates(estimates: readonly CostEstimate[]): CostEstimateAggregate {
	const amountsByCurrency = new Map<Currency, DecimalAmount[]>();
	for (const estimate of estimates) {
		if (estimate.completeness === "unavailable") continue;
		amountsByCurrency.set(estimate.currency, [
			...(amountsByCurrency.get(estimate.currency) ?? []),
			estimate.total,
		]);
	}
	const unavailableEstimates = estimates.filter(
		(estimate) => estimate.completeness === "unavailable",
	).length;
	const allComplete = estimates.every((estimate) => estimate.completeness === "complete");
	return {
		totals: [...amountsByCurrency.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([currency, amounts]) => ({ currency, amount: sumDecimalAmounts(amounts) })),
		estimates: estimates.length,
		unavailableEstimates,
		completeness: allComplete
			? "complete"
			: unavailableEstimates === estimates.length
				? "unavailable"
				: "partial",
	};
}

type Resolution<T> = T | { readonly issue: PricingIssue };

/** Prefers a snapshot for the attempt's connection, then the latest-starting one in effect. */
function resolveSnapshot(
	provider: ProviderIdentity,
	occurredAt: Timestamp,
	candidates: readonly PricingSnapshot[],
): Resolution<{ readonly snapshot: PricingSnapshot }> {
	const model = provider.returnedModel ?? provider.requestedModel;
	const matching = candidates.filter(
		(snapshot) =>
			snapshot.provider === provider.provider &&
			snapshot.model === model &&
			(snapshot.connectionId === undefined || snapshot.connectionId === provider.connectionId) &&
			isEffectiveAt(snapshot, epochMilliseconds(occurredAt)),
	);
	const connectionSpecific = matching.filter(
		(snapshot) => snapshot.connectionId === provider.connectionId,
	);
	const eligible = connectionSpecific.length > 0 ? connectionSpecific : matching;
	const latestStart = Math.max(
		...eligible.map((snapshot) => epochMilliseconds(snapshot.effectiveFrom)),
	);
	const [latest, ...tied] = eligible.filter(
		(snapshot) => epochMilliseconds(snapshot.effectiveFrom) === latestStart,
	);
	if (!latest) {
		return {
			issue: {
				code: "no-snapshot",
				message: `No pricing snapshot for ${provider.provider}/${model} was in effect at ${occurredAt}`,
			},
		};
	}
	if (tied.length > 0) {
		return {
			issue: {
				code: "ambiguous-snapshot",
				message: `Multiple pricing snapshots are in effect for ${provider.provider}/${model}`,
			},
		};
	}
	return { snapshot: latest };
}

function isEffectiveAt(snapshot: PricingSnapshot, timestamp: number): boolean {
	const start = epochMilliseconds(snapshot.effectiveFrom);
	const end =
		snapshot.effectiveUntil === undefined
			? Number.POSITIVE_INFINITY
			: epochMilliseconds(snapshot.effectiveUntil);
	return timestamp >= start && timestamp < end;
}

function selectTier(
	tiers: readonly PricingTier[],
	inputTokens: number | undefined,
): Resolution<{ readonly tier: PricingTier }> {
	if (tiers.length > 1 && inputTokens === undefined) {
		return {
			issue: {
				code: "missing-measurement",
				category: "input",
				message: "Input total is required to select a context-length pricing tier",
			},
		};
	}
	const tier = tiers.findLast((candidate) => candidate.minimumContextTokens <= (inputTokens ?? 0));
	if (!tier) throw new Error("PricingSnapshot bypassed validation: no tier starts at zero");
	return { tier };
}

interface Priced {
	readonly lines: readonly CostLine[];
	readonly issues: readonly PricingIssue[];
}

type RatesByCategory = ReadonlyMap<RateCategory, TokenRate>;

/** Splits input into cache components when the tier prices cache tokens separately. */
function inputLines(counters: UsageCounters, rates: RatesByCategory): Priced {
	if (counters.inputTokens === undefined) return missing("input");
	const pricesCache = rates.has("cache-read-input") || rates.has("cache-write-input");
	if (!pricesCache) return line("input", counters.inputTokens, rates);
	return combine([
		counters.uncachedInputTokens === undefined
			? missing("input")
			: line("input", counters.uncachedInputTokens, rates),
		cacheLine("cache-read-input", counters.cacheReadInputTokens, rates),
		cacheLine("cache-write-input", counters.cacheWriteInputTokens, rates),
	]);
}

/** Splits reasoning out of output when the tier prices reasoning tokens separately. */
function outputLines(counters: UsageCounters, rates: RatesByCategory): Priced {
	if (counters.outputTokens === undefined) return missing("output");
	if (!rates.has("reasoning")) return line("output", counters.outputTokens, rates);
	if (counters.reasoningTokens === undefined) return missing("reasoning");
	return combine([
		line("output", counters.outputTokens - counters.reasoningTokens, rates),
		line("reasoning", counters.reasoningTokens, rates),
	]);
}

function cacheLine(
	category: "cache-read-input" | "cache-write-input",
	quantity: number | undefined,
	rates: RatesByCategory,
): Priced {
	if (quantity !== undefined) return line(category, quantity, rates);
	return rates.has(category) ? missing(category) : priced([], []);
}

function line(category: RateCategory, quantity: number, rates: RatesByCategory): Priced {
	const rate = rates.get(category);
	if (rate) {
		const amount = multiplyRate(quantity, rate.price, rate.unitTokens);
		return priced([{ category, quantity, rate, amount }], []);
	}
	if (quantity === 0) return priced([], []);
	return priced(
		[],
		[
			{
				code: "unsupported-category",
				category,
				message: `No ${category} rate is available for ${quantity} measured tokens`,
			},
		],
	);
}

function missing(category: RateCategory): Priced {
	return priced(
		[],
		[{ code: "missing-measurement", category, message: `${category} usage is not measured` }],
	);
}

function priced(lines: readonly CostLine[], issues: readonly PricingIssue[]): Priced {
	return { lines, issues };
}

function combine(parts: readonly Priced[]): Priced {
	return {
		lines: parts.flatMap((part) => part.lines),
		issues: parts.flatMap((part) => part.issues),
	};
}
