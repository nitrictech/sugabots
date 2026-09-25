import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { PricingSnapshot, ProviderReportedCharge } from "./schemas.ts";
import { snapshot } from "./test-fixtures.ts";

const decodeCharge = Schema.decodeUnknownResult(ProviderReportedCharge);
const charge = {
	chargeId: "charge-1",
	scope: "response",
	scopeId: "response-1",
	amount: { currency: "USD", amount: "0.00125" },
	source: "provider invoice export",
	reportedAt: "2026-09-18T10:00:00.000Z",
	reconciliationStatus: "unreconciled",
};

describe("boundary records", () => {
	it("accepts a scoped provider charge", () => {
		expect(Result.isSuccess(decodeCharge(charge))).toBe(true);
	});

	it.each([
		{ amount: { currency: "USD", amount: "-1" } },
		{ amount: { currency: "usd", amount: "1" } },
		{ reportedAt: "2026-09-18T10:00:00" },
	])("rejects a malformed charge: %o", (override) => {
		expect(Result.isFailure(decodeCharge({ ...charge, ...override }))).toBe(true);
	});

	it.each([
		{ tiers: [] },
		{ tiers: [{ minimumContextTokens: 10, rates: [] }] },
		{
			tiers: [
				{
					minimumContextTokens: 0,
					rates: [
						{ category: "input", price: "1", unitTokens: 1_000_000 },
						{ category: "input", price: "2", unitTokens: 1_000_000 },
					],
				},
			],
		},
		{
			tiers: [
				{ minimumContextTokens: 0, rates: [{ category: "input", price: "1", unitTokens: 1_500 }] },
			],
		},
	])("rejects rates that cannot be applied unambiguously: %o", (override) => {
		const decode = Schema.decodeUnknownResult(PricingSnapshot);
		expect(Result.isFailure(decode({ ...snapshot(), ...override }))).toBe(true);
	});
});
