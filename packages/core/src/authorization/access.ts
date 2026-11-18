import type { ToolApprovalDeciders, WorkspaceRole } from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { and, asc, eq, isNull, type SQL, type SQLWrapper, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Data, Effect } from "effect";
import type { Executor } from "../database/database.ts";
import type * as schema from "../database/schema.ts";
import {
	agent,
	directMember,
	pod,
	podMember,
	thread,
	workspace,
	workspaceMember,
} from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";
import type { UserFacing } from "../user-message.ts";
import {
	type Actor,
	type AgentFacts,
	type AgentPermission,
	mayInPod,
	mayOnAgent,
	type PodFacts,
	type PodPermission,
	rolesGrantedInPod,
	type WorkspacePermission,
} from "./permissions.ts";

/**
 * The facts every decision about who may do what is made from: the caller's
 * workspace role, and either the channel a resource is in and whether a
 * `pod_member` row puts them in it, or the bot it belongs to.
 * `Authorization` and `Visibility` load them here and decide with the pure
 * grants in `permissions.ts`; nothing else loads them or turns them into a
 * decision. Standings are only built in this module, so a caller cannot pair
 * a channel with somebody else's membership.
 *
 * **Reach** is a stored `pod_member` row for a channel; administrators are put
 * in every one by the triggers described on `podMember`. A bot is reached by
 * everyone in the workspace when it is public, by its creator alone when it is
 * private, and by its person alone when it is a Personal Assistant. A task,
 * an automation's feed or one of its runs is reached through the bot it is
 * with. A collaboration is reached as the conversation it was opened from,
 * whichever bot was asked, so asking a private bot shows its answer to the
 * people of that conversation and nobody else. A direct message between people
 * is reached through a `direct_member` row while its person is in the
 * workspace, whatever their role. A system bot's thread is reached by nobody.
 *
 * **Hidden** and **forbidden** are different refusals. A resource the caller
 * cannot reach is hidden, so an id cannot be probed for; a resource they can
 * reach but may not change is forbidden.
 */

/** The caller's standing in a workspace they belong to, so their role is known. */
export interface WorkspaceStanding {
	workspaceId: string;
	actor: Actor & { workspaceRole: WorkspaceRole };
}

/** The caller's standing towards a channel. */
export interface PodStanding {
	pod: schema.PodRow;
	actor: Actor;
	/** What the decision was made from, including whether a `pod_member` row exists. */
	facts: PodFacts;
	/** Whether the caller may also take `permission` on this same channel. */
	may(permission: PodPermission): boolean;
}

/** The caller's standing towards a bot. */
export interface AgentStanding {
	agent: schema.AgentRow;
	actor: Actor;
	facts: AgentFacts;
	/** Whether the caller may take `permission` on this bot. */
	may(permission: AgentPermission): boolean;
}

/**
 * The caller's standing towards a thread they reach: a channel's
 * conversation by their standing in the channel, any other bot's thread by
 * their standing towards the bot, and a direct message, being in which
 * permits only reading it and writing in it. A collaboration's standing is
 * the one towards the conversation it was opened from: `pod` when that is a
 * channel's, else `agent` with the standing towards that conversation's bot,
 * not the bot that was asked.
 */
export type ThreadStanding =
	| { kind: "pod"; thread: schema.ThreadRow; standing: PodStanding }
	| { kind: "agent"; thread: schema.ThreadRow; standing: AgentStanding }
	| { kind: "direct"; thread: schema.ThreadRow };

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
			| "conversation"
			| "routine"
			| "message"
			| "turn"
			| "member"
			| "invitation"
			| "artifact";
	}>
	implements UserFacing
{
	get userMessage() {
		return userText`No such ${this.resource}`;
	}
}

/** The caller can see the resource and may not take this action on it. */
export class ActionForbidden
	extends Data.TaggedError("ActionForbidden")<{
		readonly permission: WorkspacePermission | PodPermission | AgentPermission;
	}>
	implements UserFacing
{
	override get message() {
		return `Lacks the ${this.permission} permission`;
	}
	get userMessage() {
		return userText`You are not allowed to do that`;
	}
}

export type AuthorizationDenied = ResourceHidden | ActionForbidden;

/**
 * The standing, when there is one and its caller reaches the channel or bot;
 * otherwise `resource` is hidden, so a refusal never confirms an id.
 */
export function requireReach<Standing extends PodStanding | AgentStanding>(
	standing: Standing | undefined,
	resource: ResourceHidden["resource"],
): Effect.Effect<Standing, ResourceHidden> {
	const reached =
		standing !== undefined &&
		("pod" in standing ? standing.may("pod.read") : standing.may("agent.read"));
	return reached ? Effect.succeed(standing) : Effect.fail(new ResourceHidden({ resource }));
}

/**
 * The standing of `actor` towards `row`, a channel they have just been put
 * in, by creating it or joining it: they are its member.
 */
export function joinedStanding(row: schema.PodRow, actor: Actor): PodStanding {
	return podStanding(row, actor, true);
}

/** One person's standing towards one channel, from facts already in hand. */
function podStanding(row: schema.PodRow, actor: Actor, isMember: boolean): PodStanding {
	const facts: PodFacts = { isMember };
	return { pod: row, actor, facts, may: (permission) => mayInPod(actor, permission, facts) };
}

/** One person's standing towards one bot, from facts already in hand. */
export function agentStanding(row: schema.AgentRow, actor: Actor): AgentStanding {
	const facts: AgentFacts = {
		visibility: row.visibility,
		createdById: row.createdById,
		assistantOf: row.assistantOf,
	};
	return { agent: row, actor, facts, may: (permission) => mayOnAgent(actor, permission, facts) };
}

/**
 * What a channel standing is built from, for a query that has `pod`: the
 * columns to select, and the two joins onto the caller's membership of the
 * workspace and of the channel. Left joins, so a channel the caller has no
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
 * Everything a decision about one channel needs, in one query: the channel,
 * the caller's workspace role and whether a `pod_member` row puts them in it.
 *
 * `undefined` only when there is no such channel. Somebody outside the
 * workspace gets a standing that permits nothing.
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
 * A bot and `userId`'s standing towards it, in one query. `undefined` when
 * there is no such bot, or it is a system bot, which nobody addresses.
 */
export const agentStandingFor = Effect.fn("Access.agentStandingFor")(function* (
	db: Executor,
	agentId: string,
	userId: string,
) {
	if (!isUuid(agentId)) return undefined;
	const [row] = yield* db
		.select({ agent, role: workspaceMember.role })
		.from(agent)
		.leftJoin(
			workspaceMember,
			and(eq(workspaceMember.workspaceId, agent.workspaceId), eq(workspaceMember.userId, userId)),
		)
		.where(and(eq(agent.id, agentId), isNull(agent.systemAgentKey)))
		.limit(1);
	return row
		? agentStanding(row.agent, { userId, workspaceRole: row.role ?? undefined })
		: undefined;
});

/**
 * A thread `userId` reaches, with their standing towards it, in one query.
 * `undefined` when there is no such thread or they do not reach it, which are
 * answered alike.
 */
export const threadStandingFor = Effect.fn("Access.threadStandingFor")(function* (
	db: Executor,
	threadId: string,
	userId: string,
) {
	if (!isUuid(threadId)) return undefined;
	// A collaboration is reached through the conversation it was opened from,
	// so its channel and bot are that conversation's.
	const reachedThrough = alias(thread, "reached_through");
	const reachPodId = sql<string | null>`coalesce(${reachedThrough.podId}, ${thread.podId})`;
	const reachHostId = sql<
		string | null
	>`case when ${reachedThrough.id} is null then ${thread.hostAgentId} else ${reachedThrough.hostAgentId} end`;
	const [row] = yield* db
		.select({
			thread,
			pod,
			host: agent,
			role: workspaceMember.role,
			membershipId: podMember.id,
			inDirect: reachesDirectFor(thread, userId),
		})
		.from(thread)
		.leftJoin(
			reachedThrough,
			and(eq(thread.type, "collaboration"), eq(reachedThrough.id, thread.conversationId)),
		)
		.leftJoin(pod, eq(pod.id, reachPodId))
		.leftJoin(agent, and(eq(agent.id, reachHostId), isNull(agent.systemAgentKey)))
		.leftJoin(
			workspaceMember,
			and(eq(workspaceMember.workspaceId, thread.workspaceId), eq(workspaceMember.userId, userId)),
		)
		.leftJoin(podMember, podMembershipOf(userId))
		.where(eq(thread.id, threadId))
		.limit(1);
	if (!row) return undefined;
	const actor: Actor = { userId, workspaceRole: row.role ?? undefined };
	if (row.pod) {
		const inPod: ThreadStanding = {
			kind: "pod",
			thread: row.thread,
			standing: podStanding(row.pod, actor, row.membershipId !== null),
		};
		return inPod.standing.may("pod.read") ? inPod : undefined;
	}
	if (row.host) {
		const withAgent: ThreadStanding = {
			kind: "agent",
			thread: row.thread,
			standing: agentStanding(row.host, actor),
		};
		return withAgent.standing.may("agent.read") ? withAgent : undefined;
	}
	if (row.thread.type !== "direct") return undefined;
	const direct: ThreadStanding = { kind: "direct", thread: row.thread };
	return row.inDirect ? direct : undefined;
});

/**
 * The channels in a workspace that `userId` is in, by name, each with their
 * standing in it, in one query.
 */
export const reachedPodStandingsFor = Effect.fn("Access.reachedPodStandingsFor")(function* (
	db: Executor,
	workspaceId: string,
	userId: string,
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

/**
 * The channels of a workspace `userId` is in or could join, by name, each with
 * their standing in it, in one query: the public ones, and the private ones
 * they are in.
 */
export const listedPodStandingsFor = Effect.fn("Access.listedPodStandingsFor")(function* (
	db: Executor,
	workspaceId: string,
	userId: string,
) {
	const rows = yield* db
		.select(standingColumns)
		.from(pod)
		.leftJoin(workspaceMember, workspaceMembershipOf(userId))
		.leftJoin(podMember, podMembershipOf(userId))
		.where(
			and(
				eq(pod.workspaceId, workspaceId),
				sql`(${pod.visibility} = 'public' or ${podMember.id} is not null)`,
			),
		)
		.orderBy(asc(pod.name));
	return rows.map((row) => standingFromRow(row, userId));
});

/**
 * The bots in a workspace `userId` is in, each with their standing towards
 * it, in one query: those they reach, and the private ones they don't, which
 * an administrator still manages. System bots are nobody's.
 */
export const agentStandingsFor = Effect.fn("Access.agentStandingsFor")(function* (
	db: Executor,
	workspaceId: string,
	userId: string,
) {
	const rows = yield* db
		.select({ agent, role: workspaceMember.role })
		.from(agent)
		.innerJoin(
			workspaceMember,
			and(eq(workspaceMember.workspaceId, agent.workspaceId), eq(workspaceMember.userId, userId)),
		)
		.where(and(eq(agent.workspaceId, workspaceId), isNull(agent.systemAgentKey)));
	return rows.map((row) => agentStanding(row.agent, { userId, workspaceRole: row.role }));
});

/**
 * Whether a standing may decide a tool call's approval that `deciders`
 * decide. For `pod`: `approval.decide`, and `approval.routine.decide` as
 * well for one raised while an automation runs. For `sandbox-managers`:
 * `sandbox.request.decide`, wherever it was raised.
 */
export function mayDecideApprovals(
	standing: {
		may(
			permission: "approval.decide" | "approval.routine.decide" | "sandbox.request.decide",
		): boolean;
	},
	inRoutine: boolean,
	deciders: ToolApprovalDeciders,
): boolean {
	if (deciders === "sandbox-managers") return standing.may("sandbox.request.decide");
	const needed = inRoutine
		? (["approval.decide", "approval.routine.decide"] as const)
		: (["approval.decide"] as const);
	return needed.every((permission) => standing.may(permission));
}

/**
 * Whether the caller, who reaches the thread a tool call was raised in, may
 * decide it. A request to change a bot's computer is decided by the bot's
 * managers, or a Personal Assistant's person, wherever it was raised: `askingAgent` is the caller's standing
 * towards the bot that raised the call, if they have one. Any other call is
 * decided by the thread's people: in a channel's conversation by those holding
 * `approval.decide` there, and otherwise by those whose standing towards the
 * thread's bot lets them, which for a collaboration is the bot of the
 * conversation it was opened from, whichever bot asked.
 */
export function mayDecideToolCall(
	reached: ThreadStanding,
	askingAgent: AgentStanding | undefined,
	inRoutine: boolean,
	deciders: ToolApprovalDeciders,
): boolean {
	if (deciders === "sandbox-managers") return askingAgent?.may("sandbox.request.decide") ?? false;
	if (reached.kind === "pod") return reached.standing.may("approval.decide");
	if (reached.kind === "agent") return mayDecideApprovals(reached.standing, inRoutine, deciders);
	return false;
}

/**
 * SQL for "`userId` is in the channel `podId` names", `userId` being an id or
 * the column holding one: what `mayInPod(actor, "pod.read", …)` decides for
 * one channel, written again as a `where` clause. The roles come from
 * `rolesGrantedInPod`, but the shape of the rule is repeated here, so a change
 * to `mayInPod`'s shape must be made here too.
 *
 * Aliased throughout, so it composes with a query that already joins any of
 * these tables.
 */
export function reachesPodFor(podId: SQLWrapper, userId: string | SQLWrapper): SQL<boolean> {
	return sql`exists (
		select 1
		from ${pod} as reach_pod
		inner join ${workspaceMember} as reach_workspace_member
			on reach_workspace_member.workspace_id = reach_pod.workspace_id
			and reach_workspace_member.user_id = ${userId}
		inner join ${podMember} as reach_pod_member
			on reach_pod_member.pod_id = reach_pod.id
			and reach_pod_member.user_id = ${userId}
		where reach_pod.id = ${podId}
			and ${roleIsOneOf(ROLES_READING_PODS)}
	)`;
}

/**
 * SQL for "`userId` reaches the bot `agentId` names": what `reachesAgent`
 * decides for one bot, written again as a `where` clause, so a change to it
 * must be made here too. System bots are reached by nobody.
 */
export function reachesAgentFor(agentId: SQLWrapper, userId: string | SQLWrapper): SQL<boolean> {
	return sql`exists (
		select 1
		from ${agent} as reach_agent
		inner join ${workspaceMember} as reach_agent_workspace_member
			on reach_agent_workspace_member.workspace_id = reach_agent.workspace_id
			and reach_agent_workspace_member.user_id = ${userId}
		where reach_agent.id = ${agentId}
			and reach_agent.system_agent_key is null
			and case
				when reach_agent.assistant_of is not null then reach_agent.assistant_of = ${userId}
				when reach_agent.visibility = 'private' then reach_agent.created_by_id = ${userId}
				else true
			end
	)`;
}

/** The columns of a thread, or an alias of it, that whether somebody reaches it is decided from. */
export interface ThreadReachColumns {
	id: SQLWrapper;
	workspaceId: SQLWrapper;
	type: SQLWrapper;
	conversationId: SQLWrapper;
	podId: SQLWrapper;
	hostAgentId: SQLWrapper;
}

/**
 * SQL for "`userId` reaches the thread `row`": the channel rule for a
 * channel's conversation, the bot rule for a bot's thread, the rule of the
 * conversation it was opened from for a collaboration, and membership of the
 * direct message for one between people. Written as SQL for lists, as
 * `threadStandingFor` decides it for one thread.
 */
export function reachesThreadFor(
	row: ThreadReachColumns,
	userId: string | SQLWrapper,
): SQL<boolean> {
	return sql`(case when ${row.type} = 'collaboration' then exists (
		select 1
		from ${thread} as reach_opened_from
		where reach_opened_from.id = ${row.conversationId}
			and (${reachesPodFor(sql`reach_opened_from.pod_id`, userId)}
				or ${reachesAgentFor(sql`reach_opened_from.host_agent_id`, userId)})
	) else (${reachesPodFor(row.podId, userId)} or ${reachesAgentFor(row.hostAgentId, userId)} or ${reachesDirectFor(row, userId)}) end)`;
}

/**
 * SQL for "`userId` is in the direct message `row` and still in its
 * workspace". False for every other thread, which has no `direct_member` rows.
 */
function reachesDirectFor(
	row: { id: SQLWrapper; workspaceId: SQLWrapper },
	userId: string | SQLWrapper,
): SQL<boolean> {
	return sql`exists (
		select 1
		from ${directMember} as reach_direct_member
		inner join ${workspaceMember} as reach_direct_workspace_member
			on reach_direct_workspace_member.user_id = reach_direct_member.user_id
			and reach_direct_workspace_member.workspace_id = ${row.workspaceId}
		where reach_direct_member.thread_id = ${row.id}
			and reach_direct_member.user_id = ${userId}
	)`;
}

/** Roles that reach a channel once they have been added to it. */
const ROLES_READING_PODS = rolesGrantedInPod("pod.read");

/** `false` rather than an empty `in ()`, which is not valid SQL. */
function roleIsOneOf(roles: readonly WorkspaceRole[]): SQL {
	if (roles.length === 0) return sql`false`;
	return sql`reach_workspace_member.role in (${sql.join(
		roles.map((role) => sql`${role}`),
		sql`, `,
	)})`;
}
