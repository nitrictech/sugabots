import { and, asc, eq, ne } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { query } from "../../database/database.ts";
import { lane, laneRequest } from "../../workflows/sql.ts";
import { engineForTests, lanesForTests } from "../../workflows/testing.ts";
import { Facilitate, FacilitateRequest, facilitateLane } from "./facilitate.workflow.ts";
import {
	type QueueFacilitation,
	type QueueTurn,
	queueFacilitationInLane,
	queueTurnInLane,
} from "./queue.ts";
import { turnSignals } from "./signals.ts";
import type { ClaimedTurn } from "./store.ts";
import { Turn, TurnRequest, turnLane } from "./turn.workflow.ts";

/**
 * Turns and facilitations for the Postgres cases. They are asked for through
 * real lanes, but their workflows here only hold their lanes: a case runs a
 * turn's steps itself, with `runningTurns`, and frees the lane with
 * `releaseTurn` or `releaseFacilitation`.
 */
const lanes = lanesForTests;

export const turnSignalsForTests = turnSignals(engineForTests);

export const queueTurnForTests: QueueTurn = (request) =>
	Effect.flatMap(lanes, (service) => queueTurnInLane(service)(request));

export const queueFacilitationForTests: QueueFacilitation = (request) =>
	Effect.flatMap(lanes, (service) => queueFacilitationInLane(service)(request));

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

/** The facilitation asked for while the thread's facilitation runs, if any. */
export const waitingFacilitation = (threadId: string) =>
	Effect.map(
		query((db) =>
			db
				.select()
				.from(laneRequest)
				.where(eq(laneRequest.laneKey, facilitateLane(threadId))),
		),
		([row]) => row && Schema.decodeUnknownSync(FacilitateRequest)(row.payload),
	);

/** Frees the thread's facilitation lane, as its workflow's last step does. */
export const releaseFacilitation = (request: FacilitateRequest) =>
	Effect.flatMap(Facilitate.executionId(request), (executionId) =>
		Effect.flatMap(lanes, (service) =>
			service.release({ key: facilitateLane(request.threadId), executionId }),
		),
	);
