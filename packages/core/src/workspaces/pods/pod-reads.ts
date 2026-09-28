import type { PodMember } from "@sugabots/contracts";
import { asc, eq } from "drizzle-orm";
import { Effect } from "effect";
import { query } from "../../database/database.ts";
import { podMember, user } from "../../database/schema.ts";

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
