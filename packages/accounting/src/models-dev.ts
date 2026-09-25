import type { Cost, ModelCost } from "@opencode-ai/models";
import { Data, Result, Schema } from "effect";
import { PricingSnapshot, type RateCategory } from "./schemas.ts";

export interface ModelsDevSnapshotInput {
	readonly snapshotId: string;
	readonly provider: string;
	readonly model: string;
	readonly cost: ModelCost;
	readonly catalogGeneratedAt: string;
	readonly retrievedAt: string;
	readonly effectiveFrom: string;
	readonly connectionId?: string;
}

export class ModelsDevSnapshotError extends Data.TaggedError("ModelsDevSnapshotError")<{
	readonly cause: Schema.SchemaError;
}> {}

/** Models.dev quotes rates in US dollars per million tokens. */
const MODELS_DEV_RATE_UNIT = 1_000_000;

export function snapshotFromModelsDev(
	input: ModelsDevSnapshotInput,
): Result.Result<PricingSnapshot, ModelsDevSnapshotError> {
	const snapshot = Schema.decodeResult(PricingSnapshot)({
		snapshotId: input.snapshotId,
		provider: input.provider,
		model: input.model,
		...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
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
	});
	return Result.mapError(snapshot, (cause) => new ModelsDevSnapshotError({ cause }));
}

function ratesFromCost(cost: Cost) {
	const prices: readonly [RateCategory, number | undefined][] = [
		["input", cost.input],
		["output", cost.output],
		["cache-read-input", cost.cache_read],
		["cache-write-input", cost.cache_write],
		["reasoning", cost.reasoning],
	];
	return prices.flatMap(([category, usdPerMillionTokens]) =>
		usdPerMillionTokens === undefined
			? []
			: [
					{
						category,
						price: plainDecimal(usdPerMillionTokens),
						unitTokens: MODELS_DEV_RATE_UNIT,
					},
				],
	);
}

/** Writes a number without exponent notation (`1e-7` becomes `0.0000001`); the schema validates it. */
function plainDecimal(value: number): string {
	const text = String(value);
	if (!/e/i.test(text)) return text;
	const [coefficient = "", exponentText = ""] = text.toLowerCase().split("e");
	const exponent = Number(exponentText);
	const [whole = "", fraction = ""] = coefficient.split(".");
	const digits = `${whole}${fraction}`;
	const decimalPosition = whole.length + exponent;
	if (decimalPosition <= 0) return `0.${"0".repeat(-decimalPosition)}${digits}`;
	if (decimalPosition >= digits.length) {
		return `${digits}${"0".repeat(decimalPosition - digits.length)}`;
	}
	return `${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
}
