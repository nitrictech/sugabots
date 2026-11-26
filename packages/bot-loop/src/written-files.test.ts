import {
	FILE_EDIT_TOOL,
	FILE_LIST_TOOL,
	FILE_READ_TOOL,
	FILE_WRITE_TOOL,
} from "@sugabots/contracts";
import {
	ActionForbidden,
	ApprovalRefused,
	ResourceHidden,
} from "@sugabots/contracts/errors/proofs";
import {
	seedAutomation,
	seedBot,
	seedProject,
	seedProjectChat,
	seedRun,
} from "@sugabots/core/authentication/seed.test-support";
import { aChatAwaitingReply } from "@sugabots/core/chats/turns/testing";
import { Turns } from "@sugabots/core/chats/turns/turns";
import {
	bot,
	file,
	membership,
	placedChat,
	project,
	projectBot,
	toolCall,
} from "@sugabots/core/database/schema";
import { closeDatabase, onDatabase, runOnPostgres } from "@sugabots/core/database/testing";
import { Files } from "@sugabots/core/files/files";
import { asMember } from "@sugabots/core/operations/chats/testing";
import { operationsForTests } from "@sugabots/core/operations/testing";
import { and, eq } from "drizzle-orm";
import { Context } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { botLoopOnPostgres, scriptedSteps } from "./testing.ts";

describe.skipIf(!process.env.DATABASE_URL)("written file tools, against Postgres", async () => {
	const loop = await botLoopOnPostgres([]);
	const chatsAs = (memberId: string) => asMember(loop.call, memberId);
	let chatId: string;
	let workspaceId: string;
	let botId: string;
	let adminId: string;

	beforeEach(async () => {
		({ chatId, workspaceId, botId, adminId } = await aChatAwaitingReply(chatsAs));
	});

	afterAll(closeDatabase);

	const callsOf = (turnId: string) =>
		onDatabase((db) => db.select().from(toolCall).where(eq(toolCall.turnId, turnId)));

	const filesIn = (source: string) =>
		onDatabase((db) => db.select().from(file).where(eq(file.chatId, source)));

	const defaultProject = async () => {
		const [chat] = await onDatabase((db) =>
			db
				.select({ projectId: placedChat.projectId })
				.from(placedChat)
				.where(eq(placedChat.id, chatId)),
		);
		if (!chat?.projectId) throw new Error("The test chat has no project");
		return chat.projectId;
	};

	const makePersonalAssistant = () =>
		onDatabase((db) =>
			db.update(bot).set({ assistantOf: adminId, visibility: "personal" }).where(eq(bot.id, botId)),
		);

	const queueRun = async (projectId: string, trigger: Parameters<typeof seedRun>[3]) => {
		const automationId = await seedAutomation(workspaceId, projectId);
		const started = await seedRun(workspaceId, automationId, botId, trigger);
		await runOnPostgres(
			Context.get(loop.services, Turns.Service).ask({
				chatId: started.chat,
				botId,
				triggerMessageId: started.triggerMessage,
				reason: "automation",
			}),
		);
		return started.chat;
	};

	it("asks a Personal Assistant's member before creating a written file", async () => {
		await makePersonalAssistant();
		const input = { kind: "markdown", title: "  Notes  ", content: "# Notes" };
		const { model, requests } = scriptedSteps(
			{ calls: [{ toolCallId: "write-notes", toolName: FILE_WRITE_TOOL, input }] },
			{ text: ["Done."] },
		);
		const ran = await loop.runTurn(chatId, { model });
		expect(requests[0]?.tools).toHaveProperty(FILE_WRITE_TOOL);
		expect(ran.outcomes[0]).toMatchObject({ _tag: "Waiting" });
		const [parked] = await callsOf(ran.turnId);
		if (!parked) throw new Error("No file write parked");
		expect(parked).toMatchObject({
			tool: FILE_WRITE_TOOL,
			status: "awaiting_approval",
			approvalStatus: "pending",
			executionInput: { ...input, title: "Notes" },
		});
		expect(await filesIn(chatId)).toEqual([]);

		await chatsAs(adminId).decide({ toolCallId: parked.id, decision: "allow_once" });
		const principal = await ran.authentication.authenticate(ran.turnId);
		const operations = await operationsForTests({ chats: loop.services });
		await expect(
			runOnPostgres(
				operations["files.write"](
					principal,
					{ kind: "markdown", title: "Notes", content: "# Changed after approval" },
					{ kind: "toolCall", toolCall: parked.id },
				),
			),
		).rejects.toBeInstanceOf(ApprovalRefused);
		expect(
			await ran.steps.step(ran.run.request, principal, {
				turnId: ran.turnId,
				attempt: 0,
				step: 1,
			}),
		).toEqual({ _tag: "Finished" });
		const [made] = await filesIn(chatId);
		expect(made).toMatchObject({ name: "Notes", currentVersion: 1 });
		expect(await callsOf(ran.turnId)).toMatchObject([
			{
				id: parked.id,
				status: "completed",
				output: {
					status: "written",
					fileId: made?.id,
					kind: "markdown",
					title: "Notes",
					version: 1,
				},
			},
		]);
		expect(JSON.stringify(requests[1]?.continuationMessages)).toContain('"status":"written"');
	}, 15_000);

	it("writes a report in a routine run without approval", async () => {
		const projectId = await seedProject(workspaceId, { leadBotId: botId });
		const runChat = await queueRun(projectId, "routine");
		const { model, requests } = scriptedSteps(
			{
				calls: [
					{
						toolCallId: "write-report",
						toolName: FILE_WRITE_TOOL,
						input: { kind: "markdown", title: "Weekly report", content: "# Weekly report" },
					},
				],
			},
			{ text: ["The report is ready."] },
		);

		const ran = await loop.runTurn(runChat, { model });

		expect(ran.principal._tag).toBe("AutomationRun");
		expect(requests[0]?.tools).toHaveProperty(FILE_WRITE_TOOL);
		const [report] = await filesIn(runChat);
		if (!report) throw new Error("The run did not write its report");
		expect(report).toMatchObject({
			name: "Weekly report",
			currentVersion: 1,
			createdByBotId: botId,
		});
		expect(await callsOf(ran.turnId)).toMatchObject([
			{
				tool: FILE_WRITE_TOOL,
				status: "completed",
				approvalStatus: null,
				output: { status: "written", fileId: report.id, version: 1 },
			},
		]);
		expect((await chatsAs(adminId).files.getVersion(report.id, 1)).content).toBe("# Weekly report");
	});

	it.each(["github", "webhook"] as const)(
		"identifies a page written in a %s run",
		async (outsideRun) => {
			const runChat = await queueRun(await defaultProject(), outsideRun);
			const input = { kind: "html", title: "Report", content: "<p>Weekly report</p>" };
			const { model } = scriptedSteps(
				{ calls: [{ toolCallId: "write-page", toolName: FILE_WRITE_TOOL, input }] },
				{ text: ["Done."] },
			);

			await loop.runTurn(runChat, { model });

			const [page] = await filesIn(runChat);
			if (!page) throw new Error("The run did not write its page");
			const files = chatsAs(adminId).files;
			expect(await files.get(page.id)).toMatchObject({ ...input, outsideRun });
			expect(await files.getVersion(page.id, 1)).toMatchObject({ ...input, outsideRun });
		},
	);

	it("edits a routine run's own report without approval", async () => {
		const runChat = await queueRun(await defaultProject(), "routine");
		const report = await runOnPostgres(
			Files.seedWrittenFile(
				{ chatId: runChat, botId },
				{ kind: "markdown", title: "Report", content: "# Draft" },
			),
		);
		const { model, requests } = scriptedSteps(
			{
				calls: [
					{
						toolCallId: "edit-report",
						toolName: FILE_EDIT_TOOL,
						input: { fileId: report.id, baseVersion: 1, oldText: "Draft", newText: "Final" },
					},
				],
			},
			{ text: ["Done."] },
		);
		const ran = await loop.runTurn(runChat, { model });

		expect(requests[0]?.tools).toHaveProperty(FILE_EDIT_TOOL);
		expect(await callsOf(ran.turnId)).toMatchObject([
			{
				tool: FILE_EDIT_TOOL,
				status: "completed",
				approvalStatus: null,
				output: { fileId: report.id, version: 2 },
			},
		]);
		expect((await chatsAs(adminId).files.getVersion(report.id, 2)).content).toBe("# Final");
	});

	it.each(["ordinary bot", "Personal Assistant"])(
		"refuses a GitHub run's cross-chat file changes for a %s",
		async (botKind) => {
			if (botKind === "Personal Assistant") await makePersonalAssistant();
			const projectId = await defaultProject();
			const otherChat = await seedProjectChat(workspaceId, projectId, adminId);
			const report = await runOnPostgres(
				Files.seedWrittenFile(
					{ chatId: otherChat, botId },
					{ kind: "markdown", title: "Report", content: "# Draft" },
				),
			);
			const runChat = await queueRun(projectId, "github");
			const { model, requests } = scriptedSteps(
				{
					calls: [
						{
							toolCallId: "edit",
							toolName: FILE_EDIT_TOOL,
							input: { fileId: report.id, baseVersion: 1, oldText: "Draft", newText: "Final" },
						},
						{
							toolCallId: "replace",
							toolName: FILE_WRITE_TOOL,
							input: { fileId: report.id, baseVersion: 1, content: "# Final" },
						},
					],
				},
				{ text: ["Cannot change it."] },
			);
			const ran = await loop.runTurn(runChat, { model });

			expect(ran.principal._tag).toBe(
				botKind === "Personal Assistant" ? "BotForAsker" : "AutomationRun",
			);
			expect(requests[0]?.tools).toHaveProperty(FILE_EDIT_TOOL);
			expect(requests[0]?.tools).toHaveProperty(FILE_WRITE_TOOL);
			const error = new ActionForbidden({ proof: "CanChangeFile" }).userMessage;
			const calls = await callsOf(ran.turnId);
			expect(calls).toHaveLength(2);
			expect(calls).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						tool: FILE_EDIT_TOOL,
						status: "failed",
						approvalStatus: null,
						error,
					}),
					expect.objectContaining({
						tool: FILE_WRITE_TOOL,
						status: "failed",
						approvalStatus: null,
						error,
					}),
				]),
			);
			expect(await filesIn(otherChat)).toMatchObject([{ id: report.id, currentVersion: 1 }]);
			expect(JSON.stringify(requests[1]?.continuationMessages)).toContain(error);
		},
	);

	it("asks a Personal Assistant's member before its webhook run writes a file", async () => {
		await makePersonalAssistant();
		const runChat = await queueRun(await defaultProject(), "webhook");
		const input = { kind: "markdown", title: "Report", content: "# Report" };
		const { model, requests } = scriptedSteps(
			{ calls: [{ toolCallId: "write-report", toolName: FILE_WRITE_TOOL, input }] },
			{ text: ["Done."] },
		);
		const ran = await loop.runTurn(runChat, { model });

		expect(ran.principal).toMatchObject({ _tag: "BotForAsker", asker: adminId });
		expect(requests[0]?.tools).toHaveProperty(FILE_WRITE_TOOL);
		expect(ran.outcomes[0]).toMatchObject({ _tag: "Waiting" });
		expect(await callsOf(ran.turnId)).toMatchObject([
			{ tool: FILE_WRITE_TOOL, status: "awaiting_approval", approvalStatus: "pending" },
		]);
		expect(await filesIn(runChat)).toEqual([]);
	});

	it("asks a Personal Assistant's member before editing a file", async () => {
		await makePersonalAssistant();
		const report = await runOnPostgres(
			Files.seedWrittenFile(
				{ chatId, botId },
				{ kind: "markdown", title: "Report", content: "# Draft" },
			),
		);
		const input = { fileId: report.id, baseVersion: 1, oldText: "Draft", newText: "Final" };
		const { model, requests } = scriptedSteps(
			{ calls: [{ toolCallId: "edit-report", toolName: FILE_EDIT_TOOL, input }] },
			{ text: ["Done."] },
		);
		const ran = await loop.runTurn(chatId, { model });

		expect(requests[0]?.tools).toHaveProperty(FILE_EDIT_TOOL);
		expect(ran.outcomes[0]).toMatchObject({ _tag: "Waiting" });
		expect(await callsOf(ran.turnId)).toMatchObject([
			{ tool: FILE_EDIT_TOOL, status: "awaiting_approval", approvalStatus: "pending" },
		]);
		expect(await filesIn(chatId)).toMatchObject([{ id: report.id, currentVersion: 1 }]);
	});

	it("ends a run's turn without asking the model or writing its file once its bot loses the project", async () => {
		const replacement = await seedBot(workspaceId);
		const projectId = await seedProject(workspaceId, { leadBotId: botId, bots: [replacement.id] });
		const runChat = await queueRun(projectId, "routine");
		const input = { kind: "markdown", title: "Report", content: "# Report" } as const;
		const { model, requests } = scriptedSteps({
			calls: [{ toolCallId: "write-report", toolName: FILE_WRITE_TOOL, input }],
		});
		const ran = await loop.runTurn(
			runChat,
			{ model },
			{
				beforeSteps: async () => {
					await onDatabase((db) =>
						db.update(project).set({ leadBotId: replacement.id }).where(eq(project.id, projectId)),
					);
					await onDatabase((db) =>
						db
							.delete(projectBot)
							.where(and(eq(projectBot.projectId, projectId), eq(projectBot.botId, botId))),
					);
				},
			},
		);

		expect(ran.outcomes).toEqual([{ _tag: "Finished" }]);
		expect(requests).toEqual([]);
		expect(await filesIn(runChat)).toEqual([]);
	});

	it("replaces and edits a file in another chat of the same project without approval", async () => {
		const otherChat = await seedProjectChat(workspaceId, await defaultProject(), adminId);
		const made = await runOnPostgres(
			Files.seedWrittenFile(
				{ chatId: otherChat, botId },
				{
					kind: "markdown",
					title: "Plan",
					content: "# One",
				},
			),
		);
		const { model, requests } = scriptedSteps(
			{
				calls: [
					{
						toolCallId: "replace",
						toolName: FILE_WRITE_TOOL,
						input: { fileId: made.id, baseVersion: 1, content: "# Two" },
					},
				],
			},
			{
				calls: [
					{
						toolCallId: "edit",
						toolName: FILE_EDIT_TOOL,
						input: { fileId: made.id, baseVersion: 2, oldText: "Two", newText: "Three" },
					},
				],
			},
			{
				calls: [
					{ toolCallId: "list", toolName: FILE_LIST_TOOL, input: {} },
					{ toolCallId: "read", toolName: FILE_READ_TOOL, input: { fileId: made.id } },
				],
			},
			{ text: ["Done."] },
		);
		const ran = await loop.runTurn(chatId, { model });
		expect(ran.outcomes).toEqual([
			{ _tag: "Continue" },
			{ _tag: "Continue" },
			{ _tag: "Continue" },
			{ _tag: "Finished" },
		]);

		const calls = await callsOf(ran.turnId);
		expect(calls).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					tool: FILE_WRITE_TOOL,
					status: "completed",
					approvalStatus: null,
					output: expect.objectContaining({ status: "written", version: 2 }),
				}),
				expect.objectContaining({
					tool: FILE_EDIT_TOOL,
					status: "completed",
					approvalStatus: null,
					output: expect.objectContaining({ status: "written", version: 3 }),
				}),
				expect.objectContaining({
					tool: FILE_LIST_TOOL,
					writeOrDelete: false,
					output: { files: [expect.objectContaining({ fileId: made.id, version: 3 })] },
				}),
				expect.objectContaining({
					tool: FILE_READ_TOOL,
					writeOrDelete: false,
					output: expect.objectContaining({ status: "found", version: 3, content: "# Three" }),
				}),
			]),
		);
		const files = chatsAs(adminId).files;
		expect((await files.versions(made.id)).map(({ number }) => number)).toEqual([3, 2, 1]);
		expect((await files.getVersion(made.id, 2)).content).toBe("# Two");
		expect(JSON.stringify(requests[3]?.continuationMessages)).toContain("# Three");
	}, 15_000);

	it("offers a viewer only the read-only file tools and refuses a write without asking for approval", async () => {
		await onDatabase((db) =>
			db.update(membership).set({ role: "viewer" }).where(eq(membership.memberId, adminId)),
		);
		const { model, requests } = scriptedSteps(
			{
				calls: [
					{
						toolCallId: "write",
						toolName: FILE_WRITE_TOOL,
						input: { kind: "markdown", title: "Notes", content: "# Notes" },
					},
				],
			},
			{ text: ["Cannot write."] },
		);
		const ran = await loop.runTurn(chatId, { model });
		expect(
			Object.keys(requests[0]?.tools ?? {})
				.filter((name) => name.startsWith("file_"))
				.sort(),
		).toEqual([FILE_LIST_TOOL, FILE_READ_TOOL]);
		const error = new ActionForbidden({ proof: "CanChangeChat" }).userMessage;
		expect(await callsOf(ran.turnId)).toMatchObject([
			{ status: "failed", approvalStatus: null, error },
		]);
		expect(await filesIn(chatId)).toEqual([]);
		expect(JSON.stringify(requests[1]?.continuationMessages)).toContain(error);
	});

	it("hides a file outside the turn's bounds from reads and changes", async () => {
		const project = await seedProject(workspaceId, { leadBotId: botId });
		const elsewhere = await seedProjectChat(workspaceId, project, adminId);
		const made = await runOnPostgres(
			Files.seedWrittenFile(
				{ chatId: elsewhere, botId },
				{
					kind: "markdown",
					title: "Elsewhere",
					content: "# Private",
				},
			),
		);
		const { model, requests } = scriptedSteps(
			{
				calls: [
					{ toolCallId: "read", toolName: FILE_READ_TOOL, input: { fileId: made.id } },
					{
						toolCallId: "edit",
						toolName: FILE_EDIT_TOOL,
						input: { fileId: made.id, baseVersion: 1, oldText: "Private", newText: "Public" },
					},
				],
			},
			{ text: ["Cannot reach it."] },
		);
		const ran = await loop.runTurn(chatId, { model });
		const error = new ResourceHidden({ resource: "file" }).userMessage;
		expect(await callsOf(ran.turnId)).toMatchObject([
			{ status: "failed", approvalStatus: null, error },
			{ status: "failed", approvalStatus: null, error },
		]);
		expect(await filesIn(elsewhere)).toMatchObject([{ currentVersion: 1 }]);
		expect(JSON.stringify(requests[1]?.continuationMessages)).toContain(error);
	});
});
