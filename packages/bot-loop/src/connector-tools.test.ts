import { ActionForbidden, ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { toolCallPartSchema } from "@sugabots/contracts/messages";
import {
	seedBot,
	seedConnector,
	seedMember,
	seedMessage,
	seedProject,
	seedProjectBotConnector,
	seedProjectChat,
	seedTurnAnswering,
	setRole,
} from "@sugabots/core/authentication/seed.test-support";
import { ConnectorCatalog } from "@sugabots/core/chats/tools/connector-catalog";
import { CALL_TOOL } from "@sugabots/core/chats/tools/tool-search/tool";
import { aChatWithConnectorAwaitingReply, runningTurns } from "@sugabots/core/chats/turns/testing";
import { Turns } from "@sugabots/core/chats/turns/turns";
import type { CommittedEvent } from "@sugabots/core/database/events/outbox";
import { bot, connector, membership, projectBotConnector } from "@sugabots/core/database/schema";
import { closeDatabase, onDatabase, runOnPostgres } from "@sugabots/core/database/testing";
import { asMember } from "@sugabots/core/operations/chats/testing";
import { authenticators, principals } from "@sugabots/core/proofs/world.test-support";
import { ConnectorStore } from "@sugabots/core/providers/connectors/connector-store";
import {
	egressToGitHub,
	gitHubSetupAt,
	installedConnector,
	json,
	mintsTokens,
	standInGitHub,
} from "@sugabots/core/providers/connectors/github/github.test-support";
import { Models } from "@sugabots/core/providers/models/models";
import { defaultProjectOf } from "@sugabots/core/workspaces/projects/project-reads";
import { type JSONSchema7, jsonSchema, tool } from "ai";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	botLoopOnPostgres,
	calling,
	callsOf,
	failedCall,
	parkedCallOf,
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
			await setRole(workspaceId, adminId, "viewer");
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

		it.each([
			"connector deleted",
			"connector disabled",
			"off in the project",
			"address changed in the project",
			"configuration changed",
			"tool off",
			"tool off by default",
		] as const)("closes the approval and wakes the turn after %s", async (change) => {
			let sourceChatId = chatId;
			if (change === "off in the project" || change === "address changed in the project") {
				const projectId = await seedProject(workspaceId, { leadBotId: botId });
				await seedProjectBotConnector(workspaceId, projectId, botId, connectorId);
				const started = await chatsAs(adminId).startProjectChat({
					projectId,
					retryKey: crypto.randomUUID(),
					message: "Remove outdated pages from the wiki.",
				});
				sourceChatId = started.chat.id;
			}

			const execute = vi.fn(async () => ({ removed: true }));
			const { model, requests } = calling(CALL_TOOL, { tool: "wiki__wipe", arguments: {} });
			const workflow = await loop.runWorkflow(sourceChatId, {
				model,
				connectorTools: wiki("ask", execute),
			});
			await workflow.suspended();
			const { turnId, parked } = await parkedCallOf(workflow.executionId);
			expect(parked).toMatchObject({ connectorId, approvalStatus: "pending" });

			if (change === "connector deleted") {
				await onDatabase((db) => db.delete(connector).where(eq(connector.id, connectorId)));
			} else if (change === "off in the project") {
				await onDatabase((db) =>
					db.delete(projectBotConnector).where(eq(projectBotConnector.connectorId, connectorId)),
				);
			} else {
				const changes = {
					"connector disabled": { enabled: false, configurationRevision: 2 },
					"address changed in the project": { addressRevision: 2, configurationRevision: 2 },
					"configuration changed": { configurationRevision: 2 },
					"tool off": { toolAccess: { wipe: "off" as const } },
					"tool off by default": {
						toolAccess: {},
						tools: [{ name: "wipe", description: null, readOnly: false, destructive: true }],
					},
				};
				await onDatabase((db) =>
					db.update(connector).set(changes[change]).where(eq(connector.id, connectorId)),
				);
			}

			const switchedOff = change !== "connector deleted" && change !== "configuration changed";
			const error = switchedOff
				? "This approval was closed because the connector or its tool is now off."
				: "This approval was closed because the connector or its tool settings changed.";
			await expect(
				chatsAs(adminId).decide({ toolCallId: parked.id, decision: "allow_once" }),
			).rejects.toMatchObject({
				reason: switchedOff ? "connectorOff" : "connectorChanged",
				userMessage: error,
			});
			await workflow.completed();
			expect(await callsOf(turnId)).toMatchObject([
				{ id: parked.id, status: "failed", approvalStatus: "denied", decidedById: null, error },
			]);
			expect(await chatsAs(adminId).approvals(workspaceId)).toMatchObject({
				waiting: [],
				answered: [
					{
						call: {
							id: parked.id,
							error,
							approval: { closedBecause: switchedOff ? "connectorOff" : "connectorChanged" },
						},
						answer: { status: "closed", closedAt: expect.any(String) },
					},
				],
			});
			expect(JSON.stringify(requests[1]?.continuationMessages)).toContain(error);
			expect(execute).not.toHaveBeenCalled();
		});

		it.each(["before Allow", "after Allow"] as const)(
			"does not send an approved connector call when its server changes the definition %s",
			async (when) => {
				const described = { name: "wipe", description: null, readOnly: false, destructive: false };
				await onDatabase((db) =>
					db
						.update(connector)
						.set({ handle: "wiki", toolAccess: { wipe: "ask" } })
						.where(eq(connector.id, connectorId)),
				);
				let inputSchema: JSONSchema7 = { type: "object", additionalProperties: false };
				const list = vi.fn(async () => ({
					definitions: { tools: [{ name: described.name, inputSchema }] },
					instructions: undefined,
					tools: [{ described, inputSchema, tool: { inputSchema: jsonSchema(inputSchema) } }],
				}));
				const run = vi.fn(async () => ({ removed: true }));
				const connectorTools = ConnectorCatalog.from({
					connectors: await runOnPostgres(
						ConnectorStore.Service.pipe(Effect.provide(ConnectorStore.layer)),
					),
					httpClients: { for: () => fetch },
					connect: async () => ({ list, run, close: async () => {} }),
				});
				const { model } = calling(CALL_TOOL, { tool: "wiki__wipe", arguments: {} });
				const ran = await loop.runTurn(chatId, { model, connectorTools });
				const [parked] = await callsOf(ran.turnId);
				if (!parked) throw new Error("No connector call parked");
				expect(parked).toMatchObject({ connectorId, approvalStatus: "pending", input: {} });
				expect(list).toHaveBeenCalledOnce();

				const admin = asMember(await loop.callWithConnectorCatalog(connectorTools), adminId);
				const allow = () => admin.decide({ toolCallId: parked.id, decision: "allow_once" });
				const changeDefinition = () => {
					inputSchema = { ...inputSchema, properties: { reason: { type: "string" } } };
				};
				if (when === "before Allow") {
					changeDefinition();
					await expect(allow()).rejects.toMatchObject({
						_tag: "ToolApprovalConflict",
						reason: "connectorChanged",
					});
					expect(await callsOf(ran.turnId)).toMatchObject([
						{ id: parked.id, status: "failed", approvalStatus: "denied", decidedById: null },
					]);
					expect(list).toHaveBeenCalledTimes(2);
					expect(run).not.toHaveBeenCalled();
					return;
				}

				await allow();
				changeDefinition();
				expect(await resumeAt(ran, 1)).toMatchObject({ _tag: "Waiting" });
				expect(list).toHaveBeenCalledTimes(3);
				expect(run).not.toHaveBeenCalled();
				const [renewed] = await callsOf(ran.turnId);
				expect(renewed).toMatchObject({
					id: parked.id,
					approvalStatus: "pending",
					connectorRevision: 3,
				});
				expect(renewed?.approvalId).not.toBe(parked.approvalId);

				await allow();
				expect(await resumeAt(ran, 1)).toEqual({ _tag: "Finished" });
				expect(run).toHaveBeenCalledExactlyOnceWith(
					expect.objectContaining({
						definitions: { tools: [{ name: described.name, inputSchema }] },
					}),
					described.name,
					{},
					expect.anything(),
				);
			},
		);

		it.each(["keeps the augmentation", "lists its own upload"] as const)(
			"checks an approved connector augmentation again when the server %s",
			async (change) => {
				await onDatabase((db) =>
					db
						.update(connector)
						.set({
							handle: "files",
							url: "https://mcp.linear.app/mcp",
							toolAccess: { upload_file: "ask" },
						})
						.where(eq(connector.id, connectorId)),
				);
				const described = {
					name: "upload_file",
					description: null,
					readOnly: false,
					destructive: false,
				};
				const inputSchema: JSONSchema7 = { type: "object" };
				let serverOffersUpload = false;
				const list = vi.fn(async () => ({
					definitions: { tools: serverOffersUpload ? [{ name: described.name, inputSchema }] : [] },
					instructions: undefined,
					tools: serverOffersUpload
						? [{ described, inputSchema, tool: { inputSchema: jsonSchema(inputSchema) } }]
						: [],
				}));
				const run = vi.fn(async () => ({ uploaded: true }));
				const connectorTools = ConnectorCatalog.from({
					connectors: await runOnPostgres(
						ConnectorStore.Service.pipe(Effect.provide(ConnectorStore.layer)),
					),
					httpClients: { for: () => fetch },
					connect: async () => ({ list, run, close: async () => {} }),
				});
				const { model } = calling(CALL_TOOL, {
					tool: "files__upload_file",
					arguments: {
						uploadUrl: "https://storage.googleapis.com/uploads.linear.app/example",
						headers: {},
					},
				});
				const ran = await loop.runTurn(chatId, { model, connectorTools });
				const [parked] = await callsOf(ran.turnId);
				if (!parked) throw new Error("No connector call parked");
				expect(parked).toMatchObject({ connectorId, approvalStatus: "pending" });
				const admin = asMember(await loop.callWithConnectorCatalog(connectorTools), adminId);
				const allow = () => admin.decide({ toolCallId: parked.id, decision: "allow_once" });
				await allow();
				expect(list).toHaveBeenCalledTimes(2);

				serverOffersUpload = change === "lists its own upload";
				const resumed = await resumeAt(ran, 1);
				expect(list).toHaveBeenCalledTimes(3);
				expect(run).not.toHaveBeenCalled();
				if (!serverOffersUpload) {
					expect(resumed).toEqual({ _tag: "Finished" });
					expect(await callsOf(ran.turnId)).toMatchObject([
						{
							id: parked.id,
							approvalStatus: "allowed",
							output: {
								status: "failed",
								error: expect.stringContaining("Give the file to upload"),
							},
						},
					]);
					return;
				}
				expect(resumed).toMatchObject({ _tag: "Waiting" });
				const [renewed] = await callsOf(ran.turnId);
				expect(renewed).toMatchObject({ id: parked.id, approvalStatus: "pending" });
				expect(renewed?.approvalId).not.toBe(parked.approvalId);

				await allow();
				expect(await resumeAt(ran, 1)).toEqual({ _tag: "Finished" });
				expect(run).toHaveBeenCalledOnce();
			},
		);

		it("closes a Personal Assistant's pending approval and wakes the turn when tool access changes from Allow to Ask", async () => {
			await onDatabase((db) =>
				db
					.update(bot)
					.set({ assistantOf: adminId, visibility: "personal" })
					.where(eq(bot.id, botId)),
			);
			let access: "allow" | "ask" = "allow";
			const execute = vi.fn(async () => ({ removed: true }));
			const { model, requests } = calling(CALL_TOOL, { tool: "wiki__wipe", arguments: {} });
			const workflow = await loop.runWorkflow(chatId, {
				model,
				connectorTools: {
					...ConnectorCatalog.none,
					forTurn: (...args) => wiki(access, execute).forTurn(...args),
				},
			});
			await workflow.suspended();
			const { turnId, parked } = await parkedCallOf(workflow.executionId);
			expect(parked).toMatchObject({ approvalStatus: "pending", approvalConnectorAccess: "allow" });

			access = "ask";
			await onDatabase((db) =>
				db
					.update(connector)
					.set({ toolAccess: { wipe: access } })
					.where(eq(connector.id, connectorId)),
			);
			await expect(
				chatsAs(adminId).decide({ toolCallId: parked.id, decision: "allow_once" }),
			).rejects.toMatchObject({ _tag: "ToolApprovalConflict", reason: "connectorChanged" });
			await workflow.completed();

			const error = "This approval was closed because the connector or its tool settings changed.";
			expect(await callsOf(turnId)).toMatchObject([
				{ id: parked.id, status: "failed", approvalStatus: "denied", decidedById: null, error },
			]);
			expect(JSON.stringify(requests[1]?.continuationMessages)).toContain(error);
			expect(execute).not.toHaveBeenCalled();
		});

		it("refuses a demoted asker's Allow for a pending connector write", async () => {
			await setRole(workspaceId, adminId, "editor");
			const execute = vi.fn(async () => ({ removed: true }));
			const { model } = scriptedSteps({
				calls: [
					{
						toolCallId: "wipe",
						toolName: CALL_TOOL,
						input: { tool: "wiki__wipe", arguments: {} },
					},
				],
			});
			const ran = await loop.runTurn(chatId, { model, connectorTools: wiki("ask", execute) });
			const [parked] = await callsOf(ran.turnId);
			if (!parked) throw new Error("No call parked");
			expect(parked).toMatchObject({ approvalStatus: "pending", writeOrDelete: true });

			await setRole(workspaceId, adminId, "viewer");
			await expect(
				chatsAs(adminId).decide({ toolCallId: parked.id, decision: "allow_once" }),
			).rejects.toMatchObject({ _tag: "ActionForbidden" });
			expect(await callsOf(ran.turnId)).toMatchObject([{ approvalStatus: "pending" }]);
			await chatsAs(adminId).decide({ toolCallId: parked.id, decision: "deny" });
			expect(await callsOf(ran.turnId)).toMatchObject([{ approvalStatus: "denied" }]);
			expect(execute).not.toHaveBeenCalled();
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

		it("refuses an offered connector tool after a test finds that it deletes data", async () => {
			const listed = {
				name: "lookup",
				description: "Find a page",
				readOnly: true,
				destructive: false,
			};
			const [saved] = await onDatabase((db) =>
				db
					.update(connector)
					.set({ handle: "wiki", tools: [listed] })
					.where(eq(connector.id, connectorId))
					.returning({ projectId: connector.projectId }),
			);
			if (!saved) throw new Error("No connector");
			const connectors = await runOnPostgres(
				ConnectorStore.Service.pipe(Effect.provide(ConnectorStore.layer)),
			);
			const run = vi.fn(async () => ({ found: true }));
			const catalog = ConnectorCatalog.from({
				connectors,
				httpClients: { for: () => fetch },
				connect: async () => ({
					list: async () => ({
						definitions: { tools: [] },
						instructions: undefined,
						tools: [
							{
								described: listed,
								inputSchema: { type: "object" },
								tool: tool({
									inputSchema: Schema.Struct({}).pipe(
										Schema.toStandardSchemaV1,
										Schema.toStandardJSONSchemaV1,
									),
								}),
							},
						],
					}),
					run,
					close: async () => {},
				}),
			});
			const { model } = calling(CALL_TOOL, { tool: "wiki__lookup", arguments: {} });
			const afterTest = Models.fromStream((request) =>
				(request.step === 0
					? Effect.gen(function* () {
							const target = yield* connectors.target(workspaceId, saved.projectId, connectorId);
							if (!target) throw new Error("No connector target");
							yield* connectors.recordTest(workspaceId, target, {
								tools: [{ ...listed, readOnly: false, destructive: true }],
								definitions: [
									{
										name: listed.name,
										description: listed.description,
										inputSchema: { type: "object" },
										annotations: { readOnlyHint: false, destructiveHint: true },
									},
								],
							});
						})
					: Effect.void
				).pipe(Effect.andThen(model.stream(request))),
			);

			const ran = await loop.runTurn(chatId, { model: afterTest, connectorTools: catalog });

			expect(run).not.toHaveBeenCalled();
			expect(await callsOf(ran.turnId)).toMatchObject([
				{ tool: "wiki__lookup", status: "failed", approvalStatus: null },
			]);
		});

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
				connectorTools: {
					...ConnectorCatalog.none,
					forTurn: (...args) => wiki(access, execute).forTurn(...args),
				},
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
					connectorTools: {
						...ConnectorCatalog.none,
						forTurn: (...args) => wiki(access, execute).forTurn(...args),
					},
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
					expect(await callsOf(ran.turnId)).toMatchObject([
						{ error: "The tool was not run because the connector or its tool is now off." },
					]);
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
			{ change: "before Allow", name: "selected repositories swap paths before Allow" },
			{ change: "after Allow", name: "selected repositories swap paths after Allow" },
			{ change: "branch before Allow", name: "the default base branch changes before Allow" },
			{ change: "branch after Allow", name: "the default base branch changes after Allow" },
		] as const)(
			"does not send the original GitHub call after its target changes, when $name",
			async ({ change }) => {
				await onDatabase((db) =>
					db.update(connector).set({ enabled: false }).where(eq(connector.id, connectorId)),
				);
				let swappedPaths = false;
				let defaultBase = "main";
				const github = standInGitHub(mintsTokens, ({ method, path }) => {
					if (path === "/installation/repositories") {
						const repositories = [
							{ id: 101, full_name: swappedPaths ? "acme/infra" : "acme/web", private: true },
							{ id: 102, full_name: swappedPaths ? "acme/web" : "acme/infra", private: true },
						];
						return json({ total_count: repositories.length, repositories });
					}
					if (method === "GET" && path === "/repos/acme/web") {
						return json({ default_branch: defaultBase });
					}
					if (method === "POST" && path === "/repos/acme/web/pulls") {
						return json({ number: 15, html_url: "https://github.com/acme/web/pull/15" }, 201);
					}
					return undefined;
				});
				const projectId = await runOnPostgres(defaultProjectOf(botId));
				const setup = await gitHubSetupAt(github.fetch, "https://sugabots.example.com");
				const installed = await installedConnector(setup, { projectId, adminId });
				const admin = await setup.member(adminId);
				const addRepository = (repository: string) =>
					setup.call(admin, "gitHubConnectors.addRepository", {
						projectId,
						connectorId: installed,
						repository,
					});
				await addRepository("acme/web");
				await addRepository("acme/infra");
				const installation = () =>
					onDatabase((db) => db.select().from(connector).where(eq(connector.id, installed)));
				const [before] = await installation();
				if (!before) throw new Error("No GitHub connector");
				const connectorTools = await runOnPostgres(
					ConnectorCatalog.Service.pipe(
						Effect.provide(
							ConnectorCatalog.layer.pipe(Layer.provide(egressToGitHub(github.fetch))),
						),
					),
				);
				const { model } = calling(CALL_TOOL, {
					tool: `${before.handle}__open_pull_request`,
					arguments: {
						repository: "acme/web",
						branch: "sugabots/fix-checkout",
						title: "Fix checkout",
						body: "Keep the order after a refresh.",
					},
				});
				const readsBefore = github.asked.filter(
					({ method, path }) => method === "GET" && path === "/repos/acme/web",
				).length;
				const ran = await loop.runTurn(chatId, { model, connectorTools });
				expect(
					github.asked.filter(({ method, path }) => method === "GET" && path === "/repos/acme/web"),
				).toHaveLength(readsBefore + 1);
				const [parked] = await callsOf(ran.turnId);
				if (!parked) throw new Error("No GitHub call parked");
				const opened = () =>
					github.asked.filter(
						({ method, path }) => method === "POST" && path === "/repos/acme/web/pulls",
					);
				const refreshPaths = async () => {
					swappedPaths = true;
					await addRepository("acme/web");
				};
				const adminChat = asMember(await loop.callWithConnectorCatalog(connectorTools), adminId);
				const allow = () => adminChat.decide({ toolCallId: parked.id, decision: "allow_once" });
				if (change === "before Allow" || change === "branch before Allow") {
					if (change === "before Allow") await refreshPaths();
					else defaultBase = "release";
					await expect(allow()).rejects.toMatchObject({
						_tag: "ToolApprovalConflict",
						reason: "connectorChanged",
					});
					expect(await callsOf(ran.turnId)).toMatchObject([
						{ id: parked.id, status: "failed", approvalStatus: "denied", decidedById: null },
					]);
					expect((await adminChat.approvals(workspaceId)).waiting).toEqual([]);
					expect(opened()).toEqual([]);
					return;
				}

				await allow();
				if (change === "after Allow") {
					await refreshPaths();
					expect(await resumeAt(ran, 1)).toMatchObject({ _tag: "Finished" });
					expect(opened()).toEqual([]);
					expect(await callsOf(ran.turnId)).toMatchObject([{ id: parked.id, status: "failed" }]);
					return;
				}
				defaultBase = "release";
				expect(await resumeAt(ran, 1)).toMatchObject({ _tag: "Waiting" });
				expect(opened()).toEqual([]);
				const [fresh] = (await adminChat.approvals(workspaceId)).waiting;
				expect(fresh?.call.approval?.id).not.toBe(parked.approvalId);
				expect(fresh?.call.approval).toMatchObject({
					gitHub: { repositoryId: "101", baseBranch: defaultBase },
				});
				if (!fresh) throw new Error("No renewed GitHub approval");
				await adminChat.decide({ toolCallId: fresh.call.id, decision: "allow_once" });
				expect(await resumeAt(ran, 1)).toEqual({ _tag: "Finished" });
				expect(opened()).toMatchObject([{ body: { base: defaultBase } }]);
			},
		);

		it("calls a helper's own connector only after a project manager turns it on", async () => {
			const helper = await seedBot(workspaceId, { createdById: adminId });
			await onDatabase((db) => db.update(bot).set({ model: "m" }).where(eq(bot.id, helper.id)));
			const editor = await seedMember(workspaceId, "editor");
			const projectId = await seedProject(workspaceId, {
				leadBotId: botId,
				bots: [helper.id],
				members: [editor],
			});
			const described = {
				name: "lookup",
				description: "Find a page",
				readOnly: true,
				destructive: false,
			};
			const connectorId = await seedConnector(workspaceId, helper.defaultProject, {
				tools: [described],
			});
			await onDatabase((db) =>
				db.update(connector).set({ handle: "wiki" }).where(eq(connector.id, connectorId)),
			);
			const run = vi.fn(async () => ({ found: true }));
			const list = async () => ({
				definitions: { tools: [] },
				instructions: undefined,
				tools: [
					{
						described,
						inputSchema: { type: "object" as const },
						tool: tool({
							inputSchema: Schema.Struct({}).pipe(
								Schema.toStandardSchemaV1,
								Schema.toStandardJSONSchemaV1,
							),
						}),
					},
				],
			});
			const catalog = ConnectorCatalog.from({
				connectors: await runOnPostgres(
					ConnectorStore.Service.pipe(Effect.provide(ConnectorStore.layer)),
				),
				httpClients: { for: () => fetch },
				connect: async () => ({ list, run, close: async () => {} }),
			});
			const tryLookup = async () => {
				const chatId = await seedProjectChat(workspaceId, projectId, editor);
				const parent = await seedTurnAnswering(
					chatId,
					botId,
					{ member: editor },
					{ status: "done" },
				);
				const triggerMessageId = await seedMessage(chatId, { bot: botId, turn: parent });
				await runOnPostgres(
					Context.get(loop.services, Turns.Service).ask({
						chatId,
						botId: helper.id,
						triggerMessageId,
						reason: "collaboration",
					}),
				);
				const { model } = calling(CALL_TOOL, { tool: "wiki__lookup", arguments: {} });
				const result = await loop.runTurn(chatId, { model, connectorTools: catalog });
				return callsOf(result.turnId);
			};

			const signedIn = principals(await authenticators());
			const manager = await signedIn.member(adminId);
			const offered = (await loop.call(manager, "connectors.listProjectBots", { projectId })).find(
				({ id }) => id === connectorId,
			);
			expect(offered).toMatchObject({ id: connectorId, on: false });
			const input = {
				projectId,
				connectorId,
				on: true,
				addressRevision: offered?.addressRevision ?? 0,
			};
			expect(await tryLookup()).toEqual([]);
			expect(run).not.toHaveBeenCalled();

			await expect(
				loop.call(await signedIn.member(editor), "connectors.setOnInProject", input),
			).rejects.toBeInstanceOf(ActionForbidden);
			expect(await tryLookup()).toEqual([]);
			expect(run).not.toHaveBeenCalled();

			await loop.call(manager, "connectors.setOnInProject", input);
			const calls = await tryLookup();
			expect(run).toHaveBeenCalledTimes(1);
			expect(calls).toMatchObject([{ connectorId, status: "completed", approvalStatus: null }]);
		}, 15_000);

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
				const discovery = ConnectorCatalog.from({
					connectors: await runOnPostgres(
						ConnectorStore.Service.pipe(Effect.provide(ConnectorStore.layer)),
					),
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
