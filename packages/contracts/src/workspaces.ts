import { Schema } from "effect";

/**
 * What a member may do in a workspace.
 *
 * - `admin` administers the workspace, its people, its providers and every
 *   shared pod.
 * - `member` uses the shared pods they have been added to.
 * - `viewer` reads and takes part in the shared pods they have been added to,
 *   and configures nothing in them.
 *
 * Every role owns their own Personal pod outright; a role describes what
 * somebody may do in shared space.
 *
 * These are the whole set. Anything else — better-auth's own `owner`, a
 * comma-separated pair, a role from a future release — grants nothing, so
 * assignment is validated against this list wherever a role is written.
 *
 * `docs/permissions.md` is the specification; the grants are in
 * `packages/core/src/workspaces/permissions.ts`.
 */
export const WORKSPACE_ROLES = ["admin", "member", "viewer"] as const;

export const workspaceRoleSchema = Schema.Literals(WORKSPACE_ROLES);

export type WorkspaceRole = typeof workspaceRoleSchema.Type;

/** Whether a value written by better-auth names a role this product supports. */
export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
	return typeof value === "string" && (WORKSPACE_ROLES as readonly string[]).includes(value);
}

/**
 * The role a stored value names, or `undefined` when it names one this product
 * does not support.
 *
 * better-auth writes the column as free text, so a value outside the supported
 * roles is reachable at run time however the types read. Narrowing it as it is
 * read is what makes "anything else grants nothing" true of real rows rather
 * than only of the values the grant tables were written against.
 */
export function workspaceRoleOf(value: unknown): WorkspaceRole | undefined {
	return isWorkspaceRole(value) ? value : undefined;
}

/**
 * A `Record` rather than a chain of comparisons, so adding a role to
 * `WORKSPACE_ROLES` fails to compile here instead of quietly displaying the
 * new role under an old role's name. `ROLE_DESCRIPTIONS` below is the same
 * bargain.
 */
const ROLE_LABELS: Record<WorkspaceRole, string> = {
	admin: "Administrator",
	member: "Member",
	viewer: "Viewer",
};

/**
 * One line saying what each role may do, shown wherever one is chosen.
 *
 * These sit beside the role list rather than in a screen, because they are
 * claims about the grants in
 * `packages/core/src/workspaces/permissions.ts` — when those move, these are
 * the sentences that become lies, and they should be one edit away from them.
 *
 * Deliberately say what the role does rather than everything it cannot: a
 * Member does not create pods, and a Viewer may still take part in a
 * conversation.
 */
const ROLE_DESCRIPTIONS: Record<WorkspaceRole, string> = {
	admin: "Administers the workspace, its providers and every shared pod.",
	member: "Builds agents in the pods they are added to.",
	viewer: "Reads and takes part in the pods they are added to.",
};

/**
 * How a role is named on screen. An unrecognised role is named for what it
 * grants — nothing — rather than borrowed from the role it is not.
 */
export function workspaceRoleLabel(role: WorkspaceRole | undefined): string {
	return role ? ROLE_LABELS[role] : "No access";
}

/** One line saying what a role may do, shown wherever one is chosen. */
export function workspaceRoleDescription(role: WorkspaceRole): string {
	return ROLE_DESCRIPTIONS[role];
}

/**
 * What the caller may do in the workspace itself, already decided by the API.
 *
 * Pod-scoped answers travel with each pod (`podPermissionsSchema`); these are
 * the ones that belong to no pod. As there, the client draws from these and
 * the API still decides.
 */
export const workspacePermissionsSchema = Schema.Struct({
	createPods: Schema.Boolean,
	/** Configure the model and search providers the workspace runs on. */
	manageProviders: Schema.Boolean,
	/** Invite, remove and set the access of the people in the workspace. */
	manageMembers: Schema.Boolean,
	/** Choose the models the Scribe and the Facilitator run on. */
	configureBuiltInAgents: Schema.Boolean,
});

export type WorkspacePermissions = typeof workspacePermissionsSchema.Type;
