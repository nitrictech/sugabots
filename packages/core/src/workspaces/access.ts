import { WORKSPACE_ROLES, type WorkspaceRole } from "@sugabots/contracts";
import { and, eq, type SQL, type SQLWrapper, sql } from "drizzle-orm";
import { Data, Effect } from "effect";
import type { Database, Executor } from "../database/database.ts";
import { query } from "../database/database.ts";
import type * as schema from "../database/schema.ts";
import { agent, pod, podMember, workspace, workspaceMember } from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";
import { type UserFacing, UserMessage } from "../user-message.ts";
import {
	type Actor,
	mayInPod,
	mayInWorkspace,
	type PodFacts,
	type PodPermission,
	sharedPodReach,
	type WorkspacePermission,
} from "./permissions.ts";

/**
 * Who may do what, decided once.
 *
 * This module loads facts — the caller's workspace role, the pod a resource
 * belongs to, whether a `pod_member` row exists — and hands them to the pure
 * grants in `permissions.ts`. Nothing here decides anything itself, and
 * nothing outside here loads those facts or turns them into a decision:
 * `podStanding` is the only way to build one, so a caller cannot pair a pod
 * with somebody else's membership.
 *
 * Two distinctions the rest of the codebase depends on:
 *
 * - **Explicit membership** is a stored `pod_member` row. **Reach** is
 *   membership *or* a role that grants the pod without one. They are kept
 *   apart because editing a pod's member list, and demoting somebody, both
 *   mean the stored rows and not the effective answer.
 * - **Hidden** and **forbidden** are different refusals. A resource the caller
 *   cannot reach is hidden, so an id cannot be probed for; a resource they can
 *   reach but may not change is forbidden.
 *
 * An interface, so routes can be tested without a database: the HTTP tests
 * hand `createTestApp` their own.
 */

/** The caller's standing in a workspace, once an action has been allowed. */
export interface WorkspaceStanding {
	workspaceId: string;
	actor: Actor;
}

/** The caller's standing towards a pod. */
export interface PodStanding {
	pod: schema.PodRow;
	actor: Actor;
	/** What the decision was made from, including whether a `pod_member` row exists. */
	facts: PodFacts;
	/** Whether the caller may also take `permission` on this same pod. */
	may(permission: PodPermission): boolean;
}

/** The caller's standing towards an agent, which is their standing in its pod. */
export interface AgentStanding extends PodStanding {
	agent: schema.AgentRow;
}

/**
 * The resource is not there, or the caller may not know that it is. Answered
 * as `not_found` over HTTP: telling the two apart lets a stranger enumerate
 * ids.
 */
export class ResourceHidden
	extends Data.TaggedError("ResourceHidden")<{
		readonly resource: "workspace" | "pod" | "agent" | "member" | "invitation";
	}>
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`No such ${this.resource}`;
	}
}

/** The caller can see the resource and may not take this action on it. */
export class ActionForbidden
	extends Data.TaggedError("ActionForbidden")<{
		readonly permission: WorkspacePermission | PodPermission;
	}>
	implements UserFacing
{
	override get message() {
		return `Lacks the ${this.permission} permission`;
	}
	get userMessage() {
		return UserMessage.of`You are not allowed to do that`;
	}
}

export type AuthorizationDenied = ResourceHidden | ActionForbidden;

export interface Authorization {
	/**
	 * `workspaceRef` must name a workspace the caller belongs to, by its id or
	 * its slug, and the action must be one their role grants there. The
	 * standing carries the resolved id, which is what everything after uses.
	 */
	workspace(
		userId: string,
		workspaceRef: string,
		permission: WorkspacePermission,
	): Effect.Effect<WorkspaceStanding, AuthorizationDenied, Database>;
	/**
	 * `podId` must name a pod the caller reaches, and the action must be one
	 * they may take in it.
	 */
	pod(
		userId: string,
		podId: string,
		permission: PodPermission,
	): Effect.Effect<PodStanding, AuthorizationDenied, Database>;
	/** An agent, on the same terms as the pod it lives in. */
	agent(
		userId: string,
		agentId: string,
		permission: PodPermission,
	): Effect.Effect<AgentStanding, AuthorizationDenied, Database>;
}

export const authorization: Authorization = {
	workspace: (userId, workspaceRef, permission) =>
		Effect.gen(function* () {
			// A uuid is compared as an id, and anything else as a slug, so a
			// malformed id is never handed to Postgres as a uuid.
			const named = isUuid(workspaceRef)
				? eq(workspace.id, workspaceRef)
				: eq(workspace.slug, workspaceRef);
			const [row] = yield* query((db) =>
				db
					.select({ workspaceId: workspace.id, role: workspaceMember.role })
					.from(workspaceMember)
					.innerJoin(workspace, eq(workspace.id, workspaceMember.workspaceId))
					.where(and(named, eq(workspaceMember.userId, userId)))
					.limit(1),
			);

			if (!row) {
				return yield* new ResourceHidden({ resource: "workspace" });
			}
			const actor: Actor = { userId, workspaceRole: row.role };
			if (!mayInWorkspace(actor, permission)) {
				return yield* new ActionForbidden({ permission });
			}
			return { workspaceId: row.workspaceId, actor };
		}),

	pod: (userId, podId, permission) =>
		Effect.gen(function* () {
			if (!isUuid(podId)) {
				return yield* new ResourceHidden({ resource: "pod" });
			}
			const standing = yield* query((db) => podStandingFor(db, podId, userId));
			if (!standing) {
				return yield* new ResourceHidden({ resource: "pod" });
			}
			return yield* decideInPod(standing, permission, "pod");
		}),

	agent: (userId, agentId, permission) =>
		Effect.gen(function* () {
			if (!isUuid(agentId)) {
				return yield* new ResourceHidden({ resource: "agent" });
			}

			// One round trip: the agent, its pod, the caller's workspace role, and
			// whether a membership row puts them in that pod.
			const [row] = yield* query((db) =>
				db
					.select({ agent, ...standingColumns })
					.from(agent)
					.innerJoin(pod, eq(pod.id, agent.podId))
					.leftJoin(
						workspaceMember,
						and(
							eq(workspaceMember.workspaceId, agent.workspaceId),
							eq(workspaceMember.userId, userId),
						),
					)
					.leftJoin(podMember, and(eq(podMember.podId, agent.podId), eq(podMember.userId, userId)))
					.where(eq(agent.id, agentId))
					.limit(1),
			);

			if (!row) {
				return yield* new ResourceHidden({ resource: "agent" });
			}
			return yield* Effect.map(
				decideInPod(standingFromRow(row, userId), permission, "agent"),
				(allowed): AgentStanding => ({ ...allowed, agent: row.agent }),
			);
		}),
};

/** Grants nothing. The default, so a route is never open by omission. */
export function closedAuthorization(): Authorization {
	return {
		workspace: () => Effect.fail(new ResourceHidden({ resource: "workspace" })),
		pod: () => Effect.fail(new ResourceHidden({ resource: "pod" })),
		agent: () => Effect.fail(new ResourceHidden({ resource: "agent" })),
	};
}

/**
 * One person's standing towards one pod, from facts already in hand.
 *
 * The only constructor there is, so the pod, the role and the membership in a
 * standing always describe the same person and the same pod.
 */
export function podStanding(
	row: schema.PodRow,
	actor: Actor,
	isExplicitMember: boolean,
): PodStanding {
	const facts: PodFacts = { kind: row.kind, ownerId: row.ownerId, isExplicitMember };
	return { pod: row, actor, facts, may: (permission) => mayInPod(actor, permission, facts) };
}

/** The columns a standing is built from, for a query that already joins `pod`. */
const standingColumns = {
	pod,
	role: workspaceMember.role,
	membershipId: podMember.id,
};

type StandingRow = {
	pod: schema.PodRow;
	role: WorkspaceRole | null;
	membershipId: string | null;
};

function standingFromRow(row: StandingRow, userId: string): PodStanding {
	return podStanding(
		row.pod,
		{ userId, workspaceRole: row.role ?? undefined },
		row.membershipId !== null,
	);
}

/**
 * Everything a decision about one pod needs, in one query: the pod, the
 * caller's workspace role and whether a `pod_member` row puts them in it.
 *
 * `undefined` only when there is no such pod. Somebody outside the workspace
 * gets a standing that permits nothing, because "there is no such pod" and
 * "you are in no position here" are answered differently.
 *
 * Every decision about a pod made outside an HTTP route — in the worker, in a
 * store settling a tool call — starts here, so none of them reconstructs the
 * facts its own way.
 */
export const podStandingFor = Effect.fn("Authorization.podStandingFor")(function* (
	db: Executor,
	podId: string,
	userId: string,
) {
	const [row] = yield* db
		.select(standingColumns)
		.from(pod)
		.leftJoin(
			workspaceMember,
			and(eq(workspaceMember.workspaceId, pod.workspaceId), eq(workspaceMember.userId, userId)),
		)
		.leftJoin(podMember, and(eq(podMember.podId, pod.id), eq(podMember.userId, userId)))
		.where(eq(pod.id, podId))
		.limit(1);
	return row ? standingFromRow(row, userId) : undefined;
});

/**
 * Visibility first, then the action.
 *
 * A pod the caller cannot reach is hidden whatever they asked for, so that a
 * refusal never confirms an id. Only once they can reach it does being unable
 * to act become a `forbidden`.
 */
export function decideInPod(
	standing: PodStanding,
	permission: PodPermission,
	resource: "pod" | "agent",
): Effect.Effect<PodStanding, AuthorizationDenied> {
	if (!standing.may("pod.read")) {
		return Effect.fail(new ResourceHidden({ resource }));
	}
	if (!standing.may(permission)) {
		return Effect.fail(new ActionForbidden({ permission }));
	}
	return Effect.succeed(standing);
}

/** Roles that reach every shared pod in their workspace without a membership row. */
const ROLES_REACHING_EVERY_SHARED_POD = WORKSPACE_ROLES.filter(
	(role) => sharedPodReach(role) === "all",
);

/** Roles that reach a shared pod once they have been added to it. */
const ROLES_REACHING_JOINED_PODS = WORKSPACE_ROLES.filter(
	(role) => sharedPodReach(role) !== "none",
);

/**
 * SQL for "this person reaches that pod", for the queries that scope a list
 * rather than address one resource.
 *
 * The same rule `mayInPod(actor, "pod.read", …)` applies to a single pod, in
 * the one form a `where` clause can use, so a list and a direct read cannot
 * disagree: a Personal pod is reached by its owner and by nobody else, and a
 * shared pod by a role that reaches every one of them or by a membership row
 * held by a role that reaches the pods it has joined. `podId` is the column
 * naming the pod: `thread.podId`, `agent.podId`, `pod.id`.
 *
 * Aliased throughout, so it composes with a query that already joins any of
 * these tables.
 */
export function reachesPod(podId: SQLWrapper, userId: string): SQL<boolean> {
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
