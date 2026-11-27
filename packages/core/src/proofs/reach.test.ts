import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	seedAutomation,
	seedBot,
	seedConnector,
	seedProject,
	seedProjectChat,
} from "../authentication/seed.test-support.ts";
import { bot, projectBot, projectMember } from "../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../database/testing.ts";
import type { Principal } from "../principal.ts";
import { workspaceOfProject } from "../workspaces/workspace-reference.ts";
import { proveCanJoinProject } from "./can-join-project.ts";
import { proveCanManageChats } from "./chat-permissions.ts";
import {
	proveCanChangeAllowedHosts,
	proveCanChangeChat,
	proveCanChangeProjectMembers,
	proveCanChangeProjectSettings,
	proveCanDeleteProject,
	proveCanLeaveProject,
	proveCanManageProject,
	proveCanReadConnectors,
	proveCanReadProjectRuns,
	proveCanRunAutomations,
	proveCanTakePart,
} from "./project-permissions.ts";
import { named } from "./proof.ts";
import { proveReachesAutomation } from "./reaches-automation.ts";
import { proveReachesBot } from "./reaches-bot.ts";
import { proveReachesChat } from "./reaches-chat.ts";
import { proveReachesConnector } from "./reaches-connector.ts";
import { proveReachesProject } from "./reaches-project.ts";
import { underWorkspaceLock } from "./workspace-lock.ts";
import {
	type Authenticators,
	authenticators,
	buildWorld,
	everyKindOfPrincipal,
	outcome,
	outcomesFor,
	principals,
	type World,
} from "./world.test-support.ts";

describe("reach and what it permits", () => {
	let world: World;
	let auth: Authenticators;
	let as: ReturnType<typeof principals>;
	let who: Awaited<ReturnType<typeof everyKindOfPrincipal>>;

	beforeAll(async () => {
		world = await buildWorld();
		auth = await authenticators();
		as = principals(auth);
		who = await everyKindOfPrincipal(world, as);
	});

	afterAll(async () => {
		await closeDatabase();
	});

	const reachesProject = (principal: Principal, projectId: string) =>
		outcome(named(principal, projectId, (p, j) => proveReachesProject(p, j).pipe(Effect.asVoid)));
	const reachesChat = (principal: Principal, chatId: string) =>
		outcome(named(principal, chatId, (p, c) => proveReachesChat(p, c).pipe(Effect.asVoid)));
	const reachesBot = (principal: Principal, botId: string) =>
		outcome(named(principal, botId, (p, b) => proveReachesBot(p, b).pipe(Effect.asVoid)));
	const managesProject = (principal: Principal, projectId: string) =>
		outcome(
			named(principal, projectId, (p, j) =>
				proveReachesProject(p, j).pipe(Effect.flatMap(proveCanManageProject), Effect.asVoid),
			),
		);
	/** Proved under the project's workspace's lock, as changing a project's members is. */
	const changesMembers = (principal: Principal, projectId: string) =>
		outcome(
			Effect.flatMap(workspaceOfProject(projectId), (workspaceId) =>
				underWorkspaceLock(principal, workspaceId ?? projectId, (lock) =>
					named(projectId, (j) =>
						proveReachesProject(lock.principal, j).pipe(
							Effect.flatMap((reach) => proveCanChangeProjectMembers(lock, reach)),
							Effect.asVoid,
						),
					),
				),
			),
		);
	const takesPart = (principal: Principal, chatId: string) =>
		outcome(
			named(principal, chatId, (p, c) =>
				proveReachesChat(p, c).pipe(Effect.flatMap(proveCanTakePart), Effect.asVoid),
			),
		);
	const changesChat = (principal: Principal, chatId: string) =>
		outcome(
			named(principal, chatId, (p, c) =>
				proveReachesChat(p, c).pipe(Effect.flatMap(proveCanChangeChat), Effect.asVoid),
			),
		);

	describe("ReachesProject", () => {
		it("lets a member reach a project members made only once they are in it, and admins every one", async () => {
			const { a } = world;
			const expected = {
				[a.owner]: "ok",
				[a.admin]: "ok",
				[a.ed]: "ok",
				[a.vi]: "ok",
				[a.erin]: "ResourceHidden",
			};
			for (const [memberId, result] of Object.entries(expected)) {
				expect(await reachesProject(await as.member(memberId), a.project)).toBe(result);
			}
		});

		it("lets a member reach a bot's default project as they reach the bot", async () => {
			const { a } = world;
			const cases: Array<[string, string, string]> = [
				[a.vi, a.pub.defaultProject, "ok"],
				[a.ed, a.personal.defaultProject, "ok"],
				[a.admin, a.personal.defaultProject, "ResourceHidden"],
				[a.owner, a.assistant.defaultProject, "ResourceHidden"],
				[a.ed, a.assistant.defaultProject, "ok"],
			];
			for (const [memberId, projectId, result] of cases) {
				expect(await reachesProject(await as.member(memberId), projectId)).toBe(result);
			}
		});

		it("hides every project of a workspace from someone outside it, though they are in another", async () => {
			const { a, b } = world;
			const outsider = await as.member(a.erin);
			expect(await reachesProject(outsider, b.project)).toBe("ResourceHidden");
			expect(await reachesProject(await as.member(a.ed), b.project)).toBe("ok");
			expect(await reachesProject(await as.member(a.ed), "not-an-id")).toBe("ResourceHidden");
		});

		it("checks a bot's bounds first: in chat bounds, only the chat's project, whatever its asker reaches", async () => {
			const { a, b } = world;
			const edsBot = await as.botFor(a.ed, a.pub.id, a.chat);
			expect(await reachesProject(edsBot, a.project)).toBe("ok");
			expect(await reachesProject(edsBot, a.otherProject)).toBe("ResourceHidden");
			expect(await reachesProject(edsBot, a.pub.defaultProject)).toBe("ResourceHidden");
			expect(await reachesProject(edsBot, b.project)).toBe("ResourceHidden");
		});

		it("keeps an admitted turn's reach and denies a new turn after access changes", async () => {
			const { a } = world;
			const projectId = await seedProject(a.workspace, {
				leadBotId: a.pub.id,
				bots: [a.helper.id],
				members: [a.ed, a.quinn],
			});
			const chatId = await seedProjectChat(a.workspace, projectId, a.ed);
			const quinnsBot = await as.botFor(a.quinn, a.pub.id, chatId);
			const helpersTurn = await as.botFor(a.ed, a.helper.id, chatId);
			expect(await reachesProject(quinnsBot, projectId)).toBe("ok");
			expect(await reachesProject(helpersTurn, projectId)).toBe("ok");

			await onDatabase((db) =>
				db
					.delete(projectMember)
					.where(and(eq(projectMember.projectId, projectId), eq(projectMember.memberId, a.quinn))),
			);
			await onDatabase((db) =>
				db
					.delete(projectBot)
					.where(and(eq(projectBot.projectId, projectId), eq(projectBot.botId, a.helper.id))),
			);

			expect(await reachesProject(quinnsBot, projectId)).toBe("ok");
			expect(await reachesProject(helpersTurn, projectId)).toBe("ok");
			expect(await reachesChat(helpersTurn, chatId)).toBe("ok");
			const afterMemberRemoval = await as.botFor(a.quinn, a.pub.id, chatId);
			const afterBotRemoval = await as.botFor(a.ed, a.helper.id, chatId);
			expect(await reachesProject(afterMemberRemoval, projectId)).toBe("ResourceHidden");
			expect(await reachesChat(afterBotRemoval, chatId)).toBe("BotCannotReach");
		});

		it("lets a personal bot in its own chats, a Personal Assistant included, reach what its creator reaches and nothing more", async () => {
			const { a, b } = world;
			const erinsProject = await seedProject(a.workspace, {
				leadBotId: a.helper.id,
				members: [a.erin],
			});
			const personalBots = {
				assistant: await as.botFor(a.ed, a.assistant.id, a.assistantChat),
				personal: await as.botFor(a.ed, a.personal.id, a.personalChat),
			};
			for (const [name, personalBot] of Object.entries(personalBots)) {
				expect(personalBot.bounds, name).toEqual({ kind: "member" });
				for (const projectId of [a.project, a.otherProject, a.pub.defaultProject]) {
					expect(await reachesProject(personalBot, projectId), name).toBe("ok");
				}
				expect(await reachesProject(personalBot, erinsProject), name).toBe("ResourceHidden");
				expect(await reachesProject(personalBot, b.project), name).toBe("ResourceHidden");
			}
		});

		it("keeps a bot it could not reach at admission hidden when that bot becomes public", async () => {
			const { a } = world;
			const privateBot = await seedBot(a.workspace, { visibility: "private", createdById: a.erin });
			const admitted = await as.botFor(a.ed, a.assistant.id, a.assistantChat);
			expect(await reachesBot(admitted, privateBot.id)).toBe("ResourceHidden");

			await onDatabase((db) =>
				db.update(bot).set({ visibility: "public" }).where(eq(bot.id, privateBot.id)),
			);

			expect(await reachesBot(admitted, privateBot.id)).toBe("ResourceHidden");
			expect(
				await reachesBot(await as.botFor(a.ed, a.assistant.id, a.assistantChat), privateBot.id),
			).toBe("ok");
		});

		it("lets runs reach their project while webhooks and scheduled work use target-specific proofs", async () => {
			const { a } = world;
			const { principal: run } = await as.run(a.workspace, a.project, a.pub.id);
			const webhook = await as.webhook(a.workspace, a.project);
			const sleep = who.computerSleep;
			const compaction = await as.compaction(a.chat, a.pub.id);
			const page = await as.page(a.chat, a.ed);
			expect(await reachesProject(run, a.project)).toBe("ok");
			expect(await reachesProject(run, a.otherProject)).toBe("ResourceHidden");
			expect(await reachesProject(webhook, a.project)).toBe("ResourceHidden");
			expect(await reachesProject(sleep, a.project)).toBe("ResourceHidden");
			expect(await reachesProject(compaction, a.project)).toBe("ResourceHidden");
			expect(await reachesProject(page, a.project)).toBe("ResourceHidden");
		});
	});

	describe("ReachesChat", () => {
		it("reaches a chat as its project is reached", async () => {
			const { a, b } = world;
			expect(await reachesChat(await as.member(a.vi), a.chat)).toBe("ok");
			expect(await reachesChat(await as.member(a.erin), a.chat)).toBe("ResourceHidden");
			expect(await reachesChat(await as.member(a.erin), b.chat)).toBe("ResourceHidden");
			const edsBot = await as.botFor(a.ed, a.pub.id, a.chat);
			expect(await reachesChat(edsBot, a.chat)).toBe("ok");
			expect(await reachesChat(edsBot, a.otherChat)).toBe("ResourceHidden");
		});

		it("lets a compaction reach only the chat its request names", async () => {
			const { a } = world;
			const compaction = await as.compaction(a.chat, a.pub.id);
			expect(await reachesChat(compaction, a.chat)).toBe("ok");
			expect(
				await reachesChat(compaction, await seedProjectChat(a.workspace, a.project, a.ed)),
			).toBe("ResourceHidden");
		});
	});

	describe("permissions from reach", () => {
		it("lets a viewer take part but not change the chat, and a viewer's bot do neither", async () => {
			const { a } = world;
			const vi = await as.member(a.vi);
			const visBot = await as.botFor(a.vi, a.pub.id, a.chat);
			const edsBot = await as.botFor(a.ed, a.pub.id, a.chat);
			const { principal: run } = await as.run(a.workspace, a.project, a.pub.id);
			const compaction = await as.compaction(a.chat, a.pub.id);

			expect(await takesPart(vi, a.chat)).toBe("ok");
			expect(await changesChat(vi, a.chat)).toBe("ActionForbidden");
			expect(await takesPart(visBot, a.chat)).toBe("ActionForbidden");
			expect(await changesChat(visBot, a.chat)).toBe("ActionForbidden");
			expect(await changesChat(await as.member(a.ed), a.chat)).toBe("ok");
			expect(await changesChat(edsBot, a.chat)).toBe("ok");
			expect(await changesChat(run, a.chat)).toBe("ok");
			expect(await takesPart(compaction, a.chat)).toBe("ActionForbidden");
			expect(await changesChat(compaction, a.chat)).toBe("ActionForbidden");
		});

		it("lets a viewer's own Personal Assistant change its own chats, but nothing elsewhere it reaches for them", async () => {
			const { a } = world;
			const assistant = await seedBot(a.workspace, { assistantOf: a.vi, visibility: "personal" });
			const ownChat = await seedProjectChat(a.workspace, assistant.defaultProject, a.vi);
			const visAssistant = await as.botFor(a.vi, assistant.id, ownChat);

			expect(await changesChat(visAssistant, ownChat)).toBe("ok");
			expect(await reachesChat(visAssistant, a.chat)).toBe("ok");
			expect(await changesChat(visAssistant, a.chat)).toBe("ActionForbidden");
		});

		it("lets the owner and admins manage a project members made, and a bot's managers its default project", async () => {
			const { a } = world;
			const cases: Array<[string, string, string]> = [
				[a.owner, a.project, "ok"],
				[a.admin, a.project, "ok"],
				[a.ed, a.project, "ActionForbidden"],
				[a.vi, a.project, "ActionForbidden"],
				[a.ed, a.pub.defaultProject, "ok"],
				[a.admin, a.pub.defaultProject, "ok"],
				[a.vi, a.pub.defaultProject, "ActionForbidden"],
				[a.ed, a.personal.defaultProject, "ok"],
				[a.ed, a.assistant.defaultProject, "ok"],
				[a.viewerCreator, a.viewerCreatorsBot.defaultProject, "ActionForbidden"],
			];
			for (const [memberId, projectId, result] of cases) {
				expect(await managesProject(await as.member(memberId), projectId)).toBe(result);
			}
		});

		it("gives a bot its asker's management within its bounds, and a run none", async () => {
			const { a } = world;
			const ownersBot = await as.botFor(a.owner, a.pub.id, a.chat);
			const edsBot = await as.botFor(a.ed, a.pub.id, a.chat);
			const { principal: run } = await as.run(a.workspace, a.project, a.pub.id);
			const webhook = await as.webhook(a.workspace, a.project);
			expect(await managesProject(ownersBot, a.project)).toBe("ok");
			expect(await managesProject(edsBot, a.project)).toBe("ActionForbidden");
			expect(await managesProject(run, a.project)).toBe("ActionForbidden");
			expect(await managesProject(webhook, a.project)).toBe("ResourceHidden");
		});

		it("lets anyone in a project but viewers change its members, and a bot only in member bounds", async () => {
			const { a } = world;
			expect(await changesMembers(await as.member(a.ed), a.project)).toBe("ok");
			expect(await changesMembers(await as.member(a.admin), a.project)).toBe("ok");
			expect(await changesMembers(await as.member(a.vi), a.project)).toBe("ActionForbidden");
			expect(await changesMembers(await as.member(a.ed), a.pub.defaultProject)).toBe(
				"ActionForbidden",
			);
			expect(await changesMembers(await as.botFor(a.ed, a.pub.id, a.chat), a.project)).toBe(
				"ActionForbidden",
			);
			expect(
				await changesMembers(await as.botFor(a.ed, a.assistant.id, a.assistantChat), a.project),
			).toBe("ok");
			const { principal: run } = await as.run(a.workspace, a.project, a.pub.id);
			expect(await changesMembers(run, a.project)).toBe("ActionForbidden");
		});
	});

	it("proves project chat management for the administrator and the bot's manager in its default project", async () => {
		const { a } = world;
		const manages = (principal: Principal, chatId: string) =>
			outcome(
				named(principal, chatId, (principal, chat) =>
					proveReachesChat(principal, chat).pipe(
						Effect.flatMap(proveCanManageChats),
						Effect.asVoid,
					),
				),
			);
		const { admin, ed, vi, erin, pubForAdmin, pubForEd, run, page } = who;
		expect(
			await outcomesFor({ admin, ed, vi, erin, pubForAdmin, pubForEd, run, page }, (principal) =>
				manages(principal, a.chat),
			),
		).toEqual({
			admin: "ok",
			ed: "ActionForbidden",
			vi: "ActionForbidden",
			erin: "ResourceHidden",
			pubForAdmin: "ok",
			pubForEd: "ActionForbidden",
			run: "ActionForbidden",
			page: "ResourceHidden",
		});
		expect(await manages(ed, a.pubChat)).toBe("ok");
		expect(await manages(admin, a.pubChat)).toBe("ok");
		expect(await manages(erin, a.pubChat)).toBe("ActionForbidden");
	});

	it("proves connector reads only for principals reaching the named connector's project", async () => {
		const { a } = world;
		const connectorId = await seedConnector(a.workspace, a.project);
		const reads = (principal: Principal, projectId: string, target: string) =>
			outcome(
				named(principal, projectId, target, (principal, project, connector) =>
					proveReachesConnector(principal, project, connector).pipe(
						Effect.flatMap(({ reach }) => proveCanReadConnectors(reach)),
						Effect.asVoid,
					),
				),
			);
		const {
			admin,
			vi,
			erin,
			outsider,
			pubForEd,
			helperInK,
			edsAssistant,
			run,
			webhook,
			computerSleep,
			compaction,
			page,
		} = who;
		expect(
			await outcomesFor(
				{
					admin,
					vi,
					erin,
					outsider,
					pubForEd,
					helperInK,
					edsAssistant,
					run,
					webhook,
					computerSleep,
					compaction,
					page,
				},
				(principal) => reads(principal, a.project, connectorId),
			),
		).toEqual({
			admin: "ok",
			vi: "ok",
			erin: "ResourceHidden",
			outsider: "ResourceHidden",
			pubForEd: "ok",
			helperInK: "ResourceHidden",
			edsAssistant: "ok",
			run: "ok",
			webhook: "ResourceHidden",
			computerSleep: "ResourceHidden",
			compaction: "ResourceHidden",
			page: "ResourceHidden",
		});
		expect(await reads(admin, a.otherProject, connectorId)).toBe("ResourceHidden");
		expect(await reads(admin, a.project, crypto.randomUUID())).toBe("ResourceHidden");
	});

	it("lets a workspace member join a public project or remain in a project they already reach", async () => {
		const { a } = world;
		const publicProject = await seedProject(a.workspace, {
			leadBotId: a.pub.id,
			visibility: "public",
		});
		const join = (principal: Principal, projectId: string) =>
			outcome(
				underWorkspaceLock(principal, a.workspace, (lock) =>
					named(projectId, (project) => proveCanJoinProject(lock, project).pipe(Effect.asVoid)),
				),
			);
		const { ed, erin, outsider, edsAssistant, pubForEd, run, webhook, page } = who;

		expect(await join(erin, publicProject)).toBe("ok");
		expect(await join(edsAssistant, publicProject)).toBe("ok");
		expect(await join(outsider, publicProject)).toBe("ResourceHidden");
		expect(await join(pubForEd, publicProject)).toBe("ResourceHidden");
		expect(await join(erin, a.project)).toBe("ResourceHidden");
		expect(await join(ed, a.project)).toBe("ok");
		expect(await join(pubForEd, a.project)).toBe("ActionForbidden");
		expect(await join(run, a.project)).toBe("ActionForbidden");
		expect(await join(webhook, a.project)).toBe("ResourceHidden");
		expect(await join(page, a.project)).toBe("ResourceHidden");
		expect(await join(ed, a.pub.defaultProject)).toBe("ResourceHidden");
	});

	it("lets project members leave, including a viewer and a bot acting in member bounds", async () => {
		const { a } = world;
		const leave = (principal: Principal) =>
			outcome(
				underWorkspaceLock(principal, a.workspace, (lock) =>
					named(a.project, (project) =>
						proveReachesProject(lock.principal, project).pipe(
							Effect.flatMap((reach) => proveCanLeaveProject(lock, reach)),
							Effect.asVoid,
						),
					),
				),
			);
		const { ed, vi, admin, erin, pubForEd, edsAssistant, run, page } = who;

		expect(
			await outcomesFor({ ed, vi, admin, erin, pubForEd, edsAssistant, run, page }, leave),
		).toEqual({
			ed: "ok",
			vi: "ok",
			admin: "ActionForbidden",
			erin: "ResourceHidden",
			pubForEd: "ActionForbidden",
			edsAssistant: "ok",
			run: "ActionForbidden",
			page: "ResourceHidden",
		});
	});

	it("proves project run reads for a member, a bot for its asker, and a run", async () => {
		const { a } = world;
		const { vi, pubForEd, run, webhook, compaction, computerSleep } = who;
		expect(
			await outcomesFor({ vi, pubForEd, run, webhook, compaction, computerSleep }, (principal) =>
				outcome(
					named(principal, a.project, (principal, project) =>
						proveReachesProject(principal, project).pipe(
							Effect.flatMap(proveCanReadProjectRuns),
							Effect.asVoid,
						),
					),
				),
			),
		).toEqual({
			vi: "ok",
			pubForEd: "ok",
			run: "ok",
			webhook: "ResourceHidden",
			compaction: "ResourceHidden",
			computerSleep: "ResourceHidden",
		});
	});

	it("hides an automation in an unreached project of the same workspace", async () => {
		const { a } = world;
		const reached = await seedAutomation(a.workspace, a.project);
		const unreached = await seedAutomation(a.workspace, a.otherProject);
		const provesReach = (automationId: string) =>
			outcome(
				named(who.vi, a.workspace, automationId, (principal, workspace, automation) =>
					proveReachesAutomation(principal, workspace, automation).pipe(Effect.asVoid),
				),
			);

		expect({
			reached: await provesReach(reached),
			unreached: await provesReach(unreached),
		}).toEqual({ reached: "ok", unreached: "ResourceHidden" });
	});

	it("proves who may start automation runs in a project", async () => {
		const { a } = world;
		const { ed, admin, vi, erin, pubForEd, helperInK, run, webhook, computerSleep, page } = who;
		expect(
			await outcomesFor(
				{ ed, admin, vi, erin, pubForEd, helperInK, run, webhook, computerSleep, page },
				(principal) =>
					outcome(
						named(principal, a.project, (principal, project) =>
							proveReachesProject(principal, project).pipe(
								Effect.flatMap(proveCanRunAutomations),
								Effect.asVoid,
							),
						),
					),
			),
		).toEqual({
			ed: "ok",
			admin: "ok",
			vi: "ActionForbidden",
			erin: "ResourceHidden",
			pubForEd: "ok",
			helperInK: "ResourceHidden",
			run: "ActionForbidden",
			webhook: "ResourceHidden",
			computerSleep: "ResourceHidden",
			page: "ResourceHidden",
		});
	});

	it("proves who may change a project's allowed hosts", async () => {
		const { a } = world;
		const {
			owner,
			admin,
			ed,
			vi,
			erin,
			pubForAdmin,
			adminsAssistant,
			run,
			webhook,
			computerSleep,
			page,
		} = who;
		expect(
			await outcomesFor(
				{
					owner,
					admin,
					ed,
					vi,
					erin,
					pubForAdmin,
					adminsAssistant,
					run,
					webhook,
					computerSleep,
					page,
				},
				(principal) =>
					outcome(
						named(principal, a.project, (principal, project) =>
							proveReachesProject(principal, project).pipe(
								Effect.flatMap(proveCanChangeAllowedHosts),
								Effect.asVoid,
							),
						),
					),
			),
		).toEqual({
			owner: "ok",
			admin: "ok",
			ed: "ActionForbidden",
			vi: "ActionForbidden",
			erin: "ResourceHidden",
			pubForAdmin: "ActionForbidden",
			adminsAssistant: "ok",
			run: "ActionForbidden",
			webhook: "ResourceHidden",
			computerSleep: "ResourceHidden",
			page: "ResourceHidden",
		});
	});

	it("proves who may change settings or delete a project under its workspace lock", async () => {
		const { a } = world;
		const {
			owner,
			admin,
			ed,
			vi,
			erin,
			outsider,
			pubForAdmin,
			adminsAssistant,
			edsAssistant,
			run,
			webhook,
			computerSleep,
			compaction,
			page,
		} = who;
		const cases = [
			["owner", owner, "ok"],
			["admin", admin, "ok"],
			["editor", ed, "ActionForbidden"],
			["viewer", vi, "ActionForbidden"],
			["outside project", erin, "ResourceHidden"],
			["outside workspace", outsider, "ResourceHidden"],
			["admin's bot in chat bounds", pubForAdmin, "ActionForbidden"],
			["admin's Personal Assistant", adminsAssistant, "ok"],
			["editor's Personal Assistant", edsAssistant, "ActionForbidden"],
			["run", run, "ActionForbidden"],
			["webhook", webhook, "ResourceHidden"],
			["computer sleep", computerSleep, "ResourceHidden"],
			["compaction", compaction, "ResourceHidden"],
			["page address", page, "ResourceHidden"],
		] as const;
		for (const [caseName, principal, expected] of cases) {
			const change = outcome(
				underWorkspaceLock(principal, a.workspace, (lock) =>
					named(a.project, (project) =>
						proveReachesProject(lock.principal, project).pipe(
							Effect.flatMap((reach) => proveCanChangeProjectSettings(lock, reach)),
							Effect.asVoid,
						),
					),
				),
			);
			expect(await change, `change settings: ${caseName}`).toBe(expected);
			const remove = outcome(
				underWorkspaceLock(principal, a.workspace, (lock) =>
					named(a.project, (project) =>
						proveReachesProject(lock.principal, project).pipe(
							Effect.flatMap((reach) => proveCanDeleteProject(lock, reach)),
							Effect.asVoid,
						),
					),
				),
			);
			expect(await remove, `delete: ${caseName}`).toBe(expected);
		}
	});

	describe("ReachesBot", () => {
		it("lets members reach a public bot, their own personal bot and their own Personal Assistant", async () => {
			const { a, b } = world;
			const cases: Array<[string, string, string]> = [
				[a.vi, a.pub.id, "ok"],
				[a.ed, a.personal.id, "ok"],
				[a.admin, a.personal.id, "ResourceHidden"],
				[a.ed, a.assistant.id, "ok"],
				[a.owner, a.assistant.id, "ResourceHidden"],
				[a.owner, a.system.id, "ResourceHidden"],
				[a.erin, b.bot.id, "ResourceHidden"],
			];
			for (const [memberId, botId, result] of cases) {
				expect(await reachesBot(await as.member(memberId), botId)).toBe(result);
			}
		});

		it("lets a bot reach its own bot and those within its bounds, and a run its project's", async () => {
			const { a } = world;
			const edsBot = await as.botFor(a.ed, a.pub.id, a.chat);
			const assistant = await as.botFor(a.ed, a.assistant.id, a.assistantChat);
			const personal = await as.botFor(a.ed, a.personal.id, a.personalChat);
			const { principal: run } = await as.run(a.workspace, a.project, a.pub.id);
			const webhook = await as.webhook(a.workspace, a.project);
			expect(await reachesBot(edsBot, a.pub.id)).toBe("ok");
			expect(await reachesBot(edsBot, a.helper.id)).toBe("ok");
			expect(await reachesBot(edsBot, a.personal.id)).toBe("ResourceHidden");
			expect(await reachesBot(assistant, a.personal.id)).toBe("ok");
			expect(await reachesBot(personal, a.helper.id)).toBe("ok");
			expect(await reachesBot(run, a.helper.id)).toBe("ok");
			expect(await reachesBot(run, a.personal.id)).toBe("ResourceHidden");
			expect(await reachesBot(webhook, a.pub.id)).toBe("ResourceHidden");
		});
	});

	it("carries the workspace it found, so services take it from the proof", async () => {
		const { a } = world;
		const principal = await as.member(a.ed);
		const found = await runOnPostgres(
			named(principal, a.chat, (principal, chat) =>
				proveReachesChat(principal, chat).pipe(
					Effect.map((reach) => ({
						workspace: reach.workspace,
						projectId: reach.project.id,
						actsAs: reach.as.kind,
					})),
				),
			),
		);
		expect(found).toEqual({ workspace: a.workspace, projectId: a.project, actsAs: "member" });
	});
});
