import type { WorkspaceRole } from "@sugabots/contracts";
import { and, asc, eq, type SQL, type SQLWrapper } from "drizzle-orm";
import { Data, Effect } from "effect";
import type { Executor } from "../database/database.ts";
import type * as schema from "../database/schema.ts";
import { agent, pod, podMember, thread, workspace, workspaceMember } from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";
import { type UserFacing, UserMessage } from "../user-message.ts";
import {
	type Actor,
	mayInPod,
	type PodFacts,
	type PodPermission,
	type WorkspacePermission,
} from "./permissions.ts";

/**
 * The facts every decision about who may do what is made from: the caller's
 * workspace role, the pod a resource belongs to, and whether a `pod_member`
 * row exists. `Authorization` and `Visibility` load them here and decide with
 * the pure grants in `permissions.ts`; nothing else loads them or turns them
 * into a decision. `podStanding` is the only way to build a standing, so a
 * caller cannot pair a pod with somebody else's membership.
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
 */

/** The caller's standing in a workspace they belong to, so their role is known. */
export interface WorkspaceStanding {
	workspaceId: string;
	actor: Actor & { workspaceRole: WorkspaceRole };
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

/** The caller's standing towards a thread, which is their standing in its pod. */
export interface ThreadStanding extends PodStanding {
	thread: schema.ThreadRow;
}

/**
 * The resource is not there, or the caller may not know that it is. Answered
 * as `not_found` over HTTP: telling the two apart lets a stranger enumerate
 * ids.
 */
export class ResourceHidden
	extends Data.TaggedError("ResourceHidden")<{
		readonly resource:
			| "workspace"
			| "pod"
			| "agent"
			| "thread"
			| "chat"
			| "turn"
			| "member"
			| "invitation";
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

/**
 * The standing, when there is one and its caller reaches the pod; otherwise
 * `resource` is hidden, so a refusal never confirms an id. Every read of
 * something in a pod, and every action on one, is refused this way first.
 */
export function requireReach<Standing extends PodStanding>(
	standing: Standing | undefined,
	resource: ResourceHidden["resource"],
): Effect.Effect<Standing, ResourceHidden> {
	return standing?.may("pod.read")
		? Effect.succeed(standing)
		: Effect.fail(new ResourceHidden({ resource }));
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

/**
 * What a standing is built from, for a query that has `pod`: the columns to
 * select, and the two joins onto the caller's membership of the pod's
 * workspace and of the pod itself. Left joins, so a pod the caller has no
 * part in is still found, with a standing that permits nothing.
 */
const standingColumns = {
	pod,
	role: workspaceMember.role,
	membershipId: podMember.id,
};

const workspaceMembershipOf = (userId: string) =>
	and(eq(workspaceMember.workspaceId, pod.workspaceId), eq(workspaceMember.userId, userId));

const podMembershipOf = (userId: string) =>
	and(eq(podMember.podId, pod.id), eq(podMember.userId, userId));

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
 * The workspace `workspaceRef` names, by its id or its slug, and `userId`'s
 * role in it. `undefined` when there is no such workspace or they are not in
 * it, which are answered alike.
 */
export const workspaceStandingFor = Effect.fn("Access.workspaceStandingFor")(function* (
	db: Executor,
	workspaceRef: string,
	userId: string,
) {
	// A uuid is compared as an id, and anything else as a slug, so a malformed
	// id is never handed to Postgres as a uuid.
	const named = isUuid(workspaceRef)
		? eq(workspace.id, workspaceRef)
		: eq(workspace.slug, workspaceRef);
	const [row] = yield* db
		.select({ workspaceId: workspace.id, role: workspaceMember.role })
		.from(workspaceMember)
		.innerJoin(workspace, eq(workspace.id, workspaceMember.workspaceId))
		.where(and(named, eq(workspaceMember.userId, userId)))
		.limit(1);
	return row
		? { workspaceId: row.workspaceId, actor: { userId, workspaceRole: row.role } }
		: undefined;
});

/**
 * Everything a decision about one pod needs, in one query: the pod, the
 * caller's workspace role and whether a `pod_member` row puts them in it.
 *
 * `undefined` only when there is no such pod. Somebody outside the workspace
 * gets a standing that permits nothing, because "there is no such pod" and
 * "you are in no position here" are answered differently.
 */
export const podStandingFor = Effect.fn("Access.podStandingFor")(function* (
	db: Executor,
	podId: string,
	userId: string,
) {
	if (!isUuid(podId)) return undefined;
	const [row] = yield* db
		.select(standingColumns)
		.from(pod)
		.leftJoin(workspaceMember, workspaceMembershipOf(userId))
		.leftJoin(podMember, podMembershipOf(userId))
		.where(eq(pod.id, podId))
		.limit(1);
	return row ? standingFromRow(row, userId) : undefined;
});

/**
 * An agent and `userId`'s standing in its pod, in one query. `undefined` when
 * there is no such agent or it is in no pod, as a system agent is.
 */
export const agentStandingFor = Effect.fn("Access.agentStandingFor")(function* (
	db: Executor,
	agentId: string,
	userId: string,
) {
	if (!isUuid(agentId)) return undefined;
	const [row] = yield* db
		.select({ agent, ...standingColumns })
		.from(agent)
		.innerJoin(pod, eq(pod.id, agent.podId))
		.leftJoin(workspaceMember, workspaceMembershipOf(userId))
		.leftJoin(podMember, podMembershipOf(userId))
		.where(eq(agent.id, agentId))
		.limit(1);
	return row ? { ...standingFromRow(row, userId), agent: row.agent } : undefined;
});

/**
 * A thread and `userId`'s standing in its pod, in one query. `undefined` when
 * there is no such thread.
 */
export const threadStandingFor = Effect.fn("Access.threadStandingFor")(function* (
	db: Executor,
	threadId: string,
	userId: string,
) {
	if (!isUuid(threadId)) return undefined;
	const [row] = yield* db
		.select({ thread, ...standingColumns })
		.from(thread)
		.innerJoin(pod, eq(pod.id, thread.podId))
		.leftJoin(workspaceMember, workspaceMembershipOf(userId))
		.leftJoin(podMember, podMembershipOf(userId))
		.where(eq(thread.id, threadId))
		.limit(1);
	return row ? { ...standingFromRow(row, userId), thread: row.thread } : undefined;
});

/**
 * The pods in a workspace that `userId` reaches, by name, each with their
 * standing in it, in one query. `reachesPodFor` is the SQL form of reach,
 * which `Visibility` owns; it is asked about `userId` here, so the pods listed
 * and the standings in them cannot be two different people's.
 */
export const reachedPodStandingsFor = Effect.fn("Access.reachedPodStandingsFor")(function* (
	db: Executor,
	workspaceId: string,
	userId: string,
	reachesPodFor: (podId: SQLWrapper, userId: string) => SQL<boolean>,
) {
	const rows = yield* db
		.select(standingColumns)
		.from(pod)
		.leftJoin(workspaceMember, workspaceMembershipOf(userId))
		.leftJoin(podMember, podMembershipOf(userId))
		.where(and(eq(pod.workspaceId, workspaceId), reachesPodFor(pod.id, userId)))
		.orderBy(asc(pod.name));
	return rows.map((row) => standingFromRow(row, userId));
});
