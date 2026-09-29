import { Schema } from "effect";

/**
 * What a member may do in a workspace.
 *
 * - `owner` is the one person who holds the workspace: an administrator who
 *   also decides who else administers it, and who alone can hand it on.
 *   Every workspace has exactly one, from the moment its creator makes it.
 * - `admin` administers the workspace, its people, its providers and every
 *   shared pod.
 * - `member` uses the shared pods they have been added to.
 * - `viewer` reads and takes part in the shared pods they have been added to,
 *   and configures nothing in them.
 *
 * Every role owns their own Personal pod outright; a role describes what
 * somebody may do in shared space.
 *
 * These are the whole set: the database refuses any other value.
 *
 * The grants each role holds are in
 * `packages/core/src/authorization/permissions.ts`.
 */
export const WORKSPACE_ROLES = ["owner", "admin", "member", "viewer"] as const;

export const workspaceRoleSchema = Schema.Literals(WORKSPACE_ROLES);

/**
 * The roles somebody can be invited with or given. Owner is not one: it
 * changes hands only by the owner transferring it, so there is always one.
 */
export const ASSIGNABLE_WORKSPACE_ROLES = ["admin", "member", "viewer"] as const;

export const assignableWorkspaceRoleSchema = Schema.Literals(ASSIGNABLE_WORKSPACE_ROLES);

export type AssignableWorkspaceRole = typeof assignableWorkspaceRoleSchema.Type;

/**
 * The roles that administer the workspace. Each is in every shared pod, put
 * there by database triggers, and can neither leave one nor be taken out.
 */
export const ADMINISTERING_WORKSPACE_ROLES = [
	"owner",
	"admin",
] as const satisfies readonly WorkspaceRole[];

export function administersWorkspace(role: WorkspaceRole | undefined): boolean {
	return (
		role !== undefined && (ADMINISTERING_WORKSPACE_ROLES as readonly WorkspaceRole[]).includes(role)
	);
}

export const workspaceIdOrSlugSchema = Schema.String.check(Schema.isMinLength(1));

export type WorkspaceRole = typeof workspaceRoleSchema.Type;

/**
 * A `Record` rather than a chain of comparisons, so adding a role to
 * `WORKSPACE_ROLES` fails to compile here instead of quietly displaying the
 * new role under an old role's name. `ROLE_DESCRIPTIONS` below is the same
 * bargain.
 */
const ROLE_LABELS: Record<WorkspaceRole, string> = {
	owner: "Owner",
	admin: "Admin",
	member: "Member",
	viewer: "Viewer",
};

/**
 * One line saying what each role may do, shown wherever one is chosen.
 *
 * These sit beside the role list rather than in a screen, because they are
 * claims about the grants in
 * `packages/core/src/authorization/permissions.ts` — when those move, these are
 * the sentences that become lies, and they should be one edit away from them.
 *
 * Deliberately say what the role does rather than everything it cannot: a
 * Member does not create pods, and a Viewer may still take part in a
 * conversation.
 */
const ROLE_DESCRIPTIONS: Record<WorkspaceRole, string> = {
	owner: "Administers the workspace, decides who else does, and can hand it on.",
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
	/** See what the workspace's models cost, and limit it. */
	manageUsage: Schema.Boolean,
	/** Make somebody an administrator or stop them being one, and remove an administrator. */
	manageAdmins: Schema.Boolean,
	/** Hand the workspace to another member, who becomes its owner. */
	transferOwnership: Schema.Boolean,
	/** Delete the workspace and everything in it. */
	deleteWorkspace: Schema.Boolean,
});

export type WorkspacePermissions = typeof workspacePermissionsSchema.Type;
