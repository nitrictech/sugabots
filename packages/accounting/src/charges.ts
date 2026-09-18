import { Data, Effect } from "effect";
import { validateMoneyAmount } from "./decimal.ts";
import type { ProviderReportedCharge } from "./types.ts";

export class InvalidProviderChargeError extends Data.TaggedError("InvalidProviderChargeError")<{
	readonly message: string;
}> {}

export const providerReportedCharge = Effect.fn("accounting.providerReportedCharge")(function* (
	input: ProviderReportedCharge,
) {
	return yield* Effect.try({
		try: () => providerReportedChargeSync(input),
		catch: (cause) =>
			new InvalidProviderChargeError({
				message: cause instanceof Error ? cause.message : String(cause),
			}),
	});
});

export function providerReportedChargeSync(input: ProviderReportedCharge): ProviderReportedCharge {
	if (!input.chargeId || !input.scopeId || !input.source) {
		throw new Error("Charge identity, scope identity, and source are required");
	}
	if (!/^[A-Z]{3}$/.test(input.amount.currency)) {
		throw new Error("Charge currency must be an ISO 4217 code");
	}
	const amountError = validateMoneyAmount(input.amount.amount);
	if (amountError) throw new Error(amountError);
	if (!Number.isFinite(Date.parse(input.reportedAt)))
		throw new Error("Charge timestamp is invalid");
	return Object.freeze({ ...input, amount: Object.freeze({ ...input.amount }) });
}
