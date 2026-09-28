import type { PodMember } from "@sugabots/contracts";
import { and, asc, eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import { query } from "../../database/database.ts";
import { pod, podMember, user, workspaceMember } from "../../database/schema.ts";

/** The people with a membership row in the pod, by name. */
export const podMembers = (podId: string) =>
	query((db) =>
		db
			.select({
				userId: user.id,
				name: user.name,
				email: user.email,
				image: user.image,
				addedAt: podMember.createdAt,
				removable: sql<boolean>`${pod.kind} = 'shared' and ${workspaceMember.role} <> 'admin'`,
			})
			.from(podMember)
			.innerJoin(user, eq(user.id, podMember.userId))
			.innerJoin(pod, eq(pod.id, podMember.podId))
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
