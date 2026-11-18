export * as PodRepository from "./pod-repository.ts";

import {
	administersWorkspace,
	leastUsedPodColor,
	type PodColor,
	type PodUpdate,
	type PodVisibility,
} from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { and, asc, eq, sql } from "drizzle-orm";
import { Context, Data, Effect, Layer } from "effect";
import { query, queryCatching, serviceOperations, transaction } from "../../database/database.ts";
import { isUniqueViolation } from "../../database/errors.ts";
import type * as schema from "../../database/schema.ts";
import { agent, pod, podAgent, podMember, workspaceMember } from "../../database/schema.ts";
import type { UserFacing } from "../../user-message.ts";
import { podColorOf } from "./pod.ts";

/**
 * The only writer of `pod`, `pod_member` and `pod_agent`: channels, the people
 * in them, and their bots.
 *
 * A channel's own rules are enforced here, so they hold however it is
 * reached: its slug is unique in its workspace, and only public bots are in
 * one. Whether somebody may ask for any of this is not decided here.
 */
export interface Interface {
	/**
	 * Creates a channel with `creatorId` as its first member. Without a colour
	 * it takes the one fewest of the workspace's channels have.
	 */
	readonly create: (
		workspaceId: string,
		input: {
			creatorId: string;
			name: string;
			slug: string;
			color?: PodColor;
			description?: string | null;
			visibility?: PodVisibility;
		},
	) => Effect.Effect<schema.PodRow, PodSlugTaken>;
	readonly update: (
		workspaceId: string,
		podId: string,
		changes: PodUpdate,
	) => Effect.Effect<schema.PodRow, PodGone | PodSlugTaken>;
	/** Removes a channel. One already gone counts as removed. */
	readonly remove: (workspaceId: string, podId: string) => Effect.Effect<void>;
	/** Adds a member of the channel's workspace. Adding somebody already in it changes nothing. */
	readonly addMember: (
		workspaceId: string,
		podId: string,
		userId: string,
	) => Effect.Effect<"added" | "already_member" | "not_workspace_member">;
	/** Refuses an administrator, who belongs to every channel. */
	readonly removeMember: (
		workspaceId: string,
		podId: string,
		userId: string,
	) => Effect.Effect<"removed" | "not_a_member" | "administrator">;
	/** Puts a public bot of the workspace in the channel. Adding one already in it changes nothing. */
	readonly addBot: (
		workspaceId: string,
		podId: string,
		agentId: string,
	) => Effect.Effect<void, BotNotPublic>;
	readonly removeBot: (workspaceId: string, podId: string, agentId: string) => Effect.Effect<void>;
	/** The channel's bots, by name. */
	readonly bots: (podId: string) => Effect.Effect<schema.AgentRow[]>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/PodRepository",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("PodRepository");

	return Service.of({
		create: (workspaceId, { creatorId, name, slug, color, description, visibility }) =>
			operation(
				"create",
				// One unit, so a channel is never briefly without its members: whoever
				// made it, and every administrator.
				transaction(
					Effect.gen(function* () {
						const taken = yield* query((db) =>
							db.select({ color: pod.color }).from(pod).where(eq(pod.workspaceId, workspaceId)),
						);
						const [row] = yield* query((db) =>
							db
								.insert(pod)
								.values({
									workspaceId,
									name,
									slug,
									color: color ?? leastUsedPodColor(taken.map((one) => podColorOf(one.color))),
									description: description ?? null,
									visibility: visibility ?? "public",
									createdById: creatorId,
								})
								.onConflictDoNothing({ target: [pod.workspaceId, pod.slug] })
								.returning(),
						);
						if (!row) {
							return yield* new PodSlugTaken({ slug });
						}
						// The `shared_pod_administrators` trigger has already added every
						// administrator, the creator too if they are one.
						yield* query((db) =>
							db
								.insert(podMember)
								.values({ workspaceId, podId: row.id, userId: creatorId })
								.onConflictDoNothing({ target: [podMember.podId, podMember.userId] }),
						);
						return row;
					}),
				),
			),

		update: (workspaceId, podId, changes) =>
			operation(
				"update",
				Effect.gen(function* () {
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

		remove: (workspaceId, podId) =>
			operation(
				"remove",
				query((db) =>
					db.delete(pod).where(and(eq(pod.id, podId), eq(pod.workspaceId, workspaceId))),
				).pipe(Effect.asVoid),
			),

		addMember: (workspaceId, podId, userId) =>
			operation(
				"addMember",
				Effect.gen(function* () {
					const inserted = yield* query((db) =>
						db.execute<{ id: string }>(
							sql`
							insert into ${podMember} ("workspace_id", "pod_id", "user_id")
							select ${pod.workspaceId}, ${pod.id}, ${userId}
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
				transaction(
					Effect.gen(function* () {
						// Held until the transaction ends, so nobody is promoted between the
						// role check and the delete. The pod and role triggers take it too.
						yield* query((db) => db.execute(sql`select lock_pod_membership(${workspaceId})`));
						const [membership] = yield* query((db) =>
							db
								.select({ role: workspaceMember.role })
								.from(workspaceMember)
								.where(
									and(
										eq(workspaceMember.workspaceId, workspaceId),
										eq(workspaceMember.userId, userId),
									),
								)
								.limit(1),
						);
						if (administersWorkspace(membership?.role)) {
							return "administrator";
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
			),

		addBot: (workspaceId, podId, agentId) =>
			operation(
				"addBot",
				Effect.gen(function* () {
					const added = yield* query((db) =>
						db.execute<{ agent_id: string }>(
							sql`
							insert into ${podAgent} ("workspace_id", "pod_id", "agent_id")
							select ${pod.workspaceId}, ${pod.id}, ${agent.id}
							from ${pod}
							inner join ${agent}
								on ${agent.workspaceId} = ${pod.workspaceId}
								and ${agent.id} = ${agentId}
								and ${agent.visibility} = 'public'
								and ${agent.systemAgentKey} is null
								and ${agent.assistantOf} is null
							where ${pod.id} = ${podId}
							and ${pod.workspaceId} = ${workspaceId}
							on conflict do nothing
							returning "agent_id"
						`,
							"objects",
						),
					);
					if (added.length > 0) return;
					const [present] = yield* query((db) =>
						db
							.select({ agentId: podAgent.agentId })
							.from(podAgent)
							.where(and(eq(podAgent.podId, podId), eq(podAgent.agentId, agentId)))
							.limit(1),
					);
					if (!present) return yield* new BotNotPublic();
				}),
			),

		removeBot: (workspaceId, podId, agentId) =>
			operation(
				"removeBot",
				query((db) =>
					db
						.delete(podAgent)
						.where(
							and(
								eq(podAgent.workspaceId, workspaceId),
								eq(podAgent.podId, podId),
								eq(podAgent.agentId, agentId),
							),
						),
				).pipe(Effect.asVoid),
			),

		bots: (podId) =>
			operation(
				"bots",
				query((db) =>
					db
						.select({ agent })
						.from(podAgent)
						.innerJoin(agent, eq(agent.id, podAgent.agentId))
						.where(eq(podAgent.podId, podId))
						.orderBy(asc(agent.name)),
				).pipe(Effect.map((rows) => rows.map((row) => row.agent))),
			),
	});
});

export const layer = Layer.effect(Service, make);

/** The slug is taken by another channel in this workspace. */
export class PodSlugTaken
	extends Data.TaggedError("PodSlugTaken")<{ readonly slug: string }>
	implements UserFacing
{
	override get message() {
		return `A channel with the slug "${this.slug}" already exists in this workspace`;
	}
	get userMessage() {
		return userText`A channel with that address already exists in this workspace`;
	}
}

/** The channel was deleted before the write reached it. */
export class PodGone
	extends Data.TaggedError("PodGone")<{ readonly podId: string }>
	implements UserFacing
{
	override get message() {
		return `No channel with the id "${this.podId}"`;
	}
	get userMessage() {
		return userText`No such channel`;
	}
}

/** Only a public bot of the workspace is put in a channel. */
export class BotNotPublic extends Data.TaggedError("BotNotPublic") implements UserFacing {
	get userMessage() {
		return userText`Only a public bot can be added to a channel`;
	}
}
