import { ADMINISTERING_WORKSPACE_ROLES, type PodMember } from "@sugabots/contracts";
import { and, asc, eq, inArray, not, sql } from "drizzle-orm";
import { Effect } from "effect";
import { query } from "../../database/database.ts";
import { podMember, user, workspaceMember } from "../../database/schema.ts";

/** The people in the channel, by name. Administrators, who are in every one, can't be taken out. */
export const podMembers = (podId: string) =>
	query((db) =>
		db
			.select({
				userId: user.id,
				name: user.name,
				email: user.email,
				image: user.image,
				addedAt: podMember.createdAt,
				removable: sql<boolean>`${not(inArray(workspaceMember.role, [...ADMINISTERING_WORKSPACE_ROLES]))}`,
			})
			.from(podMember)
			.innerJoin(user, eq(user.id, podMember.userId))
			.innerJoin(
				workspaceMember,
				and(
					eq(workspaceMember.workspaceId, podMember.workspaceId),
					eq(workspaceMember.userId, podMember.userId),
				),
			)
			.where(eq(podMember.podId, podId))
			.orderBy(asc(user.name)),
	).pipe(
		Effect.map((rows): PodMember[] =>
			rows.map((row) => ({ ...row, addedAt: row.addedAt.toISOString() })),
		),
	);
