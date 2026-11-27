import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { query, transaction } from "../database/database.ts";
import { chat, message, systemChat, turn } from "../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../database/testing.ts";
import type { BotForAsker } from "../principal.ts";
import {
	seedAutomation,
	seedBot,
	seedMember,
	seedMessage,
	seedProject,
	seedProjectChat,
	seedRun,
	seedTurn,
	seedTurnAnswering,
	seedWorkspace,
} from "./seed.test-support.ts";
import { TurnAuthentication } from "./turn.ts";

describe("TurnAuthentication", () => {
	let auth: TurnAuthentication.Interface;
	let workspaceId: string;
	let samId: string;
	let lead: { id: string; defaultProject: string };
	let helper: { id: string; defaultProject: string };
	let handBackHelpers: readonly { id: string }[];
	let projectId: string;
	let chatId: string;

	beforeAll(async () => {
		auth = await runOnPostgres(
			Effect.provide(TurnAuthentication.Service, TurnAuthentication.layer),
		);
		workspaceId = await seedWorkspace();
		samId = await seedMember(workspaceId, "editor");
		lead = await seedBot(workspaceId);
		helper = await seedBot(workspaceId);
		handBackHelpers = await Promise.all(Array.from({ length: 9 }, () => seedBot(workspaceId)));
		projectId = await seedProject(workspaceId, {
			leadBotId: lead.id,
			bots: [helper.id, ...handBackHelpers.map(({ id }) => id)],
			members: [samId],
		});
		chatId = await seedProjectChat(workspaceId, projectId, samId);
	});

	afterAll(async () => {
		await closeDatabase();
	});

	const authenticate = (turnId: string) => runOnPostgres(auth.authenticate(turnId));

	const seedHandBacks = async (inChat: string, firstTurn: string) => {
		let asking = firstTurn;
		for (const [index, { id }] of handBackHelpers.entries()) {
			const mention = await seedMessage(inChat, { bot: lead.id, turn: asking });
			await seedTurn(inChat, id, mention, { reason: "collaboration", status: "done" });
			asking = await seedTurn(inChat, lead.id, mention, {
				reason: "hand_back",
				status: index === handBackHelpers.length - 1 ? "running" : "done",
			});
		}
		return asking;
	};

	const asBotForAsker = async (turnId: string): Promise<BotForAsker> => {
		const principal = await authenticate(turnId);
		if (principal._tag !== "BotForAsker")
			throw new Error(`Expected BotForAsker, got ${principal._tag}`);
		return principal;
	};

	it("stores only the chat project and relevant bot facts for a chat-bounded turn", async () => {
		const unrelated = await seedBot(workspaceId);
		const otherProject = await seedProject(workspaceId, {
			leadBotId: unrelated.id,
			members: [samId],
		});
		const turnId = await seedTurnAnswering(
			chatId,
			lead.id,
			{ member: samId },
			{ reason: "mention" },
		);
		const principal = await asBotForAsker(turnId);

		expect(principal.admission?.projects[projectId]).toBeDefined();
		expect(principal.admission?.projects[helper.defaultProject]).toBeDefined();
		expect(principal.admission?.projects[unrelated.defaultProject]).toBeUndefined();
		expect(principal.admission?.projects[otherProject]).toBeUndefined();
	});

	it("keeps a mention turn's project facts small in a workspace with 5,000 other bots", async () => {
		const workspaceId = await seedWorkspace();
		const asker = await seedMember(workspaceId, "editor");
		const lead = await seedBot(workspaceId);
		const source = await seedProjectChat(workspaceId, lead.defaultProject, asker);
		await onDatabase((db) =>
			db.execute(sql`
				insert into bot (workspace_id, name, handle, color, eyes, visibility)
				select ${workspaceId}::uuid, 'Other bot ' || number, 'other-bot-' || number, 'green', 'pill', 'public'
				from generate_series(1, 5000) as series(number)
			`),
		);
		const turnId = await seedTurnAnswering(source, lead.id, { member: asker });
		const admitted = await asBotForAsker(turnId);
		const resumed = await asBotForAsker(turnId);
		const [size] = await onDatabase((db) =>
			db
				.select({ bytes: sql<number>`octet_length(${turn.admission}::text)` })
				.from(turn)
				.where(eq(turn.id, turnId)),
		);
		expect(Object.keys(admitted.admission?.projects ?? {})).toHaveLength(1);
		expect(admitted.admission?.projects[lead.defaultProject]).toBeDefined();
		expect(resumed.admission).toEqual(admitted.admission);
		expect(size?.bytes).toBeLessThan(205_000);
	});

	it("stores only reached projects for a personal bot acting in member bounds", async () => {
		const personal = await seedBot(workspaceId, { createdById: samId, visibility: "personal" });
		const ownChat = await seedProjectChat(workspaceId, personal.defaultProject, samId);
		const unreachable = await seedProject(workspaceId, { leadBotId: lead.id, members: [] });
		const turnId = await seedTurnAnswering(ownChat, personal.id, { member: samId });
		const principal = await asBotForAsker(turnId);

		expect(principal.admission?.projects[projectId]).toBeDefined();
		expect(principal.admission?.projects[unreachable]).toBeUndefined();
	});

	it("stores only its project and placed bot ids for an automation run", async () => {
		const automationId = await seedAutomation(workspaceId, projectId);
		const run = await seedRun(workspaceId, automationId, lead.id, "routine");
		const turnId = await seedTurn(run.chat, lead.id, run.triggerMessage, { reason: "automation" });
		const principal = await authenticate(turnId);

		expect(principal._tag).toBe("AutomationRun");
		expect(Object.keys(principal.admission?.projects ?? {})).toEqual([projectId]);
		expect(principal.admission?.chatProjectBotIds).toContain(helper.id);
	});

	describe("a bot acting for its asker", () => {
		it("acts for the member whose message it answers, in chat bounds", async () => {
			const turnId = await seedTurnAnswering(chatId, lead.id, { member: samId });

			const principal = await asBotForAsker(turnId);

			expect(principal).toMatchObject({
				workspace: workspaceId,
				bot: lead.id,
				asker: samId,
				chat: chatId,
				turn: turnId,
				bounds: { kind: "chat", project: projectId },
			});
		});

		it("makes each principal it builds a new execution of the turn", async () => {
			const turnId = await seedTurnAnswering(chatId, lead.id, { member: samId });

			const first = await asBotForAsker(turnId);
			const resumed = await asBotForAsker(turnId);

			expect(resumed.executionNumber).toBe(first.executionNumber + 1);
		});

		it("keeps the member who started the chat as asker when its trigger later points to a turn", async () => {
			const chatId = await seedProjectChat(workspaceId, projectId, samId);
			const reply = await seedMessage(chatId, { bot: helper.id });
			const asking = await seedTurn(chatId, lead.id, reply);
			const otherMember = await seedMember(workspaceId, "editor");
			const unrelated = await seedTurnAnswering(chatId, helper.id, { member: otherMember });
			await onDatabase((db) =>
				db.update(message).set({ turnId: unrelated }).where(eq(message.id, reply)),
			);

			expect(await asBotForAsker(asking)).toMatchObject({ asker: samId });
		});

		it("gives a helper, and the asking bot's hand-back, the asking turn's asker", async () => {
			const asking = await seedTurnAnswering(chatId, lead.id, { member: samId });
			const helperTurn = await seedTurnAnswering(
				chatId,
				helper.id,
				{ bot: lead.id, turn: asking },
				{ reason: "collaboration" },
			);
			// A hand-back answers the asking turn's own reply, the one that mentioned the helper.
			const handBack = await seedTurnAnswering(
				chatId,
				lead.id,
				{ bot: lead.id, turn: asking },
				{ reason: "hand_back" },
			);

			expect(await asBotForAsker(helperTurn)).toMatchObject({
				bot: helper.id,
				asker: samId,
				bounds: { kind: "chat", project: projectId },
			});
			expect(await asBotForAsker(handBack)).toMatchObject({ bot: lead.id, asker: samId });
		});

		it("keeps the original asker after nine successive hand-backs", async () => {
			const firstTurn = await seedTurnAnswering(
				chatId,
				lead.id,
				{ member: samId },
				{ status: "done" },
			);
			const handBack = await seedHandBacks(chatId, firstTurn);

			expect(await asBotForAsker(handBack)).toMatchObject({ bot: lead.id, asker: samId });
		});

		it("acts for whoever started a briefed chat, in chat bounds there", async () => {
			const briefed = await seedProjectChat(workspaceId, helper.defaultProject, samId);
			const turnId = await seedTurnAnswering(
				briefed,
				helper.id,
				{ bot: lead.id },
				{ reason: "brief" },
			);

			expect(await asBotForAsker(turnId)).toMatchObject({
				bot: helper.id,
				asker: samId,
				chat: briefed,
				bounds: { kind: "chat", project: helper.defaultProject },
			});
		});

		it("acts for the creator who opened a bot's interview, whose first message is its own reply", async () => {
			const creatorId = await seedMember(workspaceId, "editor");
			const created = await seedBot(workspaceId, { createdById: creatorId });
			const interview = await seedProjectChat(workspaceId, created.defaultProject, creatorId);
			const reply = await seedMessage(interview, { bot: created.id });
			const turnId = await seedTurn(interview, created.id, reply, { reason: "interview" });
			await onDatabase((db) => db.update(message).set({ turnId }).where(eq(message.id, reply)));

			expect(await asBotForAsker(turnId)).toMatchObject({
				asker: creatorId,
				bounds: { kind: "chat", project: created.defaultProject },
			});
		});

		it("gives a Personal Assistant member bounds on its own turns and on briefs written in member bounds", async () => {
			const assistant = await seedBot(workspaceId, { assistantOf: samId, visibility: "personal" });
			const own = await seedProjectChat(workspaceId, assistant.defaultProject, samId);
			const turnId = await seedTurnAnswering(own, assistant.id, { member: samId });
			const briefed = await seedTurnAnswering(
				own,
				assistant.id,
				{ bot: lead.id },
				{ reason: "brief" },
			);

			const memberBrief = await seedMessage(own, { bot: assistant.id });
			await onDatabase((db) =>
				db
					.update(message)
					.set({ briefTurnRule: "memberBounds" })
					.where(eq(message.id, memberBrief)),
			);
			const briefedWithMemberBounds = await seedTurn(own, assistant.id, memberBrief, {
				reason: "brief",
			});

			expect(await asBotForAsker(turnId)).toMatchObject({
				bot: assistant.id,
				asker: samId,
				bounds: { kind: "member" },
			});
			expect(await asBotForAsker(briefed)).toMatchObject({
				bounds: { kind: "chat", project: assistant.defaultProject },
			});
			expect(await asBotForAsker(briefedWithMemberBounds)).toMatchObject({
				bounds: { kind: "member" },
			});
		});
	});

	describe("a bot in an automation's run", () => {
		it("answers no member in the run's own turns, with the automation's project as bounds", async () => {
			const automationId = await seedAutomation(workspaceId, projectId);
			const run = await seedRun(workspaceId, automationId, lead.id, "routine");
			const turnId = await seedTurn(run.chat, lead.id, run.triggerMessage, {
				reason: "automation",
			});

			const principal = await authenticate(turnId);

			expect(principal._tag).toBe("AutomationRun");
			expect(principal).toMatchObject({
				workspace: workspaceId,
				bot: lead.id,
				automation: automationId,
				run: run.run,
				chat: run.chat,
				turn: turnId,
				bounds: { kind: "chat", project: projectId },
			});
		});

		it("gives a helper the run, and a member's message in the run's chat a turn for them", async () => {
			const automationId = await seedAutomation(workspaceId, projectId);
			const run = await seedRun(workspaceId, automationId, lead.id, "webhook");
			const asking = await seedTurn(run.chat, lead.id, run.triggerMessage, {
				reason: "automation",
			});
			const helperTurn = await seedTurnAnswering(
				run.chat,
				helper.id,
				{ bot: lead.id, turn: asking },
				{ reason: "collaboration" },
			);
			const forSam = await seedTurnAnswering(run.chat, lead.id, { member: samId });

			expect(await authenticate(helperTurn)).toMatchObject({
				_tag: "AutomationRun",
				bot: helper.id,
				run: run.run,
			});
			expect(await asBotForAsker(forSam)).toMatchObject({
				asker: samId,
				bounds: { kind: "chat", project: projectId },
			});
		});

		it("keeps the automation's run after nine successive hand-backs", async () => {
			const automationId = await seedAutomation(workspaceId, projectId);
			const run = await seedRun(workspaceId, automationId, lead.id, "webhook");
			const firstTurn = await seedTurn(run.chat, lead.id, run.triggerMessage, {
				reason: "automation",
				status: "done",
			});
			const handBack = await seedHandBacks(run.chat, firstTurn);

			expect(await authenticate(handBack)).toMatchObject({
				_tag: "AutomationRun",
				bot: lead.id,
				automation: automationId,
				run: run.run,
			});
		});

		it("acts for a Personal Assistant's member, in member bounds unless started from outside", async () => {
			const patId = await seedMember(workspaceId, "viewer");
			const assistant = await seedBot(workspaceId, { assistantOf: patId, visibility: "personal" });
			const automationId = await seedAutomation(workspaceId, assistant.defaultProject);
			const boundsOf = async (startedBy: "routine" | "manual" | "webhook" | "github") => {
				const run = await seedRun(workspaceId, automationId, assistant.id, startedBy);
				const turnId = await seedTurn(run.chat, assistant.id, run.triggerMessage, {
					reason: "automation",
				});
				const principal = await asBotForAsker(turnId);
				expect(principal.asker).toBe(patId);
				return principal.bounds;
			};

			expect(await boundsOf("routine")).toEqual({ kind: "member" });
			expect(await boundsOf("manual")).toEqual({ kind: "member" });
			expect(await boundsOf("webhook")).toEqual({
				kind: "chat",
				project: assistant.defaultProject,
			});
			expect(await boundsOf("github")).toEqual({ kind: "chat", project: assistant.defaultProject });
		});
	});

	describe("a turn with nobody to act for", () => {
		it("refuses a turn that doesn't exist", async () => {
			for (const turnId of [randomUUID(), "not-an-id"]) {
				await expect(authenticate(turnId)).rejects.toMatchObject({
					_tag: "TurnUnavailable",
					reason: "missing",
				});
			}
		});

		it("refuses a turn in a chat in no project", async () => {
			const compactor = await seedBot(workspaceId, { systemBotKey: "compact" });
			const systemChatId = randomUUID();
			await runOnPostgres(
				transaction(
					Effect.gen(function* () {
						yield* query((db) =>
							db.insert(chat).values({
								id: systemChatId,
								workspaceId,
								kind: "system_chat",
								title: "Compaction",
							}),
						);
						yield* query((db) =>
							db.insert(systemChat).values({
								chatId: systemChatId,
								workspaceId,
								botId: compactor.id,
								systemBotKey: "compact",
								servedChatId: chatId,
							}),
						);
					}),
				),
			);
			const turnId = await seedTurnAnswering(systemChatId, compactor.id, { bot: compactor.id });

			await expect(authenticate(turnId)).rejects.toMatchObject({
				_tag: "TurnUnavailable",
				reason: "inNoProject",
			});
		});

		it("refuses a turn answering an automation's message outside a run", async () => {
			const automationId = await seedAutomation(workspaceId, projectId);
			const run = await seedRun(workspaceId, automationId, lead.id, "routine");
			const turnId = await seedTurnAnswering(chatId, lead.id, {
				run: run.run,
				triggerKind: "routine",
			});

			await expect(authenticate(turnId)).rejects.toMatchObject({
				_tag: "TurnUnavailable",
				reason: "noAsker",
			});
		});
	});

	it("builds each principal in its turn's own workspace", async () => {
		const otherWorkspace = await seedWorkspace();
		const sam = await seedMember(otherWorkspace, "admin");
		const otherLead = await seedBot(otherWorkspace);
		const otherProject = await seedProject(otherWorkspace, { leadBotId: otherLead.id });
		const otherChat = await seedProjectChat(otherWorkspace, otherProject, sam);
		const turnId = await seedTurnAnswering(otherChat, otherLead.id, { member: sam });

		expect(await asBotForAsker(turnId)).toMatchObject({
			workspace: otherWorkspace,
			bounds: { kind: "chat", project: otherProject },
		});
	});
});
