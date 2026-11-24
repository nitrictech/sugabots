import type { InputOf, OperationName } from "@sugabots/contracts/operations";
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
	principals,
	type World,
} from "../../proofs/world.test-support.ts";
import { type CallOperation, servedOperations } from "../testing.ts";

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
	let who: Awaited<ReturnType<typeof principalsOnJ>>;

	const principalsOnJ = async () => {
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
			/** Pub answering Ed in J's chat: chat bounds, J. */
			pubForEd: await as.botFor(a.ed, a.pub.id, a.chat),
			/** Pub answering an admin in J's chat: chat bounds, J. */
			pubForAdmin: await as.botFor(a.admin, a.pub.id, a.chat),
			/** Helper answering Ed in K's chat: chat bounds, K, though both reach J. */
			helperInK: await as.botFor(a.ed, a.helper.id, a.otherChat),
			/** Ed's Personal Assistant in its own chat: member bounds. */
			edsAssistant: await as.botFor(a.ed, a.assistant.id, a.assistantChat),
			/** An admin's Personal Assistant in its own chat: member bounds. */
			adminsAssistant: await as.botFor(a.admin, adminsAssistant.id, adminsAssistantChat),
			run: (await as.run(a.workspace, a.project, a.pub.id)).principal,
			webhook: await as.webhook(a.workspace, a.project),
			computerSleep: (await as.computerSleep(a.workspace, a.project)).principal,
			compaction: await as.compaction(a.chat, a.pub.id),
			page: await as.page(a.chat),
		};
	};

	beforeAll(async () => {
		world = await buildWorld();
		a = world.a;
		call = await servedOperations();
		as = principals(await authenticators());
		who = await principalsOnJ();
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
				tried(principal, "projects.list", { workspace: a.workspace });

			expect(
				await outcomes(
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
					list,
				),
			).toEqual({
				viewer: "ok",
				outsider: "ResourceHidden",
				botInChatBounds: "ActionForbidden",
				botInMemberBounds: "ok",
				run: "ActionForbidden",
				webhook: "ActionForbidden",
				systemWork: "ActionForbidden",
				page: "ActionForbidden",
			});
		});

		it("takes the workspace by its slug, and hides a slug no workspace has", async () => {
			const [found] = await onDatabase((db) =>
				db.select({ slug: workspace.slug }).from(workspace).where(eq(workspace.id, a.workspace)),
			);
			const listed = await call(who.ed, "projects.list", { workspace: found?.slug ?? "" });

			expect(listed.map(({ id }) => id)).toContain(a.project);
			expect(await tried(who.ed, "projects.list", { workspace: `nobody-${unique()}` })).toBe(
				"ResourceHidden",
			);
		});
	});

	describe("reading a project", () => {
		it("lists its members, bots and those reaching it to whoever reaches it, within a turn's bounds", async () => {
			const reads = ["projects.listMembers", "projects.listMembersReaching", "projects.listBots"];
			for (const name of reads) {
				const read = (principal: Principal) =>
					tried(principal, name as "projects.listMembers", { projectId: a.project });
				expect({
					name,
					outcomes: await outcomes(
						{
							admin: who.admin,
							viewer: who.vi,
							notInProject: who.erin,
							outsider: who.outsider,
							botInBounds: who.pubForEd,
							botOutsideBounds: who.helperInK,
							run: who.run,
							webhook: who.webhook,
							computerSleep: who.computerSleep,
							compaction: who.compaction,
							page: who.page,
						},
						read,
					),
				}).toEqual({
					name,
					outcomes: {
						admin: "ok",
						viewer: "ok",
						notInProject: "ResourceHidden",
						outsider: "ResourceHidden",
						botInBounds: "ok",
						botOutsideBounds: "ResourceHidden",
						run: "ok",
						webhook: "ok",
						computerSleep: "ok",
						compaction: "ResourceHidden",
						page: "ResourceHidden",
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

			expect(await tried(helper, "projects.listMembers", { projectId: project })).toBe(
				"BotCannotReach",
			);
		});
	});

	describe("projects.update", () => {
		it("changes a project's settings for its owner and admins, and a bot only in member bounds", async () => {
			const rename = (principal: Principal) =>
				tried(principal, "projects.update", {
					projectId: a.project,
					changes: { name: `J ${unique()}` },
				});

			expect(
				await outcomes(
					{
						owner: who.owner,
						admin: who.admin,
						editor: who.ed,
						viewer: who.vi,
						notInProject: who.erin,
						outsider: who.outsider,
						adminsBotInChatBounds: who.pubForAdmin,
						adminsAssistant: who.adminsAssistant,
						editorsAssistant: who.edsAssistant,
						run: who.run,
						webhook: who.webhook,
						computerSleep: who.computerSleep,
						compaction: who.compaction,
						page: who.page,
					},
					rename,
				),
			).toEqual({
				owner: "ok",
				admin: "ok",
				editor: "ActionForbidden",
				viewer: "ActionForbidden",
				notInProject: "ResourceHidden",
				outsider: "ResourceHidden",
				adminsBotInChatBounds: "ActionForbidden",
				adminsAssistant: "ok",
				editorsAssistant: "ActionForbidden",
				run: "ActionForbidden",
				webhook: "ActionForbidden",
				computerSleep: "ActionForbidden",
				compaction: "ResourceHidden",
				page: "ResourceHidden",
			});
		});

		it("refuses a bot's default project, which takes its settings from its bot, even to the bot's managers", async () => {
			expect(
				await tried(who.admin, "projects.update", {
					projectId: a.pub.defaultProject,
					changes: { name: "Ours" },
				}),
			).toBe("ActionForbidden");
		});

		it("hides a new lead the member can't reach", async () => {
			expect(
				await tried(who.admin, "projects.update", {
					projectId: a.project,
					changes: { leadBotId: a.personal.id },
				}),
			).toBe("ResourceHidden");
		});
	});

	describe("projects.remove", () => {
		it("deletes a project for its owner and admins, and a bot only in member bounds", async () => {
			const refused = await outcomes(
				{
					editor: who.ed,
					viewer: who.vi,
					notInProject: who.erin,
					adminsBotInChatBounds: who.pubForAdmin,
					run: who.run,
					webhook: who.webhook,
					computerSleep: who.computerSleep,
					compaction: who.compaction,
					page: who.page,
				},
				(principal) => tried(principal, "projects.remove", { projectId: a.project }),
			);
			const removed = await outcomes(
				{ owner: who.owner, admin: who.admin, adminsAssistant: who.adminsAssistant },
				async (principal) =>
					tried(principal, "projects.remove", { projectId: await projectLikeJ() }),
			);

			expect({ ...refused, ...removed }).toEqual({
				editor: "ActionForbidden",
				viewer: "ActionForbidden",
				notInProject: "ResourceHidden",
				adminsBotInChatBounds: "ActionForbidden",
				run: "ActionForbidden",
				webhook: "ActionForbidden",
				computerSleep: "ActionForbidden",
				compaction: "ResourceHidden",
				page: "ResourceHidden",
				owner: "ok",
				admin: "ok",
				adminsAssistant: "ok",
			});
		});
	});

	describe("a project's members", () => {
		it("lets its members but viewers add and remove members, and a bot only in member bounds", async () => {
			const refused = await outcomes(
				{
					viewer: who.vi,
					notInProject: who.erin,
					botInChatBounds: who.pubForEd,
					run: who.run,
					webhook: who.webhook,
					computerSleep: who.computerSleep,
					page: who.page,
				},
				(principal) =>
					tried(principal, "projects.addMember", { projectId: a.project, memberId: a.erin }),
			);
			const changed = await outcomes(
				{ editor: who.ed, admin: who.admin, editorsAssistant: who.edsAssistant },
				async (principal) => {
					const projectId = await projectLikeJ();
					const added = await tried(principal, "projects.addMember", {
						projectId,
						memberId: a.erin,
					});
					const removed = await tried(principal, "projects.removeMember", {
						projectId,
						memberId: a.erin,
					});
					return `${added}, ${removed}`;
				},
			);

			expect({ ...refused, ...changed }).toEqual({
				viewer: "ActionForbidden",
				notInProject: "ResourceHidden",
				botInChatBounds: "ActionForbidden",
				run: "ActionForbidden",
				webhook: "ActionForbidden",
				computerSleep: "ActionForbidden",
				page: "ResourceHidden",
				editor: "ok, ok",
				admin: "ok, ok",
				editorsAssistant: "ok, ok",
			});
		});

		it("refuses somebody outside the workspace, and takes no administrator out", async () => {
			const projectId = await projectLikeJ();
			const outsider = await seedMember(world.b.workspace, "editor");

			expect(await tried(who.ed, "projects.addMember", { projectId, memberId: outsider })).toBe(
				"NotInWorkspace",
			);
			expect(await tried(who.ed, "projects.removeMember", { projectId, memberId: a.admin })).toBe(
				"AdministratorInEveryProject",
			);
			expect(await tried(who.ed, "projects.removeMember", { projectId, memberId: a.erin })).toBe(
				"NotInProject",
			);
		});

		it("lets a member leave, or a bot take its asker out only in member bounds; administrators stay", async () => {
			const refused = await outcomes(
				{
					admin: who.admin,
					notInProject: who.erin,
					botInChatBounds: who.pubForEd,
					run: who.run,
					page: who.page,
				},
				(principal) => tried(principal, "projects.leave", { projectId: a.project }),
			);
			const left = await outcomes(
				{ editor: who.ed, viewer: who.vi, editorsAssistant: who.edsAssistant },
				async (principal) =>
					tried(principal, "projects.leave", { projectId: await projectLikeJ() }),
			);

			expect({ ...refused, ...left }).toEqual({
				admin: "ActionForbidden",
				notInProject: "ResourceHidden",
				botInChatBounds: "ActionForbidden",
				run: "ActionForbidden",
				page: "ResourceHidden",
				editor: "ok",
				viewer: "ok",
				editorsAssistant: "ok",
			});
		});
	});

	describe("projects.join", () => {
		it("puts a member, or a bot's asker in member bounds, in a public project, and hides the rest", async () => {
			const joined = await outcomes(
				{ editor: who.erin, editorsAssistant: who.edsAssistant },
				async (principal) => {
					const projectId = await seedProject(a.workspace, {
						leadBotId: a.pub.id,
						visibility: "public",
					});
					return tried(principal, "projects.join", { projectId });
				},
			);
			const publicProject = await projectLikeJ("public");
			const onJ = await outcomes(
				{
					notInPrivateProject: who.erin,
					botInChatBounds: who.pubForEd,
					run: who.run,
					webhook: who.webhook,
					page: who.page,
				},
				(principal) => tried(principal, "projects.join", { projectId: a.project }),
			);

			expect({
				...joined,
				...onJ,
				outsider: await tried(who.outsider, "projects.join", { projectId: publicProject }),
				botOutsideBounds: await tried(who.pubForEd, "projects.join", { projectId: publicProject }),
				defaultProject: await tried(who.ed, "projects.join", { projectId: a.pub.defaultProject }),
			}).toEqual({
				editor: "ok",
				editorsAssistant: "ok",
				notInPrivateProject: "ResourceHidden",
				botInChatBounds: "ActionForbidden",
				run: "ActionForbidden",
				webhook: "ActionForbidden",
				page: "ResourceHidden",
				outsider: "ResourceHidden",
				botOutsideBounds: "ResourceHidden",
				defaultProject: "ResourceHidden",
			});
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
				tried(principal, "projects.addBot", { projectId, botId });

			expect({
				viewer: await add(who.vi, extra.id),
				notInProject: await add(who.erin, extra.id),
				botInChatBounds: await add(who.pubForEd, extra.id),
				someoneElsesPersonalBot: await add(who.ed, erinsPersonal.id),
				ownPersonalBot: await add(who.ed, a.personal.id),
				added: await add(who.ed, extra.id),
				removed: await tried(who.ed, "projects.removeBot", { projectId, botId: extra.id }),
				lead: await tried(who.ed, "projects.removeBot", { projectId, botId: a.pub.id }),
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
		it("makes a project for a member who may, and a bot only in member bounds", async () => {
			const create = (principal: Principal) =>
				tried(principal, "projects.create", {
					workspace: a.workspace,
					name: `Project ${unique()}`,
					leadBotId: a.pub.id,
				});

			expect(
				await outcomes(
					{
						editor: who.ed,
						viewer: who.vi,
						outsider: who.outsider,
						botInChatBounds: who.pubForEd,
						editorsAssistant: who.edsAssistant,
						run: who.run,
						webhook: who.webhook,
						page: who.page,
					},
					create,
				),
			).toEqual({
				editor: "ok",
				viewer: "ActionForbidden",
				outsider: "ResourceHidden",
				botInChatBounds: "ActionForbidden",
				editorsAssistant: "ok",
				run: "ActionForbidden",
				webhook: "ActionForbidden",
				page: "ActionForbidden",
			});
		});

		it("hides a lead the member can't reach, and refuses one that isn't public", async () => {
			const erinsPersonal = await seedBot(a.workspace, {
				createdById: a.erin,
				visibility: "personal",
			});
			const ledBy = (leadBotId: string) =>
				tried(who.ed, "projects.create", {
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
