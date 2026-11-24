import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedBot } from "../authentication/seed.test-support.ts";
import { closeDatabase, runOnPostgres } from "../database/testing.ts";
import type { Principal } from "../principal.ts";
import { proveCanManageBot } from "./can-manage-bot.ts";
import { proveCanRestrictBot } from "./can-restrict-bot.ts";
import { proveMayBrief } from "./may-brief.ts";
import { named } from "./proof.ts";
import {
	type Authenticators,
	authenticators,
	buildWorld,
	outcome,
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

	describe("CanManageBot", () => {
		it("lets a public bot's creator and admins manage it, and refuses those who only reach it", async () => {
			const { a, b } = world;
			const cases: Array<[string, string]> = [
				[a.ed, "ok"],
				[a.admin, "ok"],
				[a.owner, "ok"],
				[a.erin, "ActionForbidden"],
				[a.vi, "ActionForbidden"],
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
			const erinsBot = await as.botFor(a.vi, a.pub.id, a.chat);
			const { principal: run } = await as.run(a.workspace, a.project, a.pub.id);
			expect(await briefs(erinsBot, a.personal.id)).toBe("ResourceHidden");
			expect(await briefs(erinsBot, a.system.id)).toBe("ResourceHidden");
			expect(await briefs(erinsBot, b.bot.id)).toBe("ResourceHidden");
			expect(await briefs(run, a.helper.id)).toBe("ResourceHidden");
			expect(await briefs(await as.member(a.ed), a.helper.id)).toBe("ResourceHidden");
		});
	});
});
