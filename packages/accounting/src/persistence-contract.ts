import { Data, Effect } from "effect";
import type { AccountingStore } from "./lifecycle.ts";
import type { AttemptIntent, AttemptObservation } from "./types.ts";

export interface AccountingStoreContractFixture {
	readonly intent: AttemptIntent;
	readonly usageObservation: AttemptObservation;
}

export class AccountingStoreContractError extends Data.TaggedError("AccountingStoreContractError")<{
	readonly operation: string;
	readonly expected: string;
	readonly actual: string;
}> {}

export const verifyAccountingStoreContract = Effect.fn("accounting.verifyStoreContract")(function* <
	E,
	R,
>(
	store: AccountingStore<E, R>,
	fixture: AccountingStoreContractFixture,
): Effect.fn.Return<void, E | AccountingStoreContractError, R> {
	yield* assertResult(store.putIntent(fixture.intent), "created", "create intent");
	yield* assertResult(store.putIntent(fixture.intent), "duplicate", "replay intent");

	const conflictingIntent = {
		...fixture.intent,
		provider: {
			...fixture.intent.provider,
			requestedModel: `${fixture.intent.provider.requestedModel}-other`,
		},
	};
	yield* assertResult(store.putIntent(conflictingIntent), "conflict", "conflicting intent");

	const dispatchedAt = fixture.intent.startedAt;
	const dispatch = {
		observationId: `${fixture.intent.attemptId}:dispatched`,
		attemptId: fixture.intent.attemptId,
		observedAt: dispatchedAt,
		payload: { type: "dispatched" as const, dispatchedAt },
	};
	yield* assertResult(store.claimDispatch(dispatch), "claimed", "claim dispatch");
	yield* assertResult(store.claimDispatch(dispatch), "already-dispatched", "reclaim dispatch");

	yield* assertResult(
		store.putObservation(fixture.usageObservation),
		"created",
		"create observation",
	);
	yield* assertResult(
		store.putObservation(fixture.usageObservation),
		"duplicate",
		"replay observation",
	);
	yield* assertResult(
		store.putObservation({
			...fixture.usageObservation,
			observedAt: new Date(Date.parse(fixture.usageObservation.observedAt) + 1).toISOString(),
		}),
		"conflict",
		"conflicting observation",
	);
});

function assertResult<A extends string, E, R>(
	actual: Effect.Effect<A, E, R>,
	expected: A,
	operation: string,
): Effect.Effect<void, E | AccountingStoreContractError, R> {
	return Effect.flatMap(actual, (value) =>
		value === expected
			? Effect.void
			: new AccountingStoreContractError({ operation, expected, actual: value }),
	);
}
