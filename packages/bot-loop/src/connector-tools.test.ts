import { ActionForbidden, ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { toolCallPartSchema } from "@sugabots/contracts/messages";
import {
	seedBot,
	seedConnector,
	seedMessage,
	seedProject,
	seedProjectBotConnector,
	seedProjectChat,
	seedTurnAnswering,
} from "@sugabots/core/authentication/seed.test-support";
import { ConnectorCatalog } from "@sugabots/core/chats/tools/connector-catalog";
import { CALL_TOOL } from "@sugabots/core/chats/tools/tool-search/tool";
import { aChatWithConnectorAwaitingReply, runningTurns } from "@sugabots/core/chats/turns/testing";
import { Turns } from "@sugabots/core/chats/turns/turns";
import type { CommittedEvent } from "@sugabots/core/database/events/outbox";
import { bot, connector, membership } from "@sugabots/core/database/schema";
import { closeDatabase, onDatabase, runOnPostgres } from "@sugabots/core/database/testing";
import { asMember } from "@sugabots/core/operations/chats/testing";
import { Models } from "@sugabots/core/providers/models/models";
import { tool } from "ai";
import { eq } from "drizzle-orm";
import { Context, Effect, Schema } from "effect";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	botLoopOnPostgres,
	calling,
	callsOf,
	failedCall,
	resumeAt,
	scriptedSteps,
	storedReply,
	storedTurn,
	toolResultFor,
	wikiWipe,
} from "./testing.ts";

/**
 * Connector tools through the bot loop on Postgres: calls parked for
 * approval or refused as each tool's live access says, the sessions a turn
 * keeps, and what the model is told.
 */
describe.skipIf(!process.env.DATABASE_URL)(
	"a turn's connector tools, against Postgres",
	async () => {
		const delivered: CommittedEvent[] = [];
		let afterCommit: ((events: readonly CommittedEvent[]) => Promise<void>) | undefined;
		const loop = await botLoopOnPostgres(delivered, async (events) => afterCommit?.(events));
		const chatsAs = (memberId: string) => asMember(loop.call, memberId);
		let chatId: string;
		let workspaceId: string;
		let connectorId: string;
		let botId: string;
		let adminId: string;

		afterAll(async () => {
			await closeDatabase();
		});

		beforeEach(async () => {
			({ chatId, workspaceId, connectorId, botId, adminId } =
				await aChatWithConnectorAwaitingReply(chatsAs));
			delivered.length = 0;
			afterCommit = undefined;
		});

		/** The connector tool `wiki__wipe` of the connector `installedId`, with `access`, running `execute`. */
		const wiki = (
			access: "allow" | "ask" | "off",
			execute: Parameters<typeof wikiWipe>[2],
			installedId = connectorId,
		) => wikiWipe(installedId, access, execute);

		it("parks a write/delete tool call for approval without making it, then makes it once allowed", async () => {
			const execute = vi.fn(async () => ({ removed: true }));
			const outside = {
				connectorTools: wiki("ask", execute),
			};
			const { model, requests } = scriptedSteps(
				{
					text: ["I need approval."],
					calls: [
						{
							toolCallId: "sdk-1",
							toolName: CALL_TOOL,
							input: { tool: "wiki__wipe", arguments: {} },
						},
					],
				},
				{ text: [" Wiped."] },
			);

			const ran = await loop.runTurn(chatId, { model, ...outside });

			expect(ran.outcomes).toEqual([
				{ _tag: "Waiting", approvals: [expect.any(String)], taken: true },
			]);
			expect(execute).not.toHaveBeenCalled();
			expect(await storedTurn(ran.turnId)).toMatchObject({ status: "waiting" });
			const [parked] = await callsOf(ran.turnId);
			expect(parked).toMatchObject({
				tool: "wiki__wipe",
				step: 0,
				approvalStatus: "pending",
				writeOrDelete: true,
			});
			if (!parked) throw new Error("no call parked");

			await chatsAs(adminId).decide({ toolCallId: parked.id, decision: "allow_once" });
			// The workflow resumes the turn: it authenticates it again and takes the next step.
			const principal = await ran.authentication.authenticate(ran.turnId);
			const next = await ran.steps.step(ran.run.request, principal, {
				turnId: ran.turnId,
				attempt: 0,
				step: 1,
			});

			expect(next).toEqual({ _tag: "Finished" });
			expect(execute).toHaveBeenCalledOnce();
			expect(requests).toHaveLength(2);
			expect(JSON.stringify(requests[1]?.continuationMessages)).toContain('"removed":true');
			expect(await callsOf(ran.turnId)).toMatchObject([
				{ approvalStatus: "allowed", status: "completed", output: { removed: true } },
			]);
			expect(await storedReply(ran.turnId)).toMatchObject({
				status: "complete",
				content: "I need approval. Wiped.",
			});
		});

		it("refuses a call that needs approval when its input is too large to show in full", async () => {
			const execute = vi.fn(async () => ({ removed: true }));
			const { model, requests } = scriptedSteps(
				{
					calls: [
						{
							toolCallId: "wipe",
							toolName: CALL_TOOL,
							input: { tool: "wiki__wipe", arguments: { reason: "x".repeat(70_000) } },
						},
					],
				},
				{ text: ["I'll send less."] },
			);

			const ran = await loop.runTurn(chatId, { model, connectorTools: wiki("ask", execute) });

			expect(ran.outcomes).not.toContainEqual(expect.objectContaining({ _tag: "Waiting" }));
			expect(execute).not.toHaveBeenCalled();
			expect(await callsOf(ran.turnId)).toEqual([]);
			expect(JSON.stringify(requests[1]?.continuationMessages)).toContain(
				"too large for an approver to see in full",
			);
		});

		it("ends a recorded call that comes to need approval when its input is too large to show in full", async () => {
			let switched = false;
			const execute = vi.fn(async () => ({ removed: true }));
			afterCommit = async (events) => {
				const started = events.some(({ event }) => event.type === "tool_call.started");
				if (!started || switched) return;
				switched = true;
				await onDatabase((db) =>
					db
						.update(connector)
						.set({ toolAccess: { wipe: "ask" } })
						.where(eq(connector.id, connectorId)),
				);
			};
			const { model, requests } = scriptedSteps(
				{
					calls: [
						{
							toolCallId: "wipe",
							toolName: CALL_TOOL,
							input: { tool: "wiki__wipe", arguments: { reason: "x".repeat(70_000) } },
						},
					],
				},
				{ text: ["I'll send less."] },
			);

			const ran = await loop.runTurn(chatId, { model, connectorTools: wiki("allow", execute) });

			expect(switched).toBe(true);
			expect(execute).not.toHaveBeenCalled();
			expect(await callsOf(ran.turnId)).toMatchObject([
				{ tool: "wiki__wipe", status: "failed", approvalStatus: null },
			]);
			expect(JSON.stringify(requests[1]?.continuationMessages)).toContain(
				"too large for an approver to see in full",
			);
		});

		it.each(["disabled", "off", "ask"] as const)(
			"uses the connector's live access when it changes to %s after the model sees it",
			async (access) => {
				const execute = vi.fn(async () => ({ removed: true }));
				const { model, requests } = scriptedSteps(
					{
						calls: [
							{
								toolCallId: "wipe",
								toolName: CALL_TOOL,
								input: { tool: "wiki__wipe", arguments: "{}" },
							},
						],
					},
					{ text: ["Done."] },
				);
				const changed = Models.fromStream((request) =>
					Effect.promise(async () => {
						if (request.step !== 0) return;
						await onDatabase((db) =>
							db
								.update(connector)
								.set(access === "disabled" ? { enabled: false } : { toolAccess: { wipe: access } })
								.where(eq(connector.id, connectorId)),
						);
					}).pipe(Effect.andThen(model.stream(request))),
				);
				const result = await loop.runTurn(chatId, {
					model: changed,
					connectorTools: wiki("allow", execute),
				});
				expect(execute).not.toHaveBeenCalled();
				expect(await storedTurn(result.turnId)).toMatchObject({ writeOrDeleteStarted: false });
				if (access === "ask") {
					expect(result.outcomes).toEqual([
						{ _tag: "Waiting", approvals: [expect.any(String)], taken: true },
					]);
					expect(await callsOf(result.turnId)).toMatchObject([
						{ tool: "wiki__wipe", approvalStatus: "pending" },
					]);
					return;
				}
				const [refused] = await callsOf(result.turnId);
				expect(refused).toMatchObject({
					tool: "wiki__wipe",
					status: "failed",
					approvalStatus: null,
				});
				expect(JSON.stringify(requests[1]?.continuationMessages)).toContain(refused?.error);
			},
		);

		it("parks the same recorded call when its tool switches to Ask before dispatch", async () => {
			let runningId: string | undefined;
			let access: "allow" | "ask" = "allow";
			const execute = vi.fn(async () => ({ removed: true }));
			afterCommit = async (events) => {
				for (const { event } of events) {
					if (event.type !== "tool_call.started" || runningId) continue;
					const call = Schema.decodeUnknownOption(toolCallPartSchema)(event.toolCall);
					if (
						call._tag === "None" ||
						call.value.tool !== "wiki__wipe" ||
						call.value.status !== "running"
					)
						continue;
					runningId = call.value.id;
					access = "ask";
					await onDatabase((db) =>
						db
							.update(connector)
							.set({ toolAccess: { wipe: access } })
							.where(eq(connector.id, connectorId)),
					);
				}
			};
			const { model } = scriptedSteps(
				{
					calls: [
						{
							toolCallId: "wipe",
							toolName: CALL_TOOL,
							input: { tool: "wiki__wipe", arguments: {} },
						},
					],
				},
				{ text: ["Done."] },
			);
			const result = await loop.runTurn(chatId, {
				model,
				connectorTools: { forTurn: (...args) => wiki(access, execute).forTurn(...args) },
			});
			expect(execute).not.toHaveBeenCalled();
			expect(runningId).toBeDefined();
			expect(await storedTurn(result.turnId)).toMatchObject({ writeOrDeleteStarted: false });
			const [parked] = await callsOf(result.turnId);
			if (!parked) throw new Error("Connector call was not parked");
			expect(parked).toMatchObject({
				id: runningId,
				status: "awaiting_approval",
				approvalStatus: "pending",
			});
			await chatsAs(adminId).decide({ toolCallId: parked.id, decision: "allow_once" });
			const principal = await result.authentication.authenticate(result.turnId);
			await result.steps.step(result.run.request, principal, {
				turnId: result.turnId,
				attempt: 0,
				step: 1,
			});
			expect(execute).toHaveBeenCalledOnce();
			expect(await callsOf(result.turnId)).toMatchObject([{ id: runningId, status: "completed" }]);
			expect(await storedTurn(result.turnId)).toMatchObject({ writeOrDeleteStarted: true });
		});

		it("refuses a viewer's connector write even when the tool grants Allow", async () => {
			await onDatabase((db) =>
				db.update(membership).set({ role: "viewer" }).where(eq(membership.memberId, adminId)),
			);
			const execute = vi.fn(async () => ({ removed: true }));
			const { model, requests } = scriptedSteps(
				{
					calls: [
						{
							toolCallId: "wipe",
							toolName: CALL_TOOL,
							input: { tool: "wiki__wipe", arguments: {} },
						},
					],
				},
				{ text: ["No change made."] },
			);
			const result = await loop.runTurn(chatId, {
				model,
				connectorTools: wiki("allow", execute),
			});
			const error = new ActionForbidden({ proof: "CanUseConnector" }).userMessage;
			expect(execute).not.toHaveBeenCalled();
			expect(await storedTurn(result.turnId)).toMatchObject({ writeOrDeleteStarted: false });
			expect(await callsOf(result.turnId)).toMatchObject([
				{ status: "failed", error, approvalStatus: null },
			]);
			expect(JSON.stringify(requests[1]?.continuationMessages)).toContain(error);
		});

		it("asks the Personal Assistant's member before an allowed connector write", async () => {
			await onDatabase((db) =>
				db
					.update(bot)
					.set({ assistantOf: adminId, visibility: "personal" })
					.where(eq(bot.id, botId)),
			);
			const execute = vi.fn(async () => ({ removed: true }));
			const { model } = scriptedSteps(
				{
					calls: [
						{
							toolCallId: "wipe",
							toolName: CALL_TOOL,
							input: { tool: "wiki__wipe", arguments: {} },
						},
					],
				},
				{ text: ["Done."] },
			);
			const parked = await loop.runTurn(chatId, {
				model,
				connectorTools: wiki("allow", execute),
			});
			expect(execute).not.toHaveBeenCalled();
			const [call] = await callsOf(parked.turnId);
			if (!call) throw new Error("Connector call was not recorded");
			expect(call.approvalStatus).toBe("pending");
			await chatsAs(adminId).decide({ toolCallId: call.id, decision: "allow_once" });
			const principal = await parked.authentication.authenticate(parked.turnId);
			await parked.steps.step(parked.run.request, principal, {
				turnId: parked.turnId,
				attempt: 0,
				step: 1,
			});
			expect(execute).toHaveBeenCalledOnce();
		});

		it.each(["ask", "off"] as const)(
			"rechecks an allowed connector call when its access changes to %s",
			async (changed) => {
				await onDatabase((db) =>
					db
						.update(bot)
						.set({ assistantOf: adminId, visibility: "personal" })
						.where(eq(bot.id, botId)),
				);
				let access: "allow" | "ask" | "off" = "allow";
				const execute = vi.fn(async () => ({ removed: true }));
				const { model, requests } = calling(CALL_TOOL, { tool: "wiki__wipe", arguments: {} });
				const ran = await loop.runTurn(chatId, {
					model,
					connectorTools: { forTurn: (...args) => wiki(access, execute).forTurn(...args) },
				});
				const [parked] = await callsOf(ran.turnId);
				if (!parked) throw new Error("No call parked");
				expect(parked).toMatchObject({
					approvalStatus: "pending",
					approvalConnectorAccess: "allow",
				});
				await chatsAs(adminId).decide({ toolCallId: parked.id, decision: "allow_once" });
				access = changed;
				const reaskingAfter = Date.now();
				const outcome = await resumeAt(ran, 1);
				expect(execute).not.toHaveBeenCalled();
				if (changed === "off") {
					expect(outcome).toEqual({ _tag: "Finished" });
					expect(JSON.stringify(requests[1]?.continuationMessages)).toContain(
						"its approval no longer applies",
					);
					return;
				}
				const [reparked] = await callsOf(ran.turnId);
				if (!reparked) throw new Error("No renewed approval");
				expect(reparked).toMatchObject({
					id: parked.id,
					approvalStatus: "pending",
					approvalConnectorAccess: "ask",
					decidedById: null,
				});
				expect(reparked.approvalId).not.toBe(parked.approvalId);
				expect(reparked.approvalAskedAt?.getTime()).toBeGreaterThanOrEqual(reaskingAfter);
				expect(outcome).toEqual({
					_tag: "Waiting",
					approvals: [reparked.approvalId],
					taken: false,
				});
				await chatsAs(adminId).decide({ toolCallId: parked.id, decision: "allow_once" });
				expect(await resumeAt(ran, 1)).toEqual({ _tag: "Finished" });
				expect(execute).toHaveBeenCalledOnce();
				expect(await callsOf(ran.turnId)).toMatchObject([{ id: parked.id, status: "completed" }]);
			},
		);

		it.each([
			["once the asking project turned it on", true],
			["not when the asking project hasn't turned it on, though the catalog offers it", false],
		] as const)(
			"calls a helper’s own allowed connector in the asking chat %s",
			async (_case, on) => {
				const helper = await seedBot(workspaceId, { createdById: adminId });
				await onDatabase((db) => db.update(bot).set({ model: "m" }).where(eq(bot.id, helper.id)));
				const ownConnector = await seedConnector(workspaceId, helper.defaultProject);
				const projectId = await seedProject(workspaceId, { leadBotId: botId, bots: [helper.id] });
				if (on) await seedProjectBotConnector(workspaceId, projectId, helper.id, ownConnector);
				const source = await seedProjectChat(workspaceId, projectId, adminId);
				const parent = await seedTurnAnswering(
					source,
					botId,
					{ member: adminId },
					{ status: "done" },
				);
				const triggerMessageId = await seedMessage(source, { bot: botId, turn: parent });
				await runOnPostgres(
					Context.get(loop.services, Turns.Service).ask({
						chatId: source,
						botId: helper.id,
						triggerMessageId,
						reason: "collaboration",
					}),
				);
				const execute = vi.fn(async () => ({ removed: true }));
				const discovery: ConnectorCatalog.Interface = {
					forTurn: (workspace, projects, side, sessions) => {
						expect(projects).toEqual({ projectId, ownProjectId: helper.defaultProject });
						return wiki("allow", execute, ownConnector).forTurn(
							workspace,
							projects,
							side,
							sessions,
						);
					},
				};
				const { model } = scriptedSteps(
					{
						calls: [
							{
								toolCallId: "wipe",
								toolName: CALL_TOOL,
								input: { tool: "wiki__wipe", arguments: {} },
							},
						],
					},
					{ text: ["Done."] },
				);
				const result = await loop.runTurn(source, { model, connectorTools: discovery });
				expect(execute).toHaveBeenCalledTimes(on ? 1 : 0);
				expect(await callsOf(result.turnId)).toMatchObject([
					{
						chatId: source,
						connectorId: ownConnector,
						approvalStatus: null,
						status: on ? "completed" : "failed",
					},
				]);
			},
			15_000,
		);

		it("hides a connector outside chat bounds even when the catalog offers it", async () => {
			const project = await seedProject(workspaceId, { leadBotId: botId });
			const outside = await seedConnector(workspaceId, project);
			const execute = vi.fn(async () => ({ removed: true }));
			const { model, requests } = calling(CALL_TOOL, { tool: "wiki__wipe", arguments: {} });

			await loop.runTurn(chatId, { model, connectorTools: wiki("allow", execute, outside) });

			expect(toolResultFor(requests[1], "sdk-1")).toEqual(
				failedCall(new ResourceHidden({ resource: "connector" }).userMessage),
			);
			expect(execute).not.toHaveBeenCalled();
		});

		it.each([false, true])(
			"keeps MCP sessions for an execution and closes them on takeover or finish (takeover %s)",
			async (takeover) => {
				await onDatabase((db) =>
					db.update(connector).set({ handle: "wiki" }).where(eq(connector.id, connectorId)),
				);
				const described = {
					name: "lookup",
					description: "Find something",
					readOnly: true,
					destructive: false,
				};
				const schema = { type: "object" as const };
				const sessionEvents: Array<"connect" | "close"> = [];
				const close = async () => {
					sessionEvents.push("close");
				};
				const run = vi.fn(async () => ({ found: true }));
				const list = vi.fn(async () => ({
					definitions: { tools: [] },
					instructions: undefined,
					tools: [
						{
							described,
							inputSchema: schema,
							tool: tool({
								inputSchema: Schema.Struct({}).pipe(
									Schema.toStandardSchemaV1,
									Schema.toStandardJSONSchemaV1,
								),
							}),
						},
					],
				}));
				const connect = async () => {
					sessionEvents.push("connect");
					return { list, run, close };
				};
				const url = "https://wiki.example.com/mcp";
				const discovery = ConnectorCatalog.from({
					connectors: {
						targetsForProject: () =>
							Effect.succeed({
								targets: [
									{
										connectorId,
										handle: "wiki",
										kind: "mcp",
										url,
										auth: "header",
										headers: {},
										toolAccess: {},
										configurationUpdatedAt: new Date(),
										configurationRevision: 1,
									},
								],
								signInExpired: [],
								installedUrls: [url],
							}),
					},
					httpClients: { for: () => fetch },
					connect,
				});
				const call = { toolName: CALL_TOOL, input: { tool: "wiki__lookup", arguments: {} } };
				const { model, requests } = scriptedSteps(
					{ calls: [{ toolCallId: "search", toolName: "tool_search", input: { query: "wiki" } }] },
					{ calls: [{ toolCallId: "lookup-1", ...call }] },
					{ calls: [{ toolCallId: "lookup-2", ...call }] },
					{ text: ["Done."] },
				);
				const [running] = await runOnPostgres(runningTurns(chatId));
				if (!running) throw new Error("No turn is running");
				const { steps, authentication } = await loop.loopOver({ model, connectorTools: discovery });
				const opened = await steps.open(running.request, 0);
				if (opened._tag !== "Opened") throw new Error("The turn may not run");
				const { turnId } = opened;
				const first = await authentication.authenticate(turnId);
				expect(await steps.step(running.request, first, { turnId, attempt: 0, step: 0 })).toEqual({
					_tag: "Continue",
				});
				expect(sessionEvents).toEqual(["connect"]);
				const principal = takeover ? await authentication.authenticate(turnId) : first;
				for (const step of [1, 2, 3]) {
					expect(
						await steps.step(running.request, principal, { turnId, attempt: 0, step }),
					).toEqual({
						_tag: step === 3 ? "Finished" : "Continue",
					});
				}
				expect(JSON.stringify(requests[1]?.continuationMessages)).toContain("wiki__lookup");
				expect(await callsOf(turnId)).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							tool: "wiki__lookup",
							connectorId,
							sdkToolCallId: "lookup-1",
							status: "completed",
						}),
						expect.objectContaining({
							tool: "wiki__lookup",
							connectorId,
							sdkToolCallId: "lookup-2",
							status: "completed",
						}),
					]),
				);
				expect(list).toHaveBeenCalledOnce();
				expect(run).toHaveBeenCalledTimes(2);
				expect(sessionEvents).toEqual(
					takeover ? ["connect", "close", "connect", "close"] : ["connect", "close"],
				);
			},
			15_000,
		);

		it("tells the model a denied call was denied, without making it", async () => {
			const execute = vi.fn(async () => ({ removed: true }));
			const { model, requests } = scriptedSteps(
				{
					calls: [
						{
							toolCallId: "sdk-1",
							toolName: CALL_TOOL,
							input: { tool: "wiki__wipe", arguments: {} },
						},
					],
				},
				{ text: ["It was denied."] },
			);
			const ran = await loop.runTurn(chatId, { model, connectorTools: wiki("ask", execute) });
			const [parked] = await callsOf(ran.turnId);
			if (!parked) throw new Error("no call parked");

			await chatsAs(adminId).decide({ toolCallId: parked.id, decision: "deny" });
			const principal = await ran.authentication.authenticate(ran.turnId);
			await ran.steps.step(ran.run.request, principal, { turnId: ran.turnId, attempt: 0, step: 1 });

			expect(execute).not.toHaveBeenCalled();
			expect(JSON.stringify(requests[1]?.continuationMessages)).toContain("execution-denied");
			expect(await storedTurn(ran.turnId)).toMatchObject({ status: "done" });
		});
	},
);
