import { type AcceptedRun, handleFromName } from "@sugabots/contracts";
import type { InputOf } from "@sugabots/contracts/operations";
import { and, eq, ne } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { query } from "../../database/database.ts";
import { automationRun, bot, member, membership, workspace } from "../../database/schema.ts";
import { onDatabase, type Promised, runOnPostgres } from "../../database/testing.ts";
import { type ChatServicesForTests, servedOperations } from "../../operations/testing.ts";
import { authenticators, principals } from "../../proofs/world.test-support.ts";
import { lane } from "../../workflows/sql.ts";
import { defaultProjectOf } from "../../workspaces/projects/project-reads.ts";
import { seedProject } from "../../workspaces/projects/seed.test-support.ts";
import { lanesForTests } from "../testing.ts";
import { releaseTurn, runningTurns } from "../turns/testing.ts";
import { Automation, AutomationRun, automationLane } from "./automation.workflow.ts";
import type { AutomationRunner } from "./automation-runner.ts";

/** Starts an automation's run by hand, as the web app's Run button does, returning it. */
export type StartRun = (input: InputOf<"automations.run">) => Promise<AcceptedRun>;

/**
 * Starting runs by hand through the `automations.run` operation, over the
 * chat services a case drives the runs with, for the member the returned
 * function is given, signed in.
 */
export async function manualRunsOver(
	services: ChatServicesForTests,
): Promise<(memberId: string) => StartRun> {
	const call = await servedOperations({ chats: services });
	const signedIn = principals(await authenticators());
	return (memberId) => async (input) =>
		call(await signedIn.member(memberId), "automations.run", input);
}

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
		([row]) => (row ? Schema.decodeUnknownSync(AutomationRun)(row.payload) : undefined),
	);

/** Frees the automation's lane, as its run's last step does, starting its next run. */
export const releaseRun = (run: AutomationRun) =>
	Effect.flatMap(lanesForTests, (lanes) =>
		Effect.flatMap(Automation.executionId(run), (executionId) =>
			lanes.release({ key: automationLane(run), executionId }),
		),
	);

/**
 * A member administering a new workspace with a project, which has no bots
 * yet, and a bot whose default project (`ownProjectId`) holds its own
 * automations; and the queued runs other cases left cancelled, so an
 * automation's next run is the one a case asks for.
 */
export async function anAutomationAdmin() {
	await onDatabase((db) =>
		db
			.update(automationRun)
			.set({ state: "cancelled", finishedAt: new Date() })
			.where(eq(automationRun.state, "queued")),
	);
	const suffix = crypto.randomUUID();
	const [somebody] = await onDatabase((db) =>
		db
			.insert(member)
			.values({ name: "Automation admin", email: `automation-${suffix}@example.com` })
			.returning(),
	);
	const [created] = await onDatabase((db) =>
		db
			.insert(workspace)
			.values({ name: "Automation workspace", slug: `automation-${suffix}` })
			.returning(),
	);
	if (!somebody || !created) throw new Error("Could not create automation test identity");
	const memberId = somebody.id;
	const workspaceId = created.id;
	await onDatabase((db) => db.insert(membership).values({ workspaceId, memberId, role: "admin" }));
	const [automationBot] = await onDatabase((db) =>
		db
			.insert(bot)
			.values({
				workspaceId,
				name: "Automation Bot",
				handle: handleFromName(`Automation Bot ${suffix}`),
				color: "green",
				eyes: "pill",
				model: "test/model",
				createdById: memberId,
			})
			.returning(),
	);
	if (!automationBot) throw new Error("Could not create automation test bot");
	const project = await onDatabase((db) =>
		seedProject(db, {
			workspaceId,
			name: "Automation project",
			slug: `automation-${suffix}`,
			createdById: memberId,
			leadBotId: automationBot.id,
		}),
	);
	const projectId = project.id;
	return {
		memberId,
		workspaceId,
		projectId,
		botId: automationBot.id,
		ownProjectId: await runOnPostgres(defaultProjectOf(automationBot.id)),
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

/** Ends the turns running in the chat, as their workflows do once done. */
export async function finishTurnsIn(chatId: string) {
	for (const run of await runOnPostgres(runningTurns(chatId))) {
		await runOnPostgres(releaseTurn(run));
	}
}
