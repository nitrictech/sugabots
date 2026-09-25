import { Schema } from "effect";

const NON_NEGATIVE_DECIMAL = /^(0|[1-9]\d*)(?:\.(\d+))?$/;

/** A non-negative decimal written in plain notation, such as `0.0024`. */
export const DecimalAmount = Schema.String.check(
	Schema.isPattern(NON_NEGATIVE_DECIMAL, { message: "A non-negative decimal such as 0.0024" }),
).pipe(Schema.brand("DecimalAmount"));
export type DecimalAmount = typeof DecimalAmount.Type;

/** A token count that a rate is quoted per, such as 1 or 1,000,000. */
export const RateUnit = Schema.Int.check(
	Schema.makeFilter((unit) => /^10*$/.test(String(unit)), { expected: "a power of ten" }),
).pipe(Schema.brand("RateUnit"));
export type RateUnit = typeof RateUnit.Type;

interface Decimal {
	readonly coefficient: bigint;
	readonly scale: number;
}

/** Prices `quantity` tokens at `price` per `unitTokens` tokens, without rounding. */
export function multiplyRate(
	quantity: number,
	price: DecimalAmount,
	unitTokens: RateUnit,
): DecimalAmount {
	const decimal = parseDecimal(price);
	const unitScale = String(unitTokens).length - 1;
	return serializeDecimal({
		coefficient: decimal.coefficient * BigInt(quantity),
		scale: decimal.scale + unitScale,
	});
}

export function sumDecimalAmounts(amounts: readonly DecimalAmount[]): DecimalAmount {
	const parsed = amounts.map(parseDecimal);
	const scale = Math.max(0, ...parsed.map((amount) => amount.scale));
	const coefficient = parsed.reduce(
		(total, amount) => total + amount.coefficient * 10n ** BigInt(scale - amount.scale),
		0n,
	);
	return serializeDecimal({ coefficient, scale });
}

function parseDecimal(amount: DecimalAmount): Decimal {
	const match = NON_NEGATIVE_DECIMAL.exec(amount);
	if (!match) throw new Error(`DecimalAmount bypassed validation: ${amount}`);
	const fraction = match[2] ?? "";
	return { coefficient: BigInt(`${match[1]}${fraction}`), scale: fraction.length };
}

function serializeDecimal(decimal: Decimal): DecimalAmount {
	if (decimal.coefficient === 0n) return "0" as DecimalAmount;
	const digits = decimal.coefficient.toString().padStart(decimal.scale + 1, "0");
	if (decimal.scale === 0) return digits as DecimalAmount;
	const whole = digits.slice(0, -decimal.scale);
	const fraction = digits.slice(-decimal.scale).replace(/0+$/, "");
	return (fraction ? `${whole}.${fraction}` : whole) as DecimalAmount;
}
