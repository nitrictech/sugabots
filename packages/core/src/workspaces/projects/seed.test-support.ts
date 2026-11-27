import { Effect } from "effect";
import type { Executor } from "../../database/database.ts";
import { bot, project, projectBot } from "../../database/schema.ts";

/**
 * A project members made, as fixtures write it straight into the database, with
 * its lead bot: `leadBotId`, a public bot of the workspace, or a new public bot
 * without a model made for it. Either way the lead is added to the project's
 * bots, as every project's lead is one of them.
 */
type ProjectSeed = Omit<typeof project.$inferInsert, "leadBotId" | "defaultOfBotId"> & {
	leadBotId?: string;
};

export const seedProject = (db: Executor, { leadBotId, ...values }: ProjectSeed) =>
	Effect.gen(function* () {
		const lead = leadBotId ?? (yield* madeLead(db, values));
		const [made] = yield* db
			.insert(project)
			.values({ ...values, leadBotId: lead })
			.returning();
		if (!made) return yield* Effect.die(new Error("The project was not inserted"));
		yield* db
			.insert(projectBot)
			.values({ workspaceId: made.workspaceId, projectId: made.id, botId: lead });
		return made;
	});

/** A public bot to lead the project, named for its slug, which no other project in the workspace has. */
const madeLead = (db: Executor, { workspaceId, slug, createdById }: ProjectSeed) =>
	Effect.gen(function* () {
		const [made] = yield* db
			.insert(bot)
			.values({
				workspaceId,
				name: `Lead of ${slug}`,
				handle: `lead-of-${slug}`,
				color: "sky",
				eyes: "pill",
				createdById,
			})
			.returning({ id: bot.id });
		if (!made) return yield* Effect.die(new Error("The lead bot was not inserted"));
		return made.id;
	});
