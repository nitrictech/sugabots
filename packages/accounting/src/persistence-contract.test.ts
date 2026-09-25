import { Effect } from "effect";
import { describe, it } from "vitest";
import type { AccountingStore } from "./lifecycle.ts";
import { verifyAccountingStoreContract } from "./persistence-contract.ts";
import type { AttemptIntent, AttemptObservation } from "./schemas.ts";
import { successfulAttempt, usageObservation } from "./test-fixtures.ts";

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
				usageObservation: usageObservation(
					successfulAttempt,
					`${successfulAttempt.attemptId}:usage:provider-response`,
				),
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
