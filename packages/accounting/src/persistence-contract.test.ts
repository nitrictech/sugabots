import { Effect } from "effect";
import { describe, it } from "vitest";
import { completeUsageEvidence, successfulAttempt } from "./examples.ts";
import type { AccountingStore } from "./lifecycle.ts";
import { verifyAccountingStoreContract } from "./persistence-contract.ts";
import type { AttemptIntent, AttemptObservation } from "./types.ts";

describe("accounting store contract", () => {
	it("provides a reusable adapter conformance check", async () => {
		const intents = new Map<string, string>();
		const observations = new Map<string, string>();
		const store: AccountingStore = {
			putIntent: (intent: AttemptIntent) =>
				Effect.sync(() => put(intents, intent.attemptId, intent)),
			claimDispatch: (observation) =>
				Effect.sync(() => {
					const existing = observations.get(observation.observationId);
					if (existing === undefined) {
						observations.set(observation.observationId, JSON.stringify(observation));
						return "claimed";
					}
					return existing === JSON.stringify(observation) ? "already-dispatched" : "conflict";
				}),
			putObservation: (observation: AttemptObservation) =>
				Effect.sync(() => put(observations, observation.observationId, observation)),
		};

		await Effect.runPromise(
			verifyAccountingStoreContract(store, {
				intent: successfulAttempt,
				usageObservation: {
					observationId: `${successfulAttempt.attemptId}:usage:provider-response`,
					attemptId: successfulAttempt.attemptId,
					observedAt: "2026-09-18T10:00:01.000Z",
					payload: { type: "usage", evidence: completeUsageEvidence },
				},
			}),
		);
	});
});

function put(
	records: Map<string, string>,
	id: string,
	value: AttemptIntent | AttemptObservation,
): "created" | "duplicate" | "conflict" {
	const serialized = JSON.stringify(value);
	const existing = records.get(id);
	if (existing === undefined) {
		records.set(id, serialized);
		return "created";
	}
	return existing === serialized ? "duplicate" : "conflict";
}
