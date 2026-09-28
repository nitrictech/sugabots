import type { Pod, PodMember } from "@sugabots/contracts";
import { and, asc, eq, type SQL, type SQLWrapper, sql } from "drizzle-orm";
import { Effect } from "effect";
import { query } from "../../database/database.ts";
import { pod, podMember, user } from "../../database/schema.ts";
import { podStanding } from "../access.ts";
import type { Actor } from "../permissions.ts";
import { podSeenBy } from "./pod.ts";

/**
 * The pods `actor` reaches in a workspace, by name, each with the permissions
 * they hold in it. `reachesPod` is `Visibility`'s rule for `actor`, the one
 * `Authorization` applies to a single pod, so a list and a direct read cannot
 * disagree.
 */
export const visiblePods = (
	workspaceId: string,
	actor: Actor,
	reachesPod: (podId: SQLWrapper) => SQL<boolean>,
) =>
	query((db) =>
		db
			.select({ pod, isExplicitMember: sql<boolean>`${podMember.id} is not null` })
			.from(pod)
			.leftJoin(podMember, and(eq(podMember.podId, pod.id), eq(podMember.userId, actor.userId)))
			.where(and(eq(pod.workspaceId, workspaceId), reachesPod(pod.id)))
			.orderBy(asc(pod.name)),
	).pipe(
		Effect.map((rows): Pod[] =>
			rows.map((row) => podSeenBy(podStanding(row.pod, actor, row.isExplicitMember))),
		),
	);

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
			})
			.from(podMember)
			.innerJoin(user, eq(user.id, podMember.userId))
			.where(eq(podMember.podId, podId))
			.orderBy(asc(user.name)),
	).pipe(
		Effect.map((rows): PodMember[] =>
			rows.map((row) => ({ ...row, addedAt: row.addedAt.toISOString() })),
		),
	);
