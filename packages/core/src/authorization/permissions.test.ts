import { WORKSPACE_ROLES, type WorkspaceRole } from "@sugabots/contracts";
import { describe, expect, it } from "vitest";
import {
	type Actor,
	type BotFacts,
	type BotPermission,
	botPermissions,
	mayInProject,
	mayInWorkspace,
	mayOnBot,
	type ProjectPermission,
	projectPermissions,
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

const actor = (workspaceRole: WorkspaceRole | undefined, memberId = ALICE): Actor => ({
	memberId,
	workspaceRole,
});

const publicBotBy = (createdById: string | null): BotFacts => ({
	visibility: "public",
	createdById,
	assistantOf: null,
});

const personalBotBy = (createdById: string): BotFacts => ({
	visibility: "personal",
	createdById,
	assistantOf: null,
});

/** A Personal Assistant, which the workspace makes rather than its member. */
const assistantOf = (memberId: string): BotFacts => ({
	visibility: "personal",
	createdById: null,
	assistantOf: memberId,
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
	"workspace.ownership.handOver": true,
	"workspace.delete": true,
	"workspace.systemModel.choose": true,
	"workspace.usage.manage": true,
	"project.create": true,
	"bot.create": true,
} satisfies Record<WorkspacePermission, true>) as WorkspacePermission[];

const PROJECT_PERMISSIONS = Object.keys({
	"project.read": true,
	"project.update": true,
	"project.delete": true,
	"project.members.manage": true,
	"project.bots.manage": true,
	"project.leave": true,
	"project.chats.manage": true,
	"approval.decide": true,
	"connector.read": true,
	"connector.manage": true,
	"automation.read": true,
	"automation.manage": true,
	"automation.run": true,
	"automation.history.read": true,
	"computer.read": true,
	"computer.manage": true,
	"computer.request.decide": true,
	"computer.desktop.use": true,
} satisfies Record<ProjectPermission, true>) as ProjectPermission[];

const BOT_PERMISSIONS = Object.keys({
	"bot.read": true,
	"bot.settings.read": true,
	"bot.update": true,
	"bot.delete": true,
	"connector.read": true,
	"connector.manage": true,
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
	"workspace.ownership.handOver",
	"workspace.delete",
];

/** What an editor may do in the workspace: belong to it, and make projects and bots. */
const EDITOR_IN_WORKSPACE: WorkspacePermission[] = [
	"workspace.read",
	"project.create",
	"bot.create",
];

/** What an editor holds in a project they are in: everything but changing or deleting it. */
const EDITOR_IN_PROJECT: ProjectPermission[] = [
	"project.read",
	"project.leave",
	"project.members.manage",
	"project.bots.manage",
	"approval.decide",
	"connector.read",
	"automation.read",
	"automation.history.read",
	"automation.run",
	"computer.read",
	"computer.desktop.use",
];

/**
 * What a viewer holds in a project they are in: reading, taking part, and
 * leaving, and seeing its connectors, automations and computer.
 */
const VIEWER_IN_PROJECT: ProjectPermission[] = [
	"project.read",
	"project.leave",
	"connector.read",
	"automation.read",
	"automation.history.read",
	"computer.read",
];

/** What anybody who reaches a bot may do with it without managing it. */
const USING_A_BOT: BotPermission[] = [
	"bot.read",
	"bot.settings.read",
	"connector.read",
	"automation.read",
	"automation.history.read",
	"automation.run",
	"approval.decide",
	"computer.desktop.use",
];

/** What a viewer who reaches a bot may do with it: read, and take part in its chats. */
const VIEWING_A_BOT: BotPermission[] = [
	"bot.read",
	"bot.settings.read",
	"connector.read",
	"automation.read",
	"automation.history.read",
];

/**
 * What a bot's creator, or an administrator, may do with it besides use it,
 * with reading the configuration they change, but not its chats, files or
 * automations' runs.
 */
const MANAGING_A_BOT: BotPermission[] = [
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
];

/**
 * What a member may do with their Personal Assistant besides use it: change its
 * look and connectors, manage and run its automations, and decide what it and
 * its computer ask.
 */
const OWNING_AN_ASSISTANT: BotPermission[] = [
	"bot.update",
	"connector.manage",
	"automation.manage",
	"automation.run",
	"approval.automation.decide",
	"computer.request.decide",
	"approval.decide",
];

/** Everything that concerns a bot's automations, which on a Personal Assistant are its member's alone. */
const AUTOMATIONS: Array<BotPermission & ProjectPermission> = [
	"automation.read",
	"automation.manage",
	"automation.run",
	"automation.history.read",
];

describe("workspace actions", () => {
	it.each(WORKSPACE_PERMISSIONS)("the owner may %s", (permission) => {
		expect(mayInWorkspace(actor("owner"), permission)).toBe(true);
	});

	it.each(WORKSPACE_PERMISSIONS)("an admin may %s unless only the owner may", (permission) => {
		expect(mayInWorkspace(actor("admin"), permission)).toBe(!OWNER_ONLY.includes(permission));
	});

	it.each(WORKSPACE_PERMISSIONS)("an editor may %s only when granted", (permission) => {
		expect(mayInWorkspace(actor("editor"), permission)).toBe(
			EDITOR_IN_WORKSPACE.includes(permission),
		);
	});

	it.each(WORKSPACE_PERMISSIONS)("a viewer may %s only if it is belonging", (permission) => {
		expect(mayInWorkspace(actor("viewer"), permission)).toBe(permission === "workspace.read");
	});

	it.each(WORKSPACE_PERMISSIONS)("somebody outside the workspace may not %s", (permission) => {
		expect(mayInWorkspace(actor(undefined), permission)).toBe(false);
	});
});

describe("project actions", () => {
	describe.each(["owner", "admin"] as const)("as %s", (role) => {
		it.each(PROJECT_PERMISSIONS)("in the project may %s unless it is leaving", (permission) => {
			expect(mayInProject(actor(role), permission, { isMember: true, defaultOf: null })).toBe(
				permission !== "project.leave",
			);
		});

		it.each(PROJECT_PERMISSIONS)("outside the project may not %s", (permission) => {
			expect(mayInProject(actor(role), permission, { isMember: false, defaultOf: null })).toBe(
				false,
			);
		});
	});

	it.each(PROJECT_PERMISSIONS)(
		"an editor in the project may %s only when granted",
		(permission) => {
			expect(mayInProject(actor("editor"), permission, { isMember: true, defaultOf: null })).toBe(
				EDITOR_IN_PROJECT.includes(permission),
			);
		},
	);

	it.each(PROJECT_PERMISSIONS)("a viewer in the project may %s only when granted", (permission) => {
		expect(mayInProject(actor("viewer"), permission, { isMember: true, defaultOf: null })).toBe(
			VIEWER_IN_PROJECT.includes(permission),
		);
	});

	it.each(["editor", "viewer"] as const)(
		"a %s outside the project may do nothing in it",
		(role) => {
			for (const permission of PROJECT_PERMISSIONS) {
				expect(mayInProject(actor(role), permission, { isMember: false, defaultOf: null })).toBe(
					false,
				);
			}
		},
	);

	it.each(PROJECT_PERMISSIONS)("somebody outside the workspace may not %s", (permission) => {
		expect(mayInProject(actor(undefined), permission, { isMember: true, defaultOf: null })).toBe(
			false,
		);
	});
});

describe("a bot's default project", () => {
	/** A bot's default project, as its bot's facts decide it. */
	const defaultProjectOf = (bot: BotFacts) => ({ isMember: false, defaultOf: bot });

	it("is reached by whoever reaches its bot, and by nobody else", () => {
		const publicOne = defaultProjectOf(publicBotBy(BOB));
		for (const role of ["owner", "admin", "editor", "viewer"] as const) {
			expect(mayInProject(actor(role), "project.read", publicOne)).toBe(true);
		}
		const personalOne = defaultProjectOf(personalBotBy(BOB));
		expect(mayInProject(actor("editor", BOB), "project.read", personalOne)).toBe(true);
		expect(mayInProject(actor("editor"), "project.read", personalOne)).toBe(false);
		const assistants = defaultProjectOf(assistantOf(BOB));
		expect(mayInProject(actor("editor", BOB), "project.read", assistants)).toBe(true);
		expect(mayInProject(actor("owner"), "project.read", assistants)).toBe(false);
	});

	it("lets an admin manage what a personal bot's default project holds, but not see its chats", () => {
		const personalOne = defaultProjectOf(personalBotBy(BOB));
		const managed: ProjectPermission[] = [
			"connector.read",
			"connector.manage",
			"automation.read",
			"automation.manage",
			"computer.read",
			"computer.manage",
			"computer.request.decide",
		];
		for (const permission of PROJECT_PERMISSIONS) {
			expect(mayInProject(actor("admin"), permission, personalOne)).toBe(
				managed.includes(permission),
			);
		}
	});

	it("lets its bot's managers tidy its chats, and those who may decide the bot's calls decide them", () => {
		const own = defaultProjectOf(publicBotBy(BOB));
		expect(mayInProject(actor("editor", BOB), "project.chats.manage", own)).toBe(true);
		expect(mayInProject(actor("admin"), "project.chats.manage", own)).toBe(true);
		expect(mayInProject(actor("editor"), "project.chats.manage", own)).toBe(false);
		expect(mayInProject(actor("editor"), "approval.decide", own)).toBe(true);
		expect(mayInProject(actor("viewer"), "approval.decide", own)).toBe(false);
	});

	it.each(["owner", "admin", "editor"] as const)(
		"lets a %s never change it, staff it, join, leave or delete it",
		(role) => {
			const own = defaultProjectOf(publicBotBy(BOB));
			const permissions = projectPermissions(actor(role, BOB), { ...own, isPublic: true });
			expect(permissions).toMatchObject({
				rename: false,
				manageMembers: false,
				manageBots: false,
				leave: false,
				join: false,
				delete: false,
			});
		},
	);
});

describe("reaching a bot", () => {
	it.each(["owner", "admin", "editor", "viewer"] as const)(
		"lets a %s reach a public bot somebody else made",
		(role) => {
			expect(reachesBot(actor(role), publicBotBy(BOB))).toBe(true);
		},
	);

	it("lets only its creator reach a personal bot, not an admin", () => {
		expect(reachesBot(actor("editor", BOB), personalBotBy(BOB))).toBe(true);
		expect(reachesBot(actor("editor"), personalBotBy(BOB))).toBe(false);
		expect(reachesBot(actor("admin"), personalBotBy(BOB))).toBe(false);
		expect(reachesBot(actor("owner"), personalBotBy(BOB))).toBe(false);
	});

	it("lets only its member reach a Personal Assistant", () => {
		expect(reachesBot(actor("viewer"), assistantOf(ALICE))).toBe(true);
		expect(reachesBot(actor("owner", BOB), assistantOf(ALICE))).toBe(false);
	});

	it("lets nobody outside the workspace reach any bot, even one they made", () => {
		expect(reachesBot(actor(undefined), publicBotBy(ALICE))).toBe(false);
		expect(reachesBot(actor(undefined), personalBotBy(ALICE))).toBe(false);
		expect(reachesBot(actor(undefined), assistantOf(ALICE))).toBe(false);
	});
});

describe("bot actions", () => {
	it.each(BOT_PERMISSIONS)(
		"an editor may %s on a public bot somebody else made only to use it",
		(permission) => {
			expect(mayOnBot(actor("editor"), permission, publicBotBy(BOB))).toBe(
				USING_A_BOT.includes(permission),
			);
		},
	);

	it.each(BOT_PERMISSIONS)("an editor may %s on a bot they made", (permission) => {
		expect(mayOnBot(actor("editor"), permission, publicBotBy(ALICE))).toBe(true);
		expect(mayOnBot(actor("editor"), permission, personalBotBy(ALICE))).toBe(true);
	});

	it.each(BOT_PERMISSIONS)("an admin may %s on a public bot somebody else made", (permission) => {
		expect(mayOnBot(actor("admin"), permission, publicBotBy(BOB))).toBe(true);
	});

	it.each(BOT_PERMISSIONS)(
		"an admin may %s on another member's personal bot only to manage it",
		(permission) => {
			expect(mayOnBot(actor("admin"), permission, personalBotBy(BOB))).toBe(
				MANAGING_A_BOT.includes(permission),
			);
		},
	);

	it.each(BOT_PERMISSIONS)(
		"an editor may not %s on another member's personal bot",
		(permission) => {
			expect(mayOnBot(actor("editor"), permission, personalBotBy(BOB))).toBe(false);
		},
	);

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
		"its member may %s on their Personal Assistant only to use it, change its look, connectors and automations, or decide what it asks",
		(permission) => {
			expect(mayOnBot(actor("editor"), permission, assistantOf(ALICE))).toBe(
				USING_A_BOT.includes(permission) || OWNING_AN_ASSISTANT.includes(permission),
			);
		},
	);

	it.each(AUTOMATIONS)(
		"lets its member %s for their Personal Assistant's automations, whatever their role",
		(permission) => {
			const assistants = { isMember: false, defaultOf: assistantOf(ALICE) };
			for (const role of WORKSPACE_ROLES) {
				expect(mayInProject(actor(role), permission, assistants)).toBe(true);
			}
		},
	);

	it.each(AUTOMATIONS)(
		"lets no administrator %s for another member's Personal Assistant's automations",
		(permission) => {
			const assistants = { isMember: false, defaultOf: assistantOf(ALICE) };
			for (const role of ["owner", "admin"] as const) {
				expect(mayInProject(actor(role, BOB), permission, assistants)).toBe(false);
			}
		},
	);

	it("lets only its member decide what their Personal Assistant's runs ask, whatever their role", () => {
		for (const role of WORKSPACE_ROLES) {
			expect(mayOnBot(actor(role), "approval.automation.decide", assistantOf(ALICE))).toBe(true);
		}
		for (const role of ["owner", "admin"] as const) {
			expect(mayOnBot(actor(role, BOB), "approval.automation.decide", assistantOf(ALICE))).toBe(
				false,
			);
		}
	});

	it("lets a viewer decide what their own Personal Assistant asks to do for them", () => {
		expect(mayOnBot(actor("viewer"), "approval.decide", assistantOf(ALICE))).toBe(true);
		expect(mayInWorkspace(actor("viewer"), "project.create")).toBe(false);
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
	it("lets an admin change, staff and delete a project, and not leave it", () => {
		expect(
			projectPermissions(actor("admin"), { isMember: true, defaultOf: null, isPublic: false }),
		).toEqual({
			rename: true,
			manageMembers: true,
			manageBots: true,
			leave: false,
			join: false,
			delete: true,
			resources: {
				readHistory: true,
				openSettings: true,
				deleteFiles: true,
				manageConnectors: true,
				manageComputer: true,
				useDesktop: true,
				manageAutomations: true,
				runAutomations: true,
			},
		});
	});

	it("lets an editor staff and leave a project they are in, run its automations and use its desktop, and not change or delete it", () => {
		expect(
			projectPermissions(actor("editor"), { isMember: true, defaultOf: null, isPublic: true }),
		).toEqual({
			rename: false,
			manageMembers: true,
			manageBots: true,
			leave: true,
			join: false,
			delete: false,
			resources: {
				readHistory: true,
				openSettings: true,
				deleteFiles: false,
				manageConnectors: false,
				manageComputer: false,
				useDesktop: true,
				manageAutomations: false,
				runAutomations: true,
			},
		});
	});

	it("lets anyone in the workspace join a public project they are not in, and nothing else", () => {
		for (const role of ["editor", "viewer"] as const) {
			expect(
				projectPermissions(actor(role), { isMember: false, defaultOf: null, isPublic: true }),
			).toEqual({
				rename: false,
				manageMembers: false,
				manageBots: false,
				leave: false,
				join: true,
				delete: false,
				resources: {
					readHistory: false,
					openSettings: false,
					deleteFiles: false,
					manageConnectors: false,
					manageComputer: false,
					useDesktop: false,
					manageAutomations: false,
					runAutomations: false,
				},
			});
		}
	});

	it("does not offer to join a private project, or a public one from outside the workspace", () => {
		expect(
			projectPermissions(actor("editor"), { isMember: false, defaultOf: null, isPublic: false })
				.join,
		).toBe(false);
		expect(
			projectPermissions(actor(undefined), { isMember: false, defaultOf: null, isPublic: true })
				.join,
		).toBe(false);
	});

	it("lets an editor talk to a public bot without managing it", () => {
		expect(botPermissions(actor("editor"), publicBotBy(BOB))).toEqual({
			update: false,
			delete: false,
			talk: true,
			resources: {
				readHistory: true,
				openSettings: false,
				deleteFiles: false,
				manageConnectors: false,
				manageComputer: false,
				useDesktop: true,
				manageAutomations: false,
				runAutomations: true,
			},
		});
	});

	it("lets an admin manage another member's personal bot without talking to it", () => {
		expect(botPermissions(actor("admin"), personalBotBy(BOB))).toEqual({
			update: true,
			delete: true,
			talk: false,
			resources: {
				readHistory: false,
				openSettings: true,
				deleteFiles: false,
				manageConnectors: true,
				manageComputer: true,
				useDesktop: false,
				manageAutomations: true,
				runAutomations: false,
			},
		});
	});

	it.each(["owner", "admin", "editor", "viewer"] as const)(
		"tells a %s the same of what a bot holds as of its default project",
		(role) => {
			for (const bot of [
				publicBotBy(BOB),
				personalBotBy(BOB),
				personalBotBy(ALICE),
				assistantOf(ALICE),
			]) {
				expect(botPermissions(actor(role), bot).resources).toEqual(
					projectPermissions(actor(role), { isMember: false, defaultOf: bot, isPublic: false })
						.resources,
				);
			}
		},
	);

	it("lets a member change their Personal Assistant but not delete it", () => {
		const resolved = botPermissions(actor("editor"), assistantOf(ALICE));
		expect(resolved).toMatchObject({
			update: true,
			talk: true,
			resources: { manageConnectors: true },
		});
		expect(resolved.delete).toBe(false);
	});
});
