import { DisplayName, userText } from "@sugabots/errors";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { Data, Effect } from "effect";
import { query } from "../../database/database.ts";
import { bot, project, projectMember } from "../../database/schema.ts";
import type { UserFacing } from "../../user-message.ts";

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

const LIST = new Intl.ListFormat("en", { type: "conjunction" });

/**
 * The bot leads projects members made, so it stays in them, public, until each
 * has another lead. `projects` names those the member refused sees;
 * `leadsUnseenProjects` says it also leads private ones they aren't in.
 */
export class LeadsProjects
	extends Data.TaggedError("LeadsProjects")<{
		readonly botName: DisplayName;
		readonly projects: readonly DisplayName[];
		readonly leadsUnseenProjects: boolean;
	}>
	implements UserFacing
{
	get userMessage() {
		if (this.leadsUnseenProjects) {
			if (this.projects.length === 0) {
				return userText`${this.botName} leads private projects you aren't in. Each needs another lead bot first.`;
			}
			const names = DisplayName.fromRecord(this.projects.join(", "));
			return userText`${this.botName} leads ${names} and private projects you aren't in. Each needs another lead bot first.`;
		}
		// A list of names members see is itself a name they see.
		const names = DisplayName.fromRecord(LIST.format(this.projects));
		const them = this.projects.length === 1 ? "it" : "each";
		return userText`${this.botName} leads ${names}. Choose another lead bot for ${them} first.`;
	}
}
