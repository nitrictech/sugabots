import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	seedBot,
	seedMember,
	seedProject,
	seedProjectChat,
	unique,
} from "../../authentication/seed.test-support.ts";
import { projectBot, workspace } from "../../database/schema.ts";
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
 * The projects operations, each called for every kind of principal through
 * the registry, as an entrypoint calls them. What each comes to is "ok" or the
 * tag of its refusal: hidden where the principal doesn't reach the project or
 * bot, forbidden where it does but may not act. Who may do what in detail is
 * the provers' tests'; the project's own rules are `workspaces/projects/`'.
 *
 * The world is `buildWorld`'s: in workspace A, Ed (an editor) made the public
 * bot Pub, which leads the private project J with Helper in it; Ed, Vi (a
 * viewer) and Quinn are in J, and Erin (an editor) isn't.
 */
describe("the projects operations, for each kind of principal", () => {
	let world: World;
	let call: CallOperation;
	let as: ReturnType<typeof principals>;
	let a: World["a"];
	/** Every principal the cases call for, on J unless its name says otherwise. */
	let who: Awaited<ReturnType<typeof everyKindOfPrincipal>>;

	beforeAll(async () => {
		world = await buildWorld();
		a = world.a;
		call = await servedOperations();
		as = principals(await authenticators());
		who = await everyKindOfPrincipal(world, as);
	});

	afterAll(async () => {
		await closeDatabase();
	});

	/** A new private project like J: led by Pub, with Helper, and Ed, Vi and Quinn in it. */
	const projectLikeJ = (visibility: "public" | "private" = "private") =>
		seedProject(a.workspace, {
			leadBotId: a.pub.id,
			bots: [a.helper.id],
			members: [a.ed, a.vi, a.quinn],
			visibility,
		});

	describe("projects.list", () => {
		it("lists a workspace's projects to its members, and to a bot only in member bounds", async () => {
			const list = (principal: Principal) =>
				operationOutcome(call, principal, "projects.list", { workspace: a.workspace });

			expect(
				await outcomesFor(
					{
						viewer: who.vi,
						outsider: who.outsider,
						botInChatBounds: who.pubForEd,
					},
					list,
				),
			).toEqual({
				viewer: "ok",
				outsider: "ResourceHidden",
				botInChatBounds: "ActionForbidden",
			});
		});

		it("takes the workspace by its slug, and hides a slug no workspace has", async () => {
			const [found] = await onDatabase((db) =>
				db.select({ slug: workspace.slug }).from(workspace).where(eq(workspace.id, a.workspace)),
			);
			const listed = await call(who.ed, "projects.list", { workspace: found?.slug ?? "" });

			expect(listed.map(({ id }) => id)).toContain(a.project);
			expect(
				await operationOutcome(call, who.ed, "projects.list", { workspace: `nobody-${unique()}` }),
			).toBe("ResourceHidden");
		});
	});

	describe("reading a project", () => {
		it("lists its members, bots and those reaching it to whoever reaches it, within a turn's bounds", async () => {
			const reads = [
				"projects.listMembers",
				"projects.listMembersReaching",
				"projects.listBots",
			] as const;
			for (const name of reads) {
				const read = (principal: Principal) =>
					operationOutcome(call, principal, name, {
						projectId: a.project,
					});
				expect({
					name,
					outcomes: await outcomesFor(
						{
							viewer: who.vi,
							notInProject: who.erin,
							botOutsideBounds: who.helperInK,
						},
						read,
					),
				}).toEqual({
					name,
					outcomes: {
						viewer: "ok",
						notInProject: "ResourceHidden",
						botOutsideBounds: "ResourceHidden",
					},
				});
			}
		});

		it("shows a principal acting for no member each bot with nothing it may do", async () => {
			const bots = await call(who.run, "projects.listBots", { projectId: a.project });

			expect(bots.map(({ id }) => id).toSorted()).toEqual([a.pub.id, a.helper.id].toSorted());
			for (const shown of bots) {
				expect(shown.pinned).toBe(false);
				expect(shown.permissions.update).toBe(false);
			}
		});

		it("tells a bot its asker reaches what it can't once it is taken out of the project", async () => {
			const project = await projectLikeJ();
			const chat = await seedProjectChat(a.workspace, project, a.ed);
			const helper = await as.botFor(a.ed, a.helper.id, chat);
			await onDatabase((db) =>
				db
					.delete(projectBot)
					.where(and(eq(projectBot.projectId, project), eq(projectBot.botId, a.helper.id))),
			);

			expect(
				await operationOutcome(call, helper, "projects.listMembers", { projectId: project }),
			).toBe("BotCannotReach");
		});
	});

	describe("projects.update", () => {
		it("shows a project's settings changed by its admin", async () => {
			const projectId = a.project;
			const name = `J ${unique()}`;
			const input = { projectId, changes: { name } };
			expect(await operationOutcome(call, who.pubForAdmin, "projects.update", input)).toBe(
				"ActionForbidden",
			);
			expect(await operationOutcome(call, who.erin, "projects.update", input)).toBe(
				"ResourceHidden",
			);

			await call(who.admin, "projects.update", input);

			expect(await call(who.admin, "projects.list", { workspace: a.workspace })).toContainEqual(
				expect.objectContaining({ id: projectId, name }),
			);
		});

		it("refuses a bot's default project, which takes its settings from its bot, even to the bot's managers", async () => {
			expect(
				await operationOutcome(call, who.admin, "projects.update", {
					projectId: a.pub.defaultProject,
					changes: { name: "Ours" },
				}),
			).toBe("ActionForbidden");
		});

		it("hides a new lead the member can't reach", async () => {
			expect(
				await operationOutcome(call, who.admin, "projects.update", {
					projectId: a.project,
					changes: { leadBotId: a.personal.id },
				}),
			).toBe("ResourceHidden");
		});
	});

	describe("projects.remove", () => {
		it("removes an admin's project from the workspace list", async () => {
			const projectId = await projectLikeJ();
			const input = { projectId };
			expect(await operationOutcome(call, who.ed, "projects.remove", input)).toBe(
				"ActionForbidden",
			);
			expect(await operationOutcome(call, who.erin, "projects.remove", input)).toBe(
				"ResourceHidden",
			);

			await call(who.admin, "projects.remove", input);

			const projects = await call(who.admin, "projects.list", { workspace: a.workspace });
			expect(projects.map(({ id }) => id)).not.toContain(projectId);
		});
	});

	describe("a project's members", () => {
		it("lists a member when an editor adds them and omits them after removal", async () => {
			const projectId = await projectLikeJ();
			const target = { projectId, memberId: a.erin };
			const listed = async () =>
				(await call(who.ed, "projects.listMembers", { projectId })).map(({ memberId }) => memberId);

			for (const name of ["projects.addMember", "projects.removeMember"] as const) {
				expect(await operationOutcome(call, who.vi, name, target), name).toBe("ActionForbidden");
				expect(await operationOutcome(call, who.erin, name, target), name).toBe("ResourceHidden");
			}
			await call(who.ed, "projects.addMember", target);
			expect(await listed()).toContain(a.erin);
			await call(who.ed, "projects.removeMember", target);
			expect(await listed()).not.toContain(a.erin);
		});
		it("refuses somebody outside the workspace, and takes no administrator out", async () => {
			const projectId = await projectLikeJ();
			const outsider = await seedMember(world.b.workspace, "editor");

			expect(
				await operationOutcome(call, who.ed, "projects.addMember", {
					projectId,
					memberId: outsider,
				}),
			).toBe("NotInWorkspace");
			expect(
				await operationOutcome(call, who.ed, "projects.removeMember", {
					projectId,
					memberId: a.admin,
				}),
			).toBe("AdministratorInEveryProject");
			expect(
				await operationOutcome(call, who.ed, "projects.removeMember", {
					projectId,
					memberId: a.erin,
				}),
			).toBe("NotInProject");
		});

		it("removes a viewer who leaves, while an administrator stays", async () => {
			const projectId = await projectLikeJ();
			const target = { projectId };
			expect(await operationOutcome(call, who.admin, "projects.leave", target)).toBe(
				"ActionForbidden",
			);
			expect(await operationOutcome(call, who.erin, "projects.leave", target)).toBe(
				"ResourceHidden",
			);

			await call(who.vi, "projects.leave", target);

			const members = await call(who.admin, "projects.listMembers", target);
			expect(members.map(({ memberId }) => memberId)).not.toContain(a.vi);
		});
	});

	describe("projects.join", () => {
		it("lists a member after they join a public project and gates a bot's join on approval", async () => {
			const projectId = await projectLikeJ("public");
			const target = { projectId };
			expect(
				await operationOutcome(call, who.pubForEd, "projects.join", { projectId: a.project }),
			).toBe("ActionForbidden");
			expect(await operationOutcome(call, who.outsider, "projects.join", target)).toBe(
				"ResourceHidden",
			);
			expect(await operationOutcome(call, who.edsAssistant, "projects.join", target)).toBe(
				"ApprovalNeeded",
			);

			await call(who.erin, "projects.join", target);

			const members = await call(who.admin, "projects.listMembers", target);
			expect(members.map(({ memberId }) => memberId)).toContain(a.erin);
		});
	});

	describe("a project's bots", () => {
		it("lets its members but viewers add and remove public bots they reach", async () => {
			const extra = await seedBot(a.workspace, { createdById: a.erin });
			const erinsPersonal = await seedBot(a.workspace, {
				createdById: a.erin,
				visibility: "personal",
			});
			const projectId = await projectLikeJ();
			const add = (principal: Principal, botId: string) =>
				operationOutcome(call, principal, "projects.addBot", { projectId, botId });

			expect({
				viewer: await add(who.vi, extra.id),
				notInProject: await add(who.erin, extra.id),
				botInChatBounds: await add(who.pubForEd, extra.id),
				someoneElsesPersonalBot: await add(who.ed, erinsPersonal.id),
				ownPersonalBot: await add(who.ed, a.personal.id),
				added: await add(who.ed, extra.id),
				removed: await operationOutcome(call, who.ed, "projects.removeBot", {
					projectId,
					botId: extra.id,
				}),
				lead: await operationOutcome(call, who.ed, "projects.removeBot", {
					projectId,
					botId: a.pub.id,
				}),
			}).toEqual({
				viewer: "ActionForbidden",
				notInProject: "ResourceHidden",
				botInChatBounds: "ResourceHidden",
				someoneElsesPersonalBot: "ResourceHidden",
				ownPersonalBot: "BotNotPublic",
				added: "ok",
				removed: "ok",
				lead: "LeadsProjects",
			});
		});
	});

	describe("projects.create", () => {
		it("lists an editor's new project and gates a bot's creation on approval", async () => {
			const workspace = a.workspace;
			const name = `Project ${unique()}`;
			const input = { workspace, name, leadBotId: a.pub.id };
			expect(await operationOutcome(call, who.vi, "projects.create", input)).toBe(
				"ActionForbidden",
			);
			expect(await operationOutcome(call, who.outsider, "projects.create", input)).toBe(
				"ResourceHidden",
			);
			expect(await operationOutcome(call, who.edsAssistant, "projects.create", input)).toBe(
				"ApprovalNeeded",
			);

			const created = await call(who.ed, "projects.create", input);

			expect(await call(who.ed, "projects.list", { workspace })).toContainEqual(
				expect.objectContaining({ id: created.id, name, leadBotId: a.pub.id }),
			);
		});
		it("hides a lead the member can't reach, and refuses one that isn't public", async () => {
			const erinsPersonal = await seedBot(a.workspace, {
				createdById: a.erin,
				visibility: "personal",
			});
			const ledBy = (leadBotId: string) =>
				operationOutcome(call, who.ed, "projects.create", {
					workspace: a.workspace,
					name: `Project ${unique()}`,
					leadBotId,
				});

			expect({
				someoneElsesPersonalBot: await ledBy(erinsPersonal.id),
				ownPersonalBot: await ledBy(a.personal.id),
			}).toEqual({
				someoneElsesPersonalBot: "ResourceHidden",
				ownPersonalBot: "BotNotPublic",
			});
		});
	});
});
