import { ActionForbidden } from "@sugabots/contracts/errors/proofs";
import { seedBot, seedMember, seedProject } from "@sugabots/core/authentication/seed.test-support";
import { startBotChat } from "@sugabots/core/chats/chats/testing";
import { aChatAwaitingReply } from "@sugabots/core/chats/turns/testing";
import type { CommittedEvent } from "@sugabots/core/database/events/outbox";
import {
	bot,
	membership,
	project,
	projectBot,
	projectMember,
	workspace,
} from "@sugabots/core/database/schema";
import { closeDatabase, onDatabase } from "@sugabots/core/database/testing";
import { asMember } from "@sugabots/core/operations/chats/testing";
import { authenticators, principals } from "@sugabots/core/proofs/world.test-support";
import { INTERVIEW_PROMPT } from "@sugabots/core/workspaces/bots/interview-prompt";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
	botLoopOnPostgres,
	calling,
	callsOf,
	openTurnInChat,
	resumeAt,
	scriptedSteps,
} from "./testing.ts";

const SAVE_INSTRUCTIONS_TOOL = "save_instructions";

/**
 * Tools that change a bot or its member's workspace, through the bot loop on
 * Postgres: a bot saving its own instructions, and a Personal Assistant
 * acting for its member, each once its member approves.
 */
describe.skipIf(!process.env.DATABASE_URL)(
	"a turn's bot and workspace tools, against Postgres",
	async () => {
		const delivered: CommittedEvent[] = [];
		const loop = await botLoopOnPostgres(delivered);
		const chatsAs = (memberId: string) => asMember(loop.call, memberId);
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
		});

		describe("a call the bot makes outside its tools", () => {
			type TurnPrincipal = Awaited<ReturnType<typeof loop.runTurn>>["principal"];
			const directCalls: ReadonlyArray<
				readonly [string, (principal: TurnPrincipal) => Promise<unknown>]
			> = [
				[
					"chats.startBriefedChat",
					(principal) =>
						loop.call(principal, "chats.startBriefedChat", {
							title: "Report",
							brief: "Draft it.",
						}),
				],
				[
					"automations.createWithRoutine",
					(principal) =>
						loop.call(principal, "automations.createWithRoutine", {
							name: "Morning standup",
							instructions: "Ask the team what they are working on today.",
							routineExpression: "0 9 * * 1-5",
						}),
				],
				[
					"bots.saveInstructions",
					(principal) =>
						loop.call(principal, "bots.saveInstructions", {
							instructions: "You triage support tickets.",
							description: "Sorts support tickets by urgency.",
						}),
				],
			];

			it.each(directCalls)(
				"refuses %s, which its asker must approve, made straight to the registry",
				async (_name, callDirectly) => {
					const { steps, authentication } = await loop.loopOver({ model: scriptedSteps().model });
					const { opened } = await openTurnInChat(chatId, steps);
					const principal = await authentication.authenticate(opened.turnId);

					await expect(callDirectly(principal)).rejects.toMatchObject({ _tag: "ApprovalNeeded" });
					expect(await callsOf(opened.turnId)).toEqual([]);
				},
			);
		});

		describe("saving its own instructions", () => {
			beforeEach(async () => {
				await onDatabase((db) =>
					db.update(bot).set({ instructions: INTERVIEW_PROMPT }).where(eq(bot.id, botId)),
				);
			});

			const storedBot = async () => {
				const [row] = await onDatabase((db) =>
					db
						.select({ instructions: bot.instructions, description: bot.description })
						.from(bot)
						.where(eq(bot.id, botId)),
				);
				return row;
			};

			const written = {
				instructions: "You triage support tickets.",
				description: "Sorts support tickets by urgency.",
			};

			it("saves its instructions once the member it answers approves, and links to them", async () => {
				const { model, requests } = calling(SAVE_INSTRUCTIONS_TOOL, written);

				const ran = await loop.runTurn(chatId, { model });

				const [parked] = await callsOf(ran.turnId);
				if (!parked) throw new Error("No call parked");
				expect(ran.outcomes).toEqual([
					{ _tag: "Waiting", approvals: [parked.approvalId], taken: true },
				]);
				expect(parked).toMatchObject({
					tool: SAVE_INSTRUCTIONS_TOOL,
					approvalStatus: "pending",
					input: written,
				});
				expect(await storedBot()).toMatchObject({ instructions: INTERVIEW_PROMPT });

				await chatsAs(adminId).decide({ toolCallId: parked.id, decision: "allow_once" });

				expect(await resumeAt(ran, 1)).toEqual({ _tag: "Finished" });
				expect(await storedBot()).toEqual(written);
				const [place] = await onDatabase((db) =>
					db
						.select({ workspace: workspace.slug, handle: bot.handle })
						.from(bot)
						.innerJoin(workspace, eq(workspace.id, bot.workspaceId))
						.where(eq(bot.id, botId)),
				);
				const settingsUrl = `http://sugabots.test/${place?.workspace}/bots/${place?.handle}/settings`;
				expect(await callsOf(ran.turnId)).toMatchObject([
					{ approvalStatus: "allowed", status: "completed", output: { saved: true, settingsUrl } },
				]);
				expect(JSON.stringify(requests[1]?.continuationMessages)).toContain(settingsUrl);
			});

			it("saves nothing its member denied", async () => {
				const { model, requests } = calling(SAVE_INSTRUCTIONS_TOOL, written);
				const ran = await loop.runTurn(chatId, { model });
				const [parked] = await callsOf(ran.turnId);
				if (!parked) throw new Error("No call parked");

				await chatsAs(adminId).decide({ toolCallId: parked.id, decision: "deny" });

				expect(await resumeAt(ran, 1)).toEqual({ _tag: "Finished" });
				expect(await storedBot()).toMatchObject({ instructions: INTERVIEW_PROMPT });
				expect(requests).toHaveLength(2);
			});

			it("refuses a member who may not edit the bot, without asking them", async () => {
				await onDatabase((db) =>
					db.update(membership).set({ role: "viewer" }).where(eq(membership.memberId, adminId)),
				);
				const { model, requests } = calling(SAVE_INSTRUCTIONS_TOOL, written);

				const ran = await loop.runTurn(chatId, { model });

				const error = new ActionForbidden({ proof: "CanManageBot" }).userMessage;
				expect(ran.outcomes).toEqual([{ _tag: "Continue" }, { _tag: "Finished" }]);
				expect(await callsOf(ran.turnId)).toMatchObject([
					{ tool: SAVE_INSTRUCTIONS_TOOL, approvalStatus: null, status: "failed", error },
				]);
				expect(await storedBot()).toMatchObject({ instructions: INTERVIEW_PROMPT });
				expect(JSON.stringify(requests[1]?.continuationMessages)).toContain(error);
			});

			it("is offered only in the bot's own chats", async () => {
				const projectId = await seedProject(workspaceId, { leadBotId: botId });
				const started = await chatsAs(adminId).startProjectChat({
					projectId,
					retryKey: crypto.randomUUID(),
					message: "Change how you work.",
				});
				const { model, requests } = calling(SAVE_INSTRUCTIONS_TOOL, written);

				const ran = await loop.runTurn(started.chat.id, { model });

				expect(requests[0]?.tools).not.toHaveProperty(SAVE_INSTRUCTIONS_TOOL);
				expect(await callsOf(ran.turnId)).toEqual([]);
				await expect(
					loop.call(ran.principal, "bots.saveInstructions", written),
				).rejects.toMatchObject({ _tag: "ActionForbidden" });
				expect(await storedBot()).toMatchObject({ instructions: INTERVIEW_PROMPT });
			});
		});

		describe("a Personal Assistant acting for its member", () => {
			const anAssistant = async () => {
				const assistant = await seedBot(workspaceId, {
					assistantOf: adminId,
					visibility: "personal",
				});
				await onDatabase((db) =>
					db.update(bot).set({ model: "m" }).where(eq(bot.id, assistant.id)),
				);
				return assistant;
			};

			/** The admin's Personal Assistant, on a model, and a chat with it they wrote in. */
			const assistantChat = async () => {
				const assistant = await anAssistant();
				const started = await startBotChat(chatsAs(adminId), {
					botId: assistant.id,
					messageId: crypto.randomUUID(),
					content: "Set up a project for the launch.",
				});
				return { assistant, chat: started.chat.id };
			};

			/**
			 * The call to `toolName` a Personal Assistant makes in a new chat of its
			 * own default project `ownProject` for `memberId`, once it waited for them
			 * and they allowed it.
			 */
			const approvedInItsOwnChat = async (
				memberId: string,
				ownProject: string,
				toolName: string,
				input: unknown,
			) => {
				const started = await chatsAs(memberId).startProjectChat({
					projectId: ownProject,
					retryKey: crypto.randomUUID(),
					message: "Please do it.",
				});
				const ran = await loop.runTurn(started.chat.id, { model: calling(toolName, input).model });
				const [parked] = await callsOf(ran.turnId);
				if (!parked) throw new Error("No call parked");
				expect(parked).toMatchObject({ tool: toolName, approvalStatus: "pending" });
				await chatsAs(memberId).decide({ toolCallId: parked.id, decision: "allow_once" });
				expect(await resumeAt(ran, 1)).toEqual({ _tag: "Finished" });
				return (await callsOf(ran.turnId))[0];
			};

			const projectsNamed = (name: string) =>
				onDatabase((db) =>
					db
						.select()
						.from(project)
						.where(and(eq(project.workspaceId, workspaceId), eq(project.name, name))),
				);

			it("reads the workspace guide as its member, with the ids its other tools take", async () => {
				const { chat } = await assistantChat();
				const { model, requests } = calling("workspace_guide", {});

				const ran = await loop.runTurn(chat, { model });

				expect(ran.outcomes).toEqual([{ _tag: "Continue" }, { _tag: "Finished" }]);
				const [read] = await callsOf(ran.turnId);
				expect(read).toMatchObject({
					tool: "workspace_guide",
					status: "completed",
					approvalStatus: null,
				});
				expect(read?.output).toMatchObject({
					workspaceId,
					bots: [expect.objectContaining({ id: botId })],
				});
				expect(JSON.stringify(requests[1]?.continuationMessages)).toContain(botId);
			});

			it("makes a project only once its member approves, under the workspace's lock", async () => {
				const { chat } = await assistantChat();
				const input = { workspace: workspaceId, name: "Launch", leadBotId: botId };
				const { model, requests } = scriptedSteps(
					{ calls: [{ toolCallId: "create", toolName: "create_project", input }] },
					{ calls: [{ toolCallId: "guide", toolName: "workspace_guide", input: {} }] },
					{ text: ["Done."] },
				);

				const ran = await loop.runTurn(chat, { model });

				const [parked] = await callsOf(ran.turnId);
				if (!parked) throw new Error("No call parked");
				expect(ran.outcomes).toEqual([
					{ _tag: "Waiting", approvals: [parked.approvalId], taken: true },
				]);
				expect(parked).toMatchObject({ tool: "create_project", approvalStatus: "pending", input });
				expect(await projectsNamed("Launch")).toEqual([]);
				expect(loop.deliveredEvents()).not.toContainEqual(
					expect.objectContaining({
						type: "reach.changed",
						about: { kind: "project", projectId: expect.any(String) },
					}),
				);
				await expect(loop.call(ran.principal, "projects.create", input)).rejects.toMatchObject({
					_tag: "ApprovalNeeded",
				});

				delivered.length = 0;
				await chatsAs(adminId).decide({ toolCallId: parked.id, decision: "allow_once" });
				const resumed = await ran.authentication.authenticate(ran.turnId);
				expect(
					await ran.steps.step(ran.run.request, resumed, {
						turnId: ran.turnId,
						attempt: 0,
						step: 1,
					}),
				).toEqual({ _tag: "Continue" });

				const [made] = await projectsNamed("Launch");
				expect(made).toMatchObject({ leadBotId: botId });
				expect(
					await onDatabase((db) =>
						db
							.select({ memberId: projectMember.memberId })
							.from(projectMember)
							.where(eq(projectMember.projectId, made?.id ?? "")),
					),
				).toEqual([{ memberId: adminId }]);
				expect(loop.deliveredEvents()).toContainEqual(
					expect.objectContaining({
						type: "reach.changed",
						about: { kind: "project", projectId: made?.id },
					}),
				);
				expect(JSON.stringify(requests[1]?.continuationMessages)).toContain(made?.id);
				if (!made) throw new Error("The turn did not create the project");
				await chatsAs(adminId).startProjectChat({
					projectId: made.id,
					retryKey: crypto.randomUUID(),
					message: "Launch is ready for dispatch.",
				});
				await expect(
					loop.call(resumed, "chats.searchHistory", { chat: "all", query: "dispatch" }),
				).resolves.toMatchObject({
					messages: [expect.objectContaining({ text: "Launch is ready for dispatch." })],
				});
				expect(await resumeAt(ran, 2)).toEqual({ _tag: "Finished" });
			});

			it("joins a public project and adds a bot to one for its member, each once approved", async () => {
				const editor = await seedMember(workspaceId, "editor");
				const assistant = await seedBot(workspaceId, {
					assistantOf: editor,
					visibility: "personal",
				});
				await onDatabase((db) =>
					db.update(bot).set({ model: "m" }).where(eq(bot.id, assistant.id)),
				);
				const other = await seedBot(workspaceId, { createdById: adminId });
				const projectId = await seedProject(workspaceId, {
					leadBotId: botId,
					visibility: "public",
				});
				const approveAndResume = (toolName: string, input: unknown) =>
					approvedInItsOwnChat(editor, assistant.defaultProject, toolName, input);
				const inProject = () =>
					onDatabase((db) =>
						db
							.select()
							.from(projectMember)
							.where(
								and(eq(projectMember.projectId, projectId), eq(projectMember.memberId, editor)),
							),
					);

				expect(await inProject()).toEqual([]);
				expect(await approveAndResume("join_project", { projectId })).toMatchObject({
					status: "completed",
				});
				expect(await inProject()).toHaveLength(1);

				expect(
					await approveAndResume("add_bot_to_project", { projectId, botId: other.id }),
				).toMatchObject({ status: "completed" });
				expect(
					await onDatabase((db) =>
						db
							.select()
							.from(projectBot)
							.where(and(eq(projectBot.projectId, projectId), eq(projectBot.botId, other.id))),
					),
				).toHaveLength(1);
			});

			it.each([
				{ change: "the project became public", startsPrivate: true },
				{ change: "the bot became private", startsPrivate: false },
			])("closes an add-bot approval when $change", async ({ startsPrivate }) => {
				const editor = await seedMember(workspaceId, "editor");
				const assistant = await seedBot(workspaceId, {
					assistantOf: editor,
					visibility: "personal",
				});
				await onDatabase((db) =>
					db.update(bot).set({ model: "m" }).where(eq(bot.id, assistant.id)),
				);
				const other = await seedBot(workspaceId, {
					visibility: startsPrivate ? "private" : "public",
					createdById: adminId,
					members: startsPrivate ? [editor] : [],
				});
				const projectId = await seedProject(workspaceId, {
					leadBotId: botId,
					members: [editor],
					visibility: startsPrivate ? "private" : "public",
				});
				const member = chatsAs(editor);
				const { chat } = await member.startProjectChat({
					projectId: assistant.defaultProject,
					retryKey: crypto.randomUUID(),
					message: "Add my bot to the project.",
				});
				const { model } = calling("add_bot_to_project", { projectId, botId: other.id });
				const ran = await loop.runTurn(chat.id, { model });
				const [parked] = await callsOf(ran.turnId);
				if (!parked) throw new Error("No call parked");
				expect(parked).toMatchObject({ approvalStatus: "pending" });
				const admin = await chatsAs(adminId).principal();
				if (startsPrivate) {
					await loop.call(admin, "projects.update", {
						projectId,
						changes: { visibility: "public" },
					});
				} else {
					await loop.call(admin, "bots.update", {
						botId: other.id,
						changes: { visibility: "private" },
					});
				}

				await expect(
					member.decide({ toolCallId: parked.id, decision: "allow_once" }),
				).rejects.toMatchObject({
					_tag: "ToolApprovalConflict",
					reason: "botCanNoLongerJoinProject",
				});
				expect(await member.approvals(workspaceId)).toMatchObject({
					waiting: [],
					answered: [
						{
							call: {
								id: parked.id,
								approval: { closedBecause: "botCanNoLongerJoinProject", decidedAt: null },
							},
						},
					],
				});
			});

			it("closes a public project's approval when its proposed lead becomes private", async () => {
				const { chat } = await assistantChat();
				const input = { workspace: workspaceId, name: "Launch", leadBotId: botId };
				const ran = await loop.runTurn(chat, { model: calling("create_project", input).model });
				const [parked] = await callsOf(ran.turnId);
				if (!parked) throw new Error("No call parked");
				expect(parked).toMatchObject({ approvalStatus: "pending" });
				const member = chatsAs(adminId);
				await loop.call(await member.principal(), "bots.update", {
					botId,
					changes: { visibility: "private" },
				});

				await expect(
					member.decide({ toolCallId: parked.id, decision: "allow_once" }),
				).rejects.toMatchObject({
					_tag: "ToolApprovalConflict",
					reason: "botCanNoLongerLeadProject",
				});
				expect(await member.approvals(workspaceId)).toMatchObject({
					waiting: [],
					answered: [
						{
							call: {
								id: parked.id,
								approval: { closedBecause: "botCanNoLongerLeadProject", decidedAt: null },
							},
						},
					],
				});
				expect(await projectsNamed(input.name)).toEqual([]);
			});

			it("searches a project joined by this turn, including after the turn resumes", async () => {
				const editor = await seedMember(workspaceId, "editor");
				const assistant = await seedBot(workspaceId, {
					assistantOf: editor,
					visibility: "personal",
				});
				await onDatabase((db) =>
					db.update(bot).set({ model: "m" }).where(eq(bot.id, assistant.id)),
				);
				const projectId = await seedProject(workspaceId, {
					leadBotId: botId,
					visibility: "public",
				});
				const { chat: target } = await chatsAs(adminId).startProjectChat({
					projectId,
					retryKey: crypto.randomUUID(),
					message: "The shipping deadline is Friday.",
				});
				const { chat: source } = await chatsAs(editor).startProjectChat({
					projectId: assistant.defaultProject,
					retryKey: crypto.randomUUID(),
					message: "Join the project and find the shipping deadline.",
				});
				const { model } = scriptedSteps(
					{ calls: [{ toolCallId: "join", toolName: "join_project", input: { projectId } }] },
					{
						calls: [
							{
								toolCallId: "point",
								toolName: "search_history",
								input: { chat: target.id, query: "shipping" },
							},
							{
								toolCallId: "list",
								toolName: "search_history",
								input: { chat: "all", query: "shipping" },
							},
						],
					},
					{ text: ["Found the deadline."] },
				);
				const ran = await loop.runTurn(source.id, { model });
				const [parked] = await callsOf(ran.turnId);
				if (!parked) throw new Error("No call parked");
				await chatsAs(editor).decide({ toolCallId: parked.id, decision: "allow_once" });
				expect(await resumeAt(ran, 1)).toEqual({ _tag: "Continue" });
				const hasDeadline = {
					messages: [expect.objectContaining({ text: "The shipping deadline is Friday." })],
				};
				expect(await callsOf(ran.turnId)).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							sdkToolCallId: "point",
							output: expect.objectContaining(hasDeadline),
						}),
						expect.objectContaining({
							sdkToolCallId: "list",
							output: expect.objectContaining(hasDeadline),
						}),
					]),
				);
				const resumed = await ran.authentication.authenticate(ran.turnId);
				await expect(
					loop.call(resumed, "chats.searchHistory", { chat: target.id, query: "shipping" }),
				).resolves.toMatchObject(hasDeadline);
				expect(await resumeAt(ran, 2)).toEqual({ _tag: "Finished" });
			});

			it.each([
				["pin_bot", false, true],
				["unpin_bot", true, false],
			] as const)(
				"applies %s to its member's sidebar once approved",
				async (tool, before, after) => {
					const assistant = await anAssistant();
					const other = await seedBot(workspaceId, { createdById: null });
					const member = await principals(await authenticators()).member(adminId);
					if (before) await loop.call(member, "bots.pin", { botId: other.id });
					const pinned = async () =>
						(await loop.call(member, "bots.list", { workspace: workspaceId })).find(
							({ id }) => id === other.id,
						)?.pinned;

					expect(await pinned()).toBe(before);
					await approvedInItsOwnChat(adminId, assistant.defaultProject, tool, { botId: other.id });
					expect(await pinned()).toBe(after);
				},
			);

			it("is refused a change its member, a viewer, couldn't make themselves", async () => {
				await onDatabase((db) =>
					db.update(membership).set({ role: "viewer" }).where(eq(membership.memberId, adminId)),
				);
				const { chat } = await assistantChat();
				const input = { workspace: workspaceId, name: "Launch", leadBotId: botId };
				const { model, requests } = calling("create_project", input);
				const ran = await loop.runTurn(chat, { model });
				expect(ran.outcomes).toEqual([{ _tag: "Continue" }, { _tag: "Finished" }]);

				const error = new ActionForbidden({ proof: "CanCreateProjects" }).userMessage;
				expect(await callsOf(ran.turnId)).toMatchObject([
					{ status: "failed", approvalStatus: null, error },
				]);
				expect(await projectsNamed("Launch")).toEqual([]);
				expect(JSON.stringify(requests[1]?.continuationMessages)).toContain(error);
			});

			it.each(["bot's own chat", "project chat"])(
				"withholds the workspace guide in chat bounds in a %s",
				async (place) => {
					let source = chatId;
					if (place === "project chat") {
						const opened = await chatsAs(adminId).startProjectChat({
							projectId: await seedProject(workspaceId, { leadBotId: botId }),
							retryKey: crypto.randomUUID(),
							message: "Show me the workspace guide.",
						});
						source = opened.chat.id;
					}
					const { model, requests } = calling("workspace_guide", {});
					const ran = await loop.runTurn(source, { model });

					expect(ran.principal.bounds.kind).toBe("chat");
					expect(requests[0]?.tools).not.toHaveProperty("workspace_guide");
					expect(await callsOf(ran.turnId)).toEqual([]);
					await expect(loop.call(ran.principal, "workspaces.guide", {})).rejects.toMatchObject({
						_tag: "ResourceHidden",
						resource: "workspace",
					});
				},
			);

			it("withholds the workspace guide from a personal bot that isn't a Personal Assistant, which has member bounds and their tools", async () => {
				const personal = await seedBot(workspaceId, {
					createdById: adminId,
					visibility: "personal",
				});
				await onDatabase((db) => db.update(bot).set({ model: "m" }).where(eq(bot.id, personal.id)));
				const started = await startBotChat(chatsAs(adminId), {
					botId: personal.id,
					messageId: crypto.randomUUID(),
					content: "Show me the workspace guide.",
				});
				const { model, requests } = calling("workspace_guide", {});
				const ran = await loop.runTurn(started.chat.id, { model });

				expect(ran.principal.bounds.kind).toBe("member");
				expect(requests[0]?.tools).not.toHaveProperty("workspace_guide");
				expect(requests[0]?.tools).toHaveProperty("pin_bot");
			});

			it.each(["create_project", "join_project", "add_bot_to_project", "pin_bot", "unpin_bot"])(
				"offers no other bot %s, outside member bounds",
				async (toolName) => {
					const { model, requests } = calling(toolName, {});

					const ran = await loop.runTurn(chatId, { model });

					expect(requests[0]?.tools).not.toHaveProperty(toolName);
					expect(await callsOf(ran.turnId)).toEqual([]);
				},
			);
		});
	},
);
