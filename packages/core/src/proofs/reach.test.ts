import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedProjectChat } from "../authentication/seed.test-support.ts";
import { projectBot, projectMember } from "../database/schema.ts";
import { closeDatabase, onDatabase } from "../database/testing.ts";
import type { Principal } from "../principal.ts";
import {
	proveCanChangeChat,
	proveCanChangeProjectMembers,
	proveCanManageProject,
	proveCanTakePart,
} from "./project-permissions.ts";
import { named } from "./proof.ts";
import { proveReachesBot } from "./reaches-bot.ts";
import { proveReachesChat } from "./reaches-chat.ts";
import { proveReachesProject } from "./reaches-project.ts";
import {
	type Authenticators,
	authenticators,
	buildWorld,
	outcome,
	principals,
	type World,
} from "./world.test-support.ts";

describe("reach and what it permits", () => {
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
	const changesMembers = (principal: Principal, projectId: string) =>
		outcome(
			named(principal, projectId, (p, j) =>
				proveReachesProject(p, j).pipe(Effect.flatMap(proveCanChangeProjectMembers), Effect.asVoid),
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

		it("hides the project from a bot whose asker lost it, and tells a bot it can't reach one its asker reaches", async () => {
			const { a } = world;
			const quinnsBot = await as.botFor(a.quinn, a.pub.id, a.chat);
			const helpersTurn = await as.botFor(a.ed, a.helper.id, a.chat);
			expect(await reachesProject(quinnsBot, a.project)).toBe("ok");
			expect(await reachesProject(helpersTurn, a.project)).toBe("ok");

			await onDatabase((db) =>
				db
					.delete(projectMember)
					.where(and(eq(projectMember.projectId, a.project), eq(projectMember.memberId, a.quinn))),
			);
			await onDatabase((db) =>
				db
					.delete(projectBot)
					.where(and(eq(projectBot.projectId, a.project), eq(projectBot.botId, a.helper.id))),
			);

			expect(await reachesProject(quinnsBot, a.project)).toBe("ResourceHidden");
			expect(await reachesProject(helpersTurn, a.project)).toBe("BotCannotReach");
			expect(await reachesChat(helpersTurn, a.chat)).toBe("BotCannotReach");

			await onDatabase((db) =>
				db
					.insert(projectMember)
					.values({ workspaceId: a.workspace, projectId: a.project, memberId: a.quinn }),
			);
			await onDatabase((db) =>
				db
					.insert(projectBot)
					.values({ workspaceId: a.workspace, projectId: a.project, botId: a.helper.id }),
			);
		});

		it("lets a Personal Assistant in member bounds reach what its member reaches", async () => {
			const { a, b } = world;
			const assistant = await as.botFor(a.ed, a.assistant.id, a.assistantChat);
			expect(assistant.bounds).toEqual({ kind: "member" });
			for (const projectId of [a.project, a.otherProject, a.personal.defaultProject]) {
				expect(await reachesProject(assistant, projectId)).toBe("ok");
			}
			expect(await reachesProject(assistant, b.project)).toBe("ResourceHidden");
		});

		it("lets a run, a webhook call and system work reach only the project they come from", async () => {
			const { a } = world;
			const { principal: run } = await as.run(a.workspace, a.project, a.pub.id);
			const webhook = await as.webhook(a.workspace, a.project);
			const { principal: sleep } = await as.computerSleep(a.workspace, a.project);
			const compaction = await as.compaction(a.chat, a.pub.id);
			const page = await as.page(a.chat);
			for (const principal of [run, webhook, sleep]) {
				expect(await reachesProject(principal, a.project)).toBe("ok");
				expect(await reachesProject(principal, a.otherProject)).toBe("ResourceHidden");
			}
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
			expect(await managesProject(webhook, a.project)).toBe("ActionForbidden");
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
			const { principal: run } = await as.run(a.workspace, a.project, a.pub.id);
			const webhook = await as.webhook(a.workspace, a.project);
			expect(await reachesBot(edsBot, a.pub.id)).toBe("ok");
			expect(await reachesBot(edsBot, a.helper.id)).toBe("ok");
			expect(await reachesBot(edsBot, a.personal.id)).toBe("ResourceHidden");
			expect(await reachesBot(assistant, a.personal.id)).toBe("ok");
			expect(await reachesBot(run, a.helper.id)).toBe("ok");
			expect(await reachesBot(run, a.personal.id)).toBe("ResourceHidden");
			expect(await reachesBot(webhook, a.pub.id)).toBe("ResourceHidden");
		});
	});

	it("carries the workspace it found, so services take it from the proof", async () => {
		const { a } = world;
		const principal = await as.member(a.ed);
		const found = await outcome(
			named(principal, a.chat, (p, c) =>
				proveReachesChat(p, c).pipe(
					Effect.flatMap((reach) =>
						Effect.sync(() => {
							expect(reach.workspace).toBe(a.workspace);
							expect(reach.project.id).toBe(a.project);
							expect(reach.as.kind).toBe("member");
						}),
					),
				),
			),
		);
		expect(found).toBe("ok");
	});
});
