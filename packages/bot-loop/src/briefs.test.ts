import { botStartedChatSchema, FILE_WRITE_TOOL, START_CHAT_TOOL } from "@sugabots/contracts";
import { BotHasNoModel } from "@sugabots/contracts/errors/chats";
import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import {
	seedBot,
	seedMember,
	seedMessage,
	seedProject,
	seedProjectChat,
	seedTurnAnswering,
} from "@sugabots/core/authentication/seed.test-support";
import { startBotChat } from "@sugabots/core/chats/chats/testing";
import { aChatAwaitingReply, runningTurns } from "@sugabots/core/chats/turns/testing";
import { Turns } from "@sugabots/core/chats/turns/turns";
import type { CommittedEvent } from "@sugabots/core/database/events/outbox";
import {
	bot,
	chatParticipant,
	message,
	placedChat,
	project,
	projectBot,
} from "@sugabots/core/database/schema";
import { closeDatabase, onDatabase, runOnPostgres } from "@sugabots/core/database/testing";
import { asMember } from "@sugabots/core/operations/chats/testing";
import { operationsForTests } from "@sugabots/core/operations/testing";
import { and, eq } from "drizzle-orm";
import { Context, Schema } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
	botLoopOnPostgres,
	calling,
	callsOf,
	parkedCallOf,
	resumeAt,
	scriptedSteps,
} from "./testing.ts";

/**
 * Briefs through the bot loop on Postgres: start_chat, which starts a chat
 * with another bot once its asker approves, and the approval rule a brief
 * carries into the briefed bot's turn.
 */
describe.skipIf(!process.env.DATABASE_URL)("a turn's briefs, against Postgres", async () => {
	const delivered: CommittedEvent[] = [];
	let afterCommit: ((events: readonly CommittedEvent[]) => Promise<void>) | undefined;
	const loop = await botLoopOnPostgres(delivered, async (events) => afterCommit?.(events));
	const chatsAs = (memberId: string) => asMember(loop.call, memberId);
	const operations = await operationsForTests({ chats: loop.services });
	let chatId: string;
	let workspaceId: string;
	let botId: string;
	let adminId: string;

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		({ chatId, workspaceId, botId, adminId } = await aChatAwaitingReply(chatsAs));
		delivered.length = 0;
		afterCommit = undefined;
	});

	it.each(["mark_resolved", FILE_WRITE_TOOL])(
		"a brief carries its Personal Assistant's approval rule into an ordinary bot's %s call",
		async (toolName) => {
			const assistant = await seedBot(workspaceId, {
				assistantOf: adminId,
				visibility: "personal",
			});
			await onDatabase((db) => db.update(bot).set({ model: "m" }).where(eq(bot.id, assistant.id)));
			const [recipient] = await onDatabase((db) =>
				db.select({ handle: bot.handle }).from(bot).where(eq(bot.id, botId)),
			);
			if (!recipient) throw new Error("No recipient");
			const source = await startBotChat(chatsAs(adminId), {
				botId: assistant.id,
				messageId: crypto.randomUUID(),
				content: "Ask for a separate report.",
			});
			const briefing = calling(START_CHAT_TOOL, {
				with: recipient.handle,
				title: "Report",
				brief: "Finish the report.",
			});
			const parent = await loop.runTurn(source.chat.id, briefing);
			const [brief] = await callsOf(parent.turnId);
			if (!brief) throw new Error("No brief call");
			expect(brief.approvalStatus).toBe("pending");
			await chatsAs(adminId).decide({ toolCallId: brief.id, decision: "allow_once" });
			expect(await resumeAt(parent, 1)).toEqual({ _tag: "Finished" });
			const [started] = await callsOf(parent.turnId);
			const { chat } = Schema.decodeUnknownSync(Schema.Struct({ chat: botStartedChatSchema }))(
				started?.output,
			);

			const input =
				toolName === FILE_WRITE_TOOL
					? { kind: "markdown", title: "Report", content: "# Report" }
					: { chatId: chat.id, resolved: true };
			const child = calling(toolName, input);
			const ran = await loop.runTurn(chat.id, child);
			const [parked] = await callsOf(ran.turnId);
			if (!parked) throw new Error("No call waiting for approval");
			expect(child.requests[0]?.tools).toHaveProperty(toolName);
			expect(ran.outcomes).toEqual([
				{ _tag: "Waiting", approvals: [parked.approvalId], taken: true },
			]);
			expect(parked).toMatchObject({ tool: toolName, approvalStatus: "pending" });
			await chatsAs(adminId).decide({ toolCallId: parked.id, decision: "allow_once" });
			expect(await resumeAt(ran, 1)).toEqual({ _tag: "Finished" });
			expect(await callsOf(ran.turnId)).toMatchObject([
				{ status: "completed", decidedById: adminId },
			]);
		},
	);

	it.each([
		"the asking project",
		"the recipient's default project",
		"the asker's Personal Assistant's default project",
	])("starts a brief in %s only after its asker approves", async (destination) => {
		const toAssistant = destination === "the asker's Personal Assistant's default project";
		if (toAssistant) {
			const other = await seedMember(workspaceId, "editor");
			const otherAssistant = await seedBot(workspaceId, {
				assistantOf: other,
				visibility: "personal",
			});
			await onDatabase((db) =>
				db
					.update(bot)
					.set({ handle: "personal-assistant-2", model: "m" })
					.where(eq(bot.id, otherAssistant.id)),
			);
		}
		const recipient = await seedBot(workspaceId, {
			createdById: adminId,
			...(toAssistant && {
				assistantOf: adminId,
				visibility: "personal" as const,
			}),
		});
		const [target] = await onDatabase((db) =>
			db
				.update(bot)
				.set({ model: "m", ...(toAssistant && { handle: "personal-assistant-2" }) })
				.where(eq(bot.id, recipient.id))
				.returning(),
		);
		if (!target) throw new Error("No recipient bot");
		let source = chatId;
		let expectedProject = recipient.defaultProject;
		const projectName = destination === "the asking project" ? "Launch" : null;
		if (projectName) {
			expectedProject = await seedProject(workspaceId, {
				leadBotId: botId,
				bots: [recipient.id],
			});
			await onDatabase((db) =>
				db.update(project).set({ name: projectName }).where(eq(project.id, expectedProject)),
			);
			const started = await chatsAs(adminId).startProjectChat({
				projectId: expectedProject,
				retryKey: crypto.randomUUID(),
				message: "Ask the other bot to draft the report.",
			});
			source = started.chat.id;
		}
		const input = {
			title: "Draft the report",
			brief: "Summarize the March refunds.",
			with: `@${target.handle}`,
		};
		const { model, requests } = scriptedSteps(
			{
				calls: [
					{
						toolCallId: "brief",
						toolName: START_CHAT_TOOL,
						input: { ...input, brief: `  ${input.brief}  ` },
					},
				],
			},
			{ text: ["Started."] },
		);
		const ran = await loop.runTurn(source, { model });

		const [parked] = await callsOf(ran.turnId);
		if (!parked) throw new Error("No call parked");
		expect(ran.outcomes).toEqual([
			{ _tag: "Waiting", approvals: [parked.approvalId], taken: true },
		]);
		expect(parked).toMatchObject({ tool: START_CHAT_TOOL, approvalStatus: "pending", input });
		if (projectName) {
			await onDatabase((db) =>
				db.update(project).set({ name: "Release" }).where(eq(project.id, expectedProject)),
			);
		}
		expect((await chatsAs(adminId).approvals(workspaceId)).waiting).toContainEqual(
			expect.objectContaining({
				call: expect.objectContaining({
					id: parked.id,
					approval: expect.objectContaining({
						briefDestination: { botName: target.name, projectName },
					}),
				}),
			}),
		);
		const startedChats = () =>
			onDatabase((db) =>
				db
					.select()
					.from(placedChat)
					.where(and(eq(placedChat.workspaceId, workspaceId), eq(placedChat.title, input.title))),
			);
		expect(await startedChats()).toEqual([]);

		await chatsAs(adminId).decide({ toolCallId: parked.id, decision: "allow_once" });
		const principal = await ran.authentication.authenticate(ran.turnId);
		expect(
			await ran.steps.step(ran.run.request, principal, {
				turnId: ran.turnId,
				attempt: 0,
				step: 1,
			}),
		).toEqual({ _tag: "Finished" });

		const [started] = await startedChats();
		if (!started) throw new Error("No briefed chat");
		expect(started).toMatchObject({ projectId: expectedProject, startedById: adminId });
		expect(
			await onDatabase((db) =>
				db.select().from(chatParticipant).where(eq(chatParticipant.chatId, started.id)),
			),
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ memberId: adminId }),
				expect.objectContaining({ botId: recipient.id }),
			]),
		);
		expect(
			await onDatabase((db) => db.select().from(message).where(eq(message.chatId, started.id))),
		).toMatchObject([{ authorBotId: botId, content: input.brief }]);
		expect(await runOnPostgres(runningTurns(started.id))).toMatchObject([
			{ request: { botId: recipient.id, reason: "brief" } },
		]);
		const [completed] = await callsOf(ran.turnId);
		expect(completed).toMatchObject({ approvalStatus: "allowed", status: "completed" });
		const { chat } = Schema.decodeUnknownSync(Schema.Struct({ chat: botStartedChatSchema }))(
			completed?.output,
		);
		expect(chat).toEqual({
			id: started.id,
			title: input.title,
			with: target.name,
			withBotId: recipient.id,
		});
		expect(JSON.stringify(requests[1]?.continuationMessages)).toContain(started.id);
	});

	it("asks again when the recipient changes projects before the tool call starts", async () => {
		const recipient = await seedBot(workspaceId, { createdById: adminId });
		const [target] = await onDatabase((db) =>
			db.update(bot).set({ model: "m" }).where(eq(bot.id, recipient.id)).returning(),
		);
		if (!target) throw new Error("No recipient bot");
		const projectId = await seedProject(workspaceId, {
			leadBotId: botId,
			bots: [recipient.id],
			members: [adminId],
		});
		const asked = await chatsAs(adminId).startProjectChat({
			projectId,
			retryKey: crypto.randomUUID(),
			message: "Ask the other bot to draft the report.",
		});
		const input = { title: "Draft the report", brief: "Summarize it.", with: `@${target.handle}` };
		const { model } = scriptedSteps(
			{ calls: [{ toolCallId: "brief", toolName: START_CHAT_TOOL, input }] },
			{ text: ["Started."] },
		);
		const ran = await loop.runTurn(asked.chat.id, { model });
		const [parked] = await callsOf(ran.turnId);
		if (!parked) throw new Error("No call parked");
		await chatsAs(adminId).decide({ toolCallId: parked.id, decision: "allow_once" });
		const principal = await ran.authentication.authenticate(ran.turnId);

		await onDatabase((db) =>
			db
				.delete(projectBot)
				.where(and(eq(projectBot.projectId, projectId), eq(projectBot.botId, recipient.id))),
		);
		const briefing = runOnPostgres(
			operations["chats.startBriefedChat"](principal, input, {
				kind: "toolCall",
				toolCall: parked.id,
			}),
		);

		await expect(briefing).rejects.toMatchObject({ _tag: "ApprovalNeeded" });
		expect(
			await onDatabase((db) =>
				db
					.select()
					.from(placedChat)
					.where(and(eq(placedChat.workspaceId, workspaceId), eq(placedChat.title, input.title))),
			),
		).toEqual([]);
	});

	it("closes a brief approval and wakes its turn if the handle now names another bot", async () => {
		const original = await seedBot(workspaceId, { createdById: adminId });
		const replacement = await seedBot(workspaceId, { createdById: adminId });
		await onDatabase((db) =>
			db.update(bot).set({ model: "m", handle: "report-writer" }).where(eq(bot.id, original.id)),
		);
		const input = { title: "Draft the report", brief: "Summarize it.", with: "@report-writer" };
		const { model, requests } = calling(START_CHAT_TOOL, input);
		const workflow = await loop.runWorkflow(chatId, { model });
		await workflow.suspended();
		const { turnId, parked } = await parkedCallOf(workflow.executionId);
		expect(parked.approvalStatus).toBe("pending");

		await onDatabase((db) =>
			db.update(bot).set({ handle: "report-writer-old" }).where(eq(bot.id, original.id)),
		);
		await onDatabase((db) =>
			db.update(bot).set({ model: "m", handle: "report-writer" }).where(eq(bot.id, replacement.id)),
		);

		const error = "This approval was closed because the chat the bot wanted to start changed.";
		await expect(
			chatsAs(adminId).decide({ toolCallId: parked.id, decision: "allow_once" }),
		).rejects.toMatchObject({ userMessage: error });
		await workflow.completed();
		expect(await callsOf(turnId)).toMatchObject([
			{ id: parked.id, status: "failed", approvalStatus: "denied", decidedById: null, error },
		]);
		expect(JSON.stringify(requests[1]?.continuationMessages)).toContain(error);
		expect(
			await onDatabase((db) =>
				db
					.select()
					.from(placedChat)
					.where(and(eq(placedChat.workspaceId, workspaceId), eq(placedChat.title, input.title))),
			),
		).toEqual([]);
	});

	it("asks again when the brief's handle names another bot by the time it runs", async () => {
		const [approvedBot, otherBot] = await Promise.all([
			seedBot(workspaceId, { createdById: adminId }),
			seedBot(workspaceId, { createdById: adminId }),
		]);
		await onDatabase((db) =>
			db.update(bot).set({ model: "m", handle: "report-writer" }).where(eq(bot.id, approvedBot.id)),
		);
		await onDatabase((db) => db.update(bot).set({ model: "m" }).where(eq(bot.id, otherBot.id)));
		const input = { title: "Draft the report", brief: "Summarize it.", with: "@report-writer" };
		const { model } = scriptedSteps(
			{ calls: [{ toolCallId: "brief", toolName: START_CHAT_TOOL, input }] },
			{ text: ["Started."] },
		);
		const ran = await loop.runTurn(chatId, { model });
		const [parked] = await callsOf(ran.turnId);
		if (!parked) throw new Error("No call parked");
		await chatsAs(adminId).decide({ toolCallId: parked.id, decision: "allow_once" });

		// The handle moves to another bot after its asker allowed the brief.
		await onDatabase((db) =>
			db.update(bot).set({ handle: "report-writer-old" }).where(eq(bot.id, approvedBot.id)),
		);
		await onDatabase((db) =>
			db.update(bot).set({ handle: "report-writer" }).where(eq(bot.id, otherBot.id)),
		);
		const principal = await ran.authentication.authenticate(ran.turnId);
		await ran.steps.step(ran.run.request, principal, { turnId: ran.turnId, attempt: 0, step: 1 });

		expect(
			await onDatabase((db) =>
				db
					.select()
					.from(placedChat)
					.where(and(eq(placedChat.workspaceId, workspaceId), eq(placedChat.title, input.title))),
			),
		).toEqual([]);
		expect(await callsOf(ran.turnId)).toMatchObject([
			{ tool: START_CHAT_TOOL, approvalStatus: "pending" },
		]);
	});

	it.each(["unknown", "missing a model"])(
		"refuses a brief without waiting when the recipient is %s",
		async (recipient) => {
			let handle = "@unknown-bot";
			let error = new ResourceHidden({ resource: "bot" }).userMessage;
			if (recipient === "missing a model") {
				const target = await seedBot(workspaceId, { createdById: adminId });
				const [row] = await onDatabase((db) =>
					db.select({ handle: bot.handle }).from(bot).where(eq(bot.id, target.id)),
				);
				if (!row) throw new Error("No recipient bot");
				handle = row.handle;
				error = new BotHasNoModel().userMessage;
			}
			const { model, requests } = scriptedSteps(
				{
					calls: [
						{
							toolCallId: "brief",
							toolName: START_CHAT_TOOL,
							input: { title: "Report", brief: "Draft it.", with: handle },
						},
					],
				},
				{ text: ["I couldn't start the chat."] },
			);

			const ran = await loop.runTurn(chatId, { model });

			expect(ran.outcomes).toEqual([{ _tag: "Continue" }, { _tag: "Finished" }]);
			expect(await callsOf(ran.turnId)).toMatchObject([
				{ tool: START_CHAT_TOOL, approvalStatus: null, status: "failed", error },
			]);
			expect(JSON.stringify(requests[1]?.continuationMessages)).toContain(error);
		},
	);

	it.each(["brief", "collaboration"] as const)(
		"withholds start_chat from a %s turn",
		async (reason) => {
			const projectId = await seedProject(workspaceId, { leadBotId: botId });
			const source = await seedProjectChat(workspaceId, projectId, adminId);
			const parent =
				reason === "collaboration"
					? await seedTurnAnswering(source, botId, { member: adminId }, { status: "done" })
					: undefined;
			const triggerMessageId = await seedMessage(source, {
				bot: botId,
				...(parent && { turn: parent }),
			});
			await runOnPostgres(
				Context.get(loop.services, Turns.Service).ask({
					chatId: source,
					botId,
					triggerMessageId,
					reason,
				}),
			);
			const input = { title: "Report", brief: "Draft it." };
			const { model, requests } = scriptedSteps(
				{ calls: [{ toolCallId: "brief", toolName: START_CHAT_TOOL, input }] },
				{ text: ["I couldn't start the chat."] },
			);

			const ran = await loop.runTurn(source, { model });

			expect(requests[0]?.tools).not.toHaveProperty(START_CHAT_TOOL);
			expect(ran.outcomes).toEqual([{ _tag: "Continue" }, { _tag: "Finished" }]);
			expect(await callsOf(ran.turnId)).toEqual([]);
			await expect(loop.call(ran.principal, "chats.startBriefedChat", input)).rejects.toMatchObject(
				{
					_tag: "ResourceHidden",
				},
			);
		},
	);
});
