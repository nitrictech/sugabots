import type { Cost, ModelCost } from "@opencode-ai/models";
import { Data, Effect } from "effect";
import type { PricingSnapshot, TokenRate } from "./types.ts";

export interface ModelsDevSnapshotInput {
	snapshotId: string;
	provider: string;
	model: string;
	cost: ModelCost;
	catalogGeneratedAt: string;
	retrievedAt: string;
	effectiveFrom: string;
	connectionId?: string;
}

export class ModelsDevSnapshotError extends Data.TaggedError("ModelsDevSnapshotError")<{
	readonly cause: unknown;
}> {}

export const snapshotFromModelsDev = Effect.fn("accounting.snapshotFromModelsDev")(function* (
	input: ModelsDevSnapshotInput,
) {
	return yield* Effect.try({
		try: () => snapshotFromModelsDevSync(input),
		catch: (cause) => new ModelsDevSnapshotError({ cause }),
	});
});

export function snapshotFromModelsDevSync(input: ModelsDevSnapshotInput): PricingSnapshot {
	const snapshot: PricingSnapshot = {
		snapshotId: input.snapshotId,
		provider: input.provider,
		model: input.model,
		connectionId: input.connectionId,
		currency: "USD",
		source: {
			name: "models.dev",
			url: "https://models.dev",
			version: input.catalogGeneratedAt,
			retrievedAt: input.retrievedAt,
		},
		effectiveFrom: input.effectiveFrom,
		tiers: [
			{ minimumContextTokens: 0, rates: ratesFromCost(input.cost) },
			...(input.cost.tiers ?? []).map((tier) => ({
				minimumContextTokens: tier.tier.size,
				rates: ratesFromCost(tier),
			})),
		],
	};
	return Object.freeze({
		...snapshot,
		source: Object.freeze({ ...snapshot.source }),
		tiers: Object.freeze(
			snapshot.tiers.map((tier) =>
				Object.freeze({
					...tier,
					rates: Object.freeze(tier.rates.map((rate) => Object.freeze({ ...rate }))),
				}),
			),
		),
	});
}

function ratesFromCost(cost: Cost): TokenRate[] {
	return [
		rate("input", cost.input),
		rate("output", cost.output),
		...(cost.cache_read === undefined ? [] : [rate("cache-read-input", cost.cache_read)]),
		...(cost.cache_write === undefined ? [] : [rate("cache-write-input", cost.cache_write)]),
		...(cost.reasoning === undefined ? [] : [rate("reasoning", cost.reasoning)]),
	];
}

function rate(category: TokenRate["category"], usdPerMillionTokens: number): TokenRate {
	return {
		category,
		price: decimalFromNumber(usdPerMillionTokens),
		unitTokens: 1_000_000,
	};
}

function decimalFromNumber(value: number): string {
	if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid Models.dev rate: ${value}`);
	const text = String(value);
	if (!/[eE]/.test(text)) return text;
	const [coefficient = "", exponentText = ""] = text.toLowerCase().split("e");
	const exponent = Number(exponentText);
	const [whole = "", fraction = ""] = coefficient.split(".");
	const digits = `${whole}${fraction}`;
	const decimalPosition = whole.length + exponent;
	if (decimalPosition <= 0) return `0.${"0".repeat(-decimalPosition)}${digits}`;
	if (decimalPosition >= digits.length)
		return `${digits}${"0".repeat(decimalPosition - digits.length)}`;
	return `${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
}
