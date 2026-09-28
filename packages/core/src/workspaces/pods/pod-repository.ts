export * as PodRepository from "./pod-repository.ts";

import {
	leastUsedPodColor,
	PERSONAL_POD_SLUG,
	type PodColor,
	type PodUpdate,
} from "@sugabots/contracts";
import { and, eq, sql } from "drizzle-orm";
import { Context, Data, Effect, Layer } from "effect";
import { query, queryCatching, serviceOperations, transaction } from "../../database/database.ts";
import { isUniqueViolation } from "../../database/errors.ts";
import type * as schema from "../../database/schema.ts";
import { pod, podMember, workspaceMember } from "../../database/schema.ts";
import { Ids } from "../../ids/ids.ts";
import { type UserFacing, UserMessage } from "../../user-message.ts";
import { podColorOf } from "./pod.ts";

/**
 * The only writer of `pod` and `pod_member`.
 *
 * A pod's own rules are enforced here, so they hold however a pod is reached:
 * a Personal pod keeps its name, its members and its place, and a shared
 * pod's slug is unique in its workspace. Whether somebody may ask for any of
 * this is not decided here.
 */
export interface Interface {
	/**
	 * Creates a shared pod with `creatorId` as its first member. Without a
	 * colour it takes the one fewest of the workspace's shared pods have.
	 */
	readonly create: (
		workspaceId: string,
		input: { creatorId: string; name: string; slug: string; color?: PodColor },
	) => Effect.Effect<schema.PodRow, PodSlugTaken>;
	/** Makes `userId`'s Personal pod, with them in it, unless it already exists. */
	readonly provisionPersonal: (workspaceId: string, userId: string) => Effect.Effect<schema.PodRow>;
	readonly update: (
		workspaceId: string,
		podId: string,
		changes: PodUpdate,
	) => Effect.Effect<schema.PodRow, PersonalPodFixed | PodGone | PodSlugTaken>;
	/** Stops every pod in the workspace handing the floor to the Facilitator. */
	readonly stopFacilitatorRouting: (workspaceId: string) => Effect.Effect<void>;
	/** Removes a shared pod. One already gone counts as removed. */
	readonly remove: (workspaceId: string, podId: string) => Effect.Effect<void, PersonalPodFixed>;
	/** Adds a member of the pod's workspace. Adding somebody already in it changes nothing. */
	readonly addMember: (
		workspaceId: string,
		podId: string,
		userId: string,
	) => Effect.Effect<"added" | "already_member" | "not_workspace_member" | "personal_pod">;
	readonly removeMember: (
		workspaceId: string,
		podId: string,
		userId: string,
	) => Effect.Effect<"removed" | "not_a_member" | "personal_pod">;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/PodRepository",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("PodRepository");
	const ids = yield* Ids.Service;

	const kindOf = (workspaceId: string, podId: string) =>
		query((db) =>
			db
				.select({ kind: pod.kind })
				.from(pod)
				.where(and(eq(pod.id, podId), eq(pod.workspaceId, workspaceId)))
				.limit(1),
		).pipe(Effect.map(([target]) => target?.kind));

	return Service.of({
		create: (workspaceId, { creatorId, name, slug, color }) =>
			operation(
				"create",
				// One unit, so a pod is never briefly without the member who made it.
				transaction(
					Effect.gen(function* () {
						const taken = yield* query((db) =>
							db
								.select({ color: pod.color })
								.from(pod)
								.where(and(eq(pod.workspaceId, workspaceId), eq(pod.kind, "shared"))),
						);
						const id = yield* ids.next;
						const [row] = yield* query((db) =>
							db
								.insert(pod)
								.values({
									id,
									workspaceId,
									kind: "shared",
									name,
									slug,
									color: color ?? leastUsedPodColor(taken.map((one) => podColorOf(one.color))),
									createdById: creatorId,
								})
								.onConflictDoNothing({
									target: [pod.workspaceId, pod.slug],
									where: sql`${pod.kind} = 'shared'`,
								})
								.returning(),
						);
						if (!row) {
							return yield* new PodSlugTaken({ slug });
						}
						const memberId = yield* ids.next;
						yield* query((db) =>
							db
								.insert(podMember)
								.values({ id: memberId, workspaceId, podId: row.id, userId: creatorId }),
						);
						return row;
					}),
				),
			),

		provisionPersonal: (workspaceId, userId) =>
			operation(
				"provisionPersonal",
				Effect.gen(function* () {
					const podId = yield* ids.next;
					const [created] = yield* query((db) =>
						db
							.insert(pod)
							.values({
								id: podId,
								workspaceId,
								ownerId: userId,
								kind: "personal",
								name: "Personal",
								slug: PERSONAL_POD_SLUG,
								createdById: userId,
							})
							.onConflictDoNothing()
							.returning(),
					);
					const personal =
						created ??
						(yield* query((db) =>
							db
								.select()
								.from(pod)
								.where(
									and(
										eq(pod.workspaceId, workspaceId),
										eq(pod.ownerId, userId),
										eq(pod.kind, "personal"),
									),
								)
								.limit(1),
						))[0];
					if (!personal) {
						return yield* Effect.die(new Error("Personal pod could not be provisioned"));
					}
					const memberId = yield* ids.next;
					yield* query((db) =>
						db
							.insert(podMember)
							.values({ id: memberId, workspaceId, podId: personal.id, userId })
							.onConflictDoNothing({ target: [podMember.podId, podMember.userId] }),
					);
					return personal;
				}),
			),

		update: (workspaceId, podId, changes) =>
			operation(
				"update",
				Effect.gen(function* () {
					const renames =
						changes.name !== undefined || changes.slug !== undefined || changes.color !== undefined;
					if (renames && (yield* kindOf(workspaceId, podId)) === "personal") {
						return yield* new PersonalPodFixed({ attempted: "rename" });
					}

					// An UPDATE has no `on conflict`, so a taken slug arrives as a unique
					// violation. The slug is the only unique column a change can touch.
					const [row] = yield* queryCatching(
						(db) =>
							db
								.update(pod)
								.set(changes)
								.where(and(eq(pod.id, podId), eq(pod.workspaceId, workspaceId)))
								.returning(),
						(failure) =>
							isUniqueViolation(failure) && changes.slug !== undefined
								? new PodSlugTaken({ slug: changes.slug })
								: undefined,
					);
					if (!row) {
						return yield* new PodGone({ podId });
					}
					return row;
				}),
			),

		stopFacilitatorRouting: (workspaceId) =>
			operation(
				"stopFacilitatorRouting",
				query((db) =>
					db
						.update(pod)
						.set({ routing: { facilitator: false } })
						.where(and(eq(pod.workspaceId, workspaceId), facilitatorRouting)),
				),
			),

		remove: (workspaceId, podId) =>
			operation(
				"remove",
				Effect.gen(function* () {
					const [deleted] = yield* query((db) =>
						db
							.delete(pod)
							.where(
								and(eq(pod.id, podId), eq(pod.workspaceId, workspaceId), eq(pod.kind, "shared")),
							)
							.returning({ id: pod.id }),
					);
					if (deleted) return;

					// Nothing was deleted: the pod is Personal, which is refused, or it is
					// already gone.
					if ((yield* kindOf(workspaceId, podId)) === "personal") {
						return yield* new PersonalPodFixed({ attempted: "delete" });
					}
				}),
			),

		addMember: (workspaceId, podId, userId) =>
			operation(
				"addMember",
				Effect.gen(function* () {
					if ((yield* kindOf(workspaceId, podId)) === "personal") {
						return "personal_pod";
					}

					const memberId = yield* ids.next;
					const inserted = yield* query((db) =>
						db.execute<{ id: string }>(
							sql`
							insert into ${podMember} ("id", "workspace_id", "pod_id", "user_id")
							select ${memberId}, ${pod.workspaceId}, ${pod.id}, ${userId}
							from ${pod}
							inner join ${workspaceMember}
								on ${workspaceMember.workspaceId} = ${pod.workspaceId}
								and ${workspaceMember.userId} = ${userId}
							where ${pod.id} = ${podId}
							and ${pod.workspaceId} = ${workspaceId}
							on conflict ("pod_id", "user_id") do nothing
							returning "id"
						`,
							"objects",
						),
					);

					if (inserted.length > 0) {
						return "added";
					}

					const [existing] = yield* query((db) =>
						db
							.select({ id: podMember.id })
							.from(podMember)
							.innerJoin(pod, eq(pod.id, podMember.podId))
							.innerJoin(
								workspaceMember,
								and(
									eq(workspaceMember.workspaceId, pod.workspaceId),
									eq(workspaceMember.userId, userId),
								),
							)
							.where(and(eq(podMember.podId, podId), eq(podMember.userId, userId)))
							.limit(1),
					);

					return existing ? "already_member" : "not_workspace_member";
				}),
			),

		removeMember: (workspaceId, podId, userId) =>
			operation(
				"removeMember",
				Effect.gen(function* () {
					if ((yield* kindOf(workspaceId, podId)) === "personal") {
						return "personal_pod";
					}
					const removed = yield* query((db) =>
						db
							.delete(podMember)
							.where(
								and(
									eq(podMember.workspaceId, workspaceId),
									eq(podMember.podId, podId),
									eq(podMember.userId, userId),
								),
							)
							.returning({ id: podMember.id }),
					);
					return removed.length > 0 ? "removed" : "not_a_member";
				}),
			),
	});
});

export const layer = Layer.effect(Service, make);

/** The slug is taken by another shared pod in this workspace. */
export class PodSlugTaken
	extends Data.TaggedError("PodSlugTaken")<{ readonly slug: string }>
	implements UserFacing
{
	override get message() {
		return `A pod with the slug "${this.slug}" already exists in this workspace`;
	}
	get userMessage() {
		return UserMessage.of`A pod with that address already exists in this workspace`;
	}
}

/** The pod was deleted before the write reached it. */
export class PodGone
	extends Data.TaggedError("PodGone")<{ readonly podId: string }>
	implements UserFacing
{
	override get message() {
		return `No pod with the id "${this.podId}"`;
	}
	get userMessage() {
		return UserMessage.of`No such pod`;
	}
}

/**
 * A Personal pod is one person's: it keeps the name it was given and it stays
 * for as long as they are in the workspace. Its owner holds every permission
 * in it, so this refuses an impossible request rather than a forbidden one.
 */
export class PersonalPodFixed
	extends Data.TaggedError("PersonalPodFixed")<{ readonly attempted: "rename" | "delete" }>
	implements UserFacing
{
	override get message() {
		return `A Personal pod cannot be ${this.attempted === "rename" ? "renamed" : "deleted"}`;
	}
	get userMessage() {
		return this.attempted === "rename"
			? UserMessage.of`A Personal pod's name, address and colour cannot be changed`
			: UserMessage.of`Personal pods cannot be deleted`;
	}
}

/** Pods whose routing currently hands the floor to the Facilitator. */
const facilitatorRouting = sql`${pod.routing} ->> 'facilitator' = 'true'`;
