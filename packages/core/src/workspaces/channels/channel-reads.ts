import { ADMINISTERING_WORKSPACE_ROLES, type ChannelMember } from "@sugabots/contracts";
import { and, asc, eq, inArray, not, sql } from "drizzle-orm";
import { Effect } from "effect";
import { query } from "../../database/database.ts";
import { channelMember, user, workspaceMember } from "../../database/schema.ts";

/** The people in the channel, by name. Administrators, who are in every one, can't be taken out. */
export const channelMembers = (channelId: string) =>
	query((db) =>
		db
			.select({
				userId: user.id,
				name: user.name,
				email: user.email,
				image: user.image,
				addedAt: channelMember.createdAt,
				removable: sql<boolean>`${not(inArray(workspaceMember.role, [...ADMINISTERING_WORKSPACE_ROLES]))}`,
			})
			.from(channelMember)
			.innerJoin(user, eq(user.id, channelMember.userId))
			.innerJoin(
				workspaceMember,
				and(
					eq(workspaceMember.workspaceId, channelMember.workspaceId),
					eq(workspaceMember.userId, channelMember.userId),
				),
			)
			.where(eq(channelMember.channelId, channelId))
			.orderBy(asc(user.name)),
	).pipe(
		Effect.map((rows): ChannelMember[] =>
			rows.map((row) => ({ ...row, addedAt: row.addedAt.toISOString() })),
		),
	);
