import { Schema } from "effect";

/**
 * What a member may do in a workspace.
 *
 * - `owner` is the one member who holds the workspace: an administrator who
 *   also decides who else administers it, and who alone can hand it on.
 *   Every workspace has exactly one, from the moment its creator makes it.
 * - `admin` administers the workspace, its members, its providers, every
 *   project and every bot.
 * - `editor` makes bots and projects, and uses the public bots and the
 *   projects they are in.
 * - `viewer` reads and takes part in the projects they are in and with the
 *   public bots, and configures nothing.
 *
 * Everybody has their own Personal Assistant whatever their role.
 *
 * These are the whole set: the database refuses any other value.
 *
 * The grants each role holds are in
 * `packages/core/src/authorization/permissions.ts`.
 */
export const WORKSPACE_ROLES = ["owner", "admin", "editor", "viewer"] as const;

export const workspaceRoleSchema = Schema.Literals(WORKSPACE_ROLES);

/**
 * The roles somebody can be invited with or given. Owner is not one: it
 * changes hands only when the owner hands it over, so there is always one.
 */
export const ASSIGNABLE_WORKSPACE_ROLES = ["admin", "editor", "viewer"] as const;

export const assignableWorkspaceRoleSchema = Schema.Literals(ASSIGNABLE_WORKSPACE_ROLES);

export type AssignableWorkspaceRole = typeof assignableWorkspaceRoleSchema.Type;

/**
 * The roles that administer the workspace. Each is in every project members
 * made, put there by database triggers, and can neither leave one nor be taken
 * out. A bot's default project has no members: it is reached through its bot.
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
 * new role under an old role's name. `WORKSPACE_ROLE_DESCRIPTIONS` below is the same
 * bargain.
 */
const WORKSPACE_ROLE_LABELS: Record<WorkspaceRole, string> = {
	owner: "Owner",
	admin: "Admin",
	editor: "Editor",
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
 * Deliberately say what the role does rather than everything it cannot: an
 * Editor does not change other members' bots, and a Viewer may still take
 * part in a chat.
 */
const WORKSPACE_ROLE_DESCRIPTIONS: Record<WorkspaceRole, string> = {
	owner: "Administers the workspace, decides who else does, and can hand it on.",
	admin:
		"Administers the workspace, its providers, every project members made and every bot but others' Personal Assistants.",
	editor: "Makes bots and projects, and works with the public bots.",
	viewer: "Reads and takes part in projects and with public bots.",
};

/**
 * How a role is named on screen. An unrecognised role is named for what it
 * grants — nothing — rather than borrowed from the role it is not.
 */
export function workspaceRoleLabel(role: WorkspaceRole | undefined): string {
	return role ? WORKSPACE_ROLE_LABELS[role] : "No access";
}

/** One line saying what a role may do, shown wherever one is chosen. */
export function workspaceRoleDescription(role: WorkspaceRole): string {
	return WORKSPACE_ROLE_DESCRIPTIONS[role];
}

/**
 * What the caller may do in the workspace itself, already decided by the API.
 *
 * Answers about one project travel with it (`projectPermissionsSchema`), and
 * about one bot with it (`botPermissionsSchema`); these are the ones that
 * belong to neither. As there, the client draws from these and
 * the API still decides.
 */
export const workspacePermissionsSchema = Schema.Struct({
	createProjects: Schema.Boolean,
	createBots: Schema.Boolean,
	/** Rename the workspace, change its address, and move it to another time zone. */
	updateWorkspace: Schema.Boolean,
	/** Configure the model and search providers the workspace runs on. */
	manageProviders: Schema.Boolean,
	/** Invite, remove and set the access of the members in the workspace. */
	manageMembers: Schema.Boolean,
	/** Choose the model Compaction runs on. */
	chooseSystemModel: Schema.Boolean,
	/** See what the workspace's models cost, and limit it. */
	manageUsage: Schema.Boolean,
	/** Make somebody an administrator or stop them being one, and remove an administrator. */
	manageAdmins: Schema.Boolean,
	/** Hand the workspace to another member in it, who becomes its owner. */
	handOverOwnership: Schema.Boolean,
	/** Delete the workspace and everything in it. */
	deleteWorkspace: Schema.Boolean,
});

export type WorkspacePermissions = typeof workspacePermissionsSchema.Type;

/**
 * What the caller may do in one workspace, so the web app can decide whether
 * to draw a control at all rather than let it fail. The role is here too,
 * because a settings screen says which one somebody holds.
 */
export const workspaceAccessSchema = Schema.Struct({
	/** Always present past `workspace.read`, which no role-less caller holds. */
	role: Schema.optional(workspaceRoleSchema),
	permissions: workspacePermissionsSchema,
});
export type WorkspaceAccess = typeof workspaceAccessSchema.Type;
