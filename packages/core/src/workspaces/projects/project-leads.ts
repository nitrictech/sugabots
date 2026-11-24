import { LeadsProjects } from "@sugabots/contracts/errors/projects";
import { DisplayName } from "@sugabots/errors";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { Effect } from "effect";
import { query } from "../../database/database.ts";
import { bot, project, projectMember } from "../../database/schema.ts";

export { LeadsProjects } from "@sugabots/contracts/errors/projects";

/**
 * The lead bot of a project members made is always one of its public bots. So
 * a bot leading projects members made is not taken out of one, made personal or
 * deleted until each has another lead; its own default project, which it
 * leads, goes with it.
 *
 * Fails with `LeadsProjects` when the bot `botId` leads any of the projects
 * `among` selects (every project members made, unless narrowed to one). The
 * refusal names only the projects `viewerId` sees, the public ones and those
 * they are in, so it never tells them a private project's name. Run it in the
 * transaction that changes the bot, after locking its row, so a lead chosen
 * meanwhile is seen.
 */
export const refuseWhileLeading = Effect.fn("ProjectLeads.refuseWhileLeading")(function* (
	botId: string,
	among: { viewerId: string; projectId?: string },
) {
	const led = yield* query((db) =>
		db
			.select({
				name: project.name,
				botName: bot.name,
				seen: sql<boolean>`(${project.visibility} = 'public' or exists (
					select 1 from ${projectMember}
					where ${projectMember.projectId} = ${project.id}
						and ${projectMember.memberId} = ${among.viewerId}
				))`,
			})
			.from(project)
			.innerJoin(bot, eq(bot.id, project.leadBotId))
			.where(
				and(
					eq(project.leadBotId, botId),
					isNull(project.defaultOfBotId),
					among.projectId === undefined ? undefined : eq(project.id, among.projectId),
				),
			)
			.orderBy(asc(project.name)),
	);
	const [first] = led;
	if (!first) return;
	return yield* new LeadsProjects({
		botName: DisplayName.fromRecord(first.botName),
		projects: led.filter((one) => one.seen).map((one) => DisplayName.fromRecord(one.name)),
		leadsUnseenProjects: led.some((one) => !one.seen),
	});
});
