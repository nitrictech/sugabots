export * as Visibility from "./visibility.ts";

import { WORKSPACE_ROLES, type WorkspaceRole } from "@sugabots/contracts";
import { and, eq, type SQL, type SQLWrapper, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { query, serviceOperations } from "../database/database.ts";
import type * as schema from "../database/schema.ts";
import { chat, pod, podMember, workspaceMember } from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";
import {
	type PodStanding,
	ResourceHidden,
	reachedPodStandingsFor,
	requireReach,
	type ThreadStanding,
	threadStandingFor,
} from "./access.ts";
import { CurrentActor } from "./current-actor.ts";
import { sharedPodReach } from "./permissions.ts";

/**
 * What the current actor can see. A pod is seen by whoever reaches it, and
 * everything inside it, its threads and chats included, by whoever sees the
 * pod. Lists and single reads are scoped by the one rule, the same one
 * `Authorization` checks `pod.read` with, so they cannot disagree.
 */
export interface Interface {
	/** The rule for the pods the actor reaches, for queries that scope a list. */
	readonly reachesPod: Effect.Effect<ReachesPod, never, CurrentActor.Service>;
	/** The pods the actor reaches in the workspace, by name, with their standing in each. */
	readonly pods: (workspaceId: string) => Effect.Effect<PodStanding[], never, CurrentActor.Service>;
	/** The thread, with the actor's standing in its pod. */
	readonly thread: (
		threadId: string,
	) => Effect.Effect<ThreadStanding, ResourceHidden, CurrentActor.Service>;
	readonly chat: (
		chatId: string,
	) => Effect.Effect<schema.ChatRow, ResourceHidden, CurrentActor.Service>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Visibility") {}

/**
 * SQL for "somebody reaches this pod", given the column naming the pod:
 * `thread.podId`, `agent.podId`, `pod.id`.
 */
export type ReachesPod = (podId: SQLWrapper) => SQL<boolean>;

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("Visibility");
	return Service.of({
		reachesPod: Effect.map(
			CurrentActor.Service,
			({ userId }) =>
				(podId) =>
					reachesPodFor(podId, userId),
		),

		pods: (workspaceId) =>
			operation(
				"pods",
				Effect.flatMap(CurrentActor.Service, ({ userId }) =>
					query((db) => reachedPodStandingsFor(db, workspaceId, userId, reachesPodFor)),
				),
			),

		thread: (threadId) =>
			operation(
				"thread",
				Effect.gen(function* () {
					const { userId } = yield* CurrentActor.Service;
					const standing = yield* query((db) => threadStandingFor(db, threadId, userId));
					return yield* requireReach(standing, "thread");
				}),
			),

		chat: (chatId) =>
			operation(
				"chat",
				Effect.gen(function* () {
					const { userId } = yield* CurrentActor.Service;
					const [row] = isUuid(chatId)
						? yield* query((db) =>
								db
									.select()
									.from(chat)
									.where(and(eq(chat.id, chatId), reachesPodFor(chat.podId, userId)))
									.limit(1),
							)
						: [];
					if (!row) return yield* new ResourceHidden({ resource: "chat" });
					return row;
				}),
			),
	});
});

export const layer = Layer.effect(Service, make);

/** Roles that reach every shared pod in their workspace without a membership row. */
const ROLES_REACHING_EVERY_SHARED_POD = WORKSPACE_ROLES.filter(
	(role) => sharedPodReach(role) === "all",
);

/** Roles that reach a shared pod once they have been added to it. */
const ROLES_REACHING_JOINED_PODS = WORKSPACE_ROLES.filter(
	(role) => sharedPodReach(role) !== "none",
);

/**
 * SQL for "`userId` reaches that pod": the rule `mayInPod(actor, "pod.read",
 * …)` applies to a single pod, in the one form a `where` clause can use. A
 * Personal pod is reached by its owner and by nobody else, and a shared pod by
 * a role that reaches every one of them or by a membership row held by a role
 * that reaches the pods it has joined.
 *
 * Aliased throughout, so it composes with a query that already joins any of
 * these tables.
 */
function reachesPodFor(podId: SQLWrapper, userId: string): SQL<boolean> {
	return sql`exists (
		select 1
		from ${pod} as reach_pod
		inner join ${workspaceMember} as reach_workspace_member
			on reach_workspace_member.workspace_id = reach_pod.workspace_id
			and reach_workspace_member.user_id = ${userId}
		left join ${podMember} as reach_pod_member
			on reach_pod_member.pod_id = reach_pod.id
			and reach_pod_member.user_id = ${userId}
		where reach_pod.id = ${podId}
			and (
				(reach_pod.kind = 'personal' and reach_pod.owner_id = ${userId})
				or (
					reach_pod.kind = 'shared'
					and (
						${roleIsOneOf(ROLES_REACHING_EVERY_SHARED_POD)}
						or (
							reach_pod_member.id is not null
							and ${roleIsOneOf(ROLES_REACHING_JOINED_PODS)}
						)
					)
				)
			)
	)`;
}

/** `false` rather than an empty `in ()`, which is not valid SQL. */
function roleIsOneOf(roles: readonly WorkspaceRole[]): SQL {
	if (roles.length === 0) return sql`false`;
	return sql`reach_workspace_member.role in (${sql.join(
		roles.map((role) => sql`${role}`),
		sql`, `,
	)})`;
}
