import type { WorkspaceRole } from "@sugabots/contracts";
import { describe, expect, it } from "vitest";
import {
	type Actor,
	type BotFacts,
	type BotPermission,
	mayInProject,
	mayInWorkspace,
	mayOnBot,
	type ProjectPermission,
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
	"project.create": true,
	"bot.create": true,
} satisfies Record<WorkspacePermission, true>) as WorkspacePermission[];

const PROJECT_PERMISSIONS = Object.keys({
	"project.read": true,
	"project.change": true,
	"project.update": true,
	"project.delete": true,
	"project.members.manage": true,
	"project.bots.manage": true,
	"project.leave": true,
	"project.chats.manage": true,
	"connector.read": true,
	"automation.read": true,
	"automation.manage": true,
	"automation.run": true,
	"automation.history.read": true,
	"computer.read": true,
	"computer.manage": true,
	"computer.desktop.use": true,
} satisfies Record<ProjectPermission, true>) as ProjectPermission[];

const BOT_PERMISSIONS = Object.keys({
	"bot.read": true,
	"bot.use": true,
	"bot.settings.read": true,
	"bot.update": true,
	"connector.read": true,
	"automation.read": true,
	"automation.manage": true,
	"automation.run": true,
	"automation.history.read": true,
	"computer.manage": true,
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
	"project.change",
	"project.leave",
	"project.members.manage",
	"project.bots.manage",
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
	"bot.use",
	"bot.settings.read",
	"connector.read",
	"automation.read",
	"automation.history.read",
	"automation.run",
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
	"automation.manage",
	"computer.manage",
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
	});

	it("lets an admin manage what a personal bot's default project holds, but not see its chats", () => {
		const personalOne = defaultProjectOf(personalBotBy(BOB));
		const managed: ProjectPermission[] = [
			"connector.read",
			"automation.read",
			"automation.manage",
			"computer.read",
			"computer.manage",
		];
		for (const permission of PROJECT_PERMISSIONS) {
			expect(mayInProject(actor("admin"), permission, personalOne)).toBe(
				managed.includes(permission),
			);
		}
	});

	it("lets its bot's managers tidy its chats", () => {
		const own = defaultProjectOf(publicBotBy(BOB));
		expect(mayInProject(actor("editor", BOB), "project.chats.manage", own)).toBe(true);
		expect(mayInProject(actor("admin"), "project.chats.manage", own)).toBe(true);
		expect(mayInProject(actor("editor"), "project.chats.manage", own)).toBe(false);
	});

	it.each(["owner", "admin", "editor"] as const)(
		"lets a %s never change it, staff it, leave or delete it",
		(role) => {
			const own = defaultProjectOf(publicBotBy(BOB));
			for (const permission of [
				"project.update",
				"project.members.manage",
				"project.bots.manage",
				"project.leave",
				"project.delete",
			] as const) {
				expect(mayInProject(actor(role, BOB), permission, own)).toBe(false);
			}
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

	it("lets nobody outside the workspace reach any bot, even one they made", () => {
		expect(reachesBot(actor(undefined), publicBotBy(ALICE))).toBe(false);
		expect(reachesBot(actor(undefined), personalBotBy(ALICE))).toBe(false);
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

	it.each(BOT_PERMISSIONS)("somebody outside the workspace may not %s", (permission) => {
		expect(mayOnBot(actor(undefined), permission, publicBotBy(ALICE))).toBe(false);
	});
});
