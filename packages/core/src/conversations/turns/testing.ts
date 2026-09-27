import { and, asc, eq, ne } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { query } from "../../database/database.ts";
import { lane, laneRequest } from "../../workflows/sql.ts";
import { engineForTests, lanesForTests } from "../../workflows/testing.ts";
import { type QueueTurn, queueTurnInLane } from "./queue.ts";
import { turnSignals } from "./signals.ts";
import type { ClaimedTurn } from "./store.ts";
import { Turn, TurnRequest, turnLane } from "./turn.workflow.ts";

/**
 * Turns for the Postgres cases. They are asked for through real lanes, but a
 * turn's workflow here only holds its lane: a case runs the turn's steps
 * itself, with `runningTurns`, and frees the lane with `releaseTurn`.
 */
const lanes = lanesForTests;

export const turnSignalsForTests = turnSignals(engineForTests);

export const queueTurnForTests: QueueTurn = (request) =>
	Effect.flatMap(lanes, (service) => queueTurnInLane(service)(request));

/** The turns running in the thread, each claimed as its workflow claims its first run. */
export const runningTurns = (threadId: string) =>
	Effect.map(
		query((db) =>
			db
				.select()
				.from(lane)
				.where(
					and(eq(lane.subject, threadId), eq(lane.workflow, Turn._tag), ne(lane.state, "idle")),
				),
		),
		(rows) =>
			rows.map((row): ClaimedTurn => {
				const request = Schema.decodeUnknownSync(TurnRequest)(row.payload);
				return {
					owner: row.executionId ?? "",
					threadId: request.threadId,
					payload: {
						agentId: request.agentId,
						triggerMessageId: request.triggerMessageId,
						reason: request.reason,
					},
					attempts: 1,
				};
			}),
	);

/** The turns asked for while the agent's turn in the thread runs, oldest first. */
export const waitingTurns = (lane: Pick<TurnRequest, "threadId" | "agentId">) =>
	Effect.map(
		query((db) =>
			db
				.select()
				.from(laneRequest)
				.where(eq(laneRequest.laneKey, turnLane(lane)))
				.orderBy(asc(laneRequest.createdAt), asc(laneRequest.id)),
		),
		(rows) => rows.map((row) => Schema.decodeUnknownSync(TurnRequest)(row.payload)),
	);

/** Frees the turn's lane, as its workflow's last step does, starting the turn waiting in it. */
export const releaseTurn = (claim: ClaimedTurn) =>
	Effect.flatMap(lanes, (service) =>
		service.release({
			key: turnLane({ threadId: claim.threadId, agentId: claim.payload.agentId }),
			executionId: claim.owner,
		}),
	);
