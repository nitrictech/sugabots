import type { WorkspaceRole } from "@sugabots/contracts";
import { describe, expect, it } from "vitest";
import {
	type Actor,
	type AgentFacts,
	type AgentPermission,
	agentPermissions,
	mayInPod,
	mayInWorkspace,
	mayOnAgent,
	type PodPermission,
	podPermissions,
	reachesAgent,
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

const publicBotBy = (createdById: string | null): AgentFacts => ({
	visibility: "public",
	createdById,
	assistantOf: null,
});

const privateBotBy = (createdById: string): AgentFacts => ({
	visibility: "private",
	createdById,
	assistantOf: null,
});

/** A Personal Assistant, which the workspace makes rather than its person. */
const assistantOf = (userId: string): AgentFacts => ({
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
	"workspace.builtInAgents.configure": true,
	"workspace.usage.manage": true,
	"pod.create": true,
	"agent.create": true,
} satisfies Record<WorkspacePermission, true>) as WorkspacePermission[];

const POD_PERMISSIONS = Object.keys({
	"pod.read": true,
	"pod.update": true,
	"pod.delete": true,
	"pod.members.manage": true,
	"pod.bots.manage": true,
	"pod.leave": true,
	"approval.decide": true,
} satisfies Record<PodPermission, true>) as PodPermission[];

const AGENT_PERMISSIONS = Object.keys({
	"agent.read": true,
	"agent.settings.read": true,
	"agent.update": true,
	"agent.delete": true,
	"connection.read": true,
	"connection.manage": true,
	"routine.read": true,
	"routine.manage": true,
	"routine.run": true,
	"routine.history.read": true,
	"approval.decide": true,
	"approval.routine.decide": true,
	"sandbox.manage": true,
	"sandbox.request.decide": true,
	"sandbox.desktop.use": true,
} satisfies Record<AgentPermission, true>) as AgentPermission[];

/** What only the owner may do: decide who administers, hand the workspace on, and delete it. */
const OWNER_ONLY: WorkspacePermission[] = [
	"workspace.admins.manage",
	"workspace.ownership.transfer",
	"workspace.delete",
];

/** What a member may do in the workspace: belong to it, and make channels and bots. */
const MEMBER_IN_WORKSPACE: WorkspacePermission[] = ["workspace.read", "pod.create", "agent.create"];

/** What a member holds in a channel they are in: everything but changing or deleting it. */
const MEMBER_IN_CHANNEL: PodPermission[] = [
	"pod.read",
	"pod.leave",
	"pod.members.manage",
	"pod.bots.manage",
	"approval.decide",
];

/** What a viewer holds in a channel they are in: reading, taking part, and leaving. */
const VIEWER_IN_CHANNEL: PodPermission[] = ["pod.read", "pod.leave"];

/** What anybody who reaches a bot may do with it without managing it. */
const USING_A_BOT: AgentPermission[] = [
	"agent.read",
	"agent.settings.read",
	"connection.read",
	"routine.read",
	"routine.history.read",
	"routine.run",
	"approval.decide",
	"sandbox.desktop.use",
];

/** What a viewer who reaches a bot may do with it: read, and take part in its tasks. */
const VIEWING_A_BOT: AgentPermission[] = [
	"agent.read",
	"agent.settings.read",
	"connection.read",
	"routine.read",
	"routine.history.read",
];

/**
 * What a bot's creator, or an administrator, may do with it besides use it,
 * with reading the configuration they change, but not its tasks, files or
 * automations' runs.
 */
const MANAGING_A_BOT: AgentPermission[] = [
	"agent.settings.read",
	"connection.read",
	"routine.read",
	"agent.update",
	"agent.delete",
	"connection.manage",
	"routine.manage",
	"approval.routine.decide",
	"sandbox.manage",
	"sandbox.request.decide",
];

/** What a person may do with their Personal Assistant besides use it: change its look and connections, and decide its computer's requests. */
const OWNING_AN_ASSISTANT: AgentPermission[] = [
	"agent.update",
	"connection.manage",
	"sandbox.request.decide",
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
		it.each(POD_PERMISSIONS)("in the channel may %s unless it is leaving", (permission) => {
			expect(mayInPod(actor(role), permission, { isMember: true })).toBe(
				permission !== "pod.leave",
			);
		});

		it.each(POD_PERMISSIONS)("outside the channel may not %s", (permission) => {
			expect(mayInPod(actor(role), permission, { isMember: false })).toBe(false);
		});
	});

	it.each(POD_PERMISSIONS)("a member in the channel may %s only when granted", (permission) => {
		expect(mayInPod(actor("member"), permission, { isMember: true })).toBe(
			MEMBER_IN_CHANNEL.includes(permission),
		);
	});

	it.each(POD_PERMISSIONS)("a viewer in the channel may %s only when granted", (permission) => {
		expect(mayInPod(actor("viewer"), permission, { isMember: true })).toBe(
			VIEWER_IN_CHANNEL.includes(permission),
		);
	});

	it.each(["member", "viewer"] as const)(
		"a %s outside the channel may do nothing in it",
		(role) => {
			for (const permission of POD_PERMISSIONS) {
				expect(mayInPod(actor(role), permission, { isMember: false })).toBe(false);
			}
		},
	);

	it.each(POD_PERMISSIONS)("somebody outside the workspace may not %s", (permission) => {
		expect(mayInPod(actor(undefined), permission, { isMember: true })).toBe(false);
	});
});

describe("reaching a bot", () => {
	it.each(["owner", "admin", "member", "viewer"] as const)(
		"lets a %s reach a public bot somebody else made",
		(role) => {
			expect(reachesAgent(actor(role), publicBotBy(BOB))).toBe(true);
		},
	);

	it("lets only its creator reach a private bot, not an admin", () => {
		expect(reachesAgent(actor("member", BOB), privateBotBy(BOB))).toBe(true);
		expect(reachesAgent(actor("member"), privateBotBy(BOB))).toBe(false);
		expect(reachesAgent(actor("admin"), privateBotBy(BOB))).toBe(false);
		expect(reachesAgent(actor("owner"), privateBotBy(BOB))).toBe(false);
	});

	it("lets only its person reach a Personal Assistant", () => {
		expect(reachesAgent(actor("viewer"), assistantOf(ALICE))).toBe(true);
		expect(reachesAgent(actor("owner", BOB), assistantOf(ALICE))).toBe(false);
	});

	it("lets nobody outside the workspace reach any bot, even one they made", () => {
		expect(reachesAgent(actor(undefined), publicBotBy(ALICE))).toBe(false);
		expect(reachesAgent(actor(undefined), privateBotBy(ALICE))).toBe(false);
		expect(reachesAgent(actor(undefined), assistantOf(ALICE))).toBe(false);
	});
});

describe("bot actions", () => {
	it.each(AGENT_PERMISSIONS)(
		"a member may %s on a public bot somebody else made only to use it",
		(permission) => {
			expect(mayOnAgent(actor("member"), permission, publicBotBy(BOB))).toBe(
				USING_A_BOT.includes(permission),
			);
		},
	);

	it.each(AGENT_PERMISSIONS)("a member may %s on a bot they made", (permission) => {
		expect(mayOnAgent(actor("member"), permission, publicBotBy(ALICE))).toBe(true);
		expect(mayOnAgent(actor("member"), permission, privateBotBy(ALICE))).toBe(true);
	});

	it.each(AGENT_PERMISSIONS)("an admin may %s on a public bot somebody else made", (permission) => {
		expect(mayOnAgent(actor("admin"), permission, publicBotBy(BOB))).toBe(true);
	});

	it.each(AGENT_PERMISSIONS)(
		"an admin may %s on another person's private bot only to manage it",
		(permission) => {
			expect(mayOnAgent(actor("admin"), permission, privateBotBy(BOB))).toBe(
				MANAGING_A_BOT.includes(permission),
			);
		},
	);

	it.each(AGENT_PERMISSIONS)(
		"a member may not %s on another person's private bot",
		(permission) => {
			expect(mayOnAgent(actor("member"), permission, privateBotBy(BOB))).toBe(false);
		},
	);

	it.each(AGENT_PERMISSIONS)("a viewer may %s on a public bot only to view it", (permission) => {
		expect(mayOnAgent(actor("viewer"), permission, publicBotBy(BOB))).toBe(
			VIEWING_A_BOT.includes(permission),
		);
	});

	it("does not let a viewer manage a bot they made before they became one", () => {
		for (const permission of MANAGING_A_BOT.filter((one) => !VIEWING_A_BOT.includes(one))) {
			expect(mayOnAgent(actor("viewer"), permission, publicBotBy(ALICE))).toBe(false);
		}
	});

	it.each(AGENT_PERMISSIONS)(
		"its person may %s on their Personal Assistant only to use it, change its look and connections, or decide its computer's requests",
		(permission) => {
			expect(mayOnAgent(actor("member"), permission, assistantOf(ALICE))).toBe(
				USING_A_BOT.includes(permission) || OWNING_AN_ASSISTANT.includes(permission),
			);
		},
	);

	it.each(AGENT_PERMISSIONS)(
		"nobody else may %s on a Personal Assistant, the workspace's owner included",
		(permission) => {
			expect(mayOnAgent(actor("owner", BOB), permission, assistantOf(ALICE))).toBe(false);
		},
	);

	it.each(AGENT_PERMISSIONS)("somebody outside the workspace may not %s", (permission) => {
		expect(mayOnAgent(actor(undefined), permission, publicBotBy(ALICE))).toBe(false);
	});
});

describe("what the API tells a client", () => {
	it("lets an admin change, staff and delete a channel, and not leave it", () => {
		expect(podPermissions(actor("admin"), { isMember: true, isPublic: false })).toEqual({
			rename: true,
			manageMembers: true,
			manageBots: true,
			leave: false,
			join: false,
			delete: true,
			deleteArtifacts: true,
		});
	});

	it("lets a member staff and leave a channel they are in, and not change or delete it", () => {
		expect(podPermissions(actor("member"), { isMember: true, isPublic: true })).toEqual({
			rename: false,
			manageMembers: true,
			manageBots: true,
			leave: true,
			join: false,
			delete: false,
			deleteArtifacts: false,
		});
	});

	it("lets anyone in the workspace join a public channel they are not in, and nothing else", () => {
		for (const role of ["member", "viewer"] as const) {
			expect(podPermissions(actor(role), { isMember: false, isPublic: true })).toEqual({
				rename: false,
				manageMembers: false,
				manageBots: false,
				leave: false,
				join: true,
				delete: false,
				deleteArtifacts: false,
			});
		}
	});

	it("does not offer to join a private channel, or a public one from outside the workspace", () => {
		expect(podPermissions(actor("member"), { isMember: false, isPublic: false }).join).toBe(false);
		expect(podPermissions(actor(undefined), { isMember: false, isPublic: true }).join).toBe(false);
	});

	it("lets a member talk to a public bot without managing it", () => {
		expect(agentPermissions(actor("member"), publicBotBy(BOB))).toEqual({
			update: false,
			delete: false,
			manageConnections: false,
			manageSandbox: false,
			useDesktop: true,
			manageRoutines: false,
			runRoutines: true,
			decideApprovals: true,
			talk: true,
		});
	});

	it("lets an admin manage another person's private bot without talking to it", () => {
		expect(agentPermissions(actor("admin"), privateBotBy(BOB))).toEqual({
			update: true,
			delete: true,
			manageConnections: true,
			manageSandbox: true,
			useDesktop: false,
			manageRoutines: true,
			runRoutines: false,
			decideApprovals: false,
			talk: false,
		});
	});

	it("lets a person change their Personal Assistant but not delete it", () => {
		const resolved = agentPermissions(actor("member"), assistantOf(ALICE));
		expect(resolved).toMatchObject({ update: true, manageConnections: true, talk: true });
		expect(resolved.delete).toBe(false);
	});
});
