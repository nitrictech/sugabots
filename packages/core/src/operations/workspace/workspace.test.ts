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
	outcomesFor,
	principals,
	type World,
} from "../../proofs/world.test-support.ts";
import { type CallOperation, operationOutcome, servedOperations } from "../testing.ts";

/**
 * The workspace and notifications operations, each called for every kind of
 * principal through the registry, as an entrypoint calls them. What each comes
 * to is "ok" or the tag of its refusal: hidden where the principal isn't in the
 * workspace or doesn't reach the project, forbidden where it is but may not
 * act. Who may do what in detail is the provers' tests'; what the writes do is
 * `workspaces/membership/`'s.
 *
 * The world is `buildWorld`'s: in workspace A, Ed (an editor) made the public
 * bot Pub, which leads the private project J; Ed and Vi (a viewer) are in J,
 * and Erin (an editor) isn't.
 */
describe("the workspace operations, for each kind of principal", () => {
	let world: World;
	let call: CallOperation;
	let as: ReturnType<typeof principals>;
	let a: World["a"];
	/** Every principal the cases call for, in workspace A. */
	let who: Awaited<ReturnType<typeof everyKindOfPrincipal>>;

	beforeAll(async () => {
		world = await buildWorld();
		a = world.a;
		// Sign-up as the server's settings say, which is closed here, so nobody has a referral link.
		call = await servedOperations({ accounts: Layer.orDie(Accounts.layer) });
		as = principals(await authenticators());
		who = await everyKindOfPrincipal(world, as);
	});

	afterAll(async () => {
		await closeDatabase();
	});

	/** The id of `memberId`'s membership of workspace A. */
	const membershipIdOf = async (memberId: string) => {
		const [found] = await onDatabase((db) =>
			db
				.select({ id: membership.id })
				.from(membership)
				.where(and(eq(membership.workspaceId, a.workspace), eq(membership.memberId, memberId))),
		);
		if (!found) throw new Error("Not in workspace A");
		return found.id;
	};

	it("does what only a member signed in does for that member alone", async () => {
		const ownOnly = ["workspaces.list", "referrals.link", "notifications.settings"] as const;
		for (const name of ownOnly) {
			expect(
				await outcomesFor(
					{
						member: who.vi,
						botInMemberBounds: who.edsAssistant,
						botInChatBounds: who.pubForEd,
						run: who.run,
						webhook: who.webhook,
						systemWork: who.computerSleep,
						page: who.page,
					},
					(principal) => operationOutcome(call, principal, name, {}),
				),
				name,
			).toEqual({
				member: "ok",
				botInMemberBounds: "ActionForbidden",
				botInChatBounds: "ActionForbidden",
				run: "ActionForbidden",
				webhook: "ActionForbidden",
				systemWork: "ActionForbidden",
				page: "ActionForbidden",
			});
		}
	});

	it("shows a workspace's members, invitations and what one may do there to whoever is in it, and a bot only in member bounds", async () => {
		const reads = [
			"workspaces.memberships",
			"workspaces.invitations",
			"system.workspaceAccess",
		] as const;
		for (const name of reads) {
			expect({
				name,
				outcomes: await outcomesFor(
					{
						viewer: who.vi,
						outsider: who.outsider,
						botInChatBounds: who.pubForEd,
					},
					(principal) => operationOutcome(call, principal, name, { workspace: a.workspace }),
				),
			}).toEqual({
				name,
				outcomes: {
					viewer: "ok",
					outsider: "ResourceHidden",
					botInChatBounds: "ActionForbidden",
				},
			});
		}
	});

	it("shows what the workspace's models cost to whoever may manage it, and a bot only in member bounds", async () => {
		expect(
			await outcomesFor(
				{
					admin: who.admin,
					outsider: who.outsider,
					adminsBotInChatBounds: who.pubForAdmin,
				},
				(principal) =>
					operationOutcome(call, principal, "usage.month", {
						workspace: a.workspace,
						month: "2026-09",
					}),
			),
		).toEqual({
			admin: "ok",
			outsider: "ResourceHidden",
			adminsBotInChatBounds: "ActionForbidden",
		});
	});

	it("shows the new membership role after an admin changes it", async () => {
		const workspace = a.workspace;
		const membershipId = await membershipIdOf(await seedMember(workspace, "editor"));
		const input = { workspace, membershipId, role: "viewer" } as const;
		await expect(call(who.ed, "workspaces.changeRole", input)).rejects.toMatchObject({
			_tag: "ActionForbidden",
		});
		await expect(call(who.outsider, "workspaces.changeRole", input)).rejects.toMatchObject({
			_tag: "ResourceHidden",
		});

		await call(who.admin, "workspaces.changeRole", input);

		const members = await call(who.admin, "workspaces.memberships", { workspace });
		expect(members.find(({ id }) => id === membershipId)).toMatchObject({ role: "viewer" });
	});

	it("removes another member while protecting the owner’s membership", async () => {
		const workspace = a.workspace;
		const membershipId = await membershipIdOf(await seedMember(workspace, "editor"));
		await expect(
			call(who.admin, "workspaces.removeMembership", {
				workspace,
				membershipId: await membershipIdOf(a.owner),
			}),
		).rejects.toMatchObject({ _tag: "ActionForbidden" });
		await expect(
			call(who.outsider, "workspaces.removeMembership", {
				workspace,
				membershipId,
			}),
		).rejects.toMatchObject({ _tag: "ResourceHidden" });

		await call(who.admin, "workspaces.removeMembership", { workspace, membershipId });

		const members = await call(who.admin, "workspaces.memberships", { workspace });
		expect(members.map(({ id }) => id)).not.toContain(membershipId);
	});

	it("hides a membership the workspace doesn't have", async () => {
		expect(
			await operationOutcome(call, who.admin, "workspaces.changeRole", {
				workspace: a.workspace,
				membershipId: crypto.randomUUID(),
				role: "viewer",
			}),
		).toBe("ResourceHidden");
	});

	it("lists a new invitation with the role the admin assigned", async () => {
		const workspace = a.workspace;
		const email = `invited-${crypto.randomUUID()}@example.com`;
		await expect(
			call(who.admin, "workspaces.invite", { workspace, email, role: "admin" }),
		).rejects.toMatchObject({ _tag: "ActionForbidden" });
		await expect(
			call(who.outsider, "workspaces.invite", { workspace, email, role: "editor" }),
		).rejects.toMatchObject({ _tag: "ResourceHidden" });

		const invited = await call(who.admin, "workspaces.invite", {
			workspace,
			email,
			role: "editor",
		});

		expect(await call(who.admin, "workspaces.invitations", { workspace })).toContainEqual(
			expect.objectContaining({ id: invited.id, email, role: "editor" }),
		);
	});

	it("takes an admin invitation out of the pending list when the owner cancels it", async () => {
		const workspace = a.workspace;
		const invitationId = await seedInvitation(workspace, a.owner, {
			email: `invited-${crypto.randomUUID()}@example.com`,
			role: "admin",
		});
		await expect(
			call(who.admin, "workspaces.cancelInvitation", { invitationId }),
		).rejects.toMatchObject({ _tag: "ActionForbidden" });
		await expect(
			call(who.outsider, "workspaces.cancelInvitation", { invitationId }),
		).rejects.toMatchObject({ _tag: "ResourceHidden" });
		await expect(
			call(who.owner, "workspaces.cancelInvitation", { invitationId: crypto.randomUUID() }),
		).rejects.toMatchObject({ _tag: "ResourceHidden" });

		await call(who.owner, "workspaces.cancelInvitation", { invitationId });

		const pending = await call(who.owner, "workspaces.invitations", { workspace });
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

	it("sets a member's level in a project they reach, and clears it anywhere", async () => {
		const setting = (principal: Principal, level: "all" | null) =>
			operationOutcome(call, principal, "notifications.setLevel", {
				kind: "project",
				id: a.project,
				level,
			});

		expect(
			await outcomesFor(
				{
					inProject: who.vi,
					notInProject: who.erin,
					outsider: who.outsider,
					botInChatBounds: who.pubForEd,
					botInMemberBounds: who.edsAssistant,
					run: who.run,
				},
				(principal) => setting(principal, "all"),
			),
		).toEqual({
			inProject: "ok",
			notInProject: "ResourceHidden",
			outsider: "ResourceHidden",
			botInChatBounds: "ActionForbidden",
			botInMemberBounds: "ActionForbidden",
			run: "ActionForbidden",
		});
		expect(await setting(who.erin, null)).toBe("ok");
	});
});
