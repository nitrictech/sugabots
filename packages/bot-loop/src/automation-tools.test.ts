import type { NewAutomation } from "@sugabots/contracts";
import {
	InvalidRoutineSchedule,
	TriggerSetInSettings,
} from "@sugabots/contracts/errors/automations";
import {
	ActionForbidden,
	ApprovalRefused,
	ResourceHidden,
} from "@sugabots/contracts/errors/proofs";
import { seedBot, seedMember, seedProject } from "@sugabots/core/authentication/seed.test-support";
import { AutomationRunner } from "@sugabots/core/chats/automations/automation-runner";
import { startRunning } from "@sugabots/core/chats/automations/testing";
import { startBotChat } from "@sugabots/core/chats/chats/testing";
import { aChatAwaitingReply } from "@sugabots/core/chats/turns/testing";
import {
	automation,
	bot,
	placedChat,
	project,
	toolCall,
	workspace,
} from "@sugabots/core/database/schema";
import {
	closeDatabase,
	onDatabase,
	onPostgres,
	runOnPostgres,
} from "@sugabots/core/database/testing";
import { asMember } from "@sugabots/core/operations/chats/testing";
import { operationsForTests } from "@sugabots/core/operations/testing";
import { asSchema } from "ai";
import { eq } from "drizzle-orm";
import { Context } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { botLoopOnPostgres, scriptedSteps } from "./testing.ts";

const standup = {
	name: "Morning standup",
	instructions: "Ask the team what they are working on today.",
	routineExpression: "0 9 * * 1-5",
};
const routine = {
	kind: "routine",
	schedule: { repeat: "cron", expression: standup.routineExpression },
	timezone: "Australia/Sydney",
} as const;

describe.skipIf(!process.env.DATABASE_URL)("automation tools through the bot loop", async () => {
	const loop = await botLoopOnPostgres([]);
	const chatsAs = (member: string) => asMember(loop.call, member);
	let chatId: string;
	let workspaceId: string;
	let botId: string;
	let adminId: string;
	let defaultProject: string;

	afterAll(closeDatabase);

	beforeEach(async () => {
		({ chatId, workspaceId, botId, adminId } = await aChatAwaitingReply(chatsAs));
		const [chat] = await onDatabase((db) =>
			db
				.select({ projectId: placedChat.projectId })
				.from(placedChat)
				.where(eq(placedChat.id, chatId)),
		);
		if (!chat?.projectId) throw new Error("The test chat has no project");
		defaultProject = chat.projectId;
		await onDatabase((db) =>
			db.update(workspace).set({ timeZone: routine.timezone }).where(eq(workspace.id, workspaceId)),
		);
	});

	const callsOf = (turnId: string) =>
		onDatabase((db) => db.select().from(toolCall).where(eq(toolCall.turnId, turnId)));

	const automationsOf = (projectId: string) =>
		onDatabase((db) => db.select().from(automation).where(eq(automation.projectId, projectId)));

	const defineAutomation = async (
		triggers: NewAutomation["triggers"],
		projectId = defaultProject,
	) =>
		loop.call(await chatsAs(adminId).principal(), "automations.create", {
			projectId,
			name: standup.name,
			instructions: standup.instructions,
			triggers,
		});

	const requestTool = (toolName: string, input: unknown) =>
		scriptedSteps(
			{ calls: [{ toolCallId: "automation-tool", toolName, input }] },
			{ text: ["Done."] },
		);

	const approve = async (ran: Awaited<ReturnType<typeof loop.runTurn>>, asker = adminId) => {
		const [parked] = await callsOf(ran.turnId);
		if (!parked) throw new Error("No call waiting for approval");
		expect(ran.outcomes).toEqual([
			{ _tag: "Waiting", approvals: [parked.approvalId], taken: true },
		]);
		await chatsAs(asker).decide({ toolCallId: parked.id, decision: "allow_once" });
		return parked;
	};

	const resume = async (ran: Awaited<ReturnType<typeof loop.runTurn>>) => {
		const principal = await ran.authentication.authenticate(ran.turnId);
		expect(
			await ran.steps.step(ran.run.request, principal, { turnId: ran.turnId, attempt: 0, step: 1 }),
		).toEqual({ _tag: "Finished" });
	};

	it.each(["own chat", "project chat", "Personal Assistant's chat"])(
		"creates a routine in a %s with the asker's approval",
		async (place) => {
			let source = chatId;
			let projectId = defaultProject;
			let maker = botId;
			if (place === "project chat") {
				projectId = await seedProject(workspaceId, { leadBotId: botId });
				const opened = await chatsAs(adminId).startProjectChat({
					projectId,
					messageId: crypto.randomUUID(),
					content: "Set up a standup.",
				});
				source = opened.chat.id;
			}
			if (place === "Personal Assistant's chat") {
				const assistant = await seedBot(workspaceId, {
					createdById: adminId,
					assistantOf: adminId,
					visibility: "personal",
				});
				await onDatabase((db) =>
					db.update(bot).set({ model: "m" }).where(eq(bot.id, assistant.id)),
				);
				const opened = await startBotChat(chatsAs(adminId), {
					botId: assistant.id,
					messageId: crypto.randomUUID(),
					content: "Set up a standup.",
				});
				source = opened.chat.id;
				projectId = assistant.defaultProject;
				maker = assistant.id;
			}
			const { model, requests } = requestTool("create_automation", {
				...standup,
				name: `  ${standup.name}  `,
			});
			const ran = await loop.runTurn(source, { model });

			expect(requests[0]?.tools).toHaveProperty("create_automation");
			expect(await automationsOf(projectId)).toEqual([]);
			await expect(
				loop.call(ran.principal, "automations.createWithRoutine", standup),
			).rejects.toMatchObject({ _tag: "ApprovalNeeded" });
			const parked = await approve(ran);
			expect(parked).toMatchObject({
				tool: "create_automation",
				input: standup,
				writeOrDelete: true,
			});

			if (place === "own chat") {
				const operations = await operationsForTests({ chats: loop.services });
				const call = { kind: "toolCall", toolCall: parked.id } as const;
				const current = await ran.authentication.authenticate(ran.turnId);
				await expect(
					runOnPostgres(
						operations["automations.createWithRoutine"](
							current,
							{ ...standup, instructions: "Different instructions" },
							call,
						),
					),
				).rejects.toMatchObject({ _tag: "ApprovalRefused" });
				await ran.authentication.authenticate(ran.turnId);
				await expect(
					runOnPostgres(operations["automations.createWithRoutine"](current, standup, call)),
				).rejects.toMatchObject({ _tag: "TurnExecutionSuperseded" });
				expect(await automationsOf(projectId)).toEqual([]);
			}

			await resume(ran);
			const [created] = await automationsOf(projectId);
			if (!created) throw new Error("No automation created");
			expect(created).toMatchObject({
				createdById: adminId,
				createdByBotId: maker,
				name: standup.name,
			});
			const [completed] = await callsOf(ran.turnId);
			expect(completed).toMatchObject({
				id: parked.id,
				approvalStatus: "allowed",
				status: "completed",
				output: {
					automation: {
						id: created.id,
						paused: false,
						settingsUrl: expect.stringMatching(
							new RegExp(
								`/${place === "project chat" ? "projects" : "bots"}/[^/]+/automations/${created.id}$`,
							),
						),
						when: [{ ...routine, nextRunAt: expect.any(String) }],
					},
				},
			});
			expect(JSON.stringify(requests[1]?.continuationMessages)).toContain(created.id);
		},
	);

	it.each([
		{ name: "adds a first routine", triggers: [], expression: "0 10 * * 1-5" },
		{ name: "replaces a sole routine", triggers: [routine], expression: "0 10 * * 1-5" },
		{
			name: "leaves a webhook alone",
			triggers: [{ kind: "webhook" }] as const,
			expression: undefined,
		},
		{
			name: "refuses to replace a webhook",
			triggers: [{ kind: "webhook" }] as const,
			expression: "0 10 * * 1-5",
			error: new TriggerSetInSettings(),
		},
		{
			name: "refuses to replace multiple triggers",
			triggers: [routine, { kind: "webhook" }] as const,
			expression: "0 10 * * 1-5",
			error: new TriggerSetInSettings(),
		},
		{
			name: "refuses an invalid schedule",
			triggers: [routine],
			expression: "not cron",
			error: new InvalidRoutineSchedule({ reason: "notFiveFields" }),
		},
	])("$name in an approved edit", async ({ triggers, expression, error }) => {
		const { automation: created } = await defineAutomation(triggers);
		const input = {
			automationId: created.id,
			name: "Renamed",
			paused: true,
			...(expression === undefined ? {} : { routineExpression: expression }),
		};
		const { model, requests } = requestTool("update_automation", input);
		const ran = await loop.runTurn(chatId, { model });
		expect(requests[0]?.tools).toHaveProperty("update_automation");
		const parked = await approve(ran);
		expect(parked).toMatchObject({ tool: "update_automation", input, writeOrDelete: true });
		expect(await automationsOf(defaultProject)).toMatchObject([
			{ name: created.name, state: "enabled" },
		]);
		await resume(ran);

		const [completed] = await callsOf(ran.turnId);
		if (error) {
			expect(completed).toMatchObject({
				id: parked.id,
				status: "failed",
				error: error.userMessage,
			});
			expect(await automationsOf(defaultProject)).toMatchObject([
				{ name: created.name, state: "enabled" },
			]);
			expect(JSON.stringify(requests[1]?.continuationMessages)).toContain(error.userMessage);
			return;
		}
		expect(completed).toMatchObject({
			id: parked.id,
			status: "completed",
			output: {
				automation: {
					id: created.id,
					name: "Renamed",
					paused: true,
					when: expression
						? [{ ...routine, schedule: { repeat: "cron", expression }, nextRunAt: null }]
						: [{ kind: "webhook" }],
				},
			},
		});
		expect(await automationsOf(defaultProject)).toMatchObject([
			{ name: "Renamed", state: "paused" },
		]);
	});

	it("lets a viewer list automations but refuses their bot's writes without asking for approval", async () => {
		const { automation: created } = await defineAutomation([routine]);
		const viewer = await seedMember(workspaceId, "viewer");
		const started = await startBotChat(chatsAs(viewer), {
			botId,
			messageId: crypto.randomUUID(),
			content: "List the standup and pause it.",
		});
		const { model, requests } = scriptedSteps(
			{
				calls: [
					{ toolCallId: "list", toolName: "list_automations", input: {} },
					{
						toolCallId: "change",
						toolName: "update_automation",
						input: { automationId: created.id, paused: true },
					},
				],
			},
			{ text: ["I couldn't pause it."] },
		);
		const ran = await loop.runTurn(started.chat.id, { model });
		const error = new ActionForbidden({ proof: "CanManageProject" }).userMessage;
		const listingTool = requests[0]?.tools?.list_automations;
		if (!listingTool) throw new Error("No listing tool was offered");
		expect(await asSchema(listingTool.inputSchema).jsonSchema).toMatchObject({ type: "object" });
		expect(await callsOf(ran.turnId)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					tool: "list_automations",
					writeOrDelete: false,
					approvalStatus: null,
					status: "completed",
					output: {
						automations: [
							expect.objectContaining({ id: created.id, when: [expect.objectContaining(routine)] }),
						],
					},
				}),
				expect.objectContaining({
					tool: "update_automation",
					approvalStatus: null,
					status: "failed",
					error,
				}),
			]),
		);
		expect(await automationsOf(defaultProject)).toMatchObject([{ state: "enabled" }]);
		expect(JSON.stringify(requests[1]?.continuationMessages)).toContain(error);
	});

	it("hides the bot's own automation from an update in a different project", async () => {
		const { automation: owned } = await defineAutomation([routine]);
		const projectId = await seedProject(workspaceId, { leadBotId: botId });
		const opened = await chatsAs(adminId).startProjectChat({
			projectId,
			messageId: crypto.randomUUID(),
			content: "Pause the standup.",
		});
		const { model, requests } = requestTool("update_automation", {
			automationId: owned.id,
			paused: true,
		});
		const ran = await loop.runTurn(opened.chat.id, { model });
		const error = new ResourceHidden({ resource: "automation" }).userMessage;
		expect(await callsOf(ran.turnId)).toMatchObject([
			{ approvalStatus: null, status: "failed", error },
		]);
		expect(await automationsOf(defaultProject)).toMatchObject([{ state: "enabled" }]);
		expect(JSON.stringify(requests[1]?.continuationMessages)).toContain(error);
	});

	it.each(["project", "default project"])(
		"lists automations in a run in a %s and withholds both writes",
		async (place) => {
			const projectId =
				place === "default project"
					? defaultProject
					: await seedProject(workspaceId, { leadBotId: botId });
			const { automation: created } = await defineAutomation([], projectId);
			const run = await loop.call(await chatsAs(adminId).principal(), "automations.run", {
				projectId,
				automationId: created.id,
				requestId: crypto.randomUUID(),
			});
			await startRunning(
				onPostgres(Context.get(loop.services, AutomationRunner.Service)),
				created.id,
			);
			const { model, requests } = requestTool("list_automations", {});
			const ran = await loop.runTurn(run.chatId, { model });
			expect(requests[0]?.tools).toHaveProperty("list_automations");
			expect(requests[0]?.tools).not.toHaveProperty("create_automation");
			expect(requests[0]?.tools).not.toHaveProperty("update_automation");
			expect(await callsOf(ran.turnId)).toMatchObject([
				{
					tool: "list_automations",
					approvalStatus: null,
					status: "completed",
					output: { automations: [{ id: created.id }] },
				},
			]);
			await expect(
				loop.call(ran.principal, "automations.createWithRoutine", standup),
			).rejects.toMatchObject({ _tag: "ResourceHidden" });
		},
	);

	it("lists automations in a bot's default-project automation feed", async () => {
		const { automation: created } = await defineAutomation([routine]);
		const admin = chatsAs(adminId);
		const feed = await admin.openAutomationFeed({
			workspace: workspaceId,
			automationId: created.id,
		});
		await admin.post({
			chatId: feed.id,
			messageId: crypto.randomUUID(),
			content: "List the automations.",
		});
		const { model, requests } = requestTool("list_automations", {});
		const ran = await loop.runTurn(feed.id, { model });

		expect(requests[0]?.tools).toHaveProperty("list_automations");
		expect(requests[0]?.tools).not.toHaveProperty("create_automation");
		expect(requests[0]?.tools).not.toHaveProperty("update_automation");
		expect(await callsOf(ran.turnId)).toMatchObject([
			{
				tool: "list_automations",
				status: "completed",
				approvalStatus: null,
				output: { automations: [{ id: created.id }] },
			},
		]);
	});

	it("hides the automation list when the turn's project is being deleted", async () => {
		const projectId = await seedProject(workspaceId, { leadBotId: botId });
		const { automation: created } = await defineAutomation([routine], projectId);
		const { chat } = await chatsAs(adminId).startProjectChat({
			projectId,
			messageId: crypto.randomUUID(),
			content: "List the automations.",
		});
		const { model } = requestTool("list_automations", {});
		const ran = await loop.runTurn(chat.id, { model });
		expect(await callsOf(ran.turnId)).toMatchObject([
			{ status: "completed", output: { automations: [{ id: created.id }] } },
		]);

		await onDatabase((db) =>
			db.update(project).set({ deleting: true }).where(eq(project.id, projectId)),
		);

		await expect(loop.call(ran.principal, "automations.listInChat", {})).rejects.toMatchObject({
			_tag: "ResourceHidden",
			resource: "project",
		});
	});

	it("runs a previously approved edit whose stored UUID was uppercase", async () => {
		const { automation: created } = await defineAutomation([]);
		const input = { automationId: created.id, name: "Renamed" };
		const oldInput = { ...input, automationId: created.id.toUpperCase() };
		const { model } = requestTool("update_automation", oldInput);
		const ran = await loop.runTurn(chatId, { model });
		const parked = await approve(ran);
		expect(parked.input).toEqual(input);

		await onDatabase((db) =>
			db
				.update(toolCall)
				.set({ input: oldInput, executionInput: oldInput })
				.where(eq(toolCall.id, parked.id)),
		);
		await resume(ran);

		expect(await callsOf(ran.turnId)).toMatchObject([{ id: parked.id, status: "completed" }]);
		expect(await automationsOf(defaultProject)).toMatchObject([
			{ id: created.id, name: input.name },
		]);
	});

	it("rechecks tool access after approval", async () => {
		const { model, requests } = requestTool("create_automation", standup);
		const ran = await loop.runTurn(chatId, { model });
		await approve(ran);
		await onDatabase((db) =>
			db
				.update(bot)
				.set({ disabledTools: ["automations"] })
				.where(eq(bot.id, botId)),
		);

		await resume(ran);
		const error = new ApprovalRefused({ reason: "automationsOff" }).userMessage;
		expect(await callsOf(ran.turnId)).toMatchObject([{ status: "failed", error }]);
		expect(await automationsOf(defaultProject)).toEqual([]);
		expect(JSON.stringify(requests[1]?.continuationMessages)).toContain(error);
	});
});
