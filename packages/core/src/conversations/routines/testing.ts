import { handleFromName } from "@sugabots/contracts";
import { and, eq, ne } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { query } from "../../database/database.ts";
import {
	agent,
	pod,
	routineExecution,
	user,
	workspace,
	workspaceMember,
} from "../../database/schema.ts";
import { onDatabase, type Promised, runOnPostgres } from "../../database/testing.ts";
import { lane } from "../../workflows/sql.ts";
import { lanesForTests } from "../testing.ts";
import { releaseTurn, runningTurns } from "../turns/testing.ts";
import { Routine, RoutineRun, routineLane } from "./routine.workflow.ts";
import type { RoutineRunner } from "./routine-runner.ts";

/** The routine's run holding its lane, if any. */
export const runningRun = (routineId: string) =>
	Effect.map(
		query((db) =>
			db
				.select()
				.from(lane)
				.where(
					and(
						eq(lane.key, routineLane({ routineId })),
						eq(lane.workflow, Routine._tag),
						ne(lane.state, "idle"),
					),
				),
		),
		([row]) => (row ? Schema.decodeUnknownSync(RoutineRun)(row.payload) : undefined),
	);

/** Frees the routine's lane, as its run's last step does, starting its next run. */
export const releaseRun = (run: RoutineRun) =>
	Effect.flatMap(lanesForTests, (lanes) =>
		Effect.flatMap(Routine.executionId(run), (executionId) =>
			lanes.release({ key: routineLane(run), executionId }),
		),
	);

/**
 * A person administering a new workspace with a shared pod whose crew agent
 * owns routines, and the queued runs other cases left cancelled, so a
 * routine's next run is the one a case asks for.
 */
export async function aRoutineOwner() {
	await onDatabase((db) =>
		db
			.update(routineExecution)
			.set({ state: "cancelled", finishedAt: new Date() })
			.where(eq(routineExecution.state, "queued")),
	);
	const suffix = crypto.randomUUID();
	const [person] = await onDatabase((db) =>
		db
			.insert(user)
			.values({ name: "Routine owner", email: `routine-${suffix}@example.com` })
			.returning(),
	);
	const [space] = await onDatabase((db) =>
		db
			.insert(workspace)
			.values({ name: "Routine workspace", slug: `routine-${suffix}` })
			.returning(),
	);
	if (!person || !space) throw new Error("Could not create Routine test identity");
	const userId = person.id;
	const workspaceId = space.id;
	await onDatabase((db) =>
		db.insert(workspaceMember).values({ workspaceId, userId, role: "admin" }),
	);
	const [room] = await onDatabase((db) =>
		db
			.insert(pod)
			.values({
				workspaceId,
				ownerId: userId,
				kind: "shared",
				name: "Routine pod",
				slug: `routine-${suffix}`,
				createdById: userId,
			})
			.returning(),
	);
	if (!room) throw new Error("Could not create Routine test pod");
	const podId = room.id;
	const [owner] = await onDatabase((db) =>
		db
			.insert(agent)
			.values({
				workspaceId,
				podId,
				name: "Routine Agent",
				handle: handleFromName(`Routine Agent ${suffix}`),
				color: "green",
				face: "pill",
				model: "test/model",
				createdById: userId,
			})
			.returning(),
	);
	if (!owner) throw new Error("Could not create Routine test agent");
	return { userId, workspaceId, podId, agentId: owner.id };
}

/** Starts the routine's run holding its lane, as its workflow's first step does. */
export async function startRunning(
	runner: Pick<Promised<RoutineRunner.Interface>, "startRun">,
	routineId: string,
) {
	const run = await runOnPostgres(runningRun(routineId));
	if (!run) throw new Error("No run of the routine is running");
	await runner.startRun(run);
	const [execution] = await onDatabase((db) =>
		db.select().from(routineExecution).where(eq(routineExecution.id, run.executionId)),
	);
	if (!execution) throw new Error("The running run has no execution");
	return { run, execution };
}

/** Ends the turns running in the thread, as their workflows do once done. */
export async function finishTurnsIn(threadId: string) {
	for (const run of await runOnPostgres(runningTurns(threadId))) {
		await runOnPostgres(releaseTurn(run));
	}
}
