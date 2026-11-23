import { handleFromName } from "@sugabots/contracts";
import { and, eq, ne } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { query } from "../../database/database.ts";
import { automationRun, bot, user, workspace, workspaceMember } from "../../database/schema.ts";
import { onDatabase, type Promised, runOnPostgres } from "../../database/testing.ts";
import { lane } from "../../workflows/sql.ts";
import { defaultProjectOf } from "../../workspaces/projects/project-reads.ts";
import { seedProject } from "../../workspaces/projects/seed.test-support.ts";
import { lanesForTests } from "../testing.ts";
import { releaseTurn, runningTurns } from "../turns/testing.ts";
import {
	Automation,
	type AutomationRun,
	automationLane,
	runOfStored,
	StoredRun,
	storedRun,
} from "./automation.workflow.ts";
import type { AutomationRunner } from "./automation-runner.ts";

/** The automation's run holding its lane, if any. */
export const runningRun = (automationId: string) =>
	Effect.map(
		query((db) =>
			db
				.select()
				.from(lane)
				.where(
					and(
						eq(lane.key, automationLane({ automationId })),
						eq(lane.workflow, Automation._tag),
						ne(lane.state, "idle"),
					),
				),
		),
		([row]) => (row ? runOfStored(Schema.decodeUnknownSync(StoredRun)(row.payload)) : undefined),
	);

/** Frees the automation's lane, as its run's last step does, starting its next run. */
export const releaseRun = (run: AutomationRun) =>
	Effect.flatMap(lanesForTests, (lanes) =>
		Effect.flatMap(Automation.executionId(storedRun(run)), (executionId) =>
			lanes.release({ key: automationLane(run), executionId }),
		),
	);

/**
 * A person administering a new workspace with a project, which has no bots
 * yet, and a bot whose default project (`ownProjectId`) holds its own
 * automations; and the queued runs other cases left cancelled, so an
 * automation's next run is the one a case asks for.
 */
export async function anAutomationOwner() {
	await onDatabase((db) =>
		db
			.update(automationRun)
			.set({ state: "cancelled", finishedAt: new Date() })
			.where(eq(automationRun.state, "queued")),
	);
	const suffix = crypto.randomUUID();
	const [person] = await onDatabase((db) =>
		db
			.insert(user)
			.values({ name: "Automation owner", email: `automation-${suffix}@example.com` })
			.returning(),
	);
	const [space] = await onDatabase((db) =>
		db
			.insert(workspace)
			.values({ name: "Automation workspace", slug: `automation-${suffix}` })
			.returning(),
	);
	if (!person || !space) throw new Error("Could not create automation test identity");
	const userId = person.id;
	const workspaceId = space.id;
	await onDatabase((db) =>
		db.insert(workspaceMember).values({ workspaceId, userId, role: "admin" }),
	);
	const [owner] = await onDatabase((db) =>
		db
			.insert(bot)
			.values({
				workspaceId,
				name: "Automation Bot",
				handle: handleFromName(`Automation Bot ${suffix}`),
				color: "green",
				face: "pill",
				model: "test/model",
				createdById: userId,
			})
			.returning(),
	);
	if (!owner) throw new Error("Could not create automation test bot");
	const room = await onDatabase((db) =>
		seedProject(db, {
			workspaceId,
			name: "Automation project",
			slug: `automation-${suffix}`,
			createdById: userId,
			leadBotId: owner.id,
		}),
	);
	const projectId = room.id;
	return {
		userId,
		workspaceId,
		projectId,
		botId: owner.id,
		ownProjectId: await runOnPostgres(defaultProjectOf(owner.id)),
	};
}

/** Starts the automation's run holding its lane, as its workflow's first step does. */
export async function startRunning(
	runner: Pick<Promised<AutomationRunner.Interface>, "startRun">,
	automationId: string,
) {
	const run = await runOnPostgres(runningRun(automationId));
	if (!run) throw new Error("No run of the automation is running");
	await runner.startRun(run);
	const [execution] = await onDatabase((db) =>
		db.select().from(automationRun).where(eq(automationRun.id, run.runId)),
	);
	if (!execution) throw new Error("The running run has no execution");
	return { run, execution };
}

/** Ends the turns running in the conversation, as their workflows do once done. */
export async function finishTurnsIn(conversationId: string) {
	for (const run of await runOnPostgres(runningTurns(conversationId))) {
		await runOnPostgres(releaseTurn(run));
	}
}
