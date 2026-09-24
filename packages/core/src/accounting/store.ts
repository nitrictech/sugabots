import type { AccountingStore, CostEstimate, PricingSnapshot } from "@sugabots/accounting";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { Effect } from "effect";
import { Database, type Executor, type QueryFailure } from "../database/database.ts";
import { modelAttempt, modelAttemptObservation } from "./sql.ts";

/**
 * The accounting ledger in Postgres.
 *
 * Failures stay failures rather than defects, because `collectAttempt` decides
 * what an unavailable ledger means for the request. Each method is one
 * statement plus, on a conflict, one read. None of them opens a transaction, so
 * a write joins no caller's transaction and is not rolled back with it.
 */
export interface ModelAttemptStore extends AccountingStore<QueryFailure, Database> {
	/** What the attempt is estimated to have cost, replacing any earlier estimate. */
	recordEstimate(
		attemptId: string,
		snapshot: PricingSnapshot | undefined,
		estimate: CostEstimate,
	): Effect.Effect<void, QueryFailure, Database>;
}

const run = <A>(query: (db: Executor) => Effect.Effect<A, QueryFailure>) =>
	Effect.flatMap(Database, ({ execute }) => execute(query));

/** Whether a stored record equals `value` as JSON, so a replay can be told from a conflict. */
const sameJson = (column: AnyPgColumn, value: unknown) =>
	sql<boolean>`${column} = ${JSON.stringify(value)}::jsonb`;

export const modelAttemptStore: ModelAttemptStore = {
	putIntent: (intent) =>
		Effect.gen(function* () {
			const inserted = yield* run((db) =>
				db
					.insert(modelAttempt)
					.values({
						attemptId: intent.attemptId,
						executionId: intent.executionId,
						retryOfAttemptId: intent.retryOfAttemptId,
						workspaceId: intent.attribution.workspaceId,
						activity: intent.attribution.activityPurpose,
						podId: intent.attribution.podId,
						agentId: intent.attribution.agentId,
						threadId: intent.attribution.threadId,
						connectionId: intent.provider.connectionId,
						provider: intent.provider.provider,
						requestedModel: intent.provider.requestedModel,
						startedAt: new Date(intent.startedAt),
						intent,
					})
					.onConflictDoNothing()
					.returning({ attemptId: modelAttempt.attemptId }),
			);
			if (inserted.length > 0) return "created" as const;
			const [existing] = yield* run((db) =>
				db
					.select({ same: sameJson(modelAttempt.intent, intent) })
					.from(modelAttempt)
					.where(eq(modelAttempt.attemptId, intent.attemptId)),
			);
			return existing?.same ? ("duplicate" as const) : ("conflict" as const);
		}),

	claimDispatch: (observation) =>
		Effect.gen(function* () {
			const claimed = yield* run((db) =>
				db
					.update(modelAttempt)
					.set({ dispatch: observation })
					.where(
						and(eq(modelAttempt.attemptId, observation.attemptId), isNull(modelAttempt.dispatch)),
					)
					.returning({ attemptId: modelAttempt.attemptId }),
			);
			if (claimed.length > 0) return "claimed" as const;
			const [existing] = yield* run((db) =>
				db
					.select({
						dispatched: sql<boolean>`${modelAttempt.dispatch} is not null`,
						same: sameJson(modelAttempt.dispatch, observation),
						terminal: sql<boolean>`exists (
							select 1 from ${modelAttemptObservation}
							where ${modelAttemptObservation.attemptId} = ${modelAttempt.attemptId}
								and ${modelAttemptObservation.type} = 'terminal'
						)`,
					})
					.from(modelAttempt)
					.where(eq(modelAttempt.attemptId, observation.attemptId)),
			);
			// No intent to claim against: the dispatch cannot be told apart from one
			// made under a different attempt, so it is not this one's to claim.
			if (!existing?.dispatched) return "conflict" as const;
			if (existing.terminal) return "terminal" as const;
			return existing.same ? ("already-dispatched" as const) : ("conflict" as const);
		}),

	putObservation: (observation) =>
		Effect.gen(function* () {
			const inserted = yield* run((db) =>
				db
					.insert(modelAttemptObservation)
					.values({
						observationId: observation.observationId,
						attemptId: observation.attemptId,
						type: observation.payload.type,
						observedAt: new Date(observation.observedAt),
						supersedesObservationId: observation.supersedesObservationId,
						observation,
					})
					.onConflictDoNothing()
					.returning({ observationId: modelAttemptObservation.observationId }),
			);
			if (inserted.length > 0) return "created" as const;
			const [existing] = yield* run((db) =>
				db
					.select({ same: sameJson(modelAttemptObservation.observation, observation) })
					.from(modelAttemptObservation)
					.where(eq(modelAttemptObservation.observationId, observation.observationId)),
			);
			return existing?.same ? ("duplicate" as const) : ("conflict" as const);
		}),

	recordEstimate: (attemptId, snapshot, estimate) =>
		run((db) =>
			db
				.update(modelAttempt)
				.set({
					pricingSnapshot: snapshot ?? null,
					costEstimate: estimate,
					estimatedCost: estimate.total?.amount ?? null,
				})
				.where(eq(modelAttempt.attemptId, attemptId)),
		).pipe(Effect.asVoid),
};
