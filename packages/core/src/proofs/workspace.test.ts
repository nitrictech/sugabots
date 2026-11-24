import { asc, eq } from "drizzle-orm";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedInvitation, seedMember, seedWorkspace } from "../authentication/seed.test-support.ts";
import { query, transaction } from "../database/database.ts";
import { member, placedChat, project } from "../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../database/testing.ts";
import type { Principal } from "../principal.ts";
import { proveHoldsInvitation } from "./holds-invitation.ts";
import { proveInWorkspace } from "./in-workspace.ts";
import {
	type MembershipChange,
	proveCanChangeMembership,
	proveCanInvite,
} from "./membership-changes.ts";
import { named } from "./proof.ts";
import { proveReachSet } from "./reach-set.ts";
import {
	proveCanCreateBots,
	proveCanCreateProjects,
	proveCanManageWorkspace,
} from "./workspace-permissions.ts";
import {
	type Authenticators,
	authenticators,
	buildWorld,
	outcome,
	principals,
	type World,
} from "./world.test-support.ts";

describe("the workspace and who is in it", () => {
	let world: World;
	let auth: Authenticators;
	let as: ReturnType<typeof principals>;

	beforeAll(async () => {
		world = await buildWorld();
		auth = await authenticators();
		as = principals(auth);
	});

	afterAll(async () => {
		await closeDatabase();
	});

	const inWorkspace = (principal: Principal, workspaceId: string) =>
		outcome(named(principal, workspaceId, (p, w) => proveInWorkspace(p, w).pipe(Effect.asVoid)));

	describe("InWorkspace", () => {
		it("holds for a member by their membership, and hides a workspace they aren't in", async () => {
			const { a, b } = world;
			expect(await inWorkspace(await as.member(a.vi), a.workspace)).toBe("ok");
			expect(await inWorkspace(await as.member(a.erin), b.workspace)).toBe("ResourceHidden");
			expect(await inWorkspace(await as.member(a.ed), b.workspace)).toBe("ok");
			expect(await inWorkspace(await as.member(a.ed), "not-an-id")).toBe("ResourceHidden");
		});

		it("holds for any other principal only in the workspace it comes from", async () => {
			const { a, b } = world;
			const edsBot = await as.botFor(a.ed, a.pub.id, a.chat);
			const { principal: run } = await as.run(a.workspace, a.project, a.pub.id);
			const webhook = await as.webhook(a.workspace, a.project);
			const page = await as.page(a.chat);
			for (const principal of [edsBot, run, webhook, page]) {
				expect(await inWorkspace(principal, a.workspace)).toBe("ok");
				// Ed is an admin of B, but his bot's turn is in A.
				expect(await inWorkspace(principal, b.workspace)).toBe("ResourceHidden");
			}
		});
	});

	describe("workspace permissions", () => {
		const permissions = (principal: Principal) =>
			runOnPostgres(
				named(principal, world.a.workspace, (p, w) =>
					Effect.gen(function* () {
						const found = yield* proveInWorkspace(p, w);
						const result = (proved: Effect.Effect<unknown, { readonly _tag: string }>) =>
							proved.pipe(
								Effect.as("ok"),
								Effect.catch((failure) => Effect.succeed(failure._tag)),
							);
						return {
							manage: yield* result(proveCanManageWorkspace(found)),
							createBots: yield* result(proveCanCreateBots(found)),
							createProjects: yield* result(proveCanCreateProjects(found)),
						};
					}),
				),
			);

		it("follows a member's role, and an asker's only in member bounds", async () => {
			const { a } = world;
			const forbidden = "ActionForbidden";
			expect(await permissions(await as.member(a.admin))).toEqual({
				manage: "ok",
				createBots: "ok",
				createProjects: "ok",
			});
			expect(await permissions(await as.member(a.ed))).toEqual({
				manage: forbidden,
				createBots: "ok",
				createProjects: "ok",
			});
			expect(await permissions(await as.member(a.vi))).toEqual({
				manage: forbidden,
				createBots: forbidden,
				createProjects: forbidden,
			});
			expect(await permissions(await as.botFor(a.owner, a.pub.id, a.chat))).toEqual({
				manage: forbidden,
				createBots: forbidden,
				createProjects: forbidden,
			});
			expect(await permissions(await as.botFor(a.ed, a.assistant.id, a.assistantChat))).toEqual({
				manage: forbidden,
				createBots: "ok",
				createProjects: "ok",
			});
			const { principal: run } = await as.run(a.workspace, a.project, a.pub.id);
			expect(await permissions(run)).toEqual({
				manage: forbidden,
				createBots: forbidden,
				createProjects: forbidden,
			});
		});
	});

	describe("CanChangeMembership and CanInvite", () => {
		/** A fresh workspace, so changes here leave the world as it was. */
		const staffed = async () => {
			const workspaceId = await seedWorkspace();
			return {
				workspaceId,
				owner: await seedMember(workspaceId, "owner"),
				admin: await seedMember(workspaceId, "admin"),
				otherAdmin: await seedMember(workspaceId, "admin"),
				editor: await seedMember(workspaceId, "editor"),
				viewer: await seedMember(workspaceId, "viewer"),
			};
		};

		const changes = (
			principal: Principal,
			workspaceId: string,
			memberId: string,
			change: MembershipChange,
		) =>
			outcome(
				transaction(
					named(principal, workspaceId, memberId, (p, w, u) =>
						proveCanChangeMembership(p, w, u, change).pipe(Effect.asVoid),
					),
				),
			);
		const invites = (
			principal: Principal,
			workspaceId: string,
			role: "admin" | "editor" | "viewer",
		) =>
			outcome(
				transaction(
					named(principal, workspaceId, (p, w) => proveCanInvite(p, w, role).pipe(Effect.asVoid)),
				),
			);

		it("lets admins manage members but not admins, and only the owner make or remove admins", async () => {
			const staff = await staffed();
			const toViewer: MembershipChange = { kind: "role", role: "viewer" };
			const toAdmin: MembershipChange = { kind: "role", role: "admin" };
			const removal: MembershipChange = { kind: "removal" };
			const owner = await as.member(staff.owner);
			const admin = await as.member(staff.admin);
			const editor = await as.member(staff.editor);
			const { workspaceId } = staff;

			expect(await changes(admin, workspaceId, staff.editor, toViewer)).toBe("ok");
			expect(await changes(admin, workspaceId, staff.viewer, removal)).toBe("ok");
			expect(await changes(admin, workspaceId, staff.editor, toAdmin)).toBe("ActionForbidden");
			expect(await changes(admin, workspaceId, staff.otherAdmin, toViewer)).toBe("ActionForbidden");
			expect(await changes(owner, workspaceId, staff.editor, toAdmin)).toBe("ok");
			expect(await changes(owner, workspaceId, staff.otherAdmin, removal)).toBe("ok");
			expect(await changes(editor, workspaceId, staff.viewer, toViewer)).toBe("ActionForbidden");
		});

		it("lets nobody change or remove the owner's membership, the owner included", async () => {
			const staff = await staffed();
			for (const memberId of [staff.owner, staff.admin]) {
				expect(
					await changes(await as.member(memberId), staff.workspaceId, staff.owner, {
						kind: "role",
						role: "editor",
					}),
				).toBe("ActionForbidden");
			}
		});

		it("hides a membership that isn't there, and a workspace the principal isn't in", async () => {
			const staff = await staffed();
			const { a } = world;
			const removal: MembershipChange = { kind: "removal" };
			expect(await changes(await as.member(staff.admin), staff.workspaceId, a.ed, removal)).toBe(
				"ResourceHidden",
			);
			expect(
				await changes(await as.member(a.admin), staff.workspaceId, staff.editor, removal),
			).toBe("ResourceHidden");
		});

		it("lets a bot change memberships only in member bounds, for an asker who may", async () => {
			const { a } = world;
			const removal: MembershipChange = { kind: "removal" };
			expect(
				await changes(await as.botFor(a.admin, a.pub.id, a.chat), a.workspace, a.vi, removal),
			).toBe("ActionForbidden");
			const { principal: run } = await as.run(a.workspace, a.project, a.pub.id);
			expect(await changes(run, a.workspace, a.vi, removal)).toBe("ActionForbidden");
		});

		it("lets an invitation's role be only one the inviter may give", async () => {
			const staff = await staffed();
			const admin = await as.member(staff.admin);
			expect(await invites(admin, staff.workspaceId, "editor")).toBe("ok");
			expect(await invites(admin, staff.workspaceId, "admin")).toBe("ActionForbidden");
			expect(await invites(await as.member(staff.owner), staff.workspaceId, "admin")).toBe("ok");
			expect(await invites(await as.member(staff.editor), staff.workspaceId, "viewer")).toBe(
				"ActionForbidden",
			);
			expect(await invites(await as.member(world.a.erin), staff.workspaceId, "viewer")).toBe(
				"ResourceHidden",
			);
		});

		it("carries the member's current role and the change, for the write to take", async () => {
			const staff = await staffed();
			const carried = await runOnPostgres(
				transaction(
					named(await as.member(staff.owner), staff.workspaceId, staff.editor, (p, w, u) =>
						proveCanChangeMembership(p, w, u, { kind: "role", role: "admin" }).pipe(
							Effect.map((proof) => ({ currentRole: proof.currentRole, change: proof.change })),
						),
					),
				),
			);
			expect(carried).toEqual({ currentRole: "editor", change: { kind: "role", role: "admin" } });
		});
	});

	describe("HoldsInvitation", () => {
		/** The account rules of a server that requires members to verify their email, and of one that doesn't. */
		const verifying = { requireEmailVerification: true };
		const notVerifying = { requireEmailVerification: false };

		/** Whether `principal` holds the invitation, under `accounts`' rules. */
		const holds = (principal: Principal, invitationId: string, accounts = notVerifying) =>
			outcome(
				transaction(
					named(principal, invitationId, (p, i) =>
						proveHoldsInvitation(p, i, accounts).pipe(Effect.asVoid),
					),
				),
			);

		it("holds for the account whose verified email it is addressed to, whatever the case", async () => {
			const { a, b } = world;
			const newcomer = await seedMember(b.workspace, "editor", {
				email: `New.Comer.${Date.now()}@Example.com`,
			});
			const [{ email } = { email: "" }] = await onDatabase((db) =>
				db.select({ email: member.email }).from(member).where(eq(member.id, newcomer)),
			);
			const invitationId = await seedInvitation(a.workspace, a.admin, { email });

			for (const accounts of [notVerifying, verifying]) {
				expect(await holds(await as.member(newcomer), invitationId, accounts)).toBe("ok");
				expect(await holds(await as.member(a.ed), invitationId, accounts)).toBe("ResourceHidden");
				expect(await holds(await as.botFor(a.ed, a.pub.id, a.chat), invitationId, accounts)).toBe(
					"ResourceHidden",
				);
			}
		});

		it("hides an invitation that expired or was cancelled", async () => {
			const { a, b } = world;
			const verifiedEmail = `verified-${Date.now()}@example.com`;
			const verified = await seedMember(b.workspace, "editor", { email: verifiedEmail });

			for (const fields of [{ expiresInSeconds: -60 }, { status: "canceled" as const }]) {
				const invitationId = await seedInvitation(a.workspace, a.admin, {
					email: verifiedEmail,
					...fields,
				});
				expect(await holds(await as.member(verified), invitationId)).toBe("ResourceHidden");
			}
		});

		it("needs the email verified only where the server requires members to verify theirs", async () => {
			const { a, b } = world;
			const email = `unverified-${Date.now()}@example.com`;
			const unverified = await as.member(
				await seedMember(b.workspace, "editor", { email, emailVerified: false }),
			);
			const invitationId = await seedInvitation(a.workspace, a.admin, { email });

			expect(await holds(unverified, invitationId, verifying)).toBe("ResourceHidden");
			expect(await holds(unverified, invitationId, notVerifying)).toBe("ok");
		});
	});

	describe("ReachSet", () => {
		/** The projects `principal`'s reach set holds in workspace A, by id. */
		const projectsReached = (principal: Principal, workspaceId = world.a.workspace) =>
			runOnPostgres(
				named(principal, workspaceId, (p, w) =>
					Effect.gen(function* () {
						const reach = proveReachSet(yield* proveInWorkspace(p, w));
						const rows = yield* query((db) =>
							db
								.select({ id: project.id })
								.from(project)
								.where(reach.reachesProject(project.id))
								.orderBy(asc(project.id)),
						);
						return rows.map((row) => row.id).sort();
					}),
				),
			);
		const chatsReached = (principal: Principal) =>
			runOnPostgres(
				named(principal, world.a.workspace, (p, w) =>
					Effect.gen(function* () {
						const reach = proveReachSet(yield* proveInWorkspace(p, w));
						const rows = yield* query((db) =>
							db
								.select({ id: placedChat.id })
								.from(placedChat)
								.where(reach.reachesChat(placedChat)),
						);
						return rows.map((row) => row.id);
					}),
				),
			);

		it("holds what a member reaches in the workspace, and nothing of another", async () => {
			const { a, b } = world;
			const reached = await projectsReached(await as.member(a.ed));
			for (const projectId of [
				a.project,
				a.otherProject,
				a.pub.defaultProject,
				a.personal.defaultProject,
				a.assistant.defaultProject,
			]) {
				expect(reached).toContain(projectId);
			}
			expect(reached).not.toContain(b.project);
			expect(await projectsReached(await as.member(a.ed), b.workspace)).toEqual(
				[b.project, b.bot.defaultProject].sort(),
			);
		});

		it("keeps a bot to its bounds, and a run, a webhook call and system work to what they name", async () => {
			const { a } = world;
			expect(await projectsReached(await as.botFor(a.ed, a.pub.id, a.chat))).toEqual([a.project]);
			const assistantReach = await projectsReached(
				await as.botFor(a.ed, a.assistant.id, a.assistantChat),
			);
			expect(assistantReach).toEqual(await projectsReached(await as.member(a.ed)));
			const { principal: run } = await as.run(a.workspace, a.project, a.pub.id);
			expect(await projectsReached(run)).toEqual([a.project]);
			expect(await projectsReached(await as.webhook(a.workspace, a.project))).toEqual([a.project]);
			const compaction = await as.compaction(a.chat, a.pub.id);
			expect(await projectsReached(compaction)).toEqual([]);
			expect(await chatsReached(compaction)).toEqual([a.chat]);
			expect(await chatsReached(await as.page(a.chat))).toEqual([]);
		});

		it("keeps a bot's chats to its bounds, though its asker reaches more", async () => {
			const { a } = world;
			const chats = await chatsReached(await as.botFor(a.ed, a.pub.id, a.chat));
			expect(chats).toContain(a.chat);
			expect(chats).not.toContain(a.otherChat);
			expect(chats).not.toContain(a.pubChat);
		});
	});
});
