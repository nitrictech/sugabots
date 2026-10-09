import { handleFromName } from "@sugabots/contracts";
import { and, asc, eq, ne } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import { query } from "../../database/database.ts";
import { agent, connection, pod, user, workspace, workspaceMember } from "../../database/schema.ts";
import { onDatabase, type Promised } from "../../database/testing.ts";
import { lane, laneRequest } from "../../workflows/sql.ts";
import { AgentRepository } from "../../workspaces/agents/agent-repository.ts";
import type { Chats } from "../chats/chats.ts";
import {
	admitFacilitation,
	Facilitate,
	FacilitateRequest,
	facilitateLane,
} from "../floor/facilitate.workflow.ts";
import { lanesForTests } from "../testing.ts";
import { ThreadFiles } from "../thread-files/thread-files.ts";
import { ApprovedToolCalls } from "./approvals/approved-calls.ts";
import { type PreparedTurn, TurnExecution, type TurnRun, turnRunFor } from "./execution.ts";
import { TurnRepository } from "./repository.ts";
import { ToolCallRepository } from "./tool-calls/repository.ts";
import { admitTurn, Turn, TurnRequest, turnLane } from "./turn.workflow.ts";

// Turn internals the cases outside `turns/` drive or inspect directly.
export { modelPrompt } from "./context.ts";
export { type PreparedTurn, replyTurnOf, TurnExecution } from "./execution.ts";
export { type TurnCheckpoint, TurnRepository } from "./repository.ts";
export { TurnSignals } from "./signals.ts";
export { ToolCallRepository } from "./tool-calls/repository.ts";
export { Turn, turnLane } from "./turn.workflow.ts";

/**
 * The services a case drives a turn's steps through, which `Turns.layer`
 * hides; built over the conversation services.
 */
export const turnInternalsForTests = Layer.mergeAll(
	TurnExecution.layer,
	TurnRepository.layer,
	ToolCallRepository.layer,
	ApprovedToolCalls.layer,
	AgentRepository.layer,
	ThreadFiles.layer,
);

/*
 * Turns and facilitations for the Postgres cases. They are asked for through
 * real lanes, but their workflows here only hold their lanes: a case runs a
 * turn's steps itself, with `runningTurns`, and frees the lane with
 * `releaseTurn` or `releaseFacilitation`. `lanesForTests` is read only when
 * a helper runs, as `../testing.ts` imports this file.
 */

export const queueTurnForTests = (request: TurnRequest) =>
	Effect.flatMap(lanesForTests, (service) => admitTurn(service, request));

export const queueFacilitationForTests = (request: FacilitateRequest) =>
	Effect.flatMap(lanesForTests, (service) => admitFacilitation(service, request));

/** The turns running in the thread, each as its workflow runs it. */
export const runningTurns = (threadId: string) =>
	query((db) =>
		db
			.select()
			.from(lane)
			.where(and(eq(lane.subject, threadId), eq(lane.workflow, Turn._tag), ne(lane.state, "idle"))),
	).pipe(
		Effect.flatMap((rows) =>
			Effect.forEach(rows, (row) => turnRunFor(Schema.decodeUnknownSync(TurnRequest)(row.payload))),
		),
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
export const releaseTurn = (run: TurnRun) =>
	Effect.flatMap(lanesForTests, (service) =>
		service.release({ key: turnLane(run.request), executionId: run.executionId }),
	);

/** The facilitation asked for while the thread's facilitation runs, if any. */
export const waitingFacilitation = (threadId: string) =>
	Effect.map(
		query((db) =>
			db
				.select()
				.from(laneRequest)
				.where(eq(laneRequest.laneKey, facilitateLane({ threadId }))),
		),
		([row]) => row && Schema.decodeUnknownSync(FacilitateRequest)(row.payload),
	);

/** Frees the thread's facilitation lane, as its workflow's last step does. */
export const releaseFacilitation = (request: FacilitateRequest) =>
	Effect.flatMap(Facilitate.executionId(request), (executionId) =>
		Effect.flatMap(lanesForTests, (service) =>
			service.release({ key: facilitateLane(request), executionId }),
		),
	);

/** Prepares the run, for a case that needs its turn to run. */
export async function prepareRunnable(
	execution: Pick<Promised<TurnExecution.Interface>, "prepare">,
	run: TurnRun,
): Promise<PreparedTurn> {
	const preparation = await execution.prepare(run);
	if (preparation._tag !== "Prepared") {
		throw new Error(`The turn may not run: ${preparation.reason}`);
	}
	return preparation;
}

/**
 * A shared pod with a connection, whose admin has asked its host agent
 * something in a chat, so the host's turn is asked for in the chat's thread.
 */
export async function aChatAwaitingReply(
	chatsAs: (userId: string) => Pick<Promised<Chats.Interface>, "open" | "post">,
) {
	const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const [space] = await onDatabase((db) =>
		db
			.insert(workspace)
			.values({ name: `Turns ${suffix}`, slug: `turns-${suffix}` })
			.returning(),
	);
	const [member] = await onDatabase((db) =>
		db
			.insert(user)
			.values({ name: "Sam", email: `turns-${suffix}@example.com` })
			.returning(),
	);
	if (!space || !member) throw new Error("fixture");
	const workspaceId = space.id;
	const memberId = member.id;
	// An admin, because granting a standing approval in a shared pod is
	// administration; the ordinary-approval path is covered by the route tests.
	await onDatabase((db) =>
		db.insert(workspaceMember).values({ workspaceId, userId: memberId, role: "admin" }),
	);
	const [room] = await onDatabase((db) =>
		db
			.insert(pod)
			.values({
				workspaceId,
				kind: "shared",
				name: "Room",
				slug: `room-${suffix}`,
				createdById: memberId,
			})
			.returning(),
	);
	if (!room) throw new Error("fixture");
	const podId = room.id;
	const [host] = await onDatabase((db) =>
		db
			.insert(agent)
			.values({
				workspaceId,
				podId,
				name: `Host ${suffix}`,
				handle: handleFromName(`Host ${suffix}`),
				color: "rose",
				face: "pill",
				model: "m",
				createdById: memberId,
			})
			.returning({ id: agent.id }),
	);
	const [connected] = await onDatabase((db) =>
		db
			.insert(connection)
			.values({
				workspaceId,
				podId,
				name: `Linear ${suffix}`,
				handle: `linear-${suffix}`,
				url: "https://linear.example.com/mcp",
				authKind: "header",
				createdById: memberId,
			})
			.returning({ id: connection.id }),
	);
	if (!host || !connected) throw new Error("fixture");
	const chats = chatsAs(memberId);
	const opened = await chats.open({ workspace: workspaceId, podId, hostAgentId: host.id });
	await chats.post({
		chatId: opened.id,
		messageId: crypto.randomUUID(),
		content: "What does example.com say?",
	});
	return {
		workspaceId,
		podId,
		memberId,
		hostId: host.id,
		connectionId: connected.id,
		threadId: opened.mainThreadId,
	};
}
