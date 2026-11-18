import {
	type BotPermissions as BotPermissionsView,
	type ChannelPermissions as ChannelPermissionsView,
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
 * Three kinds of action, kept apart by their types so one cannot be asked
 * without the facts it needs:
 *
 * - **Workspace actions** concern the workspace itself, and are answered from
 *   the caller's role alone.
 * - **Channel actions** concern a channel and its conversations, answered from
 *   the caller's role and whether they are in it.
 * - **Bot actions** concern a bot and what it owns: its tasks, connections,
 *   automations and computer. They are answered from the caller's role and
 *   the bot's visibility, creator and person, if it is a Personal Assistant.
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
	/** Belong to the workspace: see its people, its public bots and channels, and its enabled models. */
	| "workspace.read"
	/** Rename the workspace, change its address, and move it to another time zone. */
	| "workspace.update"
	/** Configure the model and search providers the workspace runs on. */
	| "workspace.providers.manage"
	/** Invite, remove and set the access of the people in the workspace. */
	| "workspace.members.manage"
	/**
	 * Make somebody an administrator or stop them being one, and remove an
	 * administrator. Taken with `workspace.members.manage`, never instead of it.
	 */
	| "workspace.admins.manage"
	/** Hand the workspace to another member, who becomes its owner. */
	| "workspace.ownership.transfer"
	/** Delete the workspace and everything in it. */
	| "workspace.delete"
	/** Choose the models the system bots run on. */
	| "workspace.builtInBots.configure"
	/** See what the workspace's models cost, every bot's included, and limit it. */
	| "workspace.usage.manage"
	/** Make a channel. */
	| "channel.create"
	/** Make a bot. */
	| "bot.create";

/**
 * An action addressed at a channel. `channel.read` is reach: holding it is being
 * in the channel, seeing its conversations and taking part in them.
 */
export type ChannelPermission =
	| "channel.read"
	| "channel.update"
	| "channel.delete"
	/** Invite and remove people. */
	| "channel.members.manage"
	/** Add and remove bots. */
	| "channel.bots.manage"
	/** Take yourself out. Administrators stay in every channel. */
	| "channel.leave"
	/** Decide a tool call a bot raised in the channel. */
	| "approval.decide";

/**
 * An action addressed at a bot, or at something it owns: its tasks,
 * connections, automations and computer. `bot.read` is reach: seeing the
 * bot's tasks, files and automations' runs, and taking part in them. Its
 * configuration is read by whoever reaches it or manages it, so an
 * administrator can manage a private bot without seeing what it was asked.
 */
export type BotPermission =
	| "bot.read"
	/** See the bot's settings and the state of its computer. */
	| "bot.settings.read"
	| "bot.update"
	| "bot.delete"
	| "connection.read"
	| "connection.manage"
	/** See the bot's automations as defined, without what their runs said. */
	| "automation.read"
	| "automation.manage"
	| "automation.run"
	/** See what the bot's automations' runs did and said. */
	| "automation.history.read"
	/** Decide a tool call the bot raised in one of its tasks. */
	| "approval.decide"
	/** Decide a tool call the bot raised while an automation ran. */
	| "approval.automation.decide"
	/** Decide what the bot's computer may reach, and allow its requests for more. */
	| "computer.manage"
	/** Allow or refuse the bot's own request to reach more from its computer. */
	| "computer.request.decide"
	/** Click and type on the bot's desktop, rather than only watch it. */
	| "computer.desktop.use";

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

/** What a decision about a channel needs to know about it. */
export interface ChannelFacts {
	/** Whether a `channel_member` row puts the caller in this channel. */
	isMember: boolean;
}

/** What a decision about a bot needs to know about it. */
export interface BotFacts {
	visibility: "public" | "private";
	createdById: string | null;
	/** The person whose Personal Assistant it is; null for any other bot. */
	assistantOf: string | null;
}

const ADMINISTRATOR_WORKSPACE_GRANTS: readonly WorkspacePermission[] = [
	"workspace.read",
	"workspace.update",
	"workspace.providers.manage",
	"workspace.members.manage",
	"workspace.builtInBots.configure",
	"workspace.usage.manage",
	"channel.create",
	"bot.create",
];

const WORKSPACE_GRANTS: Record<WorkspaceRole, ReadonlySet<WorkspacePermission>> = {
	owner: new Set<WorkspacePermission>([
		...ADMINISTRATOR_WORKSPACE_GRANTS,
		"workspace.admins.manage",
		"workspace.ownership.transfer",
		"workspace.delete",
	]),
	admin: new Set<WorkspacePermission>(ADMINISTRATOR_WORKSPACE_GRANTS),
	member: new Set<WorkspacePermission>(["workspace.read", "channel.create", "bot.create"]),
	viewer: new Set<WorkspacePermission>(["workspace.read"]),
};

/**
 * The channel permissions each role holds in the channels it is a member of.
 *
 * Nobody reaches a channel without a `channel_member` row. Administrators are no
 * exception: database triggers make them members of every channel, as
 * `channelMember` in `packages/core/src/workspaces/sql.ts` describes.
 */
const ADMINISTRATOR_CHANNEL_GRANTS = new Set<ChannelPermission>([
	"channel.read",
	"channel.update",
	"channel.delete",
	"channel.members.manage",
	"channel.bots.manage",
	"approval.decide",
]);

const CHANNEL_GRANTS: Record<WorkspaceRole, ReadonlySet<ChannelPermission>> = {
	owner: ADMINISTRATOR_CHANNEL_GRANTS,
	admin: ADMINISTRATOR_CHANNEL_GRANTS,
	member: new Set<ChannelPermission>([
		"channel.read",
		"channel.leave",
		"channel.members.manage",
		"channel.bots.manage",
		"approval.decide",
	]),
	// A viewer reads and takes part, which `channel.read` grants, and changes nothing.
	viewer: new Set<ChannelPermission>(["channel.read", "channel.leave"]),
};

/** What anyone who reaches a bot may do with it. */
const BOT_USER_GRANTS = new Set<BotPermission>([
	"bot.read",
	"bot.settings.read",
	"connection.read",
	"automation.read",
	"automation.history.read",
	"automation.run",
	"approval.decide",
	"computer.desktop.use",
]);

/** What a viewer who reaches a bot may do with it: read, and take part in its tasks. */
const BOT_VIEWER_GRANTS = new Set<BotPermission>([
	"bot.read",
	"bot.settings.read",
	"connection.read",
	"automation.read",
	"automation.history.read",
]);

const botUserGrants = (role: WorkspaceRole) =>
	role === "viewer" ? BOT_VIEWER_GRANTS : BOT_USER_GRANTS;

/**
 * What a bot's creator, or an administrator, may do with it besides use it:
 * change it, and read the configuration they change, whether or not they
 * reach it.
 */
const BOT_MANAGER_GRANTS = new Set<BotPermission>([
	"bot.settings.read",
	"connection.read",
	"automation.read",
	"bot.update",
	"bot.delete",
	"connection.manage",
	"automation.manage",
	"approval.automation.decide",
	"computer.manage",
	"computer.request.decide",
]);

/**
 * What a person may do with their own Personal Assistant besides use it,
 * whatever their role: change its look and its connections, decide what it
 * asks to reach from its computer, and decide what it asks to do for them. An
 * action they allow still runs with their own permissions, so a viewer's
 * assistant can't make a channel for them. Sugabots manages the rest of it.
 */
const ASSISTANT_OWNER_GRANTS = new Set<BotPermission>([
	"bot.update",
	"connection.manage",
	"computer.request.decide",
	"approval.decide",
]);

function isAdministrator(role: WorkspaceRole | undefined): boolean {
	return role === "owner" || role === "admin";
}

/**
 * Whether the caller manages every bot in the workspace, those somebody else
 * made and keeps private included, though not another person's Personal
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
 * Whether the caller may take a channel-addressed action on this channel.
 *
 * `channel` must be a channel in the workspace `actor.workspaceRole` describes;
 * `access.ts` loads both together so they never mix.
 */
export function mayInChannel(
	actor: Actor,
	permission: ChannelPermission,
	channel: ChannelFacts,
): boolean {
	if (!actor.workspaceRole) return false;
	return channel.isMember && CHANNEL_GRANTS[actor.workspaceRole].has(permission);
}

/**
 * Whether the caller reaches the bot: its person for a Personal Assistant,
 * its creator for a private bot, and anyone in the workspace for a public one.
 */
export function reachesBot(actor: Actor, bot: BotFacts): boolean {
	if (!actor.workspaceRole) return false;
	if (bot.assistantOf !== null) return bot.assistantOf === actor.userId;
	if (bot.visibility === "private") return bot.createdById === actor.userId;
	return true;
}

/**
 * Whether the caller may take a bot-addressed action. Using a bot takes
 * reach; changing it takes being its creator or an administrator, who may
 * change a private bot they don't reach. Nobody but its person changes a
 * Personal Assistant, and nobody deletes one.
 */
export function mayOnBot(actor: Actor, permission: BotPermission, bot: BotFacts): boolean {
	const role = actor.workspaceRole;
	if (!role) return false;
	if (bot.assistantOf !== null) {
		if (bot.assistantOf !== actor.userId) return false;
		return botUserGrants(role).has(permission) || ASSISTANT_OWNER_GRANTS.has(permission);
	}
	const manages = role !== "viewer" && (managesEveryBot(actor) || bot.createdById === actor.userId);
	if (manages && BOT_MANAGER_GRANTS.has(permission)) return true;
	return reachesBot(actor, bot) && botUserGrants(role).has(permission);
}

/** The roles holding a workspace permission. */
export function rolesGrantedInWorkspace(permission: WorkspacePermission): WorkspaceRole[] {
	return WORKSPACE_ROLES.filter((role) => WORKSPACE_GRANTS[role].has(permission));
}

/**
 * The roles holding a channel permission in the channels they are members of,
 * for the queries that filter by the stored role rather than asking about one
 * caller. The equivalent single-resource answer is `mayInChannel`.
 */
export function rolesGrantedInChannel(permission: ChannelPermission): WorkspaceRole[] {
	return WORKSPACE_ROLES.filter((role) => CHANNEL_GRANTS[role].has(permission));
}

/**
 * The channel permissions a client needs resolved, as the API returns them.
 * `isPublic` says whether somebody not in it may join it.
 */
export function channelPermissions(
	actor: Actor,
	channel: ChannelFacts & { isPublic: boolean },
): ChannelPermissionsView {
	const may = (permission: ChannelPermission) => mayInChannel(actor, permission, channel);
	return {
		rename: may("channel.update"),
		manageMembers: may("channel.members.manage"),
		manageBots: may("channel.bots.manage"),
		leave: may("channel.leave"),
		join: !channel.isMember && channel.isPublic && mayInWorkspace(actor, "workspace.read"),
		delete: may("channel.delete"),
		deleteFiles: may("channel.update"),
	};
}

/** The bot permissions a client needs resolved, as the API returns them. */
export function botPermissions(actor: Actor, bot: BotFacts): BotPermissionsView {
	const may = (permission: BotPermission) => mayOnBot(actor, permission, bot);
	return {
		update: may("bot.update"),
		delete: may("bot.delete"),
		manageConnections: may("connection.manage"),
		manageComputer: may("computer.manage"),
		useDesktop: may("computer.desktop.use"),
		manageAutomations: may("automation.manage"),
		runAutomations: may("automation.run"),
		decideApprovals: may("approval.decide"),
		talk: reachesBot(actor, bot) && actor.workspaceRole !== undefined,
	};
}

/** The workspace permissions a client needs resolved, as the API returns them. */
export function workspacePermissions(actor: Actor): WorkspacePermissionsView {
	return {
		createChannels: mayInWorkspace(actor, "channel.create"),
		createBots: mayInWorkspace(actor, "bot.create"),
		updateWorkspace: mayInWorkspace(actor, "workspace.update"),
		manageProviders: mayInWorkspace(actor, "workspace.providers.manage"),
		manageMembers: mayInWorkspace(actor, "workspace.members.manage"),
		configureBuiltInBots: mayInWorkspace(actor, "workspace.builtInBots.configure"),
		manageUsage: mayInWorkspace(actor, "workspace.usage.manage"),
		manageAdmins: mayInWorkspace(actor, "workspace.admins.manage"),
		transferOwnership: mayInWorkspace(actor, "workspace.ownership.transfer"),
		deleteWorkspace: mayInWorkspace(actor, "workspace.delete"),
	};
}
