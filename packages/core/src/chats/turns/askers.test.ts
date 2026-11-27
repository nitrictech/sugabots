import { randomUUID } from "node:crypto";
import type { RunTriggerKind } from "@sugabots/contracts";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
	seedAutomation,
	seedBot,
	seedMember,
	seedMessage,
	seedProject,
	seedProjectChat,
	seedRun,
	seedTurn,
	seedWorkspace,
} from "../../authentication/seed.test-support.ts";
import { bot, type TurnReason, turn } from "../../database/schema.ts";
import { closeDatabase, onDatabase } from "../../database/testing.ts";
import { chatServicesForTests } from "../testing.ts";
import { openTurn, runOver } from "./testing.ts";

/**
 * Who each kind of turn acts for, as the turn store writes it when it makes
 * the turn: its asker, and whether its automation's trigger asked for it.
 */
describe.skipIf(!process.env.DATABASE_URL)("the asker a turn stores", async () => {
	const services = await chatServicesForTests({ publishCommitted: async () => undefined });
	const run = runOver(services);
	let workspaceId: string;
	let sam: string;
	let botId: string;
	let helperId: string;
	let chatId: string;

	afterAll(async () => {
		await closeDatabase();
	});

	const withModel = async (id: string) => {
		await onDatabase((db) => db.update(bot).set({ model: "m" }).where(eq(bot.id, id)));
		return id;
	};

	beforeEach(async () => {
		workspaceId = await seedWorkspace();
		sam = await seedMember(workspaceId, "editor");
		botId = await withModel((await seedBot(workspaceId)).id);
		helperId = await withModel((await seedBot(workspaceId)).id);
		const projectId = await seedProject(workspaceId, {
			leadBotId: botId,
			members: [sam],
			bots: [helperId],
		});
		chatId = await seedProjectChat(workspaceId, projectId, sam);
	});

	/** Opens the bot `onBot`'s turn on `triggerMessageId` in `inChat`, as its workflow does, and reads what it stored. */
	const askerOfTurnOn = async (
		triggerMessageId: string,
		reason: TurnReason,
		{ inChat = chatId, onBot = botId }: { inChat?: string; onBot?: string } = {},
	) => {
		const opened = await run(
			openTurn({
				executionId: randomUUID(),
				request: { chatId: inChat, botId: onBot, triggerMessageId, reason },
			}),
		);
		const [stored] = await onDatabase((db) =>
			db
				.select({ askerId: turn.askerId, askedByAutomation: turn.askedByAutomation })
				.from(turn)
				.where(eq(turn.id, opened.turnId)),
		);
		return stored;
	};

	/** The bot's reply, written by its turn answering `sam`'s message, which asks or hands back. */
	const replyOfTurnForSam = async () => {
		const asked = await seedMessage(chatId, { member: sam });
		const asking = await seedTurn(chatId, botId, asked);
		return seedMessage(chatId, { bot: botId, turn: asking });
	};

	it("acts for the member whose message it answers", async () => {
		expect(await askerOfTurnOn(await seedMessage(chatId, { member: sam }), "mention")).toEqual({
			askerId: sam,
			askedByAutomation: false,
		});
	});

	it("acts for the asking turn's asker as a helper", async () => {
		expect(
			await askerOfTurnOn(await replyOfTurnForSam(), "collaboration", { onBot: helperId }),
		).toEqual({ askerId: sam, askedByAutomation: false });
	});

	it("acts for the asking turn's asker as a hand-back", async () => {
		expect(await askerOfTurnOn(await replyOfTurnForSam(), "hand_back")).toEqual({
			askerId: sam,
			askedByAutomation: false,
		});
	});

	it("acts for the member who started the chat a brief started", async () => {
		const brief = await seedMessage(chatId, { bot: helperId });
		expect(await askerOfTurnOn(brief, "brief")).toEqual({ askerId: sam, askedByAutomation: false });
	});

	it("acts for the member who started the chat as an interview, which answers its own first reply", async () => {
		const own = await seedBot(workspaceId, { createdById: sam });
		const interviewing = await seedProjectChat(workspaceId, own.defaultProject, sam);
		expect(
			await askerOfTurnOn(randomUUID(), "interview", {
				inChat: interviewing,
				onBot: await withModel(own.id),
			}),
		).toEqual({ askerId: sam, askedByAutomation: false });
	});

	it.each(["routine", "manual", "webhook"] satisfies RunTriggerKind[])(
		"acts for a Personal Assistant's member in its %s run",
		async (startedBy) => {
			const assistant = await seedBot(workspaceId, { assistantOf: sam, visibility: "personal" });
			await withModel(assistant.id);
			const automationId = await seedAutomation(workspaceId, assistant.defaultProject);
			const started = await seedRun(workspaceId, automationId, assistant.id, startedBy);
			expect(
				await askerOfTurnOn(started.triggerMessage, "automation", {
					inChat: started.chat,
					onBot: assistant.id,
				}),
			).toEqual({ askerId: sam, askedByAutomation: true });
		},
	);

	it("acts for no member in another bot's automation run", async () => {
		const own = await seedBot(workspaceId, { createdById: sam });
		await withModel(own.id);
		const automationId = await seedAutomation(workspaceId, own.defaultProject);
		const started = await seedRun(workspaceId, automationId, own.id, "routine");
		expect(
			await askerOfTurnOn(started.triggerMessage, "automation", {
				inChat: started.chat,
				onBot: own.id,
			}),
		).toEqual({ askerId: null, askedByAutomation: true });
	});
});
