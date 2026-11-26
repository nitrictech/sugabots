import { and, asc, eq, inArray, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { Effect } from "effect";
import { query } from "../../database/database.ts";
import { bot, member, membership, project, workspace } from "../../database/schema.ts";
import { isUuid } from "../../ids/ids.ts";

/** The names of the members `memberIds` name, by id; a null id names nobody. */
export const memberNamesOf = (memberIds: ReadonlyArray<string | null>) => {
	const ids = [...new Set(memberIds.filter((id) => id !== null))];
	return Effect.map(
		ids.length === 0
			? Effect.succeed([])
			: query((db) =>
					db
						.select({ id: member.id, name: member.name })
						.from(member)
						.where(inArray(member.id, ids)),
				),
		(rows): ReadonlyMap<string, string> => new Map(rows.map((row) => [row.id, row.name])),
	);
};

/**
 * Joins the membership of the member `memberId` names in the workspace
 * `workspaceId` names, so the member joined through it is shown only while
 * they are still in the workspace.
 */
export function membershipOf(workspaceId: PgColumn, memberId: PgColumn): SQL | undefined {
	return and(
		eq(membership.workspaceId, workspaceId),
		eq(membership.memberId, memberId),
		eq(membership.leaving, false),
	);
}

/**
 * Whether `memberId` can record a sign-in, read under a share of the workspace
 * lock. A departure waits for these sign-ins, and a sign-in that waits for a
 * departure sees its intent, the membership marked leaving, even while its
 * Personal Assistants' computers are being destroyed.
 */
export const inWorkspaceUnderMembershipLock = (workspaceId: string, memberId: string) =>
	Effect.gen(function* () {
		yield* query((db) =>
			db
				.select({ id: workspace.id })
				.from(workspace)
				.where(eq(workspace.id, workspaceId))
				.for("share"),
		);
		// A statement of its own, so it reads what a removal that held the lock committed.
		const [found] = yield* query((db) =>
			db
				.select({ id: membership.id })
				.from(membership)
				.where(
					and(
						eq(membership.workspaceId, workspaceId),
						eq(membership.memberId, memberId),
						eq(membership.leaving, false),
					),
				),
		);
		return found !== undefined;
	});

/** The default projects of the member's Personal Assistants, which go with their membership. */
export const assistantProjectsFor = (workspaceId: string, memberId: string) =>
	query((db) =>
		db
			.select({ id: project.id, deleting: project.deleting })
			.from(bot)
			.innerJoin(
				project,
				and(eq(project.defaultOfBotId, bot.id), eq(project.workspaceId, bot.workspaceId)),
			)
			.where(and(eq(bot.workspaceId, workspaceId), eq(bot.assistantOf, memberId)))
			.orderBy(asc(bot.createdAt), asc(bot.id)),
	);

/**
 * The member whose membership of the workspace `membershipId` is, for an
 * operation whose input names a membership, to name and prove its member. A
 * membership's member never changes, so this needn't wait for the
 * workspace's lock. A membership the workspace doesn't have comes back as
 * itself, which is no member's id, so it proves hidden like a member who
 * isn't in the workspace.
 */
export const memberOfMembership = (workspaceId: string, membershipId: string) =>
	isUuid(workspaceId)
		? query((db) =>
				db
					.select({ memberId: membership.memberId })
					.from(membership)
					.where(and(eq(membership.id, membershipId), eq(membership.workspaceId, workspaceId)))
					.limit(1),
			).pipe(Effect.map(([found]) => found?.memberId ?? membershipId))
		: Effect.succeed(membershipId);
