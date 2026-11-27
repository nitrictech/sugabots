import { and, asc, eq, exists, gte, isNotNull, isNull, or } from "drizzle-orm";
import { DateTime, Duration, Effect, Layer } from "effect";
import { Database, query, transaction } from "../../database/database.ts";
import { toolCall, turn } from "../../database/schema.ts";
import { processLayer } from "../../tiers.ts";
import { Lanes } from "../../workflows/lanes.ts";
import { lane } from "../../workflows/sql.ts";
import { TurnSignals } from "./signals.ts";

/** How often `cancelSweepLayer` looks for cancels that never reached their workflow. */
const SWEEP_INTERVAL = Duration.minutes(1);

/**
 * How long after a turn was cancelled its workflow is still told so. A cancel
 * is lost only when the process stops between committing it and sending it,
 * or a migration cancelled the turn, so the next sweeps resend it well within
 * this; an interrupted turn is cancelled for good, so without a limit the
 * sweep would tell every one ever interrupted, every minute.
 */
const LOST_CANCEL_WINDOW = Duration.days(1);

/**
 * Resends cancellation to workflows that could still be waiting for a signal:
 * those of turns asked to stop while they wait, and of turns cancelled within
 * `LOST_CANCEL_WINDOW`. A waiting turn gives up its lane, so whether it holds
 * one says nothing. A cancel the workflow already heard changes nothing.
 */
export const resendLostCancels = Effect.gen(function* () {
	const signals = yield* TurnSignals.Service;
	const cancelledSince = DateTime.toDateUtc(
		DateTime.subtractDuration(yield* DateTime.now, LOST_CANCEL_WINDOW),
	);
	const stranded = yield* query((db) =>
		db
			.selectDistinct({ executionId: turn.executionId })
			.from(turn)
			.where(
				and(
					isNotNull(turn.endRequested),
					isNotNull(turn.executionId),
					or(
						eq(turn.status, "waiting"),
						and(eq(turn.status, "cancelled"), gte(turn.finishedAt, cancelledSince)),
					),
				),
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

/** releaseParkedLanes frees lanes left held by workflows that parked before recording the release. */
export const releaseParkedLanes = transaction(
	Effect.gen(function* () {
		const lanes = yield* Lanes.Service;
		const parked = yield* query((db) =>
			db
				.select({ key: lane.key, executionId: turn.executionId })
				.from(turn)
				.innerJoin(lane, eq(lane.executionId, turn.executionId))
				.where(
					and(
						eq(turn.status, "waiting"),
						isNull(turn.endRequested),
						exists(
							db
								.select({ id: toolCall.id })
								.from(toolCall)
								.where(and(eq(toolCall.turnId, turn.id), eq(toolCall.approvalStatus, "pending"))),
						),
					),
				)
				// Lanes are locked last, each bot's in bot-id order (see `TurnStore`'s `lockedTurn`).
				.orderBy(asc(turn.botId), asc(lane.key))
				.for("update", { of: turn, skipLocked: true }),
		);
		for (const { key, executionId } of parked) {
			if (executionId) yield* lanes.release({ key, executionId });
		}
	}),
);

/** cancelSweepLayer repairs stranded approval waits and cancels every minute. */
export const cancelSweepLayer = Layer.effectDiscard(
	Effect.gen(function* () {
		const signals = yield* TurnSignals.Service;
		const database = yield* Database;
		const lanes = yield* Lanes.Service;
		const pass = resendLostCancels.pipe(
			Effect.andThen(releaseParkedLanes),
			Effect.provideService(Lanes.Service, lanes),
			Effect.provideService(TurnSignals.Service, signals),
			Effect.provideService(Database, database),
			Effect.catchCause((cause) => Effect.logError("Repairing parked turns failed", cause)),
		);
		yield* Effect.forkScoped(
			pass.pipe(Effect.delay(SWEEP_INTERVAL), Effect.forever, Effect.withTracerEnabled(false)),
		);
	}),
).pipe(processLayer);
