import { type BotVisibility, WORKSPACE_ROLES, type WorkspaceRole } from "@sugabots/contracts";

/**
 * What a member may do, as named actions rather than role comparisons.
 *
 * Application code asks "may this member do this here?", never "is this member
 * an admin?". Role names appear in the grant tables below, in role assignment
 * and in what is displayed — nowhere else. Adding a role later means adding a
 * grant table; it does not mean revisiting every handler.
 *
 * Three kinds of action, kept apart by their types so one cannot be asked
 * without the facts it needs:
 *
 * - **Workspace actions** concern the workspace itself, and are answered from
 *   the caller's role alone.
 * - **Project actions** concern a project and what is in it: its chats,
 *   connectors, automations and computer. They are answered from the
 *   caller's role and whether they are in it. A bot's default project is the
 *   exception: it follows its bot (see `mayInProject`).
 * - **Bot actions** concern a bot, and what its default project holds, as
 *   that project's actions are decided. They are answered from the caller's
 *   role, the bot's visibility, creator and members, and whether it is their
 *   own Personal Assistant, which they manage and run whatever their role.
 *
 * Every permission here is asked for somewhere.
 *
 * Grants are additive and default to nothing: an unknown role, or a permission
 * no grant table mentions, allows nothing. There is no wildcard, so a
 * permission added below reaches a role only when that role's table names it.
 *
 * This module is pure. Loading the facts it takes is `access.ts`, and asking it
 * is `Authorization` and `Visibility`, and the provers' rules in
 * `proofs/facts.ts`. Who decides an approval is not here: it is the approver
 * rule in `proofs/approvers.ts`. What the API tells a member they may do is
 * decided by the provers' rules (`proofs/shown-permissions.ts`).
 */

/** An action addressed at a workspace. */
export type WorkspacePermission =
	/** Belong to the workspace: see its members, its public bots and projects, and its enabled models. */
	| "workspace.read"
	/** Rename the workspace, change its address, and move it to another time zone. */
	| "workspace.update"
	/** Configure the model and search providers the workspace runs on. */
	| "workspace.providers.manage"
	/** Invite, remove and set the access of the members in the workspace. */
	| "workspace.members.manage"
	/**
	 * Make somebody an administrator or stop them being one, and remove an
	 * administrator. Taken with `workspace.members.manage`, never instead of it.
	 */
	| "workspace.admins.manage"
	/** Hand the workspace to another member in it, who becomes its owner. */
	| "workspace.ownership.handOver"
	/** Delete the workspace and everything in it. */
	| "workspace.delete"
	/** Make a project. */
	| "project.create"
	/** Make a bot. */
	| "bot.create";

/**
 * An action addressed at a project, or at something in it: its chats,
 * connectors, automations and computer. `project.read` is reach: holding it
 * is being in the project, seeing its chats and automations' runs,
 * and taking part in them. Its connectors, automations and computer are
 * managed by whoever may change the project.
 */
export type ProjectPermission =
	| ProjectResourcePermission
	| "project.read"
	/**
	 * Change what is in it without managing it: mark its chats resolved, and
	 * have its bots make write/delete tool calls and work on its computer for
	 * you. A viewer reads and takes part, and changes nothing.
	 */
	| "project.change"
	/** Change its name, address, colour, description, visibility and lead bot. */
	| "project.update"
	| "project.delete"
	/** Rename its chats, and delete the files made in them. */
	| "project.chats.manage"
	/** Invite and remove members. */
	| "project.members.manage"
	/** Add and remove bots. */
	| "project.bots.manage"
	/** Take yourself out. Administrators stay in every project members made. */
	| "project.leave";

/**
 * An action on what a project holds besides its chats: its connectors,
 * automations and computer. In a bot's default project each is the bot's
 * action of the same name, so a bot's are decided as its own.
 */
type ProjectResourcePermission =
	/** See the connectors and their settings. */
	| "connector.read"
	/** See the automations as defined, without what their runs said. */
	| "automation.read"
	| "automation.manage"
	| "automation.run"
	/** See what the automations' runs did and said. */
	| "automation.history.read"
	/** See how the computer stands. */
	| "computer.read"
	/** Decide what the computer may reach, reset and upgrade it. */
	| "computer.manage"
	/** Click and type on the computer's desktop, rather than only watch it. */
	| "computer.desktop.use";

/**
 * An action addressed at a bot, or at what its default project holds.
 * `bot.read` is reach: seeing the bot's chats, files and automations' runs,
 * and taking part in them. Its configuration is read by whoever reaches it or
 * manages it, so an administrator can manage a personal bot without seeing
 * what it was asked.
 */
export type BotPermission =
	| Exclude<ProjectResourcePermission, "computer.read">
	| "bot.read"
	/** Change what is in its default project, as `project.change` does in a project members made. */
	| "bot.use"
	/** See the bot's settings and the state of its computer. */
	| "bot.settings.read"
	| "bot.update"
	/** Invite and remove a private bot's members. */
	| "bot.members.manage";

/**
 * The caller.
 *
 * `workspaceRole` is `undefined` for somebody outside the workspace holding the
 * resource, which grants nothing at all — the workspace boundary is checked
 * here rather than being left to each caller.
 */
export interface Actor {
	memberId: string;
	workspaceRole: WorkspaceRole | undefined;
}

/** What a decision about a project needs to know about it. */
export interface ProjectFacts {
	/** Whether a `project_member` row puts the caller in this project. */
	isMember: boolean;
	/** On a bot's default project: the bot, which decides who reaches it. Null on any other. */
	defaultOf: BotFacts | null;
}

/** What a decision about a bot needs to know about it. */
export interface BotFacts {
	visibility: BotVisibility;
	createdById: string | null;
	/** On a private bot: its members, who reach it. Empty on any other. */
	memberIds: readonly string[];
	/**
	 * On a Personal Assistant: the member it is for, who made it. Null for any
	 * other bot. Whose it is, as for any bot, is `createdById`'s to say.
	 */
	assistantOf: string | null;
}

const ADMINISTRATOR_WORKSPACE_GRANTS: readonly WorkspacePermission[] = [
	"workspace.read",
	"workspace.update",
	"workspace.providers.manage",
	"workspace.members.manage",
	"project.create",
	"bot.create",
];

const WORKSPACE_GRANTS: Record<WorkspaceRole, ReadonlySet<WorkspacePermission>> = {
	owner: new Set<WorkspacePermission>([
		...ADMINISTRATOR_WORKSPACE_GRANTS,
		"workspace.admins.manage",
		"workspace.ownership.handOver",
		"workspace.delete",
	]),
	admin: new Set<WorkspacePermission>(ADMINISTRATOR_WORKSPACE_GRANTS),
	editor: new Set<WorkspacePermission>(["workspace.read", "project.create", "bot.create"]),
	viewer: new Set<WorkspacePermission>(["workspace.read"]),
};

/**
 * The project permissions each role holds in the projects members made that it
 * is a member of.
 *
 * Nobody reaches a project members made without a `project_member` row.
 * Administrators are no exception: database triggers make them members of
 * every project members made, as `projectMember` in
 * `packages/core/src/workspaces/sql.ts` describes. A bot's default project
 * has no members; what may be done there is `DEFAULT_PROJECT_GRANTS`.
 */
const ADMINISTRATOR_PROJECT_GRANTS = new Set<ProjectPermission>([
	"project.read",
	"project.change",
	"project.update",
	"project.delete",
	"project.chats.manage",
	"project.members.manage",
	"project.bots.manage",
	"connector.read",
	"automation.read",
	"automation.manage",
	"automation.run",
	"automation.history.read",
	"computer.read",
	"computer.manage",
	"computer.desktop.use",
]);

/**
 * What every project member who reads its connectors, automations and
 * computer may do with them, as anyone who reaches a public bot may with its.
 */
const PROJECT_RESOURCE_READS: readonly ProjectPermission[] = [
	"connector.read",
	"automation.read",
	"automation.history.read",
	"computer.read",
];

const PROJECT_GRANTS: Record<WorkspaceRole, ReadonlySet<ProjectPermission>> = {
	// Administrators change the project, so they manage what it holds.
	owner: ADMINISTRATOR_PROJECT_GRANTS,
	admin: ADMINISTRATOR_PROJECT_GRANTS,
	editor: new Set<ProjectPermission>([
		"project.read",
		"project.change",
		"project.leave",
		"project.members.manage",
		"project.bots.manage",
		...PROJECT_RESOURCE_READS,
		"automation.run",
		"computer.desktop.use",
	]),
	// A viewer reads and takes part, which `project.read` grants, and changes nothing.
	viewer: new Set<ProjectPermission>(["project.read", "project.leave", ...PROJECT_RESOURCE_READS]),
};

/**
 * What may be done in a bot's default project, as what it takes on the bot.
 * Its chats are the bot's own, so whoever reaches the bot reads them and
 * takes part; the bot's managers tidy them. Its connectors, automations and computer are the
 * bot's, decided as the bot's own (see `RESOURCES_OF_DEFAULT_PROJECTS`).
 * Nothing else: nobody joins or leaves a default project, adds members or bots
 * to it, or changes or deletes it, which is made and deleted with its bot.
 */
const DEFAULT_PROJECT_GRANTS: Partial<Record<ProjectPermission, BotPermission>> = {
	"project.read": "bot.read",
	"project.change": "bot.use",
	"project.chats.manage": "bot.update",
	"connector.read": "connector.read",
	"automation.read": "automation.read",
	"automation.manage": "automation.manage",
	"automation.run": "automation.run",
	"automation.history.read": "automation.history.read",
	"computer.read": "bot.settings.read",
	"computer.manage": "computer.manage",
	"computer.desktop.use": "computer.desktop.use",
};

/**
 * The actions in a default project that its bot's managers take whether or
 * not they reach the bot, as they manage what a personal bot holds without
 * seeing its chats. The rest take reach as well.
 */
const RESOURCES_OF_DEFAULT_PROJECTS: ReadonlySet<ProjectPermission> = new Set<ProjectPermission>([
	"connector.read",
	"automation.read",
	"automation.manage",
	"computer.read",
	"computer.manage",
]);

/** What anyone who reaches a bot may do with it. */
const BOT_TALKER_GRANTS = new Set<BotPermission>([
	"bot.read",
	"bot.use",
	"bot.settings.read",
	"bot.members.manage",
	"connector.read",
	"automation.read",
	"automation.history.read",
	"automation.run",
	"computer.desktop.use",
]);

/** What a viewer who reaches a bot may do with it: read, and take part in its chats. */
const BOT_VIEWER_GRANTS = new Set<BotPermission>([
	"bot.read",
	"bot.settings.read",
	"connector.read",
	"automation.read",
	"automation.history.read",
]);

const botTalkerGrants = (role: WorkspaceRole) =>
	role === "viewer" ? BOT_VIEWER_GRANTS : BOT_TALKER_GRANTS;

/**
 * What a bot's creator, while they reach it, or an administrator, whether or
 * not they reach it, may do with it besides use it: change it, and read the
 * configuration they change.
 */
const BOT_MANAGER_GRANTS = new Set<BotPermission>([
	"bot.settings.read",
	"connector.read",
	"automation.read",
	"bot.update",
	"automation.manage",
	"computer.manage",
]);

function isAdministrator(role: WorkspaceRole | undefined): boolean {
	return role === "owner" || role === "admin";
}

/**
 * Whether the caller manages every bot in the workspace, those somebody else
 * made and keeps personal included: what lists every such bot for them to
 * manage.
 */
export function managesEveryBot(actor: Actor): boolean {
	return isAdministrator(actor.workspaceRole);
}

/** Whether the caller may take a workspace-addressed action. */
export function mayInWorkspace(actor: Actor, permission: WorkspacePermission): boolean {
	if (!actor.workspaceRole) return false;
	return WORKSPACE_GRANTS[actor.workspaceRole].has(permission);
}

/**
 * Whether the caller may take a project-addressed action on this project:
 * granted by their role to the members of a project members made, and in a
 * bot's default project by what they may do with the bot, reaching it but for
 * what its managers manage, so an administrator manages a personal bot's
 * computer, connectors and automations but does not see its chats, as for
 * the bot itself (see `DEFAULT_PROJECT_GRANTS`).
 *
 * `project` must be a project in the workspace `actor.workspaceRole` describes;
 * `access.ts` loads both together so they never mix.
 */
export function mayInProject(
	actor: Actor,
	permission: ProjectPermission,
	project: ProjectFacts,
): boolean {
	if (!actor.workspaceRole) return false;
	if (project.defaultOf) {
		const onBot = DEFAULT_PROJECT_GRANTS[permission];
		return (
			onBot !== undefined &&
			(RESOURCES_OF_DEFAULT_PROJECTS.has(permission) || reachesBot(actor, project.defaultOf)) &&
			mayOnBot(actor, onBot, project.defaultOf)
		);
	}
	return project.isMember && PROJECT_GRANTS[actor.workspaceRole].has(permission);
}

/**
 * The member a personal bot, a Personal Assistant included, is for: its
 * creator, the only one who reaches it and whose permissions it acts with.
 * Null for a public bot, and for a personal bot whose creator's account is
 * gone, which nobody reaches.
 */
export function personalBotCreator(
	bot: Pick<BotFacts, "visibility" | "createdById">,
): string | null {
	return bot.visibility === "personal" ? bot.createdById : null;
}

/**
 * Whether the caller reaches the bot: anyone in the workspace for a public
 * bot, its members for a private one, and its creator for a personal one.
 * A private bot in a project is talked to there by the project's members,
 * which is the project's reach, not the bot's.
 */
export function reachesBot(actor: Actor, bot: BotFacts): boolean {
	if (!actor.workspaceRole) return false;
	switch (bot.visibility) {
		case "public":
			return true;
		case "private":
			return bot.memberIds.includes(actor.memberId);
		case "personal":
			return personalBotCreator(bot) === actor.memberId;
	}
}

/**
 * Whether the caller may take a bot-addressed action. Using a bot takes
 * reach; changing it takes being its creator, while they reach it, or an
 * administrator, who may change a bot they don't reach. A private bot's
 * creator who isn't one of its members, as after an upgrade made it private
 * without them, has no say over it.
 */
export function mayOnBot(actor: Actor, permission: BotPermission, bot: BotFacts): boolean {
	const role = roleOnBot(actor, bot);
	if (!role) return false;
	// Only a private bot has members to invite: everyone reaches a public
	// one, and a personal one is its creator's alone.
	if (permission === "bot.members.manage" && bot.visibility !== "private") return false;
	const manages =
		role !== "viewer" &&
		(managesEveryBot(actor) || (bot.createdById === actor.memberId && reachesBot(actor, bot)));
	if (manages && BOT_MANAGER_GRANTS.has(permission)) return true;
	return reachesBot(actor, bot) && botTalkerGrants(role).has(permission);
}

/**
 * The role whose grants decide what `actor` may do with the bot: their own,
 * but on their own Personal Assistant at least an editor's, as a member
 * manages and runs their assistants whatever their role. Anything the
 * assistant does for them elsewhere still has only their own role.
 */
function roleOnBot(actor: Actor, bot: BotFacts): WorkspaceRole | undefined {
	const ownAssistant = bot.assistantOf !== null && bot.createdById === actor.memberId;
	return ownAssistant && actor.workspaceRole === "viewer" ? "editor" : actor.workspaceRole;
}

/** The roles holding a workspace permission. */
export function rolesGrantedInWorkspace(permission: WorkspacePermission): WorkspaceRole[] {
	return WORKSPACE_ROLES.filter((role) => WORKSPACE_GRANTS[role].has(permission));
}

/**
 * The roles holding a project permission in the projects members made that
 * they are members of, for the queries that filter by the stored role rather
 * than asking about one caller. The equivalent single-resource answer is
 * `mayInProject`, which also decides for a bot's default project.
 */
export function rolesGrantedInProject(permission: ProjectPermission): WorkspaceRole[] {
	return WORKSPACE_ROLES.filter((role) => PROJECT_GRANTS[role].has(permission));
}
