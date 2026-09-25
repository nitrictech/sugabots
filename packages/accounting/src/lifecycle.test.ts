import { describe, expect, it } from "vitest";
import { applyObservation, reduceAttempt } from "./lifecycle.ts";
import {
	completeUsageEvidence,
	decodeObservation,
	successfulAttempt,
	usageObservation,
} from "./test-fixtures.ts";

const initial = reduceAttempt(successfulAttempt, []);
const usage = (observationId: string) => usageObservation(successfulAttempt, observationId);

describe("attempt lifecycle", () => {
	it("treats the same observation as an idempotent duplicate", () => {
		const first = applyObservation(initial, usage("usage-1"));
		const duplicate = applyObservation(first.ledger, structuredClone(usage("usage-1")));

		expect(duplicate.status).toBe("duplicate");
		expect(duplicate.ledger.observations).toHaveLength(1);
	});

	it("rejects different evidence that reuses an observation ID", () => {
		const first = applyObservation(initial, usage("usage-1"));
		const conflict = applyObservation(first.ledger, {
			...usage("usage-1"),
			observedAt: terminal("x", "failed").observedAt,
		});

		expect(conflict.status).toBe("conflict");
		if (conflict.status === "conflict") expect(conflict.issue.code).toBe("conflicting-id");
	});

	it("requires corrections to supersede the active usage explicitly", () => {
		const first = applyObservation(initial, usage("usage-1"));

		const implicit = applyObservation(first.ledger, usage("usage-2"));
		expect(implicit.status).toBe("conflict");

		const corrected = applyObservation(
			first.ledger,
			usageObservation(
				successfulAttempt,
				"usage-2",
				{
					...completeUsageEvidence,
					counters: { ...completeUsageEvidence.counters, outputTokens: 201 },
				},
				"usage-1",
			),
		);

		expect(corrected.status).toBe("applied");
		expect(corrected.ledger.usage?.counters.outputTokens).toBe(201);
	});

	it("rejects a correction whose payload type differs from its target", () => {
		const first = applyObservation(initial, usage("usage-1"));
		const result = applyObservation(first.ledger, {
			...terminal("terminal-1", "failed"),
			supersedesObservationId: usage("usage-1").observationId,
		});

		expect(result.status).toBe("rejected");
		if (result.status === "rejected") expect(result.issue.code).toBe("correction-type-mismatch");
	});

	it("accepts late usage after a terminal outcome", () => {
		const ended = applyObservation(initial, terminal("terminal", "failed"));
		const late = applyObservation(ended.ledger, usage("late-usage"));

		expect(late.status).toBe("applied");
		expect(late.ledger.state).toBe("failed");
		expect(late.ledger.usage?.completeness).toBe("complete");
	});

	it("keeps an intended or dispatched attempt unresolved without a terminal observation", () => {
		const dispatched = applyObservation(
			initial,
			decodeObservation({
				observationId: "dispatched",
				attemptId: successfulAttempt.attemptId,
				observedAt: "2026-09-18T10:00:01.000Z",
				payload: { type: "dispatched", dispatchedAt: "2026-09-18T10:00:01.000Z" },
			}),
		);

		expect(initial.state).toBe("intended");
		expect(dispatched.ledger.state).toBe("dispatched");
	});

	it("resolves corrections independently of persistence row order", () => {
		const original = usage("usage-1");
		const correction = usageObservation(
			successfulAttempt,
			"usage-2",
			completeUsageEvidence,
			"usage-1",
		);

		expect(reduceAttempt(successfulAttempt, [correction, original])).toEqual(
			reduceAttempt(successfulAttempt, [original, correction]),
		);
	});

	it("orders observations by instant, not by how their timestamps are written", () => {
		const earlier = terminal("terminal-b", "succeeded", "2026-09-18T10:00:01Z");
		const later = terminal("terminal-a", "failed", "2026-09-18T10:00:01.500Z");

		const ledger = reduceAttempt(successfulAttempt, [later, earlier]);

		expect(ledger.state).toBe("succeeded");
		expect(ledger.issues).toEqual([
			expect.objectContaining({
				code: "conflicting-terminal-state",
				observationId: later.observationId,
			}),
		]);
	});

	it("retains conflicting evidence as a ledger issue during recovery", () => {
		const ledger = reduceAttempt(successfulAttempt, [
			usage("usage-1"),
			{ ...usage("usage-1"), observedAt: terminal("x", "failed").observedAt },
		]);

		expect(ledger.issues).toContainEqual(expect.objectContaining({ code: "conflicting-id" }));
	});

	it("derives returned model and request identity from response observations", () => {
		const result = applyObservation(
			initial,
			decodeObservation({
				observationId: "metadata-1",
				attemptId: successfulAttempt.attemptId,
				observedAt: "2026-09-18T10:00:01.000Z",
				payload: {
					type: "response-metadata",
					returnedModel: "claude-sonnet-4-5-20250929",
					providerRequestId: "request-1",
				},
			}),
		);

		expect(result.ledger.provider).toEqual({
			...successfulAttempt.provider,
			returnedModel: "claude-sonnet-4-5-20250929",
			providerRequestId: "request-1",
		});
	});

	it("rejects an observation that precedes the attempt start", () => {
		const result = applyObservation(
			initial,
			terminal("terminal-early", "failed", "2026-09-17T23:59:59.000Z"),
		);

		expect(result.status).toBe("rejected");
		expect(result.ledger.state).toBe("intended");
	});
});

function terminal(
	observationId: string,
	outcome: "succeeded" | "failed",
	at = "2026-09-18T10:00:02.000Z",
) {
	return decodeObservation({
		observationId,
		attemptId: successfulAttempt.attemptId,
		observedAt: at,
		payload: { type: "terminal", endedAt: at, outcome },
	});
}
