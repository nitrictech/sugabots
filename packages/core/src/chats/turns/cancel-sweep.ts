import { and, eq, inArray, ne } from "drizzle-orm";
import { Duration, Effect, Layer } from "effect";
import { Database, query } from "../../database/database.ts";
import { turn } from "../../database/schema.ts";
import { lane } from "../../workflows/sql.ts";
import { TurnSignals } from "./signals.ts";

/** How often `cancelSweepLayer` looks for cancels that never reached their workflow. */
const SWEEP_INTERVAL = Duration.minutes(1);

/**
 * Tells again the workflows of turns cancelled while they waited for approvals
 * that still hold their lanes: the turn's automation run ended, and the process
 * stopped between committing that and signalling it, or a migration cancelled
 * the turn, which can't signal.
 * The workflow would otherwise wait, and hold its lane, for good. A cancel it
 * already heard changes nothing.
 */
export const resendLostCancels = Effect.gen(function* () {
	const signals = yield* TurnSignals.Service;
	const stranded = yield* query((db) =>
		db
			.selectDistinct({ executionId: lane.executionId })
			.from(turn)
			.innerJoin(lane, and(eq(lane.executionId, turn.executionId), ne(lane.state, "idle")))
			.where(
				and(eq(turn.interruptRequested, true), inArray(turn.status, ["waiting", "cancelled"])),
			),
	);
	yield* Effect.forEach(
		stranded,
		({ executionId }) => (executionId ? signals.cancel(executionId) : Effect.void),
		{
			discard: true,
		},
	);
});

/** Runs `resendLostCancels` every minute for as long as the layer's scope is open. */
export const cancelSweepLayer = Layer.effectDiscard(
	Effect.gen(function* () {
		const signals = yield* TurnSignals.Service;
		const database = yield* Database;
		const pass = resendLostCancels.pipe(
			Effect.provideService(TurnSignals.Service, signals),
			Effect.provideService(Database, database),
			Effect.catchCause((cause) => Effect.logError("Re-sending lost turn cancels failed", cause)),
		);
		yield* Effect.forkScoped(
			pass.pipe(Effect.delay(SWEEP_INTERVAL), Effect.forever, Effect.withTracerEnabled(false)),
		);
	}),
);
