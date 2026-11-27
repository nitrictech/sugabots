import { TurnEnded } from "@sugabots/contracts/errors/proofs";
import { TurnExecutionSuperseded } from "@sugabots/contracts/errors/turns";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { Effect } from "effect";
import { type Database, query } from "../../database/database.ts";
import { ACTIVE_TURN_STATUSES, turn } from "../../database/schema.ts";
import type { Principal } from "../../principal.ts";
import type { RunsTurn } from "../../proofs/runs-turn.ts";

/**
 * The fence every write `RunsTurn` guards checks in its own SQL: the turn
 * hasn't ended, and the principal's execution of it is still the current
 * one. A workflow may resume a turn in another process while a slow one
 * still runs a step there; the authenticator raised the turn's execution
 * number when it resumed, so the slow one's writes no longer pass.
 */
export const fenced = (proof: FencedProof) =>
	and(
		eq(turn.id, proof.turn.value),
		inArray(turn.status, [...ACTIVE_TURN_STATUSES]),
		eq(turn.executionNumber, proof.execution),
	);

export type FencedProof = Pick<RunsTurn<unknown, unknown>, "execution"> & {
	readonly turn: { readonly value: string };
};

export const executionFence = (turnId: string, execution: number): FencedProof => ({
	turn: { value: turnId },
	execution,
});

export type FenceRefusal = TurnEnded | TurnExecutionSuperseded;

/**
 * Why the fence refused a write for `runsTurn`: the turn ended, or a newer
 * execution has taken it over.
 */
export const fenceRefusal = (runsTurn: FencedProof) =>
	Effect.gen(function* (): Effect.fn.Return<FenceRefusal, never, Database> {
		const [found] = yield* query((db) =>
			db
				.select({ status: turn.status, executionNumber: turn.executionNumber })
				.from(turn)
				.where(eq(turn.id, runsTurn.turn.value))
				.limit(1),
		);
		const active = found && (ACTIVE_TURN_STATUSES as readonly string[]).includes(found.status);
		return active && found.executionNumber !== runsTurn.execution
			? new TurnExecutionSuperseded()
			: new TurnEnded();
	});

/**
 * Passes the fence for a write `runsTurn` guards, in the write's own
 * transaction: locks the turn's row until the transaction ends, for update
 * when the write changes the turn itself and for share otherwise, so ending
 * or resuming the turn waits for the write, and a write after either finds
 * the fence closed and writes nothing.
 */
export const holdRunningTurn = (runsTurn: FencedProof, lock: "update" | "share") =>
	Effect.gen(function* () {
		const [held] = yield* query((db) =>
			db.select({ id: turn.id }).from(turn).where(fenced(runsTurn)).limit(1).for(lock),
		);
		if (!held) return yield* Effect.fail(yield* fenceRefusal(runsTurn));
	});

/** holdTurnForToolWrite also refuses writes once the turn has been asked to end. */
export const holdTurnForToolWrite = (
	proof: FencedProof,
	status?: "running",
	lock: "share" | "update" = "share",
) =>
	Effect.gen(function* () {
		const [held] = yield* query((db) =>
			db
				.select({ id: turn.id })
				.from(turn)
				.where(and(fenced(proof), isNull(turn.endRequested), status && eq(turn.status, status)))
				.limit(1)
				.for(lock),
		);
		if (!held) return yield* Effect.fail(yield* fenceRefusal(proof));
	});

export const holdTurnOf = (principal: Principal, lock: "share" | "update" = "share") =>
	principal._tag === "BotForAsker" || principal._tag === "AutomationRun"
		? holdTurnForToolWrite(
				executionFence(principal.turn, principal.executionNumber),
				undefined,
				lock,
			)
		: Effect.void;
