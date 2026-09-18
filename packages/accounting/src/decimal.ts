interface Decimal {
	coefficient: bigint;
	scale: number;
}

export function multiplyRate(quantity: number, price: string, unitTokens: number): string {
	if (!Number.isSafeInteger(quantity) || quantity < 0) throw new Error("Invalid token quantity");
	const unitScale = powerOfTenScale(unitTokens);
	const decimal = parseNonNegativeDecimal(price);
	return serializeDecimal({
		coefficient: decimal.coefficient * BigInt(quantity),
		scale: decimal.scale + unitScale,
	});
}

export function addDecimalAmounts(amounts: readonly string[]): string {
	const parsed = amounts.map(parseNonNegativeDecimal);
	const scale = Math.max(0, ...parsed.map((amount) => amount.scale));
	const coefficient = parsed.reduce(
		(total, amount) => total + amount.coefficient * 10n ** BigInt(scale - amount.scale),
		0n,
	);
	return serializeDecimal({ coefficient, scale });
}

export function validateRate(price: string, unitTokens: number): string | undefined {
	try {
		parseNonNegativeDecimal(price);
		powerOfTenScale(unitTokens);
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

export function validateMoneyAmount(amount: string): string | undefined {
	try {
		parseNonNegativeDecimal(amount);
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

function parseNonNegativeDecimal(value: string): Decimal {
	const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value);
	if (!match) throw new Error(`Invalid non-negative decimal: ${value}`);
	const fraction = match[2] ?? "";
	return {
		coefficient: BigInt(`${match[1]}${fraction}`),
		scale: fraction.length,
	};
}

function powerOfTenScale(value: number): number {
	if (!Number.isSafeInteger(value) || value < 1)
		throw new Error("Rate unit must be a positive integer");
	let remaining = value;
	let scale = 0;
	while (remaining > 1 && remaining % 10 === 0) {
		remaining /= 10;
		scale += 1;
	}
	if (remaining !== 1) throw new Error("Rate unit must be a power of ten");
	return scale;
}

function serializeDecimal(decimal: Decimal): string {
	if (decimal.coefficient === 0n) return "0";
	const digits = decimal.coefficient.toString().padStart(decimal.scale + 1, "0");
	if (decimal.scale === 0) return digits;
	const whole = digits.slice(0, -decimal.scale);
	const fraction = digits.slice(-decimal.scale).replace(/0+$/, "");
	return fraction ? `${whole}.${fraction}` : whole;
}
