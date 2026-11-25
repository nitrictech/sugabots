import { randomUUID } from "node:crypto";
import { FILE_WRITE_TOOL, START_CHAT_TOOL } from "@sugabots/contracts";
import { seedProject, seedProjectChat } from "@sugabots/core/authentication/seed.test-support";
import { aChatWithConnectorAwaitingReply, runningTurns } from "@sugabots/core/chats/turns/testing";
import {
	automation,
	bot,
	chat,
	file,
	placedChat,
	projectChat,
	toolCall,
	turn,
} from "@sugabots/core/database/schema";
import { closeDatabase, onDatabase, runOnPostgres } from "@sugabots/core/database/testing";
import { asMember } from "@sugabots/core/operations/chats/testing";
import { operationsForTests } from "@sugabots/core/operations/testing";
import type { BotPrincipal } from "@sugabots/core/principal";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { botLoopOnPostgres, type ScriptedStep, scriptedSteps } from "./testing.ts";

/**
 * A tool call's writes once its turn was asked to end: an interrupt that
 * commits while the call is in flight stops each kind of write the call would
 * make on the turn's behalf, though the turn's own step has yet to hear it.
 */
describe.skipIf(!process.env.DATABASE_URL)("a tool's writes after an interrupt", async () => {
	const loop = await botLoopOnPostgres([]);
	const chatsAs = (memberId: string) => asMember(loop.call, memberId);
	const operations = await operationsForTests({ chats: loop.services });
	let chatId: string;
	let workspaceId: string;
	let botId: string;
	let adminId: string;
	let connectorId: string;
	let projectId: string;

	afterAll(closeDatabase);

	beforeEach(async () => {
		({ chatId, workspaceId, botId, adminId, connectorId } =
			await aChatWithConnectorAwaitingReply(chatsAs));
		const [placed] = await onDatabase((db) =>
			db
				.select({ projectId: placedChat.projectId })
				.from(placedChat)
				.where(eq(placedChat.id, chatId)),
		);
		if (!placed?.projectId) throw new Error("The test chat has no project");
		projectId = placed.projectId;
	});

	const callsOf = (turnId: string) =>
		onDatabase((db) => db.select().from(toolCall).where(eq(toolCall.turnId, turnId)));

	/**
	 * Its asker interrupts the turn `turnId` while its step runs a call: still
	 * running, it was asked to end, and the step has yet to hear it.
	 */
	const interruptMidStep = (turnId: string) =>
		onDatabase((db) =>
			db
				.update(turn)
				.set({ status: "running", endRequested: "interrupted" })
				.where(eq(turn.id, turnId)),
		);

	/**
	 * Runs the turn until it parks `step`'s one call, which its asker allows,
	 * and is then interrupted as its next step makes the call: the call's
	 * principal, and what was approved.
	 */
	const allowedThenInterrupted = async (step: ScriptedStep) => {
		const { model } = scriptedSteps(step, { text: ["Done."] });
		const ran = await loop.runTurn(chatId, { model });
		const [parked] = await callsOf(ran.turnId);
		if (!parked) throw new Error("No call parked");
		expect(parked.approvalStatus).toBe("pending");
		await chatsAs(adminId).decide({ toolCallId: parked.id, decision: "allow_once" });
		const principal = await ran.authentication.authenticate(ran.turnId);
		await interruptMidStep(ran.turnId);
		return {
			principal,
			input: parked.executionInput,
			call: { kind: "toolCall", toolCall: parked.id } as const,
		};
	};

	/** Opens the turn waiting in `inChat`, which is then interrupted mid-step: its principal. */
	const runningThenInterrupted = async (inChat = chatId): Promise<BotPrincipal> => {
		const [run] = await runOnPostgres(runningTurns(inChat));
		if (!run) throw new Error("no turn running");
		const { steps, authentication } = await loop.loopOver({ model: scriptedSteps().model });
		const opened = await steps.open(run.request, 0);
		if (opened._tag !== "Opened") throw new Error("the turn may not run");
		const principal = await authentication.authenticate(opened.turnId);
		await interruptMidStep(opened.turnId);
		return principal;
	};

	const refusedAsEnded = { _tag: "TurnEnded" };

	it("starts no briefed chat", async () => {
		const { principal, input, call } = await allowedThenInterrupted({
			calls: [
				{
					toolCallId: "brief",
					toolName: START_CHAT_TOOL,
					input: { title: "Report", brief: "Draft it." },
				},
			],
		});

		await expect(
			runOnPostgres(
				operations["chats.startBriefedChat"](
					principal,
					input as { title: string; brief: string },
					call,
				),
			),
		).rejects.toMatchObject(refusedAsEnded);
		expect(
			await onDatabase((db) => db.select().from(chat).where(eq(chat.workspaceId, workspaceId))),
		).toHaveLength(1);
	});

	it("leaves the chat unresolved", async () => {
		const inProject = await seedProjectChat(
			workspaceId,
			await seedProject(workspaceId, { leadBotId: botId, members: [adminId] }),
			adminId,
		);
		await chatsAs(adminId).send({
			chatId: inProject,
			retryKey: randomUUID(),
			message: "Resolve this, please.",
		});
		const principal = await runningThenInterrupted(inProject);

		await expect(
			runOnPostgres(
				operations["chats.setResolved"](
					principal,
					{ chatId: inProject, resolved: true },
					{ kind: "toolCall", toolCall: randomUUID() },
				),
			),
		).rejects.toMatchObject(refusedAsEnded);
		const [unchanged] = await onDatabase((db) =>
			db
				.select({ resolvedAt: projectChat.resolvedAt })
				.from(projectChat)
				.where(eq(projectChat.chatId, inProject)),
		);
		expect(unchanged).toEqual({ resolvedAt: null });
	});

	it("creates no automation", async () => {
		const standup = {
			name: "Morning standup",
			instructions: "Ask the team what they are working on today.",
			routineExpression: "0 9 * * 1-5",
		};
		const { principal, input, call } = await allowedThenInterrupted({
			calls: [{ toolCallId: "automation", toolName: "create_automation", input: standup }],
		});

		await expect(
			runOnPostgres(
				operations["automations.createWithRoutine"](principal, input as typeof standup, call),
			),
		).rejects.toMatchObject(refusedAsEnded);
		expect(
			await onDatabase((db) =>
				db.select().from(automation).where(eq(automation.projectId, projectId)),
			),
		).toEqual([]);
	});

	it("writes no file", async () => {
		// A Personal Assistant asks its member before it writes a file.
		await onDatabase((db) =>
			db.update(bot).set({ assistantOf: adminId, visibility: "personal" }).where(eq(bot.id, botId)),
		);
		const { principal, input, call } = await allowedThenInterrupted({
			calls: [
				{
					toolCallId: "write-notes",
					toolName: FILE_WRITE_TOOL,
					input: { kind: "markdown", title: "Notes", content: "# Notes" },
				},
			],
		});

		await expect(
			runOnPostgres(
				operations["files.write"](
					principal,
					input as { kind: "markdown"; title: string; content: string },
					call,
				),
			),
		).rejects.toMatchObject(refusedAsEnded);
		expect(await onDatabase((db) => db.select().from(file).where(eq(file.chatId, chatId)))).toEqual(
			[],
		);
	});

	it("calls no connector tool", async () => {
		const principal = await runningThenInterrupted();

		await expect(
			runOnPostgres(
				operations["connectors.callTool"](
					principal,
					{ connectorId, tool: "wipe", arguments: {} },
					{ kind: "toolCall", toolCall: randomUUID() },
				),
			),
		).rejects.toMatchObject(refusedAsEnded);
	});
});
