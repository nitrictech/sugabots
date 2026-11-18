import type { WorkspaceRole } from "@sugabots/contracts";
import { describe, expect, it } from "vitest";
import {
	type Actor,
	type BotFacts,
	type BotPermission,
	botPermissions,
	type ChannelPermission,
	channelPermissions,
	mayInChannel,
	mayInWorkspace,
	mayOnBot,
	reachesBot,
	type WorkspacePermission,
} from "./permissions.ts";

/**
 * The grant tables, asserted role by role and permission by permission.
 *
 * Written as tables rather than as cases, because the thing under test is a
 * table: a grant that moves between roles should fail here loudly and in one
 * place, not somewhere in the HTTP tests.
 */

const ALICE = "0199a3a0-0000-7000-8000-00000000a11c";
const BOB = "0199a3a0-0000-7000-8000-00000000b0b0";

const actor = (workspaceRole: WorkspaceRole | undefined, userId = ALICE): Actor => ({
	userId,
	workspaceRole,
});

const publicBotBy = (createdById: string | null): BotFacts => ({
	visibility: "public",
	createdById,
	assistantOf: null,
});

const privateBotBy = (createdById: string): BotFacts => ({
	visibility: "private",
	createdById,
	assistantOf: null,
});

/** A Personal Assistant, which the workspace makes rather than its person. */
const assistantOf = (userId: string): BotFacts => ({
	visibility: "private",
	createdById: null,
	assistantOf: userId,
});

/**
 * Every permission of each kind there is.
 *
 * Spelled as a `Record` and then taken apart, so a permission added to the
 * type stops this file compiling rather than quietly dropping out of every
 * table below.
 */
const WORKSPACE_PERMISSIONS = Object.keys({
	"workspace.read": true,
	"workspace.update": true,
	"workspace.providers.manage": true,
	"workspace.members.manage": true,
	"workspace.admins.manage": true,
	"workspace.ownership.transfer": true,
	"workspace.delete": true,
	"workspace.builtInBots.configure": true,
	"workspace.usage.manage": true,
	"channel.create": true,
	"bot.create": true,
} satisfies Record<WorkspacePermission, true>) as WorkspacePermission[];

const CHANNEL_PERMISSIONS = Object.keys({
	"channel.read": true,
	"channel.update": true,
	"channel.delete": true,
	"channel.members.manage": true,
	"channel.bots.manage": true,
	"channel.leave": true,
	"approval.decide": true,
} satisfies Record<ChannelPermission, true>) as ChannelPermission[];

const BOT_PERMISSIONS = Object.keys({
	"bot.read": true,
	"bot.settings.read": true,
	"bot.update": true,
	"bot.delete": true,
	"connection.read": true,
	"connection.manage": true,
	"automation.read": true,
	"automation.manage": true,
	"automation.run": true,
	"automation.history.read": true,
	"approval.decide": true,
	"approval.automation.decide": true,
	"computer.manage": true,
	"computer.request.decide": true,
	"computer.desktop.use": true,
} satisfies Record<BotPermission, true>) as BotPermission[];

/** What only the owner may do: decide who administers, hand the workspace on, and delete it. */
const OWNER_ONLY: WorkspacePermission[] = [
	"workspace.admins.manage",
	"workspace.ownership.transfer",
	"workspace.delete",
];

/** What a member may do in the workspace: belong to it, and make channels and bots. */
const MEMBER_IN_WORKSPACE: WorkspacePermission[] = [
	"workspace.read",
	"channel.create",
	"bot.create",
];

/** What a member holds in a channel they are in: everything but changing or deleting it. */
const MEMBER_IN_CHANNEL: ChannelPermission[] = [
	"channel.read",
	"channel.leave",
	"channel.members.manage",
	"channel.bots.manage",
	"approval.decide",
];

/** What a viewer holds in a channel they are in: reading, taking part, and leaving. */
const VIEWER_IN_CHANNEL: ChannelPermission[] = ["channel.read", "channel.leave"];

/** What anybody who reaches a bot may do with it without managing it. */
const USING_A_BOT: BotPermission[] = [
	"bot.read",
	"bot.settings.read",
	"connection.read",
	"automation.read",
	"automation.history.read",
	"automation.run",
	"approval.decide",
	"computer.desktop.use",
];

/** What a viewer who reaches a bot may do with it: read, and take part in its tasks. */
const VIEWING_A_BOT: BotPermission[] = [
	"bot.read",
	"bot.settings.read",
	"connection.read",
	"automation.read",
	"automation.history.read",
];

/**
 * What a bot's creator, or an administrator, may do with it besides use it,
 * with reading the configuration they change, but not its tasks, files or
 * automations' runs.
 */
const MANAGING_A_BOT: BotPermission[] = [
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
];

/** What a person may do with their Personal Assistant besides use it: change its look and connections, and decide its computer's requests. */
const OWNING_AN_ASSISTANT: BotPermission[] = [
	"bot.update",
	"connection.manage",
	"computer.request.decide",
	"approval.decide",
];

describe("workspace actions", () => {
	it.each(WORKSPACE_PERMISSIONS)("the owner may %s", (permission) => {
		expect(mayInWorkspace(actor("owner"), permission)).toBe(true);
	});

	it.each(WORKSPACE_PERMISSIONS)("an admin may %s unless only the owner may", (permission) => {
		expect(mayInWorkspace(actor("admin"), permission)).toBe(!OWNER_ONLY.includes(permission));
	});

	it.each(WORKSPACE_PERMISSIONS)("a member may %s only when granted", (permission) => {
		expect(mayInWorkspace(actor("member"), permission)).toBe(
			MEMBER_IN_WORKSPACE.includes(permission),
		);
	});

	it.each(WORKSPACE_PERMISSIONS)("a viewer may %s only if it is belonging", (permission) => {
		expect(mayInWorkspace(actor("viewer"), permission)).toBe(permission === "workspace.read");
	});

	it.each(WORKSPACE_PERMISSIONS)("somebody outside the workspace may not %s", (permission) => {
		expect(mayInWorkspace(actor(undefined), permission)).toBe(false);
	});
});

describe("channel actions", () => {
	describe.each(["owner", "admin"] as const)("as %s", (role) => {
		it.each(CHANNEL_PERMISSIONS)("in the channel may %s unless it is leaving", (permission) => {
			expect(mayInChannel(actor(role), permission, { isMember: true })).toBe(
				permission !== "channel.leave",
			);
		});

		it.each(CHANNEL_PERMISSIONS)("outside the channel may not %s", (permission) => {
			expect(mayInChannel(actor(role), permission, { isMember: false })).toBe(false);
		});
	});

	it.each(CHANNEL_PERMISSIONS)("a member in the channel may %s only when granted", (permission) => {
		expect(mayInChannel(actor("member"), permission, { isMember: true })).toBe(
			MEMBER_IN_CHANNEL.includes(permission),
		);
	});

	it.each(CHANNEL_PERMISSIONS)("a viewer in the channel may %s only when granted", (permission) => {
		expect(mayInChannel(actor("viewer"), permission, { isMember: true })).toBe(
			VIEWER_IN_CHANNEL.includes(permission),
		);
	});

	it.each(["member", "viewer"] as const)(
		"a %s outside the channel may do nothing in it",
		(role) => {
			for (const permission of CHANNEL_PERMISSIONS) {
				expect(mayInChannel(actor(role), permission, { isMember: false })).toBe(false);
			}
		},
	);

	it.each(CHANNEL_PERMISSIONS)("somebody outside the workspace may not %s", (permission) => {
		expect(mayInChannel(actor(undefined), permission, { isMember: true })).toBe(false);
	});
});

describe("reaching a bot", () => {
	it.each(["owner", "admin", "member", "viewer"] as const)(
		"lets a %s reach a public bot somebody else made",
		(role) => {
			expect(reachesBot(actor(role), publicBotBy(BOB))).toBe(true);
		},
	);

	it("lets only its creator reach a private bot, not an admin", () => {
		expect(reachesBot(actor("member", BOB), privateBotBy(BOB))).toBe(true);
		expect(reachesBot(actor("member"), privateBotBy(BOB))).toBe(false);
		expect(reachesBot(actor("admin"), privateBotBy(BOB))).toBe(false);
		expect(reachesBot(actor("owner"), privateBotBy(BOB))).toBe(false);
	});

	it("lets only its person reach a Personal Assistant", () => {
		expect(reachesBot(actor("viewer"), assistantOf(ALICE))).toBe(true);
		expect(reachesBot(actor("owner", BOB), assistantOf(ALICE))).toBe(false);
	});

	it("lets nobody outside the workspace reach any bot, even one they made", () => {
		expect(reachesBot(actor(undefined), publicBotBy(ALICE))).toBe(false);
		expect(reachesBot(actor(undefined), privateBotBy(ALICE))).toBe(false);
		expect(reachesBot(actor(undefined), assistantOf(ALICE))).toBe(false);
	});
});

describe("bot actions", () => {
	it.each(BOT_PERMISSIONS)(
		"a member may %s on a public bot somebody else made only to use it",
		(permission) => {
			expect(mayOnBot(actor("member"), permission, publicBotBy(BOB))).toBe(
				USING_A_BOT.includes(permission),
			);
		},
	);

	it.each(BOT_PERMISSIONS)("a member may %s on a bot they made", (permission) => {
		expect(mayOnBot(actor("member"), permission, publicBotBy(ALICE))).toBe(true);
		expect(mayOnBot(actor("member"), permission, privateBotBy(ALICE))).toBe(true);
	});

	it.each(BOT_PERMISSIONS)("an admin may %s on a public bot somebody else made", (permission) => {
		expect(mayOnBot(actor("admin"), permission, publicBotBy(BOB))).toBe(true);
	});

	it.each(BOT_PERMISSIONS)(
		"an admin may %s on another person's private bot only to manage it",
		(permission) => {
			expect(mayOnBot(actor("admin"), permission, privateBotBy(BOB))).toBe(
				MANAGING_A_BOT.includes(permission),
			);
		},
	);

	it.each(BOT_PERMISSIONS)("a member may not %s on another person's private bot", (permission) => {
		expect(mayOnBot(actor("member"), permission, privateBotBy(BOB))).toBe(false);
	});

	it.each(BOT_PERMISSIONS)("a viewer may %s on a public bot only to view it", (permission) => {
		expect(mayOnBot(actor("viewer"), permission, publicBotBy(BOB))).toBe(
			VIEWING_A_BOT.includes(permission),
		);
	});

	it("does not let a viewer manage a bot they made before they became one", () => {
		for (const permission of MANAGING_A_BOT.filter((one) => !VIEWING_A_BOT.includes(one))) {
			expect(mayOnBot(actor("viewer"), permission, publicBotBy(ALICE))).toBe(false);
		}
	});

	it.each(BOT_PERMISSIONS)(
		"its person may %s on their Personal Assistant only to use it, change its look and connections, or decide what it asks",
		(permission) => {
			expect(mayOnBot(actor("member"), permission, assistantOf(ALICE))).toBe(
				USING_A_BOT.includes(permission) || OWNING_AN_ASSISTANT.includes(permission),
			);
		},
	);

	it("lets a viewer decide what their own Personal Assistant asks to do for them", () => {
		expect(mayOnBot(actor("viewer"), "approval.decide", assistantOf(ALICE))).toBe(true);
		expect(mayInWorkspace(actor("viewer"), "channel.create")).toBe(false);
	});

	it.each(BOT_PERMISSIONS)(
		"nobody else may %s on a Personal Assistant, the workspace's owner included",
		(permission) => {
			expect(mayOnBot(actor("owner", BOB), permission, assistantOf(ALICE))).toBe(false);
		},
	);

	it.each(BOT_PERMISSIONS)("somebody outside the workspace may not %s", (permission) => {
		expect(mayOnBot(actor(undefined), permission, publicBotBy(ALICE))).toBe(false);
	});
});

describe("what the API tells a client", () => {
	it("lets an admin change, staff and delete a channel, and not leave it", () => {
		expect(channelPermissions(actor("admin"), { isMember: true, isPublic: false })).toEqual({
			rename: true,
			manageMembers: true,
			manageBots: true,
			leave: false,
			join: false,
			delete: true,
			deleteFiles: true,
		});
	});

	it("lets a member staff and leave a channel they are in, and not change or delete it", () => {
		expect(channelPermissions(actor("member"), { isMember: true, isPublic: true })).toEqual({
			rename: false,
			manageMembers: true,
			manageBots: true,
			leave: true,
			join: false,
			delete: false,
			deleteFiles: false,
		});
	});

	it("lets anyone in the workspace join a public channel they are not in, and nothing else", () => {
		for (const role of ["member", "viewer"] as const) {
			expect(channelPermissions(actor(role), { isMember: false, isPublic: true })).toEqual({
				rename: false,
				manageMembers: false,
				manageBots: false,
				leave: false,
				join: true,
				delete: false,
				deleteFiles: false,
			});
		}
	});

	it("does not offer to join a private channel, or a public one from outside the workspace", () => {
		expect(channelPermissions(actor("member"), { isMember: false, isPublic: false }).join).toBe(
			false,
		);
		expect(channelPermissions(actor(undefined), { isMember: false, isPublic: true }).join).toBe(
			false,
		);
	});

	it("lets a member talk to a public bot without managing it", () => {
		expect(botPermissions(actor("member"), publicBotBy(BOB))).toEqual({
			update: false,
			delete: false,
			manageConnections: false,
			manageComputer: false,
			useDesktop: true,
			manageAutomations: false,
			runAutomations: true,
			decideApprovals: true,
			talk: true,
		});
	});

	it("lets an admin manage another person's private bot without talking to it", () => {
		expect(botPermissions(actor("admin"), privateBotBy(BOB))).toEqual({
			update: true,
			delete: true,
			manageConnections: true,
			manageComputer: true,
			useDesktop: false,
			manageAutomations: true,
			runAutomations: false,
			decideApprovals: false,
			talk: false,
		});
	});

	it("lets a person change their Personal Assistant but not delete it", () => {
		const resolved = botPermissions(actor("member"), assistantOf(ALICE));
		expect(resolved).toMatchObject({ update: true, manageConnections: true, talk: true });
		expect(resolved.delete).toBe(false);
	});
});
