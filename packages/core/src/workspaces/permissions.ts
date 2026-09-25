import {
	type PodPermissions as PodPermissionsView,
	WORKSPACE_ROLES,
	type WorkspacePermissions as WorkspacePermissionsView,
	type WorkspaceRole,
} from "@sugabots/contracts";

/**
 * What a person may do, as named actions rather than role comparisons.
 *
 * Application code asks "may this person do this here?", never "is this person
 * an admin?". Role names appear in the grant tables below, in role assignment
 * and in what is displayed — nowhere else. Adding a role later means adding a
 * grant table; it does not mean revisiting every handler.
 *
 * Two kinds of action, kept apart by their types so a pod action cannot be
 * asked without the pod's facts:
 *
 * - **Workspace actions** concern the workspace itself, and are answered from
 *   the caller's role alone.
 * - **Pod actions** concern a pod and everything inside it — agents, their
 *   Routines, the pod's connections, its conversations and the approvals they
 *   need. They are answered from the caller's role *and* the pod.
 *
 * Every permission here is asked for somewhere. An action that no role holds
 * without also holding `pod.read` is not a permission: conversations are read,
 * joined and cancelled by whoever reaches the pod, which is what `pod.read`
 * already says.
 *
 * Grants are additive and default to nothing: an unknown role, or a permission
 * no grant table mentions, allows nothing. There is no wildcard, so a
 * permission added below reaches a role only when that role's table names it.
 *
 * This module is pure. Loading the facts it takes is
 * `packages/core/src/workspaces/access.ts`; the specification it implements is
 * `docs/permissions.md`.
 */

/** An action addressed at a workspace. */
export type WorkspacePermission =
	/** Belong to the workspace: see its roster, its enabled models, its own personal pod. */
	| "workspace.read"
	/** Rename the workspace and change its address. */
	| "workspace.update"
	/** Configure the model and search providers the workspace runs on. */
	| "workspace.providers.manage"
	/** Invite, remove and set the access of the people in the workspace. */
	| "workspace.members.manage"
	/** Choose the models the Scribe and the Facilitator run on. */
	| "workspace.builtInAgents.configure"
	/** Create a shared pod. */
	| "pod.create";

/**
 * An action addressed at a pod, or at something inside one.
 *
 * `pod.read` is reach: holding it is being able to see the pod, its agents and
 * its conversations, and to take part in them.
 */
export type PodPermission =
	| "pod.read"
	| "pod.update"
	| "pod.delete"
	| "pod.members.manage"
	| "agent.read"
	| "agent.create"
	| "agent.update"
	| "agent.delete"
	| "connection.read"
	| "connection.manage"
	| "routine.read"
	| "routine.manage"
	| "routine.run"
	| "routine.history.read"
	/** Decide a tool call an agent raised in ordinary conversation. */
	| "approval.decide"
	/** Decide a tool call an agent raised while a Routine was running. */
	| "approval.routine.decide"
	/** Throw away the pod's sandbox, so the next agent to need one gets a new one. */
	| "sandbox.manage";

/**
 * The caller.
 *
 * `workspaceRole` is `undefined` for somebody outside the workspace holding the
 * resource, which grants nothing at all — the workspace boundary is checked
 * here rather than being left to each caller.
 */
export interface Actor {
	userId: string;
	workspaceRole: WorkspaceRole | undefined;
}

/** What a decision about a pod needs to know about it. */
export interface PodFacts {
	kind: "personal" | "shared";
	/** Whose Personal pod this is. `null` for a shared pod. */
	ownerId: string | null;
	/** Whether a `pod_member` row puts the caller in this pod. */
	isExplicitMember: boolean;
}

/**
 * Where a role holds a pod permission.
 *
 * `shared-pods` reaches every shared pod in the workspace without a membership
 * row; `joined-pods` reaches only the shared pods the caller has actually been
 * added to. Personal pods are not reached by either — they are governed by
 * ownership alone, below.
 */
type PodGrantScope = "shared-pods" | "joined-pods";

const WORKSPACE_GRANTS: Record<WorkspaceRole, ReadonlySet<WorkspacePermission>> = {
	admin: new Set<WorkspacePermission>([
		"workspace.read",
		"workspace.update",
		"workspace.providers.manage",
		"workspace.members.manage",
		"workspace.builtInAgents.configure",
		"pod.create",
	]),
	member: new Set<WorkspacePermission>(["workspace.read"]),
	viewer: new Set<WorkspacePermission>(["workspace.read"]),
};

const POD_GRANTS: Record<WorkspaceRole, Readonly<Partial<Record<PodPermission, PodGrantScope>>>> = {
	admin: {
		"pod.read": "shared-pods",
		"pod.update": "shared-pods",
		"pod.delete": "shared-pods",
		"pod.members.manage": "shared-pods",
		"agent.read": "shared-pods",
		"agent.create": "shared-pods",
		"agent.update": "shared-pods",
		"agent.delete": "shared-pods",
		"connection.read": "shared-pods",
		"connection.manage": "shared-pods",
		"routine.read": "shared-pods",
		"routine.manage": "shared-pods",
		"routine.run": "shared-pods",
		"routine.history.read": "shared-pods",
		"approval.decide": "shared-pods",
		"approval.routine.decide": "shared-pods",
		"sandbox.manage": "shared-pods",
	},
	member: {
		"pod.read": "joined-pods",
		"agent.read": "joined-pods",
		"agent.create": "joined-pods",
		"agent.update": "joined-pods",
		"connection.read": "joined-pods",
		"routine.read": "joined-pods",
		"routine.history.read": "joined-pods",
		"approval.decide": "joined-pods",
	},
	// A viewer reads and takes part — which `pod.read` grants — and configures
	// nothing beyond that.
	viewer: {
		"pod.read": "joined-pods",
		"agent.read": "joined-pods",
		"connection.read": "joined-pods",
		"routine.read": "joined-pods",
		"routine.history.read": "joined-pods",
	},
};

/**
 * A Personal pod belongs to one person and nobody else, administrator
 * included. Its owner holds every pod permission in it; separate domain rules
 * still refuse to rename it, delete it or give it other members.
 */
function isPersonalPodOwner(actor: Actor, pod: PodFacts): boolean {
	return pod.kind === "personal" && pod.ownerId !== null && pod.ownerId === actor.userId;
}

/** The grants a role holds, or nothing at all for somebody outside the workspace. */
function grantsFor(role: WorkspaceRole | undefined) {
	if (!role) return undefined;
	return { workspace: WORKSPACE_GRANTS[role], pod: POD_GRANTS[role] };
}

/** Whether the caller may take a workspace-addressed action. */
export function mayInWorkspace(actor: Actor, permission: WorkspacePermission): boolean {
	return grantsFor(actor.workspaceRole)?.workspace.has(permission) ?? false;
}

/**
 * Whether the caller may take a pod-addressed action on this pod.
 *
 * `pod` must be a pod in the workspace `actor.workspaceRole` describes; the
 * caller is responsible for not mixing workspaces, which
 * `packages/core/src/workspaces/access.ts` does by loading both together.
 */
export function mayInPod(actor: Actor, permission: PodPermission, pod: PodFacts): boolean {
	const grants = grantsFor(actor.workspaceRole);
	if (!grants) return false;
	if (pod.kind === "personal") return isPersonalPodOwner(actor, pod);

	const scope = grants.pod[permission];
	if (!scope) return false;
	return scope === "shared-pods" || pod.isExplicitMember;
}

/**
 * The roles holding a workspace permission, for the queries that filter by the
 * stored role rather than asking about one caller.
 *
 * Derived from the grants, so a query scoped with it follows a grant that
 * moves instead of naming a role that used to hold it.
 */
export function rolesWith(permission: WorkspacePermission): WorkspaceRole[] {
	return WORKSPACE_ROLES.filter((role) => WORKSPACE_GRANTS[role].has(permission));
}

/**
 * Which shared pods a role reaches, for the queries that list rather than
 * address one resource.
 *
 * `all` means every shared pod in the workspace; `joined` means only those with
 * a membership row; `none` means the role reaches no shared pod at all. Either
 * way a Personal pod is reached by its owner alone, which is why this answers
 * about shared pods only.
 *
 * The equivalent single-resource answer is `mayInPod(actor, "pod.read", pod)`.
 * `packages/core/src/workspaces/access.ts` expresses the same rule as one SQL
 * predicate so a list and a direct read cannot disagree.
 */
export function sharedPodReach(role: WorkspaceRole | undefined): "all" | "joined" | "none" {
	const scope = grantsFor(role)?.pod["pod.read"];
	if (!scope) return "none";
	return scope === "shared-pods" ? "all" : "joined";
}

/**
 * The pod permissions a client needs resolved, as the API returns them.
 *
 * The same grants the API enforces, answered once per pod so the web app never
 * has to reason about roles or ownership itself. The domain rules that hold a
 * Personal pod fixed are folded in here too, so a client never pairs one of
 * these with the pod's kind: renaming one and giving it members are refused to
 * everybody, its owner included.
 */
export function podPermissions(actor: Actor, pod: PodFacts): PodPermissionsView {
	const may = (permission: PodPermission) => mayInPod(actor, permission, pod);
	const shared = pod.kind === "shared";
	return {
		rename: shared && may("pod.update"),
		changeRouting: may("pod.update"),
		manageMembers: shared && may("pod.members.manage"),
		createAgents: may("agent.create"),
		updateAgents: may("agent.update"),
		deleteAgents: may("agent.delete"),
		manageConnections: may("connection.manage"),
		manageRoutines: may("routine.manage"),
		runRoutines: may("routine.run"),
		manageSandbox: may("sandbox.manage"),
	};
}

/** The workspace permissions a client needs resolved, as the API returns them. */
export function workspacePermissions(actor: Actor): WorkspacePermissionsView {
	return {
		createPods: mayInWorkspace(actor, "pod.create"),
		manageProviders: mayInWorkspace(actor, "workspace.providers.manage"),
		manageMembers: mayInWorkspace(actor, "workspace.members.manage"),
		configureBuiltInAgents: mayInWorkspace(actor, "workspace.builtInAgents.configure"),
	};
}
