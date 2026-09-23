/**
 * The actions an endpoint can require, by name.
 *
 * They are part of the API's contract because each endpoint declares the one
 * it needs (`./http/access.ts`). Who holds which is decided in
 * `packages/core/src/workspaces/permissions.ts`; `docs/permissions.md` is the
 * specification.
 */

/** An action addressed at a workspace. */
export type WorkspacePermission =
	/** Belong to the workspace: see its roster, its enabled models, its own personal pod. */
	| "workspace.read"
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
	/** Turn one decision into a standing approval for that tool. */
	| "approval.alwaysAllow"
	/** Withdraw a standing approval, whoever granted it. */
	| "approval.revoke";
