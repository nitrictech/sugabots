import {
	ADMINISTERING_WORKSPACE_ROLES,
	type PersonParticipant,
	type ProjectMember,
} from "@sugabots/contracts";
import { and, asc, count, eq, inArray, isNull, not, sql } from "drizzle-orm";
import { Effect } from "effect";
import { peopleReachingProject } from "../../authorization/access.ts";
import { personColumns, toPerson } from "../../chats/store/participants.ts";
import { query } from "../../database/database.ts";
import {
	bot,
	membership,
	person,
	project,
	projectBot,
	projectMember,
} from "../../database/schema.ts";

/** The people in the project, by name. Administrators, who are in every one, can't be taken out. */
export const projectMembers = (projectId: string) =>
	query((db) =>
		db
			.select({
				personId: person.id,
				name: person.name,
				email: person.email,
				image: person.image,
				removable: sql<boolean>`${not(inArray(membership.role, [...ADMINISTERING_WORKSPACE_ROLES]))}`,
			})
			.from(projectMember)
			.innerJoin(person, eq(person.id, projectMember.personId))
			.innerJoin(
				membership,
				and(
					eq(membership.workspaceId, projectMember.workspaceId),
					eq(membership.personId, projectMember.personId),
				),
			)
			.where(eq(projectMember.projectId, projectId))
			.orderBy(asc(person.name)),
	).pipe(Effect.map((rows): ProjectMember[] => rows));

/** The people who reach the project (see `peopleReachingProject`), by name. */
export const peopleReachingProjectNamed = (projectId: string) =>
	query((db) =>
		db.query.person.findMany({
			...personColumns,
			where: {
				RAW: (person) => sql`${person.id} in (${peopleReachingProject(sql`${projectId}`)})`,
			},
			orderBy: { name: "asc" },
		}),
	).pipe(Effect.map((people): PersonParticipant[] => people.map(toPerson)));

/**
 * How many people and bots are in each of the projects `projectIds`, counted
 * as the project's members list and bots list would list them.
 */
export const projectHeadcounts = (projectIds: readonly string[]) =>
	Effect.gen(function* () {
		const people = yield* query((db) =>
			db
				.select({ projectId: projectMember.projectId, count: count() })
				.from(projectMember)
				.innerJoin(
					membership,
					and(
						eq(membership.workspaceId, projectMember.workspaceId),
						eq(membership.personId, projectMember.personId),
					),
				)
				.where(inArray(projectMember.projectId, [...projectIds]))
				.groupBy(projectMember.projectId),
		);
		const bots = yield* query((db) =>
			db
				.select({ projectId: projectBot.projectId, count: count() })
				.from(projectBot)
				.innerJoin(bot, eq(bot.id, projectBot.botId))
				.where(and(inArray(projectBot.projectId, [...projectIds]), isNull(bot.systemBotKey)))
				.groupBy(projectBot.projectId),
		);
		const memberCounts = new Map(people.map((row) => [row.projectId, row.count]));
		const botCounts = new Map(bots.map((row) => [row.projectId, row.count]));
		return (projectId: string) => ({
			memberCount: memberCounts.get(projectId) ?? 0,
			botCount: botCounts.get(projectId) ?? 0,
		});
	});

/**
 * The id of the bot's default project, where its own chats are. Every bot
 * but a system bot has one from the moment it is made.
 */
export const defaultProjectOf = (botId: string) =>
	query((db) =>
		db.select({ id: project.id }).from(project).where(eq(project.defaultOfBotId, botId)).limit(1),
	).pipe(
		Effect.flatMap(([row]) =>
			row ? Effect.succeed(row.id) : Effect.die(new Error(`Bot ${botId} has no default project`)),
		),
	);
