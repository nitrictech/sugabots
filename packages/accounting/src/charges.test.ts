import { describe, expect, it } from "vitest";
import { providerReportedChargeSync as providerReportedCharge } from "./charges.ts";

describe("provider-reported charges", () => {
	it("validates and freezes a scoped charge", () => {
		const charge = providerReportedCharge({
			chargeId: "charge-1",
			scope: "response",
			scopeId: "response-1",
			amount: { currency: "USD", amount: "0.00125" },
			source: "provider invoice export",
			reportedAt: "2026-09-18T10:00:00.000Z",
			reconciliationStatus: "unreconciled",
		});

		expect(Object.isFrozen(charge)).toBe(true);
		expect(Object.isFrozen(charge.amount)).toBe(true);
	});

	it("rejects malformed or negative amounts", () => {
		const base = {
			chargeId: "charge-1",
			scope: "attempt" as const,
			scopeId: "attempt-1",
			source: "provider",
			reportedAt: "2026-09-18T10:00:00.000Z",
			reconciliationStatus: "unreconciled" as const,
		};
		expect(() =>
			providerReportedCharge({ ...base, amount: { currency: "USD", amount: "-1" } }),
		).toThrow("Invalid non-negative decimal");
		expect(() =>
			providerReportedCharge({ ...base, amount: { currency: "usd", amount: "1" } }),
		).toThrow("ISO 4217");
	});
});
