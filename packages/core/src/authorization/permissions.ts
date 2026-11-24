import {
	type BotPermissions as BotPermissionsView,
	type ProjectPermissions as ProjectPermissionsView,
	type ResourcePermissions as ResourcePermissionsView,
	WORKSPACE_ROLES,
	type WorkspacePermissions as WorkspacePermissionsView,
	type WorkspaceRole,
} from "@sugabots/contracts";

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
 *   role and the bot's visibility, creator and member, if it is a Personal
 *   Assistant.
 *
 * Every permission here is asked for somewhere.
 *
 * Grants are additive and default to nothing: an unknown role, or a permission
 * no grant table mentions, allows nothing. There is no wildcard, so a
 * permission added below reaches a role only when that role's table names it.
 *
 * This module is pure. Loading the facts it takes is `access.ts`, and asking it
 * is `Authorization` and `Visibility`. Its grant tables are the specification.
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
	/** Choose the models the system bots run on. */
	| "workspace.systemModel.choose"
	/** See what the workspace's models cost, every bot's included, and limit it. */
	| "workspace.usage.manage"
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
	| "project.leave"
	/** Decide a tool call a bot raised in the project. */
	| "approval.decide";

/**
 * An action on what a project holds besides its chats: its connectors,
 * automations and computer. In a bot's default project each is the bot's
 * action of the same name, so a bot's are decided as its own.
 */
type ProjectResourcePermission =
	/** See the connectors and their settings. */
	| "connector.read"
	/** Add, change, sign in and remove connectors, the GitHub app among them. */
	| "connector.manage"
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
	/** Allow or refuse a bot's request to reach more from the computer. */
	| "computer.request.decide"
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
	/** See the bot's settings and the state of its computer. */
	| "bot.settings.read"
	| "bot.update"
	| "bot.delete"
	/** Decide a tool call the bot raised in one of its chats. */
	| "approval.decide"
	/**
	 * Decide a tool call raised in a run the bot does, whichever project its
	 * automation is in: the bot's own default project, or a project members
	 * made that it leads. Taken with `approval.decide` in the chat's
	 * project, never instead of it (see `mayDecideToolCall`).
	 */
	| "approval.automation.decide";

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
	visibility: "public" | "personal";
	createdById: string | null;
	/** The member whose Personal Assistant it is; null for any other bot. */
	assistantOf: string | null;
}

const ADMINISTRATOR_WORKSPACE_GRANTS: readonly WorkspacePermission[] = [
	"workspace.read",
	"workspace.update",
	"workspace.providers.manage",
	"workspace.members.manage",
	"workspace.systemModel.choose",
	"workspace.usage.manage",
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
	"project.update",
	"project.delete",
	"project.chats.manage",
	"project.members.manage",
	"project.bots.manage",
	"approval.decide",
	"connector.read",
	"connector.manage",
	"automation.read",
	"automation.manage",
	"automation.run",
	"automation.history.read",
	"computer.read",
	"computer.manage",
	"computer.request.decide",
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
		"project.leave",
		"project.members.manage",
		"project.bots.manage",
		"approval.decide",
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
 * takes part, and who decides the bot's tool calls decides there; the bot's
 * managers tidy them. Its connectors, automations and computer are the
 * bot's, decided as the bot's own (see `RESOURCES_OF_DEFAULT_PROJECTS`).
 * Nothing else: nobody joins or leaves a default project, adds members or bots
 * to it, or changes or deletes it, which is made and deleted with its bot.
 */
const DEFAULT_PROJECT_GRANTS: Partial<Record<ProjectPermission, BotPermission>> = {
	"project.read": "bot.read",
	"approval.decide": "approval.decide",
	"project.chats.manage": "bot.update",
	"connector.read": "connector.read",
	"connector.manage": "connector.manage",
	"automation.read": "automation.read",
	"automation.manage": "automation.manage",
	"automation.run": "automation.run",
	"automation.history.read": "automation.history.read",
	"computer.read": "bot.settings.read",
	"computer.manage": "computer.manage",
	"computer.request.decide": "computer.request.decide",
	"computer.desktop.use": "computer.desktop.use",
};

/**
 * The actions in a default project that its bot's managers take whether or
 * not they reach the bot, as they manage what a personal bot holds without
 * seeing its chats. The rest take reach as well.
 */
const RESOURCES_OF_DEFAULT_PROJECTS: ReadonlySet<ProjectPermission> = new Set<ProjectPermission>([
	"connector.read",
	"connector.manage",
	"automation.read",
	"automation.manage",
	"computer.read",
	"computer.manage",
	"computer.request.decide",
]);

/** What anyone who reaches a bot may do with it. */
const BOT_TALKER_GRANTS = new Set<BotPermission>([
	"bot.read",
	"bot.settings.read",
	"connector.read",
	"automation.read",
	"automation.history.read",
	"automation.run",
	"approval.decide",
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
 * What a bot's creator, or an administrator, may do with it besides use it:
 * change it, and read the configuration they change, whether or not they
 * reach it; and decide what its runs ask, in a run's chat they reach.
 */
const BOT_MANAGER_GRANTS = new Set<BotPermission>([
	"bot.settings.read",
	"connector.read",
	"automation.read",
	"bot.update",
	"bot.delete",
	"connector.manage",
	"automation.manage",
	"approval.automation.decide",
	"computer.manage",
	"computer.request.decide",
]);

/**
 * What a member may do with their own Personal Assistant besides use it,
 * whatever their role: change its name, avatar and connectors, manage and run its
 * automations and decide what their runs ask, decide what it asks to reach from
 * its computer, and decide what it asks to do for them. An action they allow
 * still runs with their own permissions, so a viewer's assistant can't make a
 * project for them. Sugabots manages the rest of it.
 */
const ASSISTANT_OWNER_GRANTS = new Set<BotPermission>([
	"bot.update",
	"connector.manage",
	"automation.manage",
	"automation.run",
	"approval.automation.decide",
	"computer.request.decide",
	"approval.decide",
]);

function isAdministrator(role: WorkspaceRole | undefined): boolean {
	return role === "owner" || role === "admin";
}

/**
 * Whether the caller manages every bot in the workspace, those somebody else
 * made and keeps personal included, though not another member's Personal
 * Assistant: what lists every such bot for them to manage.
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
 * Whether the caller reaches the bot: its member for a Personal Assistant,
 * its creator for a personal bot, and anyone in the workspace for a public one.
 */
export function reachesBot(actor: Actor, bot: BotFacts): boolean {
	if (!actor.workspaceRole) return false;
	if (bot.assistantOf !== null) return bot.assistantOf === actor.memberId;
	if (bot.visibility === "personal") return bot.createdById === actor.memberId;
	return true;
}

/**
 * Whether the caller may take a bot-addressed action. Using a bot takes
 * reach; changing it takes being its creator or an administrator, who may
 * change a personal bot they don't reach. Nobody but its member changes a
 * Personal Assistant or its automations, and nobody deletes one.
 */
export function mayOnBot(actor: Actor, permission: BotPermission, bot: BotFacts): boolean {
	const role = actor.workspaceRole;
	if (!role) return false;
	if (bot.assistantOf !== null) {
		if (bot.assistantOf !== actor.memberId) return false;
		return botTalkerGrants(role).has(permission) || ASSISTANT_OWNER_GRANTS.has(permission);
	}
	const manages =
		role !== "viewer" && (managesEveryBot(actor) || bot.createdById === actor.memberId);
	if (manages && BOT_MANAGER_GRANTS.has(permission)) return true;
	return reachesBot(actor, bot) && botTalkerGrants(role).has(permission);
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

/**
 * The project permissions a client needs resolved, as the API returns them.
 * `isPublic` says whether somebody not in it may join it.
 */
export function projectPermissions(
	actor: Actor,
	project: ProjectFacts & { isPublic: boolean },
): ProjectPermissionsView {
	const may = (permission: ProjectPermission) => mayInProject(actor, permission, project);
	return {
		rename: may("project.update"),
		manageMembers: may("project.members.manage"),
		manageBots: may("project.bots.manage"),
		leave: may("project.leave"),
		join:
			project.defaultOf === null &&
			!project.isMember &&
			project.isPublic &&
			mayInWorkspace(actor, "workspace.read"),
		delete: may("project.delete"),
		resources: resourcePermissions(actor, project),
	};
}

/**
 * What the caller may do with what the project holds, as the API returns it
 * on a project and, from its default project, on a bot, so the two agree.
 */
export function resourcePermissions(actor: Actor, project: ProjectFacts): ResourcePermissionsView {
	const may = (permission: ProjectPermission) => mayInProject(actor, permission, project);
	return {
		readHistory: may("project.read"),
		// A bot's settings are for whoever may change it; a project's for anyone in it.
		openSettings: project.defaultOf
			? mayOnBot(actor, "bot.update", project.defaultOf)
			: may("project.read"),
		deleteFiles: may("project.chats.manage"),
		manageConnectors: may("connector.manage"),
		manageComputer: may("computer.manage"),
		useDesktop: may("computer.desktop.use"),
		manageAutomations: may("automation.manage"),
		runAutomations: may("automation.run"),
	};
}

/** The bot permissions a client needs resolved, as the API returns them. */
export function botPermissions(actor: Actor, bot: BotFacts): BotPermissionsView {
	const may = (permission: BotPermission) => mayOnBot(actor, permission, bot);
	return {
		update: may("bot.update"),
		delete: may("bot.delete"),
		talk: reachesBot(actor, bot),
		// Its default project is nobody's to be in; it follows the bot.
		resources: resourcePermissions(actor, { isMember: false, defaultOf: bot }),
	};
}

/** The workspace permissions a client needs resolved, as the API returns them. */
export function workspacePermissions(actor: Actor): WorkspacePermissionsView {
	return {
		createProjects: mayInWorkspace(actor, "project.create"),
		createBots: mayInWorkspace(actor, "bot.create"),
		updateWorkspace: mayInWorkspace(actor, "workspace.update"),
		manageProviders: mayInWorkspace(actor, "workspace.providers.manage"),
		manageMembers: mayInWorkspace(actor, "workspace.members.manage"),
		chooseSystemModel: mayInWorkspace(actor, "workspace.systemModel.choose"),
		manageUsage: mayInWorkspace(actor, "workspace.usage.manage"),
		manageAdmins: mayInWorkspace(actor, "workspace.admins.manage"),
		handOverOwnership: mayInWorkspace(actor, "workspace.ownership.handOver"),
		deleteWorkspace: mayInWorkspace(actor, "workspace.delete"),
	};
}
