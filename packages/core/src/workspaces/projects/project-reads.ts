import { ADMINISTERING_WORKSPACE_ROLES, type ProjectMember } from "@sugabots/contracts";
import { and, asc, eq, inArray, not, sql } from "drizzle-orm";
import { Effect } from "effect";
import { query } from "../../database/database.ts";
import { project, projectMember, user, workspaceMember } from "../../database/schema.ts";

/** The people in the project, by name. Administrators, who are in every one, can't be taken out. */
export const projectMembers = (projectId: string) =>
	query((db) =>
		db
			.select({
				userId: user.id,
				name: user.name,
				email: user.email,
				image: user.image,
				addedAt: projectMember.createdAt,
				removable: sql<boolean>`${not(inArray(workspaceMember.role, [...ADMINISTERING_WORKSPACE_ROLES]))}`,
			})
			.from(projectMember)
			.innerJoin(user, eq(user.id, projectMember.userId))
			.innerJoin(
				workspaceMember,
				and(
					eq(workspaceMember.workspaceId, projectMember.workspaceId),
					eq(workspaceMember.userId, projectMember.userId),
				),
			)
			.where(eq(projectMember.projectId, projectId))
			.orderBy(asc(user.name)),
	).pipe(
		Effect.map((rows): ProjectMember[] =>
			rows.map((row) => ({ ...row, addedAt: row.addedAt.toISOString() })),
		),
	);

/**
 * The id of the bot's default project, where its own threads are. Every bot
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
