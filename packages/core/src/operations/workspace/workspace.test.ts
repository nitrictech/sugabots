import { and, eq } from "drizzle-orm";
import { Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Accounts } from "../../accounts/accounts.ts";
import {
	seedInvitation,
	seedMember,
	seedWorkspace,
} from "../../authentication/seed.test-support.ts";
import { membership } from "../../database/schema.ts";
import { closeDatabase, onDatabase } from "../../database/testing.ts";
import type { Principal } from "../../principal.ts";
import {
	authenticators,
	buildWorld,
	everyKindOfPrincipal,
	principals,
	type World,
} from "../../proofs/world.test-support.ts";
import { type CallOperation, operationOutcome, servedOperations } from "../testing.ts";

/**
 * The workspace and notifications operations whose rules the table in
 * `permissions.test.ts` can't state: answering an invitation, which is for its
 * address alone, leaving, handing over and deleting a workspace, which leave
 * it changed for every later case, and clearing a level. What each comes to
 * is "ok" or the tag of its refusal.
 *
 * The world is `buildWorld`'s: in workspace A, Ed (an editor) made the public
 * bot Pub, which leads the private project J; Ed and Vi (a viewer) are in J,
 * and Erin (an editor) isn't.
 */
describe("the workspace operations the permission table leaves out", () => {
	let world: World;
	let call: CallOperation;
	let as: ReturnType<typeof principals>;
	let a: World["a"];
	/** Every principal the cases call for, in workspace A. */
	let who: Awaited<ReturnType<typeof everyKindOfPrincipal>>;

	beforeAll(async () => {
		world = await buildWorld();
		a = world.a;
		// Accounts as a server's are when it isn't set to require verified email.
		call = await servedOperations({ accounts: Layer.orDie(Accounts.layer) });
		as = principals(await authenticators());
		who = await everyKindOfPrincipal(world, as);
	});

	afterAll(async () => {
		await closeDatabase();
	});

	it("hides a missing or foreign workspace membership from role changes", async () => {
		const foreign = await seedMember(world.b.workspace, "editor");
		const [row] = await onDatabase((db) =>
			db.select({ id: membership.id }).from(membership).where(eq(membership.memberId, foreign)),
		);
		if (!row) throw new Error("Expected the foreign membership");

		for (const membershipId of [row.id, crypto.randomUUID()]) {
			await expect(
				call(who.admin, "workspaces.changeRole", {
					workspace: a.workspace,
					membershipId,
					role: "viewer",
				}),
			).rejects.toMatchObject({ _tag: "ResourceHidden", resource: "membership" });
		}
	});

	it("leaves inviting administrators to the owner", async () => {
		const input = {
			workspace: a.workspace,
			email: `next-admin-${crypto.randomUUID()}@example.com`,
			role: "admin",
		} as const;
		await expect(call(who.admin, "workspaces.invite", input)).rejects.toMatchObject({
			_tag: "ActionForbidden",
		});
		expect(await call(who.owner, "workspaces.invite", input)).toMatchObject({
			email: input.email,
			role: "admin",
		});
	});

	it("leaves cancelling an administrator's invitation to the owner", async () => {
		const invitationId = await seedInvitation(a.workspace, a.owner, {
			email: `cancelled-admin-${crypto.randomUUID()}@example.com`,
			role: "admin",
		});
		await expect(
			call(who.admin, "workspaces.cancelInvitation", { invitationId }),
		).rejects.toMatchObject({ _tag: "ActionForbidden" });

		await call(who.owner, "workspaces.cancelInvitation", { invitationId });
		const pending = await call(who.owner, "workspaces.invitations", { workspace: a.workspace });
		expect(pending.map(({ id }) => id)).not.toContain(invitationId);
	});

	it("lets only the member an invitation is addressed to answer it", async () => {
		const workspace = await seedWorkspace();
		const owner = await seedMember(workspace, "owner");
		const inviteeAddress = `invitee-${crypto.randomUUID().slice(0, 8)}@example.com`;
		const unprovedAddress = `unproved-${crypto.randomUUID().slice(0, 8)}@example.com`;
		const invitee = await seedMember(world.b.workspace, "editor", { email: inviteeAddress });
		const unproved = await seedMember(world.b.workspace, "editor", {
			email: unprovedAddress,
			emailVerified: false,
		});
		const toInvitee = await seedInvitation(workspace, owner, { email: inviteeAddress });
		const toUnproved = await seedInvitation(workspace, owner, { email: unprovedAddress });
		const inviteePrincipal = await as.member(invitee);
		const unprovedPrincipal = await as.member(unproved);

		expect(
			await operationOutcome(call, who.ed, "workspaces.invitation", { invitationId: toInvitee }),
		).toBe("ResourceHidden");
		expect(
			await operationOutcome(call, who.edsAssistant, "workspaces.invitation", {
				invitationId: toInvitee,
			}),
		).toBe("ActionForbidden");
		await expect(
			call(who.ed, "workspaces.acceptInvitation", { invitationId: toInvitee }),
		).rejects.toMatchObject({ _tag: "ResourceHidden", resource: "invitation" });
		// This server, like any not set to, doesn't require members to verify their email;
		// the provers' tests and `workspaces/membership/`'s cover one that does.
		expect(
			await operationOutcome(call, unprovedPrincipal, "workspaces.acceptInvitation", {
				invitationId: toUnproved,
			}),
		).toBe("ok");
		expect(
			await call(inviteePrincipal, "workspaces.invitation", { invitationId: toInvitee }),
		).toMatchObject({ status: "pending", role: "editor" });
		expect(
			await call(inviteePrincipal, "workspaces.acceptInvitation", { invitationId: toInvitee }),
		).toEqual({ workspaceId: workspace });
		// Accepting again, as a reload does, leads back in.
		expect(
			await call(inviteePrincipal, "workspaces.acceptInvitation", { invitationId: toInvitee }),
		).toEqual({ workspaceId: workspace });
		expect(
			await call(inviteePrincipal, "workspaces.invitation", { invitationId: toInvitee }),
		).toEqual({ status: "accepted", workspaceId: workspace });
	});

	it("lets a member leave, but not the owner, and no bot outside member bounds", async () => {
		const workspace = await seedWorkspace();
		const owner = await as.member(await seedMember(workspace, "owner"));
		const editor = await as.member(await seedMember(workspace, "editor"));
		const leaving = (principal: Principal) =>
			operationOutcome(call, principal, "workspaces.leave", { workspace });

		expect(await leaving(owner)).toBe("OwnerStays");
		expect(await leaving(who.outsider)).toBe("ResourceHidden");
		expect(await leaving(who.pubForEd)).toBe("ActionForbidden");
		expect(await leaving(editor)).toBe("ok");
		expect(await leaving(editor)).toBe("ResourceHidden");
	});

	it("hands a workspace over and deletes it for its owner alone", async () => {
		const workspace = await seedWorkspace();
		const owner = await seedMember(workspace, "owner");
		const admin = await seedMember(workspace, "admin");
		const [adminsMembership] = await onDatabase((db) =>
			db
				.select({ id: membership.id })
				.from(membership)
				.where(and(eq(membership.workspaceId, workspace), eq(membership.memberId, admin))),
		);
		const handingOver = (principal: Principal) =>
			operationOutcome(call, principal, "workspaces.handOverOwnership", {
				workspace,
				membershipId: adminsMembership?.id ?? "",
			});
		const deleting = (principal: Principal) =>
			operationOutcome(call, principal, "workspaces.delete", { workspace });

		expect(await handingOver(await as.member(admin))).toBe("ActionForbidden");
		expect(await deleting(await as.member(admin))).toBe("ActionForbidden");
		expect(await deleting(who.outsider)).toBe("ResourceHidden");
		expect(await handingOver(who.outsider)).toBe("ResourceHidden");
		expect(await handingOver(await as.member(owner))).toBe("ok");
		expect(
			await call(await as.member(admin), "workspaces.memberships", { workspace }),
		).toContainEqual(expect.objectContaining({ id: adminsMembership?.id, role: "owner" }));
		expect(await deleting(await as.member(owner))).toBe("ActionForbidden");
		const newOwner = await as.member(admin);
		expect(await deleting(newOwner)).toBe("ok");
		expect((await call(newOwner, "workspaces.list", {})).map(({ id }) => id)).not.toContain(
			workspace,
		);
	});

	it("clears a member's level in a project they don't reach", async () => {
		expect(
			await operationOutcome(call, who.erin, "notifications.setLevel", {
				kind: "project",
				id: a.project,
				level: null,
			}),
		).toBe("ok");
	});
});
