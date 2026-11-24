import { and, eq, inArray, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { Effect } from "effect";
import { query } from "../../database/database.ts";
import { member, membership, workspace } from "../../database/schema.ts";

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
	return and(eq(membership.workspaceId, workspaceId), eq(membership.memberId, memberId));
}

/**
 * Whether `memberId` is in the workspace, read once a share of its membership
 * lock (see `lockWorkspace` in `membership.ts`) is held until the enclosing
 * transaction ends. A removal or leaving waits for that transaction, so its
 * own checks see what it records as theirs; one that held the lock first has
 * committed by then, so a member it took away is not in the workspace.
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
				.where(and(eq(membership.workspaceId, workspaceId), eq(membership.memberId, memberId))),
		);
		return found !== undefined;
	});
