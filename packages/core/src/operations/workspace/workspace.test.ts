import type { InputOf, OperationName } from "@sugabots/contracts/operations";
import { and, eq } from "drizzle-orm";
import { Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Accounts } from "../../accounts/accounts.ts";
import {
	seedBot,
	seedInvitation,
	seedMember,
	seedProjectChat,
	seedWorkspace,
} from "../../authentication/seed.test-support.ts";
import { membership } from "../../database/schema.ts";
import { closeDatabase, onDatabase } from "../../database/testing.ts";
import type { Principal } from "../../principal.ts";
import {
	authenticators,
	buildWorld,
	principals,
	type World,
} from "../../proofs/world.test-support.ts";
import { type CallOperation, servedOperations } from "../testing.ts";

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
	let who: Awaited<ReturnType<typeof principalsInA>>;

	const principalsInA = async () => {
		const outsider = await seedMember(world.b.workspace, "editor");
		const adminsAssistant = await seedBot(a.workspace, {
			assistantOf: a.admin,
			visibility: "personal",
		});
		const adminsAssistantChat = await seedProjectChat(
			a.workspace,
			adminsAssistant.defaultProject,
			a.admin,
		);
		return {
			owner: await as.member(a.owner),
			admin: await as.member(a.admin),
			ed: await as.member(a.ed),
			vi: await as.member(a.vi),
			erin: await as.member(a.erin),
			outsider: await as.member(outsider),
			/** Pub answering Ed in J's chat: chat bounds. */
			pubForEd: await as.botFor(a.ed, a.pub.id, a.chat),
			/** Pub answering an admin in J's chat: chat bounds. */
			pubForAdmin: await as.botFor(a.admin, a.pub.id, a.chat),
			/** Ed's Personal Assistant in its own chat: member bounds. */
			edsAssistant: await as.botFor(a.ed, a.assistant.id, a.assistantChat),
			/** An admin's Personal Assistant in its own chat: member bounds. */
			adminsAssistant: await as.botFor(a.admin, adminsAssistant.id, adminsAssistantChat),
			run: (await as.run(a.workspace, a.project, a.pub.id)).principal,
			webhook: await as.webhook(a.workspace, a.project),
			computerSleep: (await as.computerSleep(a.workspace, a.project)).principal,
			page: await as.page(a.chat),
		};
	};

	beforeAll(async () => {
		world = await buildWorld();
		a = world.a;
		// Sign-up as the server's settings say, which is closed here, so nobody has a referral link.
		call = await servedOperations({ accounts: Layer.orDie(Accounts.layer) });
		as = principals(await authenticators());
		who = await principalsInA();
	});

	afterAll(async () => {
		await closeDatabase();
	});

	/** What calling `name` with `input` for `principal` came to: "ok", or its error's tag. */
	const tried = <Name extends OperationName>(
		principal: Principal,
		name: Name,
		input: InputOf<Name>,
	): Promise<string> =>
		call(principal, name, input).then(
			() => "ok",
			(failure: { readonly _tag: string }) => failure._tag,
		);

	/** What `attempt` came to for each principal of `principals`, by its name. */
	const outcomes = async <Key extends string>(
		principals: Record<Key, Principal>,
		attempt: (principal: Principal) => Promise<string>,
	) => {
		const entries = await Promise.all(
			Object.entries<Principal>(principals).map(async ([key, principal]) => [
				key,
				await attempt(principal),
			]),
		);
		return Object.fromEntries(entries) as Record<Key, string>;
	};

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
		const ownOnly: ReadonlyArray<(principal: Principal) => Promise<string>> = [
			(principal) => tried(principal, "workspaces.list", {}),
			(principal) => tried(principal, "referrals.link", {}),
			(principal) => tried(principal, "notifications.settings", {}),
		];
		for (const attempt of ownOnly) {
			expect(
				await outcomes(
					{
						member: who.vi,
						botInMemberBounds: who.edsAssistant,
						botInChatBounds: who.pubForEd,
						run: who.run,
						webhook: who.webhook,
						systemWork: who.computerSleep,
						page: who.page,
					},
					attempt,
				),
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
				outcomes: await outcomes(
					{
						viewer: who.vi,
						outsider: who.outsider,
						botInChatBounds: who.pubForEd,
						botInMemberBounds: who.edsAssistant,
						run: who.run,
						webhook: who.webhook,
						systemWork: who.computerSleep,
						page: who.page,
					},
					(principal) => tried(principal, name, { workspace: a.workspace }),
				),
			}).toEqual({
				name,
				outcomes: {
					viewer: "ok",
					outsider: "ResourceHidden",
					botInChatBounds: "ActionForbidden",
					botInMemberBounds: "ok",
					run: "ActionForbidden",
					webhook: "ActionForbidden",
					systemWork: "ActionForbidden",
					page: "ActionForbidden",
				},
			});
		}
	});

	it("shows what the workspace's models cost to whoever may manage it, and a bot only in member bounds", async () => {
		expect(
			await outcomes(
				{
					owner: who.owner,
					admin: who.admin,
					editor: who.ed,
					outsider: who.outsider,
					adminsBotInChatBounds: who.pubForAdmin,
					adminsBotInMemberBounds: who.adminsAssistant,
					run: who.run,
					page: who.page,
				},
				(principal) =>
					tried(principal, "usage.month", { workspace: a.workspace, month: "2026-09" }),
			),
		).toEqual({
			owner: "ok",
			admin: "ok",
			editor: "ActionForbidden",
			outsider: "ResourceHidden",
			adminsBotInChatBounds: "ActionForbidden",
			adminsBotInMemberBounds: "ok",
			run: "ActionForbidden",
			page: "ActionForbidden",
		});
	});

	it("changes a member's role for the owner and admins, and a bot only in member bounds", async () => {
		const changeAnEditor = async (principal: Principal) =>
			tried(principal, "workspaces.changeRole", {
				workspace: a.workspace,
				membershipId: await membershipIdOf(await seedMember(a.workspace, "editor")),
				role: "viewer",
			});

		expect(
			await outcomes(
				{
					owner: who.owner,
					admin: who.admin,
					editor: who.ed,
					outsider: who.outsider,
					adminsBotInChatBounds: who.pubForAdmin,
					adminsBotInMemberBounds: who.adminsAssistant,
					run: who.run,
					webhook: who.webhook,
					page: who.page,
				},
				changeAnEditor,
			),
		).toEqual({
			owner: "ok",
			admin: "ok",
			editor: "ActionForbidden",
			outsider: "ResourceHidden",
			adminsBotInChatBounds: "ActionForbidden",
			adminsBotInMemberBounds: "ok",
			run: "ActionForbidden",
			webhook: "ActionForbidden",
			page: "ActionForbidden",
		});
	});

	it("leaves admins to the owner, and the owner's own membership to nobody", async () => {
		const otherAdmin = await membershipIdOf(a.otherAdmin);
		const owner = await membershipIdOf(a.owner);
		const changing = (principal: Principal, membershipId: string) =>
			tried(principal, "workspaces.changeRole", {
				workspace: a.workspace,
				membershipId,
				role: "admin",
			});

		expect(await changing(who.admin, otherAdmin)).toBe("ActionForbidden");
		expect(await changing(who.owner, otherAdmin)).toBe("ok");
		expect(await changing(who.owner, owner)).toBe("ActionForbidden");
		expect(
			await tried(who.admin, "workspaces.removeMembership", {
				workspace: a.workspace,
				membershipId: owner,
			}),
		).toBe("ActionForbidden");
	});

	it("hides a membership the workspace doesn't have", async () => {
		expect(
			await tried(who.admin, "workspaces.changeRole", {
				workspace: a.workspace,
				membershipId: crypto.randomUUID(),
				role: "viewer",
			}),
		).toBe("ResourceHidden");
	});

	it("invites with the roles the inviter may give, and leaves cancelling an admin's invitation to the owner", async () => {
		const address = () => `invited-${crypto.randomUUID().slice(0, 8)}@example.com`;
		const inviting = (principal: Principal, role: "admin" | "editor") =>
			tried(principal, "workspaces.invite", { workspace: a.workspace, email: address(), role });

		expect(await inviting(who.admin, "editor")).toBe("ok");
		expect(await inviting(who.admin, "admin")).toBe("ActionForbidden");
		expect(await inviting(who.owner, "admin")).toBe("ok");
		expect(await inviting(who.ed, "editor")).toBe("ActionForbidden");
		expect(await inviting(who.pubForAdmin, "editor")).toBe("ActionForbidden");

		const adminInvitation = await seedInvitation(a.workspace, a.owner, {
			email: address(),
			role: "admin",
		});
		const cancelling = (principal: Principal) =>
			tried(principal, "workspaces.cancelInvitation", { invitationId: adminInvitation });
		expect(await cancelling(who.outsider)).toBe("ResourceHidden");
		expect(await cancelling(who.admin)).toBe("ActionForbidden");
		expect(await cancelling(who.owner)).toBe("ok");
		expect(await cancelling(who.owner)).toBe("ResourceHidden");
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

		expect(await tried(who.ed, "workspaces.invitation", { invitationId: toInvitee })).toBe(
			"ResourceHidden",
		);
		expect(
			await tried(who.edsAssistant, "workspaces.invitation", { invitationId: toInvitee }),
		).toBe("ActionForbidden");
		// This server, like any not set to, doesn't require members to verify their email;
		// the provers' tests and `workspaces/membership/`'s cover one that does.
		expect(
			await tried(unprovedPrincipal, "workspaces.acceptInvitation", { invitationId: toUnproved }),
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
		const leaving = (principal: Principal) => tried(principal, "workspaces.leave", { workspace });

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
			tried(principal, "workspaces.handOverOwnership", {
				workspace,
				membershipId: adminsMembership?.id ?? "",
			});
		const deleting = (principal: Principal) => tried(principal, "workspaces.delete", { workspace });

		expect(await handingOver(await as.member(admin))).toBe("ActionForbidden");
		expect(await deleting(await as.member(admin))).toBe("ActionForbidden");
		expect(await deleting(who.outsider)).toBe("ResourceHidden");
		expect(await handingOver(await as.member(owner))).toBe("ok");
		expect(await deleting(await as.member(owner))).toBe("ActionForbidden");
		expect(await deleting(await as.member(admin))).toBe("ok");
	});

	it("sets a member's level in a project they reach, and clears it anywhere", async () => {
		const setting = (principal: Principal, level: "all" | null) =>
			tried(principal, "notifications.setLevel", { kind: "project", id: a.project, level });

		expect(
			await outcomes(
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
