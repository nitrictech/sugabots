import type { WorkspaceRole } from "@sugabots/contracts";
import { describe, expect, it } from "vitest";
import {
	type Actor,
	mayInPod,
	mayInWorkspace,
	type PodFacts,
	type PodPermission,
	podPermissions,
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

const sharedPod = (isMember: boolean): PodFacts => ({
	kind: "shared",
	ownerId: null,
	isMember,
});

const personalPodOf = (ownerId: string): PodFacts => ({
	kind: "personal",
	ownerId,
	isMember: ownerId === ALICE,
});

/**
 * Every pod permission there is.
 *
 * Spelled as a `Record` and then taken apart, so a permission added to
 * `PodPermission` stops this file compiling rather than quietly dropping out
 * of every table below.
 */
const POD_PERMISSIONS = Object.keys({
	"pod.read": true,
	"pod.update": true,
	"pod.delete": true,
	"pod.members.manage": true,
	"pod.leave": true,
	"agent.read": true,
	"agent.create": true,
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
} satisfies Record<PodPermission, true>) as PodPermission[];

/** What a Member holds in a shared pod they have been added to. */
const MEMBER_IN_JOINED_POD: PodPermission[] = [
	"pod.read",
	"pod.leave",
	"agent.read",
	"agent.create",
	"agent.update",
	"connection.read",
	"routine.read",
	"routine.history.read",
	"approval.decide",
];

/** What a Viewer holds there: reading, taking part, and nothing else. */
const VIEWER_IN_JOINED_POD: PodPermission[] = [
	"pod.read",
	"pod.leave",
	"agent.read",
	"connection.read",
	"routine.read",
	"routine.history.read",
];

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
} satisfies Record<WorkspacePermission, true>) as WorkspacePermission[];

/** What only the owner may do: decide who administers, hand the workspace on, and delete it. */
const OWNER_ONLY: WorkspacePermission[] = [
	"workspace.admins.manage",
	"workspace.ownership.transfer",
	"workspace.delete",
];

describe("workspace actions", () => {
	it.each(WORKSPACE_PERMISSIONS)("the owner may %s", (permission) => {
		expect(mayInWorkspace(actor("owner"), permission)).toBe(true);
	});

	it.each(WORKSPACE_PERMISSIONS)("an admin may %s unless only the owner may", (permission) => {
		expect(mayInWorkspace(actor("admin"), permission)).toBe(!OWNER_ONLY.includes(permission));
	});

	it.each(["member", "viewer"] as const)(
		"a %s belongs to the workspace but configures nothing in it",
		(role) => {
			expect(mayInWorkspace(actor(role), "workspace.read")).toBe(true);
			expect(mayInWorkspace(actor(role), "workspace.providers.manage")).toBe(false);
			expect(mayInWorkspace(actor(role), "workspace.members.manage")).toBe(false);
			expect(mayInWorkspace(actor(role), "workspace.admins.manage")).toBe(false);
			expect(mayInWorkspace(actor(role), "workspace.ownership.transfer")).toBe(false);
			expect(mayInWorkspace(actor(role), "workspace.builtInAgents.configure")).toBe(false);
			expect(mayInWorkspace(actor(role), "workspace.usage.manage")).toBe(false);
			expect(mayInWorkspace(actor(role), "pod.create")).toBe(false);
		},
	);

	it.each(WORKSPACE_PERMISSIONS)("somebody outside the workspace may not %s", (permission) => {
		expect(mayInWorkspace(actor(undefined), permission)).toBe(false);
	});
});

describe("shared pods", () => {
	describe.each(["owner", "admin"] as const)("as %s", (role) => {
		it.each(POD_PERMISSIONS)("in the pod may %s unless it is leaving", (permission) => {
			expect(mayInPod(actor(role), permission, sharedPod(true))).toBe(permission !== "pod.leave");
		});

		it.each(POD_PERMISSIONS)("outside the pod may not %s", (permission) => {
			expect(mayInPod(actor(role), permission, sharedPod(false))).toBe(false);
		});
	});

	it.each(POD_PERMISSIONS)("a member in the pod may %s only when granted", (permission) => {
		expect(mayInPod(actor("member"), permission, sharedPod(true))).toBe(
			MEMBER_IN_JOINED_POD.includes(permission),
		);
	});

	it.each(POD_PERMISSIONS)("a member outside the pod may not %s", (permission) => {
		expect(mayInPod(actor("member"), permission, sharedPod(false))).toBe(false);
	});

	it.each(POD_PERMISSIONS)("a viewer in the pod may %s only when granted", (permission) => {
		expect(mayInPod(actor("viewer"), permission, sharedPod(true))).toBe(
			VIEWER_IN_JOINED_POD.includes(permission),
		);
	});

	it.each(POD_PERMISSIONS)("a viewer outside the pod may not %s", (permission) => {
		expect(mayInPod(actor("viewer"), permission, sharedPod(false))).toBe(false);
	});

	it.each(POD_PERMISSIONS)("somebody outside the workspace may not %s", (permission) => {
		expect(mayInPod(actor(undefined), permission, sharedPod(true))).toBe(false);
	});

	it("a member creates and edits agents but cannot delete them", () => {
		const inPod = sharedPod(true);
		expect(mayInPod(actor("member"), "agent.create", inPod)).toBe(true);
		expect(mayInPod(actor("member"), "agent.update", inPod)).toBe(true);
		expect(mayInPod(actor("member"), "agent.delete", inPod)).toBe(false);
	});

	it("a member approves ordinary tool calls but not Routine ones", () => {
		const inPod = sharedPod(true);
		expect(mayInPod(actor("member"), "approval.decide", inPod)).toBe(true);
		expect(mayInPod(actor("member"), "approval.routine.decide", inPod)).toBe(false);
	});

	it("lets a viewer read and take part, and change nothing", () => {
		const inPod = sharedPod(true);
		expect(mayInPod(actor("viewer"), "pod.read", inPod)).toBe(true);
		expect(mayInPod(actor("viewer"), "agent.read", inPod)).toBe(true);
		expect(mayInPod(actor("viewer"), "agent.create", inPod)).toBe(false);
		expect(mayInPod(actor("viewer"), "agent.update", inPod)).toBe(false);
		expect(mayInPod(actor("viewer"), "approval.decide", inPod)).toBe(false);
	});

	it("gives a viewer strictly less than a member in the same pod", () => {
		const inPod = sharedPod(true);
		for (const permission of POD_PERMISSIONS) {
			if (!mayInPod(actor("viewer"), permission, inPod)) continue;
			expect(
				mayInPod(actor("member"), permission, inPod),
				`a member should hold ${permission} wherever a viewer does`,
			).toBe(true);
		}
	});

	it("agent editing does not carry Routine management with it", () => {
		const inPod = sharedPod(true);
		expect(mayInPod(actor("member"), "agent.update", inPod)).toBe(true);
		expect(mayInPod(actor("member"), "routine.manage", inPod)).toBe(false);
		expect(mayInPod(actor("member"), "routine.run", inPod)).toBe(false);
	});
});

describe("personal pods", () => {
	it.each(POD_PERMISSIONS)("the owner may %s in their own pod", (permission) => {
		expect(mayInPod(actor("member"), permission, personalPodOf(ALICE))).toBe(true);
	});

	it.each(POD_PERMISSIONS)("a viewer may %s in their own pod", (permission) => {
		// A role says what somebody may do in shared space. Their own pod is
		// theirs whatever it says.
		expect(mayInPod(actor("viewer"), permission, personalPodOf(ALICE))).toBe(true);
	});

	it.each(POD_PERMISSIONS)(
		"an admin, or the workspace's owner, may not %s in somebody else's pod",
		(permission) => {
			expect(mayInPod(actor("admin"), permission, personalPodOf(BOB))).toBe(false);
			expect(mayInPod(actor("owner"), permission, personalPodOf(BOB))).toBe(false);
		},
	);

	it("an admin is an ordinary owner of their own personal pod", () => {
		expect(mayInPod(actor("admin"), "agent.delete", personalPodOf(ALICE))).toBe(true);
	});

	it("ownership grants nothing to somebody outside the workspace", () => {
		expect(mayInPod(actor(undefined), "pod.read", personalPodOf(ALICE))).toBe(false);
	});
});

describe("what the API tells a client", () => {
	it("refuses a Personal pod's rename and membership to its owner, who holds every permission", () => {
		const own = personalPodOf(ALICE);
		expect(mayInPod(actor("admin"), "pod.update", own)).toBe(true);
		expect(mayInPod(actor("admin"), "pod.members.manage", own)).toBe(true);

		const resolved = podPermissions(actor("admin"), own);
		expect(resolved.rename).toBe(false);
		expect(resolved.manageMembers).toBe(false);
		// Routing is the one part of a Personal pod its owner does change.
		expect(resolved.changeRouting).toBe(true);
	});

	it("lets an admin rename and staff a shared pod, and not leave it", () => {
		const resolved = podPermissions(actor("admin"), sharedPod(true));
		expect(resolved.rename).toBe(true);
		expect(resolved.manageMembers).toBe(true);
		expect(resolved.leave).toBe(false);
	});

	it("lets a member leave a shared pod but never their Personal pod", () => {
		expect(podPermissions(actor("member"), sharedPod(true)).leave).toBe(true);
		expect(podPermissions(actor("member"), personalPodOf(ALICE)).leave).toBe(false);
	});
});
