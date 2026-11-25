import {
	ADMINISTERING_WORKSPACE_ROLES,
	type MemberParticipant,
	type Project,
	type ProjectMember,
} from "@sugabots/contracts";
import { and, asc, count, eq, inArray, isNull, not, sql } from "drizzle-orm";
import { Effect } from "effect";
import { membersReachingProject } from "../../authorization/access.ts";
import { memberColumns, toMember } from "../../chats/store/participants.ts";
import { query } from "../../database/database.ts";
import {
	bot,
	member,
	membership,
	project,
	projectBot,
	projectMember,
} from "../../database/schema.ts";
import { actorOf, memberReaches } from "../../proofs/facts.ts";
import { projectFactsOf, projectSeenAs } from "./project.ts";

/** The members in the project, by name. Administrators, who are in every one, can't be taken out. */
export const projectMembers = (projectId: string) =>
	query((db) =>
		db
			.select({
				memberId: member.id,
				name: member.name,
				email: member.email,
				image: member.image,
				removable: sql<boolean>`${not(inArray(membership.role, [...ADMINISTERING_WORKSPACE_ROLES]))}`,
			})
			.from(projectMember)
			.innerJoin(member, eq(member.id, projectMember.memberId))
			.innerJoin(
				membership,
				and(
					eq(membership.workspaceId, projectMember.workspaceId),
					eq(membership.memberId, projectMember.memberId),
					eq(membership.leaving, false),
				),
			)
			.where(eq(projectMember.projectId, projectId))
			.orderBy(asc(member.name)),
	).pipe(Effect.map((rows): ProjectMember[] => rows));

/** The members who reach the project (see `membersReachingProject`), by name. */
export const membersReachingProjectNamed = (projectId: string) =>
	query((db) =>
		db.query.member.findMany({
			...memberColumns,
			where: {
				RAW: (member) => sql`${member.id} in (${membersReachingProject(sql`${projectId}`)})`,
			},
			orderBy: { name: "asc" },
		}),
	).pipe(Effect.map((members): MemberParticipant[] => members.map(toMember)));

/**
 * How many members and bots are in each of the projects `projectIds`, counted
 * as the project's members list and bots list would list them.
 */
const projectHeadcounts = (projectIds: readonly string[]) =>
	Effect.gen(function* () {
		const members = yield* query((db) =>
			db
				.select({ projectId: projectMember.projectId, count: count() })
				.from(projectMember)
				.innerJoin(
					membership,
					and(
						eq(membership.workspaceId, projectMember.workspaceId),
						eq(membership.memberId, projectMember.memberId),
						eq(membership.leaving, false),
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
		const memberCounts = new Map(members.map((row) => [row.projectId, row.count]));
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

/**
 * The projects of the workspace `workspaceId` that `memberId` is in, and the
 * public ones they could join, by name, as they see them. Each says how many
 * members and bots are in it where they may list them, as its own lists would.
 */
export const projectsListedTo = (workspaceId: string, memberId: string) =>
	Effect.gen(function* () {
		const rows = yield* query((db) =>
			db
				.select({ project, role: membership.role, projectMemberId: projectMember.id })
				.from(project)
				.leftJoin(
					membership,
					and(
						eq(membership.workspaceId, project.workspaceId),
						eq(membership.memberId, memberId),
						eq(membership.leaving, false),
					),
				)
				.leftJoin(
					projectMember,
					and(eq(projectMember.projectId, project.id), eq(projectMember.memberId, memberId)),
				)
				.where(
					and(
						eq(project.workspaceId, workspaceId),
						isNull(project.defaultOfBotId),
						sql`(${project.visibility} = 'public' or ${projectMember.id} is not null)`,
					),
				)
				.orderBy(asc(project.name)),
		);
		const listed = rows.map((row) => {
			const place = {
				actor: actorOf(memberId, row.role ?? undefined),
				inProject: row.projectMemberId !== null,
			};
			return {
				row: row.project,
				place,
				reaches: memberReaches(place, projectFactsOf(row.project)),
			};
		});
		const headcountOf = yield* projectHeadcounts(
			listed.filter(({ reaches }) => reaches).map(({ row }) => row.id),
		);
		return listed.map(({ row, place, reaches }): Project => {
			const seen = projectSeenAs(row, place);
			return reaches ? { ...seen, ...headcountOf(seen.id) } : seen;
		});
	});
