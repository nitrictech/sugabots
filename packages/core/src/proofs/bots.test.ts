import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedBot } from "../authentication/seed.test-support.ts";
import { closeDatabase, runOnPostgres } from "../database/testing.ts";
import type { Principal } from "../principal.ts";
import { proveActsForMember } from "./acts-for-member.ts";
import { proveCanDeleteBot } from "./bot-permissions.ts";
import { proveCanManageBot } from "./can-manage-bot.ts";
import { proveCanRestrictBot } from "./can-restrict-bot.ts";
import { proveMayBrief } from "./may-brief.ts";
import { named } from "./proof.ts";
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

describe("managing, restricting and briefing bots", () => {
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

	const manages = (principal: Principal, botId: string) =>
		outcome(named(principal, botId, (p, b) => proveCanManageBot(p, b).pipe(Effect.asVoid)));
	const restricts = (principal: Principal, botId: string) =>
		outcome(named(principal, botId, (p, b) => proveCanRestrictBot(p, b).pipe(Effect.asVoid)));
	const briefs = (principal: Principal, botId: string) =>
		outcome(named(principal, botId, (p, b) => proveMayBrief(p, b).pipe(Effect.asVoid)));

	it("lets a member or their Personal Assistant act for them within member bounds", async () => {
		const { a } = world;
		const member = await as.member(a.ed);
		const assistant = await as.botFor(a.ed, a.assistant.id, a.assistantChat);
		const projectBot = await as.botFor(a.ed, a.pub.id, a.chat);
		const { principal: run } = await as.run(a.workspace, a.project, a.pub.id);

		expect(
			await outcomesFor({ member, assistant, projectBot, run }, (principal) =>
				outcome(named(principal, (principal) => proveActsForMember(principal).pipe(Effect.asVoid))),
			),
		).toEqual({
			member: "ok",
			assistant: "ok",
			projectBot: "ActionForbidden",
			run: "ActionForbidden",
		});
	});

	describe("CanManageBot", () => {
		it("lets a public bot's creator and admins manage it, and refuses those who only reach it", async () => {
			const { a, b } = world;
			const cases: Array<[string, string]> = [
				[a.ed, "ok"],
				[a.admin, "ok"],
				[a.erin, "ActionForbidden"],
			];
			for (const [memberId, result] of cases) {
				expect(await manages(await as.member(memberId), a.pub.id)).toBe(result);
			}
			expect(await manages(await as.member(a.erin), b.bot.id)).toBe("ResourceHidden");
		});

		it("lets only its creator manage a personal bot, hiding it from admins, who may only restrict it", async () => {
			const { a } = world;
			expect(await manages(await as.member(a.ed), a.personal.id)).toBe("ok");
			expect(await manages(await as.member(a.admin), a.personal.id)).toBe("ResourceHidden");
			expect(await manages(await as.member(a.erin), a.personal.id)).toBe("ResourceHidden");
			expect(await restricts(await as.member(a.admin), a.personal.id)).toBe("ok");
		});

		it("lets only its member manage a Personal Assistant, whatever their role, and nobody a system bot", async () => {
			const { a } = world;
			const visAssistant = await seedBot(a.workspace, {
				assistantOf: a.vi,
				visibility: "personal",
			});
			expect(await manages(await as.member(a.ed), a.assistant.id)).toBe("ok");
			expect(await manages(await as.member(a.vi), visAssistant.id)).toBe("ok");
			expect(await manages(await as.member(a.owner), a.assistant.id)).toBe("ResourceHidden");
			expect(await manages(await as.member(a.owner), a.system.id)).toBe("ResourceHidden");
		});

		it("lets a creator who is now a viewer manage nothing", async () => {
			const { a } = world;
			expect(await manages(await as.member(a.viewerCreator), a.viewerCreatorsBot.id)).toBe(
				"ActionForbidden",
			);
		});

		it("gives a bot its asker's management only in member bounds, or of itself in its own chats", async () => {
			const { a } = world;
			const inOwnChats = await as.botFor(a.ed, a.pub.id, a.pubChat);
			const inProject = await as.botFor(a.ed, a.pub.id, a.chat);
			const assistant = await as.botFor(a.ed, a.assistant.id, a.assistantChat);
			const { principal: run } = await as.run(a.workspace, a.project, a.pub.id);

			const ownChats = await runOnPostgres(
				named(inOwnChats, a.pub.id, (p, b) =>
					proveCanManageBot(p, b).pipe(Effect.map((proof) => proof.inOwnChats)),
				),
			);
			expect(ownChats).toBe(true);
			expect(await manages(inProject, a.pub.id)).toBe("ActionForbidden");
			expect(await manages(inProject, a.personal.id)).toBe("ResourceHidden");
			expect(await manages(assistant, a.pub.id)).toBe("ok");
			expect(await manages(assistant, a.personal.id)).toBe("ok");
			expect(await manages(run, a.pub.id)).toBe("ActionForbidden");
			expect(await manages(run, a.personal.id)).toBe("ResourceHidden");
		});
	});

	describe("CanRestrictBot", () => {
		it("lets admins restrict any bot but a Personal Assistant, which is hidden to them", async () => {
			const { a } = world;
			for (const memberId of [a.admin, a.owner]) {
				const admin = await as.member(memberId);
				expect(await restricts(admin, a.personal.id)).toBe("ok");
				expect(await restricts(admin, a.pub.id)).toBe("ok");
				expect(await restricts(admin, a.assistant.id)).toBe("ResourceHidden");
			}
		});

		it("refuses a system bot, and anyone who isn't an admin, as Hidden or Forbidden by what they reach", async () => {
			const { a, b } = world;
			expect(await restricts(await as.member(a.admin), a.system.id)).toBe("ActionForbidden");
			expect(await restricts(await as.member(a.ed), a.system.id)).toBe("ResourceHidden");
			expect(await restricts(await as.member(a.ed), a.personal.id)).toBe("ActionForbidden");
			expect(await restricts(await as.member(a.ed), a.assistant.id)).toBe("ActionForbidden");
			expect(await restricts(await as.member(a.erin), a.personal.id)).toBe("ResourceHidden");
			expect(await restricts(await as.member(a.erin), b.bot.id)).toBe("ResourceHidden");
		});

		it("gives a bot an admin asker's power only in member bounds, and a run none", async () => {
			const { a } = world;
			const adminsBot = await as.botFor(a.admin, a.pub.id, a.chat);
			const { principal: run } = await as.run(a.workspace, a.project, a.pub.id);
			expect(await restricts(adminsBot, a.pub.id)).toBe("ActionForbidden");
			expect(await restricts(adminsBot, a.personal.id)).toBe("ResourceHidden");
			expect(await restricts(run, a.helper.id)).toBe("ActionForbidden");
		});
	});

	it("proves bot deletion for managers and restriction, excluding assistants, system bots and interviews", async () => {
		const { a } = world;
		const who = await everyKindOfPrincipal(world, as);
		const deletes = (principal: Principal, botId: string) =>
			outcome(
				underWorkspaceLock(principal, a.workspace, (lock) =>
					named(botId, (bot) =>
						proveCanManageBot(lock.principal, bot).pipe(
							Effect.catch(() => proveCanRestrictBot(lock.principal, bot)),
							Effect.flatMap((authority) => proveCanDeleteBot(lock, authority)),
							Effect.asVoid,
						),
					),
				),
			);

		const cases = [
			["owner of workspace", who.owner, a.helper.id, "ok"],
			["admin", who.admin, a.helper.id, "ok"],
			["admin's Personal Assistant", who.adminsAssistant, a.helper.id, "ok"],
			["personal bot creator", who.ed, a.personal.id, "ok"],
			["admin restricting a personal bot", who.admin, a.personal.id, "ok"],
			["editor with reach", who.ed, a.helper.id, "ActionForbidden"],
			["viewer with reach", who.vi, a.helper.id, "ActionForbidden"],
			["outsider", who.outsider, a.helper.id, "ResourceHidden"],
			["bot outside bounds", who.pubInOwnChats, a.helper.id, "ResourceHidden"],
			["run outside bounds", who.run, (await seedBot(a.workspace)).id, "ResourceHidden"],
			["webhook", who.webhook, a.helper.id, "ResourceHidden"],
			["page address", who.page, a.helper.id, "ResourceHidden"],
			["own Personal Assistant", who.ed, a.assistant.id, "ActionForbidden"],
			["other member’s Personal Assistant", who.admin, a.assistant.id, "ResourceHidden"],
			["system bot", who.admin, a.system.id, "ActionForbidden"],
			["interview", who.pubInOwnChats, a.pub.id, "ActionForbidden"],
			["bot in chat bounds", who.pubForEd, a.pub.id, "ActionForbidden"],
		] as const;
		for (const [caseName, principal, botId, expected] of cases) {
			expect(await deletes(principal, botId), caseName).toBe(expected);
		}
	});

	describe("MayBrief", () => {
		it("lets a bot brief any bot its asker can talk to, outside its bounds", async () => {
			const { a } = world;
			const edsBot = await as.botFor(a.ed, a.pub.id, a.chat);
			expect(await briefs(edsBot, a.personal.id)).toBe("ok");
			expect(await briefs(edsBot, a.assistant.id)).toBe("ok");
			expect(await briefs(edsBot, a.helper.id)).toBe("ok");
		});

		it("hides bots the asker can't talk to, and refuses every principal with no asker", async () => {
			const { a, b } = world;
			const visBot = await as.botFor(a.vi, a.pub.id, a.chat);
			const { principal: run } = await as.run(a.workspace, a.project, a.pub.id);
			expect(await briefs(visBot, a.personal.id)).toBe("ResourceHidden");
			expect(await briefs(visBot, a.system.id)).toBe("ResourceHidden");
			expect(await briefs(visBot, b.bot.id)).toBe("ResourceHidden");
			expect(await briefs(run, a.helper.id)).toBe("ResourceHidden");
			expect(await briefs(await as.member(a.ed), a.helper.id)).toBe("ResourceHidden");
		});
	});
});
