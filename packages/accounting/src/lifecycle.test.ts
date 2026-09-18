import { describe, expect, it } from "vitest";
import { completeUsageEvidence, successfulAttempt } from "./examples.ts";
import {
	applyObservationSync as applyObservation,
	createAttemptLedgerSync as createAttemptLedger,
	providerIdentityForLedgerSync as providerIdentityForLedger,
	reduceAttemptSync as reduceAttempt,
} from "./lifecycle.ts";
import type { AttemptObservation } from "./types.ts";

describe("attempt lifecycle", () => {
	it("treats the same observation as an idempotent duplicate", () => {
		const initial = createAttemptLedger(successfulAttempt);
		const observation = usageObservation("usage-1");
		const first = applyObservation(initial, observation);
		if (first.status !== "applied") throw new Error("Expected observation to apply");

		const duplicate = applyObservation(first.ledger, structuredClone(observation));

		expect(duplicate.status).toBe("duplicate");
		expect(duplicate.ledger.observations).toHaveLength(1);
	});

	it("rejects different evidence that reuses an observation ID", () => {
		const first = applyObservation(
			createAttemptLedger(successfulAttempt),
			usageObservation("usage-1"),
		);
		if (first.status !== "applied") throw new Error("Expected observation to apply");
		const conflict = applyObservation(first.ledger, {
			...usageObservation("usage-1"),
			observedAt: "2026-09-18T10:00:03.000Z",
		});

		expect(conflict.status).toBe("conflict");
		if (conflict.status === "conflict") expect(conflict.issue.code).toBe("conflicting-id");
	});

	it("requires corrections to supersede the active usage explicitly", () => {
		const first = applyObservation(
			createAttemptLedger(successfulAttempt),
			usageObservation("usage-1"),
		);
		if (first.status !== "applied") throw new Error("Expected observation to apply");

		const implicit = applyObservation(first.ledger, usageObservation("usage-2"));
		expect(implicit.status).toBe("conflict");

		const corrected = applyObservation(first.ledger, {
			...usageObservation("usage-2"),
			supersedesObservationId: "usage-1",
			payload: {
				type: "usage",
				evidence: {
					...completeUsageEvidence,
					counters: { ...completeUsageEvidence.counters, outputTokens: 201 },
				},
			},
		});

		expect(corrected.status).toBe("applied");
		if (corrected.status === "applied") {
			expect(corrected.ledger.observations).toHaveLength(2);
			expect(corrected.ledger.measurementCompleteness).toBe("complete");
		}
	});

	it("accepts late usage after a terminal outcome", () => {
		const terminal = applyObservation(createAttemptLedger(successfulAttempt), {
			observationId: "terminal",
			attemptId: successfulAttempt.attemptId,
			observedAt: "2026-09-18T10:00:02.000Z",
			payload: {
				type: "terminal",
				endedAt: "2026-09-18T10:00:02.000Z",
				outcome: "failed",
			},
		});
		if (terminal.status !== "applied") throw new Error("Expected terminal observation to apply");

		const late = applyObservation(terminal.ledger, usageObservation("late-usage"));

		expect(late.status).toBe("applied");
		if (late.status === "applied") {
			expect(late.ledger.state).toBe("failed");
			expect(late.ledger.measurementCompleteness).toBe("complete");
		}
	});

	it("keeps an intended or dispatched attempt unresolved without a terminal observation", () => {
		const intended = createAttemptLedger(successfulAttempt);
		const dispatched = applyObservation(intended, {
			observationId: "dispatched",
			attemptId: successfulAttempt.attemptId,
			observedAt: "2026-09-18T10:00:01.000Z",
			payload: { type: "dispatched", dispatchedAt: "2026-09-18T10:00:01.000Z" },
		});

		expect(intended.state).toBe("intended");
		expect(dispatched.ledger.state).toBe("dispatched");
	});

	it("resolves corrections independently of persistence row order", () => {
		const original = usageObservation("usage-1");
		const correction = {
			...usageObservation("usage-2"),
			supersedesObservationId: "usage-1",
		};

		expect(reduceAttempt(successfulAttempt, [correction, original])).toEqual(
			reduceAttempt(successfulAttempt, [original, correction]),
		);
	});

	it("retains conflicting evidence as a ledger issue during recovery", () => {
		const ledger = reduceAttempt(successfulAttempt, [
			usageObservation("usage-1"),
			{ ...usageObservation("usage-1"), observedAt: "2026-09-18T10:00:03.000Z" },
		]);

		expect(ledger.issues).toContainEqual(expect.objectContaining({ code: "conflicting-id" }));
	});

	it("derives returned model and request identity from response observations", () => {
		const result = applyObservation(createAttemptLedger(successfulAttempt), {
			observationId: "metadata-1",
			attemptId: successfulAttempt.attemptId,
			observedAt: "2026-09-18T10:00:01.000Z",
			payload: {
				type: "response-metadata",
				returnedModel: "claude-sonnet-4-5-20250929",
				providerRequestId: "request-1",
			},
		});

		expect(providerIdentityForLedger(result.ledger)).toEqual({
			...successfulAttempt.provider,
			returnedModel: "claude-sonnet-4-5-20250929",
			providerRequestId: "request-1",
		});
	});

	it("rejects malformed payload timestamps", () => {
		const result = applyObservation(createAttemptLedger(successfulAttempt), {
			observationId: "dispatch-1",
			attemptId: successfulAttempt.attemptId,
			observedAt: "2026-09-18T10:00:01.000Z",
			payload: { type: "dispatched", dispatchedAt: "not-a-date" },
		});

		expect(result.status).toBe("rejected");
		expect(result.ledger.state).toBe("intended");
	});
});

function usageObservation(observationId: string): AttemptObservation {
	return {
		observationId,
		attemptId: successfulAttempt.attemptId,
		observedAt: "2026-09-18T10:00:01.000Z",
		payload: { type: "usage", evidence: completeUsageEvidence },
	};
}
