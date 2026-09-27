import { sql } from "drizzle-orm";
import { Duration, Effect, Layer } from "effect";
import { Database, query, transaction } from "../database/database.ts";
import { Lanes } from "./lanes.ts";
import { Outbox } from "./outbox.ts";

/** How often lanes and the outbox are repaired. */
const RECONCILE_INTERVAL = Duration.minutes(1);

/**
 * Repairs what a crash can leave behind, every minute, for as long as the
 * layer's scope is open: lanes stuck starting or holding a finished execution,
 * and outbox messages never delivered. Every process runs it; a transaction
 * advisory lock lets one at a time do the work. A failed pass is logged and
 * tried again next time.
 */
export const reconcileLayer = Layer.effectDiscard(
	Effect.gen(function* () {
		const lanes = yield* Lanes.Service;
		const outbox = yield* Outbox.Service;
		const database = yield* Database;
		const pass = transaction(
			Effect.gen(function* () {
				const [lock] = yield* query((db) =>
					db.execute<{ taken: boolean }>(
						sql`select pg_try_advisory_xact_lock(hashtextextended('workflows:reconcile', 0)) as taken`,
						"objects",
					),
				);
				if (!lock?.taken) return;
				yield* lanes.reconcile;
				yield* outbox.reconcile;
			}),
		).pipe(
			Effect.provideService(Database, database),
			Effect.catchCause((cause) => Effect.logError("Reconciling workflows failed", cause)),
		);
		yield* Effect.forkScoped(
			pass.pipe(Effect.delay(RECONCILE_INTERVAL), Effect.forever, Effect.withTracerEnabled(false)),
		);
	}),
);
