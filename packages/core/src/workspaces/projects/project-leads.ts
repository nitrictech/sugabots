import { DisplayName, userText } from "@sugabots/errors";
import { and, asc, eq, isNull } from "drizzle-orm";
import { Data, Effect } from "effect";
import { query } from "../../database/database.ts";
import { bot, project } from "../../database/schema.ts";
import type { UserFacing } from "../../user-message.ts";

/**
 * A project's lead bot is always one of its public bots. So a bot leading
 * projects people made is not taken out of one, made private or deleted
 * until each has another lead; its own default project, which it leads, goes
 * with it.
 *
 * Fails with `LeadsProjects`, naming them, when the bot `botId` leads any of
 * those `among` selects (every project, unless narrowed). Run it in the
 * transaction that changes the bot, after locking its row, so a lead chosen
 * meanwhile is seen.
 */
export const refuseWhileLeading = Effect.fn("ProjectLeads.refuseWhileLeading")(function* (
	botId: string,
	among?: { projectId: string },
) {
	const led = yield* query((db) =>
		db
			.select({ name: project.name, botName: bot.name })
			.from(project)
			.innerJoin(bot, eq(bot.id, project.leadBotId))
			.where(
				and(
					eq(project.leadBotId, botId),
					isNull(project.defaultOfBotId),
					among && eq(project.id, among.projectId),
				),
			)
			.orderBy(asc(project.name)),
	);
	const [first] = led;
	if (!first) return;
	return yield* new LeadsProjects({
		botName: DisplayName.fromRecord(first.botName),
		projects: led.map((one) => DisplayName.fromRecord(one.name)),
	});
});

const LIST = new Intl.ListFormat("en", { type: "conjunction" });

/** The bot leads these projects, so it stays in them, public, until each has another lead. */
export class LeadsProjects
	extends Data.TaggedError("LeadsProjects")<{
		readonly botName: DisplayName;
		readonly projects: readonly DisplayName[];
	}>
	implements UserFacing
{
	get userMessage() {
		// A list of names people see is itself a name they see.
		const names = DisplayName.fromRecord(LIST.format(this.projects));
		const them = this.projects.length === 1 ? "it" : "each";
		return userText`${this.botName} leads ${names}. Choose another lead bot for ${them} first.`;
	}
}
