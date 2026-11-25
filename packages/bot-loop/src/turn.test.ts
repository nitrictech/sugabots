import { randomUUID } from "node:crypto";
import {
	botStartedChatSchema,
	chatStream,
	FILE_WRITE_TOOL,
	START_CHAT_TOOL,
	streamEvent,
} from "@sugabots/contracts";
import { BotHasNoModel } from "@sugabots/contracts/errors/chats";
import {
	ActionForbidden,
	ApprovalRefused,
	ResourceHidden,
} from "@sugabots/contracts/errors/proofs";
import { WebToolOff } from "@sugabots/contracts/errors/web";
import { toolCallPartSchema } from "@sugabots/contracts/messages";
import { WEB_FETCH_TOOL, WEB_SEARCH_TOOL } from "@sugabots/contracts/operations/web";
import { ModelRequests } from "@sugabots/core/accounting/model-requests";
import {
	seedAutomation,
	seedBot,
	seedConnector,
	seedMember,
	seedMessage,
	seedProject,
	seedProjectChat,
	seedRun,
	seedTurnAnswering,
} from "@sugabots/core/authentication/seed.test-support";
import { SystemWorkAuthentication } from "@sugabots/core/authentication/system-work";
import { startBotChat } from "@sugabots/core/chats/chats/testing";
import { ConnectorCatalog } from "@sugabots/core/chats/tools/connector-catalog";
import { CALL_TOOL } from "@sugabots/core/chats/tools/tool-search/tool";
import { aChatAwaitingReply, runningTurns } from "@sugabots/core/chats/turns/testing";
import { Turns } from "@sugabots/core/chats/turns/turns";
import { query } from "@sugabots/core/database/database";
import { EventBus } from "@sugabots/core/database/events/bus";
import type { CommittedEvent } from "@sugabots/core/database/events/outbox";
import { EventStore } from "@sugabots/core/database/events/store";
import {
	bot,
	chatParticipant,
	connector,
	membership,
	message,
	modelRequest,
	pinnedBot,
	placedChat,
	project,
	projectBot,
	projectMember,
	searchProvider,
	toolCall,
	turn,
	workspace,
} from "@sugabots/core/database/schema";
import {
	closeDatabase,
	holdTransaction,
	onDatabase,
	runOnPostgres,
	waitUntilWaitingOnLocks,
} from "@sugabots/core/database/testing";
import { asMember } from "@sugabots/core/operations/chats/testing";
import { operationsForTests } from "@sugabots/core/operations/testing";
import { authenticators, principals } from "@sugabots/core/proofs/world.test-support";
import { Models } from "@sugabots/core/providers/models/models";
import { emptyRegistry, resolvedModel, streamed } from "@sugabots/core/providers/models/testing";
import { Egress } from "@sugabots/core/providers/network/egress";
import { unimplemented } from "@sugabots/core/testing";
import { INTERVIEW_PROMPT } from "@sugabots/core/workspaces/bots/interview-prompt";
import { DisplayName, userText } from "@sugabots/errors";
import { tool } from "ai";
import { and, eq, sql } from "drizzle-orm";
import { Context, Duration, Effect, Option, Schema, Stream } from "effect";
import { afterAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { TURN_STEPS } from "./steps.ts";
import { botLoopOnPostgres, scriptedSteps } from "./testing.ts";

/**
 * A turn's steps run through the real operations and chat services on
 * Postgres: one model request a step, what each step leaves in the turn, its
 * reply and its tool calls, and what it tells the chat. The model, the tools
 * and the event bus stand in for the outside.
 */
const SAVE_INSTRUCTIONS_TOOL = "save_instructions";

describe.skipIf(!process.env.DATABASE_URL)("a turn's steps, against Postgres", async () => {
	const delivered: CommittedEvent[] = [];
	let afterCommit: ((events: readonly CommittedEvent[]) => Promise<void>) | undefined;
	const loop = await botLoopOnPostgres(delivered, async (events) => afterCommit?.(events));
	const chatsAs = (memberId: string) => asMember(loop.call, memberId);
	const testProvider = {
		provider: DisplayName.fromRecord("Test provider"),
		model: DisplayName.fromRecord("test-model"),
	};
	const providerDown = new Models.ProviderServerError({
		...testProvider,
		cause: new Error("provider down"),
	});
	let chatId: string;
	let workspaceId: string;
	let connectorId: string;
	let botId: string;
	let adminId: string;

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		({ chatId, workspaceId, connectorId, botId, adminId } = await aChatAwaitingReply(chatsAs));
		delivered.length = 0;
		afterCommit = undefined;
	});

	const storedTurn = async (turnId: string) => {
		const [row] = await onDatabase((db) => db.select().from(turn).where(eq(turn.id, turnId)));
		return row;
	};

	const storedReply = async (turnId: string) => {
		const [row] = await onDatabase((db) =>
			db.select().from(message).where(eq(message.turnId, turnId)),
		);
		return row;
	};

	const callsOf = (turnId: string) =>
		onDatabase((db) => db.select().from(toolCall).where(eq(toolCall.turnId, turnId)));

	const deliveredEvents = () => delivered.map(({ event }) => event);

	/** A connector tool `wiki__wipe` that may change things, with `access`, running `execute`. */
	const wikiWipe = (
		access: "allow" | "ask" | "off",
		execute: () => Promise<unknown>,
		installedId = connectorId,
	): ConnectorCatalog.Interface => ({
		forTurn: () =>
			Effect.promise(async () => {
				await onDatabase((db) =>
					db
						.update(connector)
						.set({ handle: "wiki", toolAccess: { wipe: access } })
						.where(eq(connector.id, installedId)),
				);
				return {
					tools: {
						wiki__wipe: {
							described: { name: "wipe", readOnly: false, destructive: null },
							tool: tool({
								inputSchema: Schema.Struct({}).pipe(
									Schema.toStandardSchemaV1,
									Schema.toStandardJSONSchemaV1,
								),
								execute,
							}),
							writeOrDelete: true,
							access,
							connectorId: installedId,
							handle: "wiki",
							description: "",
							inputSchema: { type: "object" as const },
							connectorRevision: 1,
							remoteToolName: "wipe",
						},
					},
					unavailable: [],
					signInExpired: [],
					instructions: {},
					addable: [],
					fromProjectAndBot: false,
					close: async () => undefined,
				};
			}),
	});

	const pageUrl = "https://example.com/";
	const searchBaseUrl = "https://search.example.com";
	const enableWeb = () =>
		onDatabase((db) =>
			db.insert(searchProvider).values({
				workspaceId,
				builtIn: "searxng",
				baseUrl: searchBaseUrl,
				enabled: true,
				createdById: adminId,
			}),
		);
	const pageResponse = () => new Response("Hello!");
	const fetchedPage = {
		ok: true,
		page: {
			url: pageUrl,
			finalUrl: pageUrl,
			title: null,
			contentType: "text/plain",
			text: "Hello!",
			truncated: false,
		},
	};

	it("answers in one step: streams and completes the reply, and tells the chat", async () => {
		const events = EventBus.inProcess({ store: EventStore.inMemory() });
		const publish = vi.fn(events.publish);
		const { model, requests } = scriptedSteps({
			text: ["Example Domain", " says hello."],
			contextTokens: 12,
		});

		const ran = await loop.runTurn(chatId, { model, events: { ...events, publish } });

		expect(ran.outcomes).toEqual([{ _tag: "Finished" }]);
		expect(requests).toHaveLength(1);
		expect(await storedTurn(ran.turnId)).toMatchObject({ status: "done", contextTokens: 12 });
		expect(await storedReply(ran.turnId)).toMatchObject({
			status: "complete",
			content: "Example Domain says hello.",
		});
		expect(deliveredEvents().map(({ type }) => type)).toEqual(
			expect.arrayContaining(["turn.started", "message.completed", "turn.completed"]),
		);
		// Only the reply's deltas go straight to the bus; the rest commit first.
		expect(publish.mock.calls.map(([, event]) => event.type)).toEqual([
			"message.delta",
			"message.delta",
		]);
	});

	it("counts a provider's thinking tokens once in the turn's usage", async () => {
		const providerId = randomUUID();
		const requests = await runOnPostgres(ModelRequests.make);
		const model = Models.make({
			modelProviders: {
				resolve: () =>
					Effect.succeed(
						resolvedModel(
							{
								providerId,
								builtIn: "gemini",
								baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
								apiFormat: "openai",
								apiKey: "test",
								headers: {},
								configurationUpdatedAt: new Date(0),
							},
							["thinking"],
						),
					),
				renewOAuthTokens: () => Effect.die("Gemini has no OAuth credentials here"),
			},
			httpClients: {
				for: () => async () =>
					new Response(
						`data: ${JSON.stringify({
							candidates: [
								{
									content: {
										role: "model",
										parts: [{ text: "Check the result.", thought: true }, { text: "Done." }],
									},
									finishReason: "STOP",
								},
							],
							usageMetadata: {
								promptTokenCount: 100,
								candidatesTokenCount: 12,
								thoughtsTokenCount: 8,
								totalTokenCount: 120,
							},
						})}\n\n`,
						{ headers: { "content-type": "text/event-stream" } },
					),
			},
			requests,
			registry: { ...emptyRegistry, cost: () => ({ input: 0, output: 10 }) },
		});

		const ran = await loop.runTurn(chatId, { model });

		expect(await storedReply(ran.turnId)).toMatchObject({
			content: "Done.",
			parts: [
				{ type: "text", text: "Done." },
				{ type: "thinking", step: 0, text: "Check the result." },
			],
		});
		const ledger = await onDatabase((db) =>
			db.select().from(modelRequest).where(eq(modelRequest.turnId, ran.turnId)),
		);
		expect(ledger).toMatchObject([
			{
				outcome: "completed",
				step: 0,
				inputTokens: 100,
				outputTokens: 20,
				reasoningTokens: 8,
			},
		]);
		expect(Number(ledger[0]?.costUsd)).toBeCloseTo(0.0002, 9);
	});

	it("keeps the turn going when a reply's delta cannot be published", async () => {
		const events = EventBus.inProcess({ store: EventStore.inMemory() });
		const publish = vi.fn(events.publish);
		publish.mockRejectedValueOnce(new Error("subscriber unavailable"));

		const ran = await loop.runTurn(chatId, {
			model: scriptedSteps({ text: ["Done"] }).model,
			events: { ...events, publish },
		});

		expect(await storedTurn(ran.turnId)).toMatchObject({ status: "done" });
		expect(await storedReply(ran.turnId)).toMatchObject({ status: "complete", content: "Done" });
	});

	it("calls web_fetch through egress and gives the next model request its recorded result", async () => {
		await enableWeb();
		const webFetch = vi.fn(async () => pageResponse());
		const { model, requests } = scriptedSteps(
			{
				text: ["Looking. "],
				calls: [{ toolCallId: "sdk-1", toolName: WEB_FETCH_TOOL, input: { url: pageUrl } }],
			},
			{ text: ["Found it."] },
		);

		const ran = await loop.runTurn(chatId, {
			model,
			egress: unimplemented(Egress.Service, { webFetch }),
		});

		expect(webFetch).toHaveBeenCalledExactlyOnceWith(
			new URL(pageUrl),
			expect.objectContaining({
				signal: expect.any(AbortSignal),
			}),
		);

		expect(ran.outcomes).toEqual([{ _tag: "Continue" }, { _tag: "Finished" }]);
		expect(requests).toHaveLength(2);
		expect(requests.map(({ step }) => step)).toEqual([0, 1]);
		// The first request offers the tool without running it; the second carries its result.
		expect(requests[0]?.tools?.[WEB_FETCH_TOOL]?.execute).toBeUndefined();
		expect(requests[1]?.continuationMessages).toEqual([
			expect.objectContaining({ role: "assistant" }),
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "sdk-1",
						toolName: WEB_FETCH_TOOL,
						output: { type: "json", value: fetchedPage },
					},
				],
			},
		]);
		const reply = await storedReply(ran.turnId);
		expect(await callsOf(ran.turnId)).toMatchObject([
			{
				tool: WEB_FETCH_TOOL,
				step: 0,
				sdkToolCallId: "sdk-1",
				input: { url: pageUrl },
				output: fetchedPage,
				approvalStatus: null,
				writeOrDelete: false,
				status: "completed",
				atOffset: "Looking. ".length,
				messageId: reply?.id,
			},
		]);
		expect(reply).toMatchObject({ status: "complete", content: "Looking. Found it." });
	});

	it("tells the model what was wrong with a call's input, without making the call", async () => {
		const { model, requests } = scriptedSteps(
			{ calls: [{ toolCallId: "sdk-1", toolName: WEB_FETCH_TOOL, input: { url: 3 } }] },
			{ text: ["Sorry."] },
		);

		const ran = await loop.runTurn(chatId, { model });

		expect(await callsOf(ran.turnId)).toEqual([]);
		expect(JSON.stringify(requests[1]?.continuationMessages)).toContain(
			"The input didn't match the tool's input schema",
		);
	});

	it("uses the workspace search provider and decodes the query before recording it", async () => {
		await enableWeb();
		const result = { title: "Example", url: pageUrl, snippet: "A sample page", published: null };
		const search = vi.fn(async () =>
			Response.json({
				results: Array.from({ length: 6 }, () => ({
					title: result.title,
					url: result.url,
					content: result.snippet,
				})),
			}),
		);
		const forProvider = vi.fn(() => search);
		const { model, requests } = scriptedSteps(
			{
				calls: [
					{
						toolCallId: "search",
						toolName: WEB_SEARCH_TOOL,
						input: { query: "  Example Domain  " },
					},
				],
			},
			{ text: ["Found it."] },
		);

		const ran = await loop.runTurn(chatId, {
			model,
			egress: unimplemented(Egress.Service, { providers: { for: forProvider } }),
		});

		expect(requests[0]?.tools).toHaveProperty(WEB_SEARCH_TOOL);
		expect(forProvider).toHaveBeenCalledExactlyOnceWith({ baseUrl: searchBaseUrl });
		expect(search).toHaveBeenCalledExactlyOnceWith(
			new URL(`${searchBaseUrl}/search?q=Example+Domain&format=json`),
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(ran.outcomes).toEqual([{ _tag: "Continue" }, { _tag: "Finished" }]);
		expect(await callsOf(ran.turnId)).toMatchObject([
			{
				tool: WEB_SEARCH_TOOL,
				input: { query: "Example Domain", count: 5 },
				status: "completed",
				approvalStatus: null,
				writeOrDelete: false,
				output: { ok: true, results: Array.from({ length: 5 }, () => result) },
			},
		]);
	});

	it("gives a failed search the provider's message and the workspace search settings link", async () => {
		await enableWeb();
		const [settings] = await onDatabase((db) =>
			db.select({ slug: workspace.slug }).from(workspace).where(eq(workspace.id, workspaceId)),
		);
		const { model, requests } = scriptedSteps(
			{
				calls: [
					{ toolCallId: "search", toolName: WEB_SEARCH_TOOL, input: { query: "Example Domain" } },
				],
			},
			{ text: ["The provider is rate limited."] },
		);
		const providerMessage = "Rate limit exceeded. Upgrade your plan for more searches.";
		const ran = await loop.runTurn(chatId, {
			model,
			egress: unimplemented(Egress.Service, {
				providers: { for: () => async () => new Response(providerMessage, { status: 429 }) },
			}),
		});

		const settingsPageUrl = `http://sugabots.test/${settings?.slug}/settings/search`;
		expect(await callsOf(ran.turnId)).toMatchObject([
			{
				tool: WEB_SEARCH_TOOL,
				status: "completed",
				output: {
					ok: false,
					reason: "SearXNG answered HTTP 429",
					providerMessage,
					settingsPageUrl,
				},
			},
		]);
		expect(JSON.stringify(requests[1]?.continuationMessages)).toContain(settingsPageUrl);
	});

	it.each(["workspace", "bot"])(
		"refuses a webhook run’s web calls without approval when web access is off for the %s",
		async (disabledFor) => {
			const assistant = await seedBot(workspaceId, {
				assistantOf: adminId,
				visibility: "personal",
			});
			if (disabledFor === "bot") await enableWeb();
			await onDatabase((db) =>
				db
					.update(bot)
					.set({
						model: "m",
						disabledTools: disabledFor === "bot" ? [WEB_FETCH_TOOL, WEB_SEARCH_TOOL] : [],
					})
					.where(eq(bot.id, assistant.id)),
			);
			const automation = await seedAutomation(workspaceId, assistant.defaultProject);
			const started = await seedRun(workspaceId, automation, assistant.id, "webhook");
			await runOnPostgres(
				Context.get(loop.services, Turns.Service).ask({
					chatId: started.chat,
					botId: assistant.id,
					triggerMessageId: started.triggerMessage,
					reason: "automation",
				}),
			);
			const webFetch = vi.fn();
			const forProvider = vi.fn();
			const { model, requests } = scriptedSteps(
				{
					calls: [
						{ toolCallId: "fetch", toolName: WEB_FETCH_TOOL, input: { url: pageUrl } },
						{ toolCallId: "search", toolName: WEB_SEARCH_TOOL, input: { query: "Example Domain" } },
					],
				},
				{ text: ["Web access is off."] },
			);

			const ran = await loop.runTurn(started.chat, {
				model,
				egress: unimplemented(Egress.Service, { webFetch, providers: { for: forProvider } }),
			});

			expect(requests[0]?.tools).toHaveProperty(WEB_FETCH_TOOL);
			expect(requests[0]?.tools).toHaveProperty(WEB_SEARCH_TOOL);
			expect(webFetch).not.toHaveBeenCalled();
			expect(forProvider).not.toHaveBeenCalled();
			const error = new WebToolOff().userMessage;
			expect(await callsOf(ran.turnId)).toEqual(
				expect.arrayContaining(
					[WEB_FETCH_TOOL, WEB_SEARCH_TOOL].map((tool) =>
						expect.objectContaining({ tool, status: "failed", approvalStatus: null, error }),
					),
				),
			);
			expect(JSON.stringify(requests[1]?.continuationMessages)).toContain(error);
		},
	);

	it.each(["webhook", "github"] as const)(
		"asks the Personal Assistant's member before every call in a %s run",
		async (trigger) => {
			await enableWeb();
			const assistant = await seedBot(workspaceId, {
				assistantOf: adminId,
				visibility: "personal",
			});
			await onDatabase((db) => db.update(bot).set({ model: "m" }).where(eq(bot.id, assistant.id)));
			const automation = await seedAutomation(workspaceId, assistant.defaultProject);
			const started = await seedRun(workspaceId, automation, assistant.id, trigger);
			await runOnPostgres(
				Context.get(loop.services, Turns.Service).ask({
					chatId: started.chat,
					botId: assistant.id,
					triggerMessageId: started.triggerMessage,
					reason: "automation",
				}),
			);
			const search = vi.fn(async () => Response.json({ results: [] }));
			const { model, requests } = scriptedSteps(
				{
					calls: [
						{ toolCallId: "lookup", toolName: "tool_search", input: { query: "example" } },
						{
							toolCallId: "search",
							toolName: WEB_SEARCH_TOOL,
							input: { query: "  Example Domain  " },
						},
					],
				},
				{ text: ["The search is finished."] },
			);

			const ran = await loop.runTurn(started.chat, {
				model,
				egress: unimplemented(Egress.Service, { providers: { for: () => search } }),
			});
			expect(requests[0]?.tools).not.toHaveProperty("workspace_guide");

			const calls = await callsOf(ran.turnId);
			const parked = calls.find(({ tool }) => tool === WEB_SEARCH_TOOL);
			const lookup = calls.find(({ tool }) => tool === "tool_search");
			if (!lookup) throw new Error("No tool lookup parked for approval");
			expect(lookup).toMatchObject({
				status: "awaiting_approval",
				approvalStatus: "pending",
				writeOrDelete: false,
				output: null,
			});
			if (!parked) throw new Error("No search parked for approval");
			expect(ran.outcomes).toEqual([
				{ _tag: "Waiting", approvals: [lookup.approvalId, parked.approvalId], taken: true },
			]);
			expect(parked).toMatchObject({
				tool: WEB_SEARCH_TOOL,
				input: { query: "Example Domain", count: 5 },
				approvalStatus: "pending",
				writeOrDelete: false,
			});
			expect(search).not.toHaveBeenCalled();
			const otherAdmin = await seedMember(workspaceId, "admin");
			await expect(
				chatsAs(otherAdmin).decide({ toolCallId: lookup.id, decision: "allow_once" }),
			).rejects.toMatchObject({ _tag: "ResourceHidden", resource: "approval" });
			await chatsAs(adminId).decide({ toolCallId: lookup.id, decision: "allow_once" });
			await chatsAs(adminId).decide({ toolCallId: parked.id, decision: "allow_once" });
			const principal = await ran.authentication.authenticate(ran.turnId);

			expect(
				await ran.steps.step(ran.run.request, principal, {
					turnId: ran.turnId,
					attempt: 0,
					step: 1,
				}),
			).toEqual({ _tag: "Finished" });

			expect(search).toHaveBeenCalledOnce();
			expect((await callsOf(ran.turnId)).find(({ id }) => id === lookup.id)).toMatchObject({
				status: "completed",
				approvalStatus: "allowed",
				decidedById: adminId,
			});
			expect(
				(await callsOf(ran.turnId)).filter(({ tool }) => tool === WEB_SEARCH_TOOL),
			).toMatchObject([
				{
					id: parked.id,
					status: "completed",
					approvalStatus: "allowed",
					output: { ok: true, results: [] },
				},
			]);
			expect(JSON.stringify(requests[1]?.continuationMessages)).toContain('"results":[]');
		},
	);

	it("records a failed run, which the workflow runs again", async () => {
		const ran = await loop.runTurn(chatId, { model: scriptedSteps(providerDown).model });

		expect(ran.outcomes).toEqual([{ _tag: "Retry" }]);
		expect(await storedTurn(ran.turnId)).toMatchObject({
			status: "failed",
			error: providerDown.userMessage,
			retrying: true,
		});
		expect(deliveredEvents()).toContainEqual(
			expect.objectContaining({ type: "message.failed", error: providerDown.userMessage }),
		);
	});

	it("runs a failed run again, as late as the provider asked, though the step that failed it is taken again after a restart", async () => {
		const { model, requests } = scriptedSteps(
			new Models.ProviderRateLimited({
				...testProvider,
				retryAfter: Duration.seconds(30),
				cause: new Error("429"),
			}),
		);
		const { steps, authentication } = await loop.loopOver({ model });
		const [run] = await runOnPostgres(runningTurns(chatId));
		if (!run) throw new Error("no turn running");
		const opened = await steps.open(run.request, 0);
		if (opened._tag !== "Opened") throw new Error("the turn may not run");
		const at = { turnId: opened.turnId, attempt: 0, step: 0 };
		const first = await authentication.authenticate(opened.turnId);
		expect(await steps.step(run.request, first, at)).toEqual({
			_tag: "Retry",
			after: Duration.seconds(30),
		});

		// The process stops before the workflow kept that outcome: it resumes the
		// turn and takes the step again.
		const resumed = await authentication.authenticate(opened.turnId);
		const again = await steps.step(run.request, resumed, at);

		expect(again).toMatchObject({ _tag: "Retry", after: expect.anything() });
		if (again._tag !== "Retry" || again.after === undefined) throw new Error("no retry");
		expect(Duration.toMillis(again.after)).toBeGreaterThan(0);
		expect(Duration.toMillis(again.after)).toBeLessThanOrEqual(30_000);
		expect(requests).toHaveLength(1);
		expect(await storedTurn(opened.turnId)).toMatchObject({
			status: "failed",
			retrying: true,
			retryAt: expect.any(Date),
		});
	});

	it("supersedes an older step while a newer execution waits to retry", async () => {
		const started = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const slow = Models.fromStream(() =>
			Effect.succeed(
				streamed(
					(async function* () {
						started.resolve();
						await finish.promise;
						yield "Old reply.";
					})(),
				),
			),
		);
		const retryAfter = Duration.seconds(30);
		const { steps, authentication } = await loop.loopOver({
			model: scriptedSteps(
				new Models.ProviderRateLimited({
					...testProvider,
					retryAfter,
					cause: new Error("429"),
				}),
			).model,
		});
		const older = await loop.loopOver({ model: slow }, { checkEvery: Duration.minutes(1) });
		const [run] = await runOnPostgres(runningTurns(chatId));
		if (!run) throw new Error("no turn running");
		const opened = await steps.open(run.request, 0);
		if (opened._tag !== "Opened") throw new Error("the turn may not run");
		const at = { turnId: opened.turnId, attempt: 0, step: 0 };
		const first = await authentication.authenticate(opened.turnId);
		const stale = older.steps.step(run.request, first, at);

		try {
			await started.promise;
			const second = await authentication.authenticate(opened.turnId);
			expect(await steps.step(run.request, second, at)).toEqual({
				_tag: "Retry",
				after: retryAfter,
			});
		} finally {
			finish.resolve();
		}

		expect(await stale).toEqual({ _tag: "Superseded" });
		expect(await storedTurn(opened.turnId)).toMatchObject({
			status: "failed",
			retrying: true,
			retryAt: expect.any(Date),
		});
	});

	it.each([false, true])(
		"discards partial thinking and reply text on takeover (older checkpoint %s)",
		async (olderCheckpoint) => {
			const oldWritingSaved = Promise.withResolvers<void>();
			const finishOld = Promise.withResolvers<void>();
			const resumedRequestOpened = Promise.withResolvers<void>();
			const finishResumed = Promise.withResolvers<void>();
			// Enough characters for the stream to save immediately before reading its next delta.
			const staleThinking = "Old thinking. ".repeat(100);
			const staleText = "Old reply. ".repeat(100);
			const oldModel = Models.fromStream(() =>
				Effect.succeed({
					deltas: (async function* (): AsyncGenerator<Models.Delta> {
						yield { kind: "thinking", text: staleThinking };
						yield { kind: "text", text: staleText };
						oldWritingSaved.resolve();
						await finishOld.promise;
					})(),
					finished: Effect.never,
				}),
			);
			const scripted = scriptedSteps({ thinking: ["New thinking."], text: ["New reply."] });
			const resumedModel = Models.fromStream((request) =>
				Effect.callback<void>((resume) => {
					resumedRequestOpened.resolve();
					void finishResumed.promise.then(() => resume(Effect.void));
				}).pipe(Effect.andThen(scripted.model.stream(request))),
			);
			const older = await loop.loopOver({ model: oldModel });
			const newer = await loop.loopOver({ model: resumedModel });
			const [run] = await runOnPostgres(runningTurns(chatId));
			if (!run) throw new Error("no turn running");
			const opened = await older.steps.open(run.request, 0);
			if (opened._tag !== "Opened") throw new Error("the turn may not run");
			const at = { turnId: opened.turnId, attempt: 0, step: 0 };
			const first = await older.authentication.authenticate(opened.turnId);
			const stale = older.steps.step(run.request, first, at);
			const readReply = async () =>
				(await chatsAs(adminId).get(chatId)).messages.find(({ author }) => author.kind === "bot");
			try {
				await oldWritingSaved.promise;
				expect(await readReply()).toMatchObject({
					content: staleText,
					thinking: [{ step: 0, text: staleThinking }],
				});
				if (olderCheckpoint) {
					const draft = JSON.stringify({
						content: staleText,
						toolCalls: [],
						thinking: [{ step: 0, text: staleThinking }],
					});
					await onDatabase((db) =>
						db
							.update(turn)
							.set({ checkpoint: sql`jsonb_set(${turn.checkpoint}, '{reply}', ${draft}::jsonb)` })
							.where(eq(turn.id, opened.turnId)),
					);
				}
				const second = await newer.authentication.authenticate(opened.turnId);
				const resumed = newer.steps.step(run.request, second, at);
				await resumedRequestOpened.promise;
				expect(await readReply()).toMatchObject({ content: "" });
				expect((await readReply())?.thinking ?? []).toEqual([]);
				finishResumed.resolve();
				expect(await resumed).toEqual({ _tag: "Finished" });
				expect(scripted.requests).toHaveLength(1);
				expect(scripted.requests[0]?.continuationMessages).toEqual([]);
				expect(await readReply()).toMatchObject({
					content: "New reply.",
					thinking: [{ step: 0, text: "New thinking." }],
				});
			} finally {
				finishOld.resolve();
				finishResumed.resolve();
			}
			expect(await stale).toEqual({ _tag: "Superseded" });
		},
	);

	it("fails the turn for good when its last run fails", async () => {
		const ran = await loop.runTurn(
			chatId,
			{ model: scriptedSteps(providerDown).model },
			{
				// This run is the last one allowed.
				beforeSteps: (turnId) =>
					onDatabase((db) =>
						db.update(turn).set({ runs: Turns.MAX_TURN_RUNS }).where(eq(turn.id, turnId)),
					),
			},
		);

		expect(ran.outcomes).toEqual([{ _tag: "Finished" }]);
		expect(await storedTurn(ran.turnId)).toMatchObject({ status: "failed", retrying: false });
		expect(deliveredEvents()).toContainEqual(expect.objectContaining({ type: "message.failed" }));
	});

	it("fails the turn for good when the provider refused the request", async () => {
		const ran = await loop.runTurn(chatId, {
			model: scriptedSteps(
				new Models.ProviderQuotaExhausted({ ...testProvider, cause: new Error("402") }),
			).model,
		});

		expect(ran.outcomes).toEqual([{ _tag: "Finished" }]);
		expect(deliveredEvents()).toContainEqual(expect.objectContaining({ type: "message.failed" }));
	});

	it("fails the turn for good when the provider asks to be left too long", async () => {
		const ran = await loop.runTurn(chatId, {
			model: scriptedSteps(
				new Models.ProviderRateLimited({
					...testProvider,
					retryAfter: Duration.minutes(5),
					cause: new Error("429"),
				}),
			).model,
		});

		expect(ran.outcomes).toEqual([{ _tag: "Finished" }]);
		expect(await storedTurn(ran.turnId)).toMatchObject({ status: "failed", retrying: false });
	});

	it("fails a reply the model finished without writing anything, for good", async () => {
		const ran = await loop.runTurn(chatId, { model: scriptedSteps({ text: [" \n"] }).model });

		expect(ran.outcomes).toEqual([{ _tag: "Finished" }]);
		expect(await storedTurn(ran.turnId)).toMatchObject({
			status: "failed",
			error: userText`The reply stopped before answering.`,
		});
		expect(deliveredEvents()).toContainEqual(expect.objectContaining({ type: "message.failed" }));
	});

	describe("an optional turn, on a message in the bot's chat that mentions only members", () => {
		/** Starts another of the bot's chats with `content`, whose turn is optional. */
		const optionalTurnOn = async (content: string) => {
			const started = await startBotChat(chatsAs(adminId), {
				botId,
				messageId: crypto.randomUUID(),
				content,
			});
			delivered.length = 0;
			return started;
		};

		it.each([false, true])(
			"lets the bot stay silent and react 👀 with visible thinking set to %s",
			async (showsThinking) => {
				const started = await optionalTurnOn("@sam can you look at this?");

				const ran = await loop.runTurn(started.chat.id, {
					model: scriptedSteps({
						text: [" \n"],
						thinking: showsThinking ? ["The message asks Sam."] : [],
					}).model,
				});

				expect(ran.outcomes).toEqual([{ _tag: "Finished" }]);
				const details = await chatsAs(adminId).get(started.chat.id);
				expect(details.messages.map(({ author }) => author.kind)).toEqual(["member"]);
				expect(details.messages[0]?.reactions).toEqual([
					expect.objectContaining({ emoji: "👀", bots: [expect.objectContaining({ id: botId })] }),
				]);
			},
		);

		it("posts the reply as usual when the bot chooses to answer, having been told it may stay silent", async () => {
			const started = await optionalTurnOn("@sam can you look at this?");
			const { model, requests } = scriptedSteps({ text: ["I can."] });

			const ran = await loop.runTurn(started.chat.id, { model });

			expect(await storedReply(ran.turnId)).toMatchObject({
				status: "complete",
				content: "I can.",
			});
			expect(JSON.stringify(requests)).toContain("stay silent by writing nothing at all");
		});
	});

	const resolvedAt = async (target: string) => {
		const [stored] = await onDatabase((db) =>
			db
				.select({ resolvedAt: placedChat.resolvedAt })
				.from(placedChat)
				.where(eq(placedChat.id, target)),
		);
		return stored?.resolvedAt;
	};

	const resolveFromTurn = (target: string) =>
		scriptedSteps(
			{
				calls: [
					{
						toolCallId: "resolve",
						toolName: "mark_resolved",
						input: { chatId: target, resolved: true },
					},
				],
			},
			{ text: ["Done."] },
		);

	it("resolves a chat through the operation for an asker who may change it", async () => {
		const { model } = resolveFromTurn(chatId);
		await loop.runTurn(chatId, { model });

		expect(await resolvedAt(chatId)).toBeInstanceOf(Date);
	});

	it("refuses to resolve for a viewer and returns the operation's user message to the model", async () => {
		await onDatabase((db) =>
			db.update(membership).set({ role: "viewer" }).where(eq(membership.memberId, adminId)),
		);
		const { model, requests } = resolveFromTurn(chatId);
		const ran = await loop.runTurn(chatId, { model });

		const error = new ActionForbidden({ proof: "CanChangeChat" }).userMessage;
		expect(await callsOf(ran.turnId)).toMatchObject([{ status: "failed", error }]);
		expect(await resolvedAt(chatId)).toBeNull();
		expect(JSON.stringify(requests[1]?.continuationMessages)).toContain(error);
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
			expect(await resume(parent, 1)).toEqual({ _tag: "Finished" });
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
			expect(await resume(ran, 1)).toEqual({ _tag: "Finished" });
			expect(await callsOf(ran.turnId)).toMatchObject([
				{ status: "completed", decidedById: adminId },
			]);
		},
	);

	it("hides a chat outside the turn's bounds even when the bot and asker both reach it", async () => {
		const project = await seedProject(workspaceId, { leadBotId: botId });
		const elsewhere = await seedProjectChat(workspaceId, project, adminId);
		const { model, requests } = resolveFromTurn(elsewhere);
		await loop.runTurn(chatId, { model });

		expect(await resolvedAt(elsewhere)).toBeNull();
		expect(JSON.stringify(requests[1]?.continuationMessages)).toContain(
			new ResourceHidden({ resource: "chat" }).userMessage,
		);
	});

	it("offers and runs read-only operations for a viewer within the turn's bounds", async () => {
		const current = await chatsAs(adminId).get(chatId);
		if (!current.chat.projectId) throw new Error("The fixture chat needs a project");
		const sibling = await seedProjectChat(workspaceId, current.chat.projectId, adminId);
		const outsideProject = await seedProject(workspaceId, {
			leadBotId: botId,
			visibility: "public",
		});
		const outside = await seedProjectChat(workspaceId, outsideProject, adminId);
		const member = chatsAs(adminId);
		const attachmentIn = async (chatId: string, content: string) => {
			const attached = await member.chatFiles.upload({
				chatId,
				name: "notes.txt",
				type: "text/plain",
				stream: Stream.succeed(new TextEncoder().encode(content)),
			});
			await member.post({
				chatId,
				messageId: crypto.randomUUID(),
				content,
				attachments: [attached.id],
			});
			return attached.id;
		};
		const reachedFile = await attachmentIn(sibling, "Budget: 150 euros");
		const hiddenFile = await attachmentIn(outside, "Budget: private");
		await onDatabase((db) =>
			db.insert(message).values({
				chatId,
				authorMemberId: adminId,
				content: "Budget: later",
				status: "complete",
				parts: [],
			}),
		);
		await onDatabase((db) =>
			db.update(membership).set({ role: "viewer" }).where(eq(membership.memberId, adminId)),
		);
		await expect(member.get(outside)).resolves.toMatchObject({ chat: { id: outside } });
		const { model, requests } = scriptedSteps(
			{
				calls: [
					{
						toolCallId: "search",
						toolName: "search_history",
						input: { chat: "all", query: "budget" },
					},
					{
						toolCallId: "read",
						toolName: "read_chat_file",
						input: { file: reachedFile, chat: sibling },
					},
					{
						toolCallId: "docs",
						toolName: "read_docs",
						input: { page: "members-and-roles", sections: ["Roles"] },
					},
					{ toolCallId: "role", toolName: "workspace_role", input: { member: "@sam" } },
					{
						toolCallId: "hidden-chat",
						toolName: "search_history",
						input: { chat: outside, query: "budget" },
					},
					{ toolCallId: "hidden-file", toolName: "read_chat_file", input: { file: hiddenFile } },
					{
						toolCallId: "wrong-chat",
						toolName: "read_chat_file",
						input: { file: reachedFile, chat: chatId },
					},
				],
			},
			{ text: ["Done."] },
		);

		const ran = await loop.runTurn(chatId, { model });

		expect(ran.outcomes).toEqual([{ _tag: "Continue" }, { _tag: "Finished" }]);
		for (const name of ["search_history", "read_chat_file", "read_docs", "workspace_role"]) {
			expect(requests[0]?.tools).toHaveProperty(name);
		}
		expect(requests[0]?.tools?.read_docs?.description).toContain("members-and-roles");
		const calls = await callsOf(ran.turnId);
		expect(calls).toHaveLength(7);
		expect(
			calls.every(({ writeOrDelete, approvalStatus }) => !writeOrDelete && approvalStatus === null),
		).toBe(true);
		const byId = (id: string) => calls.find(({ sdkToolCallId }) => sdkToolCallId === id);
		expect(byId("search")).toMatchObject({
			status: "completed",
			output: {
				messages: [
					expect.objectContaining({
						chatId: sibling,
						text: expect.stringContaining("Budget: 150 euros"),
					}),
				],
				more: false,
			},
		});
		expect(byId("read")).toMatchObject({
			status: "completed",
			output: { lines: "1\tBudget: 150 euros", totalLines: 1 },
		});
		expect(byId("docs")).toMatchObject({
			status: "completed",
			output: { markdown: expect.stringContaining("## Roles") },
		});
		expect(byId("role")).toMatchObject({
			status: "completed",
			output: { member: { name: "Sam", handle: "sam", role: "viewer" } },
		});
		const chatHidden = new ResourceHidden({ resource: "chat" }).userMessage;
		const fileHidden = new ResourceHidden({ resource: "file" }).userMessage;
		expect(byId("hidden-chat")).toMatchObject({ status: "failed", error: chatHidden });
		expect(byId("hidden-file")).toMatchObject({ status: "failed", error: fileHidden });
		expect(byId("wrong-chat")).toMatchObject({ status: "failed", error: fileHidden });
		const continuation = JSON.stringify(requests[1]?.continuationMessages);
		expect(continuation).toContain(chatHidden);
		expect(continuation).toContain(fileHidden);
		expect(continuation).not.toContain("Budget: private");
	}, 15_000);

	it("resumes a read-only tool call after inherited approval for the recorded arguments", async () => {
		const project = await seedProject(workspaceId, { leadBotId: botId });
		const destination = await seedProjectChat(workspaceId, project, adminId);
		const triggerMessageId = await seedMessage(destination, { bot: botId });
		await onDatabase((db) =>
			db
				.update(message)
				.set({ briefTurnRule: "askBeforeAllTools" })
				.where(eq(message.id, triggerMessageId)),
		);
		await runOnPostgres(
			Context.get(loop.services, Turns.Service).ask({
				chatId: destination,
				botId,
				triggerMessageId,
				reason: "brief",
			}),
		);
		const input = { page: "members-and-roles", sections: ["Roles"] };
		const { model, requests } = scriptedSteps(
			{ calls: [{ toolCallId: "docs", toolName: "read_docs", input }] },
			{ text: ["Done."] },
		);

		const ran = await loop.runTurn(destination, { model });
		const [parked] = await callsOf(ran.turnId);

		if (!parked) throw new Error("No call parked");
		expect(ran.outcomes).toEqual([
			{ _tag: "Waiting", approvals: [parked.approvalId], taken: true },
		]);
		expect(parked).toMatchObject({
			tool: "read_docs",
			input,
			approvalStatus: "pending",
			writeOrDelete: false,
		});
		await chatsAs(adminId).decide({ toolCallId: parked.id, decision: "allow_once" });
		const principal = await ran.authentication.authenticate(ran.turnId);
		const operations = await operationsForTests({ chats: loop.services });
		await expect(
			runOnPostgres(
				operations["chats.readDocs"](
					principal,
					{ ...input, sections: [] },
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
		expect(await callsOf(ran.turnId)).toMatchObject([
			{ id: parked.id, status: "completed", approvalStatus: "allowed", input },
		]);
		expect(JSON.stringify(requests[1]?.continuationMessages)).toContain("## Roles");
	});

	it.each([
		"the asking project",
		"the recipient's default project",
		"the asker's Personal Assistant's default project",
	])("starts a brief in %s only after its asker approves", async (destination) => {
		const recipient = await seedBot(workspaceId, {
			createdById: adminId,
			...(destination === "the asker's Personal Assistant's default project" && {
				assistantOf: adminId,
				visibility: "personal" as const,
			}),
		});
		const [target] = await onDatabase((db) =>
			db.update(bot).set({ model: "m" }).where(eq(bot.id, recipient.id)).returning(),
		);
		if (!target) throw new Error("No recipient bot");
		let source = chatId;
		let expectedProject = recipient.defaultProject;
		if (destination === "the asking project") {
			expectedProject = await seedProject(workspaceId, {
				leadBotId: botId,
				bots: [recipient.id],
			});
			const started = await chatsAs(adminId).startProjectChat({
				projectId: expectedProject,
				messageId: crypto.randomUUID(),
				content: "Ask the other bot to draft the report.",
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
		const startedChats = () =>
			onDatabase((db) =>
				db
					.select()
					.from(placedChat)
					.where(and(eq(placedChat.workspaceId, workspaceId), eq(placedChat.title, input.title))),
			);
		expect(await startedChats()).toEqual([]);
		await expect(loop.call(ran.principal, "chats.startBriefedChat", input)).rejects.toMatchObject({
			_tag: "ApprovalNeeded",
		});

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

	const pendingBrief = async (chatId: string) => {
		const { model, requests } = calling(START_CHAT_TOOL, { title: "Report", brief: "Draft it." });
		const workflow = await loop.runWorkflow(chatId, { model });
		onTestFinished(workflow.close);
		// A real workflow, which a loaded machine slows.
		await vi.waitFor(
			async () => {
				const polled = await workflow.poll();
				expect(Option.isSome(polled) && polled.value._tag).toBe("Suspended");
			},
			{ timeout: 10_000 },
		);
		const [opened] = await onDatabase((db) =>
			db.select({ id: turn.id }).from(turn).where(eq(turn.executionId, workflow.executionId)),
		);
		if (!opened) throw new Error("No turn opened");
		const [parked] = await callsOf(opened.id);
		if (!parked?.approvalId) throw new Error("No call parked");
		expect(parked.approvalStatus).toBe("pending");
		expect(await runOnPostgres(runningTurns(chatId))).toHaveLength(0);
		return { turnId: opened.id, parked: { ...parked, approvalId: parked.approvalId }, requests };
	};

	const expireAtCutoff = async (parked: { id: string; approvalId: string }) => {
		const authenticate = await runOnPostgres(
			Effect.provide(SystemWorkAuthentication.Service, SystemWorkAuthentication.layer),
		);
		expect(await runOnPostgres(authenticate.expiredApprovalIds)).not.toContain(parked.approvalId);
		await onDatabase((db) =>
			db
				.update(toolCall)
				.set({ approvalAskedAt: new Date(Date.now() - Duration.toMillis(Duration.days(7))) })
				.where(eq(toolCall.id, parked.id)),
		);
		expect(await runOnPostgres(authenticate.expiredApprovalIds)).toContain(parked.approvalId);
		const principal = await runOnPostgres(authenticate.approvalExpiry(parked.approvalId));
		return () => loop.call(principal, "approvals.expire", { approvalId: parked.approvalId });
	};

	it.each([
		"project member removal",
		"project departure",
		"workspace departure",
		"workspace member removal",
		"bot visibility",
		"bot removal",
		"project bot removal",
		"project deletion",
		"workspace deletion",
		"expiry",
	] as const)(
		"withdraws a parked call after %s and wakes its workflow to end the turn",
		async (reason) => {
			const asker = await seedMember(workspaceId, "editor");
			const signedIn = principals(await authenticators());
			const askerSession = await signedIn.member(asker);
			const adminSession = await signedIn.member(adminId);
			const projectId = await seedProject(workspaceId, {
				leadBotId:
					reason === "project bot removal" ||
					reason === "bot removal" ||
					reason === "bot visibility"
						? (await seedBot(workspaceId)).id
						: botId,
				members: [asker],
				bots: [botId],
			});
			const inProject = await seedProjectChat(workspaceId, projectId, asker);
			const triggerMessageId = await seedMessage(inProject, { member: asker });
			await runOnPostgres(
				Context.get(loop.services, Turns.Service).ask({
					chatId: inProject,
					botId,
					triggerMessageId,
					reason: "mention",
				}),
			);
			const waitingChat =
				reason === "bot visibility"
					? (
							await startBotChat(chatsAs(asker), {
								botId,
								messageId: crypto.randomUUID(),
								content: "Draft the report.",
							})
						).chat.id
					: inProject;
			const { turnId, parked, requests } = await pendingBrief(waitingChat);
			const error =
				reason === "expiry"
					? "This approval expired before anyone decided it."
					: "This approval was withdrawn because the turn lost access to its chat.";
			// Deletion can erase the entire turn. Observe the workflow's end
			// after the intent commits, before the request continues to cleanup.
			const cancelled = Promise.withResolvers<void>();
			afterCommit = async (events) => {
				if (
					!events.some(({ event }) => {
						if (event.type !== "tool_call.completed") return false;
						const call = Schema.decodeUnknownOption(toolCallPartSchema)(event.toolCall);
						return (
							Option.isSome(call) &&
							call.value.id === parked.id &&
							call.value.approval?.status === "denied"
						);
					})
				)
					return;
				try {
					expect(await callsOf(turnId)).toMatchObject([
						{ status: "failed", approvalStatus: "denied", error },
					]);
					await vi.waitFor(async () =>
						expect(await storedTurn(turnId)).toMatchObject({ status: "cancelled" }),
					);
					cancelled.resolve();
				} catch (error) {
					cancelled.reject(error);
				}
			};
			void cancelled.promise.catch(() => {});
			switch (reason) {
				case "project member removal":
					await loop.call(adminSession, "projects.removeMember", { projectId, memberId: asker });
					break;
				case "project departure":
					await loop.call(askerSession, "projects.leave", { projectId });
					break;
				case "workspace departure":
					await loop.call(askerSession, "workspaces.leave", { workspace: workspaceId });
					break;
				case "workspace member removal": {
					const [record] = await onDatabase((db) =>
						db
							.select({ id: membership.id })
							.from(membership)
							.where(and(eq(membership.workspaceId, workspaceId), eq(membership.memberId, asker))),
					);
					if (!record) throw new Error("No membership");
					await loop.call(adminSession, "workspaces.removeMembership", {
						workspace: workspaceId,
						membershipId: record.id,
					});
					break;
				}
				case "bot visibility":
					await loop.call(adminSession, "bots.update", {
						botId,
						changes: { visibility: "personal" },
					});
					break;
				case "bot removal":
					await loop.call(adminSession, "bots.remove", { botId });
					break;
				case "project bot removal":
					await loop.call(adminSession, "projects.removeBot", { projectId, botId });
					break;
				case "project deletion":
					await loop.call(adminSession, "projects.remove", { projectId });
					break;
				case "workspace deletion": {
					const owner = await signedIn.member(await seedMember(workspaceId, "owner"));
					await loop.call(owner, "workspaces.delete", { workspace: workspaceId });
					break;
				}
				case "expiry":
					await (await expireAtCutoff(parked))();
					break;
			}
			await cancelled.promise;
			await expect(
				chatsAs(asker).decide({ toolCallId: parked.id, decision: "allow_once" }),
			).rejects.toThrow();
			expect(requests).toHaveLength(1);
		},
		15_000,
	);

	it.each(["reach withdrawal", "expiry"] as const)(
		"serializes a decision racing %s and refuses it when the withdrawal wins",
		async (reason) => {
			const asker = await seedMember(workspaceId, "editor");
			const projectId = await seedProject(workspaceId, { leadBotId: botId, members: [asker] });
			const started = await chatsAs(asker).startProjectChat({
				projectId,
				messageId: crypto.randomUUID(),
				content: "Draft the report.",
			});
			const { turnId, parked, requests } = await pendingBrief(started.chat.id);
			const signedIn = principals(await authenticators());
			const admin = await signedIn.member(adminId);
			const withdraw =
				reason === "expiry"
					? await expireAtCutoff(parked)
					: () => loop.call(admin, "projects.removeMember", { projectId, memberId: asker });
			const lock = holdTransaction(
				query((db) =>
					db.select({ id: turn.id }).from(turn).where(eq(turn.id, turnId)).for("update"),
				),
			);
			await lock.held;
			const withdrawing = withdraw();
			void withdrawing.catch(() => {});
			await waitUntilWaitingOnLocks(1);
			const decision = expect(
				chatsAs(asker).decide({ toolCallId: parked.id, decision: "allow_once" }),
			).rejects.toThrow();
			void decision.catch(() => {});
			await waitUntilWaitingOnLocks(2);
			await lock.release();
			await Promise.all([withdrawing, decision]);
			await vi.waitFor(async () =>
				expect(await storedTurn(turnId)).toMatchObject({ status: "cancelled" }),
			);
			expect(await callsOf(turnId)).toMatchObject([
				{ approvalStatus: "denied", decidedById: null },
			]);
			expect(requests).toHaveLength(1);
		},
		15_000,
	);

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

	it("parks a write/delete tool call for approval without making it, then makes it once allowed", async () => {
		const execute = vi.fn(async () => ({ removed: true }));
		const outside = {
			connectorTools: wikiWipe("ask", execute),
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
				connectorTools: wikiWipe("allow", execute),
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
			expect(refused).toMatchObject({ tool: "wiki__wipe", status: "failed", approvalStatus: null });
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
					{ toolCallId: "wipe", toolName: CALL_TOOL, input: { tool: "wiki__wipe", arguments: {} } },
				],
			},
			{ text: ["Done."] },
		);
		const result = await loop.runTurn(chatId, {
			model,
			connectorTools: { forTurn: (...args) => wikiWipe(access, execute).forTurn(...args) },
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
					{ toolCallId: "wipe", toolName: CALL_TOOL, input: { tool: "wiki__wipe", arguments: {} } },
				],
			},
			{ text: ["No change made."] },
		);
		const result = await loop.runTurn(chatId, {
			model,
			connectorTools: wikiWipe("allow", execute),
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
			db.update(bot).set({ assistantOf: adminId, visibility: "personal" }).where(eq(bot.id, botId)),
		);
		const execute = vi.fn(async () => ({ removed: true }));
		const { model } = scriptedSteps(
			{
				calls: [
					{ toolCallId: "wipe", toolName: CALL_TOOL, input: { tool: "wiki__wipe", arguments: {} } },
				],
			},
			{ text: ["Done."] },
		);
		const parked = await loop.runTurn(chatId, {
			model,
			connectorTools: wikiWipe("allow", execute),
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
				connectorTools: { forTurn: (...args) => wikiWipe(access, execute).forTurn(...args) },
			});
			const [parked] = await callsOf(ran.turnId);
			if (!parked) throw new Error("No call parked");
			expect(parked).toMatchObject({ approvalStatus: "pending", approvalConnectorAccess: "allow" });
			await chatsAs(adminId).decide({ toolCallId: parked.id, decision: "allow_once" });
			access = changed;
			const reaskingAfter = Date.now();
			const outcome = await resume(ran, 1);
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
			expect(outcome).toEqual({ _tag: "Waiting", approvals: [reparked.approvalId], taken: false });
			await chatsAs(adminId).decide({ toolCallId: parked.id, decision: "allow_once" });
			expect(await resume(ran, 1)).toEqual({ _tag: "Finished" });
			expect(execute).toHaveBeenCalledOnce();
			expect(await callsOf(ran.turnId)).toMatchObject([{ id: parked.id, status: "completed" }]);
		},
	);

	it("calls a helper’s own allowed connector in the asking chat", async () => {
		const helper = await seedBot(workspaceId, { createdById: adminId });
		await onDatabase((db) => db.update(bot).set({ model: "m" }).where(eq(bot.id, helper.id)));
		const ownConnector = await seedConnector(workspaceId, helper.defaultProject);
		const projectId = await seedProject(workspaceId, { leadBotId: botId, bots: [helper.id] });
		const source = await seedProjectChat(workspaceId, projectId, adminId);
		const parent = await seedTurnAnswering(source, botId, { member: adminId }, { status: "done" });
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
				return wikiWipe("allow", execute, ownConnector).forTurn(
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
					{ toolCallId: "wipe", toolName: CALL_TOOL, input: { tool: "wiki__wipe", arguments: {} } },
				],
			},
			{ text: ["Done."] },
		);
		const result = await loop.runTurn(source, { model, connectorTools: discovery });
		expect(execute).toHaveBeenCalledOnce();
		expect(await callsOf(result.turnId)).toMatchObject([
			{ chatId: source, connectorId: ownConnector, approvalStatus: null, status: "completed" },
		]);
	}, 15_000);

	it("hides a connector outside chat bounds even when the bot and asker reach its project", async () => {
		const project = await seedProject(workspaceId, { leadBotId: botId });
		const outside = await seedConnector(workspaceId, project, {
			tools: [{ name: "lookup", description: null, readOnly: true, destructive: null }],
		});
		const { model } = scriptedSteps({
			calls: [
				{ toolCallId: "wipe", toolName: CALL_TOOL, input: { tool: "wiki__wipe", arguments: {} } },
			],
		});
		const result = await loop.runTurn(chatId, {
			model,
			connectorTools: wikiWipe("ask", async () => ({})),
		});
		await expect(
			loop.call(result.principal, "connectors.callTool", {
				connectorId: outside,
				tool: "lookup",
				arguments: {},
			}),
		).rejects.toMatchObject({ _tag: "ResourceHidden" });
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
			const close = vi.fn(async () => {});
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
			const connect = vi.fn(async () => {
				if (connect.mock.calls.length === 2) expect(close).toHaveBeenCalledOnce();
				return { list, run, close };
			});
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
			expect(close).not.toHaveBeenCalled();
			const principal = takeover ? await authentication.authenticate(turnId) : first;
			for (const step of [1, 2, 3]) {
				expect(await steps.step(running.request, principal, { turnId, attempt: 0, step })).toEqual({
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
			expect(connect).toHaveBeenCalledTimes(takeover ? 2 : 1);
			expect(list).toHaveBeenCalledOnce();
			expect(run).toHaveBeenCalledTimes(2);
			expect(close).toHaveBeenCalledTimes(takeover ? 2 : 1);
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
		const ran = await loop.runTurn(chatId, { model, connectorTools: wikiWipe("ask", execute) });
		const [parked] = await callsOf(ran.turnId);
		if (!parked) throw new Error("no call parked");

		await chatsAs(adminId).decide({ toolCallId: parked.id, decision: "deny" });
		const principal = await ran.authentication.authenticate(ran.turnId);
		await ran.steps.step(ran.run.request, principal, { turnId: ran.turnId, attempt: 0, step: 1 });

		expect(execute).not.toHaveBeenCalled();
		expect(JSON.stringify(requests[1]?.continuationMessages)).toContain("execution-denied");
		expect(await storedTurn(ran.turnId)).toMatchObject({ status: "done" });
	});

	it("ends a turn whose asker no longer reaches its chat, without asking the model", async () => {
		await onDatabase((db) => db.delete(membership).where(eq(membership.memberId, adminId)));
		const { model, requests } = scriptedSteps({ text: ["Hello."] });

		const ran = await loop.runTurn(chatId, { model });

		expect(ran.outcomes).toEqual([{ _tag: "Finished" }]);
		expect(requests).toEqual([]);
		expect(await storedTurn(ran.turnId)).toMatchObject({
			status: "failed",
			error: userText`This bot can no longer reach this chat, so it stopped.`,
		});
	});

	it("cancels the turn when it is asked to stop while a step runs, keeping what it wrote", async () => {
		const events = EventBus.inProcess({ store: EventStore.inMemory() });
		// Writes a little, then the turn is asked to stop, as its automation run
		// ending asks it; the request runs until the step aborts it.
		const model = Models.fromStream((request) =>
			Effect.map(Effect.abortSignal, (signal) => ({
				deltas: (async function* () {
					yield { kind: "text" as const, text: "partial" };
					const turnId = request.purpose.name === "bot-turn" ? request.purpose.turnId : "";
					await events.publishCommitted([
						{
							stream: chatStream(chatId),
							event: streamEvent("turn.interrupt_requested", { chatId, turnId }),
							seq: 1,
						},
					]);
					await new Promise((resolve) => signal.addEventListener("abort", resolve));
				})(),
				finished: Effect.never,
			})),
		);

		const ran = await loop.runTurn(chatId, { model, events });

		expect(ran.outcomes).toEqual([{ _tag: "Finished" }]);
		expect(await storedTurn(ran.turnId)).toMatchObject({ status: "cancelled" });
		expect(await storedReply(ran.turnId)).toMatchObject({
			status: "cancelled",
			content: "partial",
		});
	});

	it("ends a timed-out turn even when its connector sessions stall on close", async () => {
		const wiki = wikiWipe("allow", async () => ({ removed: true }));
		const closing = vi.fn(() => new Promise<void>(() => {}));
		const neverClose: ConnectorCatalog.Interface = {
			forTurn: (...args) =>
				Effect.map(wiki.forTurn(...args), (opened) => ({ ...opened, close: closing })),
		};
		const requested = vi.fn();
		// A model that never answers.
		const model = Models.fromStream(() =>
			Effect.sync(() => {
				requested();
				return streamed(
					(async function* () {
						yield* [];
						await new Promise(() => {});
					})(),
				);
			}),
		);
		const { steps, authentication } = await loop.loopOver(
			{ model, connectorTools: neverClose },
			{ stepTimeout: Duration.seconds(1) },
		);
		const [run] = await runOnPostgres(runningTurns(chatId));
		if (!run) throw new Error("no turn running");
		const opened = await steps.open(run.request, 0);
		if (opened._tag !== "Opened") throw new Error("the turn may not run");
		const principal = await authentication.authenticate(opened.turnId);

		const outcome = await steps.step(run.request, principal, {
			turnId: opened.turnId,
			attempt: 0,
			step: 0,
		});

		expect(requested).toHaveBeenCalledOnce();
		expect(closing).toHaveBeenCalledOnce();
		expect(outcome).toEqual({ _tag: "Retry" });
		expect(await storedTurn(opened.turnId)).toMatchObject({
			status: "failed",
			error: userText`The reply took too long and was stopped.`,
		});
	}, 15_000);

	it("takes no step for an execution a newer one took over, and records nothing", async () => {
		const { model, requests } = scriptedSteps({ text: ["Hello."] });
		const { steps, authentication } = await loop.loopOver({ model });
		const [run] = await runOnPostgres(runningTurns(chatId));
		if (!run) throw new Error("no turn running");
		const opened = await steps.open(run.request, 0);
		if (opened._tag !== "Opened") throw new Error("the turn may not run");
		const stale = await authentication.authenticate(opened.turnId);
		// The turn resumes elsewhere before this execution's first step.
		await authentication.authenticate(opened.turnId);

		const outcome = await steps.step(run.request, stale, {
			turnId: opened.turnId,
			attempt: 0,
			step: 0,
		});

		expect(outcome).toEqual({ _tag: "Superseded" });
		expect(requests).toEqual([]);
		expect(await storedTurn(opened.turnId)).toMatchObject({ status: "running" });
		expect(await storedReply(opened.turnId)).toMatchObject({ status: "writing", content: "" });
	});

	it("stops recording a step a newer execution took over mid-request", async () => {
		let resumed = false;
		const model = Models.fromStream((request) =>
			Effect.sync(() =>
				streamed(
					(async function* () {
						yield "Half";
						// The turn resumes in another process while this request streams.
						const turnId = request.purpose.name === "bot-turn" ? request.purpose.turnId : "";
						const { authentication } = await loop.loopOver({ model: scriptedSteps().model });
						await authentication.authenticate(turnId);
						resumed = true;
						yield " and the rest.";
					})(),
				),
			),
		);

		const ran = await loop.runTurn(chatId, { model });

		expect(resumed).toBe(true);
		expect(ran.outcomes).toEqual([{ _tag: "Superseded" }]);
		// Nothing of the request was recorded for the turn, which the newer execution carries on.
		expect(await storedTurn(ran.turnId)).toMatchObject({ status: "running" });
		expect(await storedReply(ran.turnId)).toMatchObject({ status: "writing", content: "" });
	});

	it("marks a write/delete call a stopped execution sent as interrupted when the turn resumes, rather than send it again", async () => {
		const started = Promise.withResolvers<void>();
		let comeBack = () => {};
		const cutShort = new Promise<void>((resolve) => {
			comeBack = resolve;
		});
		const execute = vi.fn(async () => {
			started.resolve();
			await cutShort;
			return { removed: true };
		});
		const { model, requests } = scriptedSteps(
			{
				text: ["Wiping. "],
				calls: [
					{
						toolCallId: "sdk-1",
						toolName: CALL_TOOL,
						input: { tool: "wiki__wipe", arguments: {} },
					},
				],
			},
			{ text: ["Check the wiki."] },
		);
		const { steps, authentication } = await loop.loopOver({
			model,
			connectorTools: wikiWipe("allow", execute),
		});
		const [run] = await runOnPostgres(runningTurns(chatId));
		if (!run) throw new Error("no turn running");
		const opened = await steps.open(run.request, 0);
		if (opened._tag !== "Opened") throw new Error("the turn may not run");
		const at = (step: number) => ({ turnId: opened.turnId, attempt: 0, step });
		// The first execution sends the call, which doesn't come back: its process stops.
		const first = await authentication.authenticate(opened.turnId);
		const stopped = steps.step(run.request, first, at(0));
		await started.promise;

		// The workflow resumes the turn in another process, which takes the step
		// again. The stopped execution, should it still be running, gives up its
		// step without waiting for the call.
		const second = await authentication.authenticate(opened.turnId);
		expect(await stopped).toEqual({ _tag: "Superseded" });
		expect(await steps.step(run.request, second, at(0))).toEqual({ _tag: "Continue" });
		expect(await steps.step(run.request, second, at(1))).toEqual({ _tag: "Finished" });

		expect(execute).toHaveBeenCalledOnce();
		expect(requests).toHaveLength(2);
		expect(JSON.stringify(requests[1]?.continuationMessages)).toContain("Check what it did");
		const interrupted = {
			tool: "wiki__wipe",
			status: "failed",
			error: expect.stringContaining("Check what it did"),
		};
		expect(await callsOf(opened.turnId)).toMatchObject([interrupted]);

		// The stopped execution's call comes back late, once the turn has ended:
		// nothing of it is recorded.
		comeBack();
		await vi.waitFor(() => expect(execute).toHaveReturned());
		expect(await callsOf(opened.turnId)).toMatchObject([interrupted]);
		expect(await storedReply(opened.turnId)).toMatchObject({
			status: "complete",
			content: "Wiping. Check the wiki.",
		});
	}, 15_000);

	it("stops a step a newer execution took over while its call runs, aborting the call", async () => {
		const aborted = vi.fn();
		const started = Promise.withResolvers<void>();
		await enableWeb();
		const webFetch: Egress.Interface["webFetch"] = async (_url, options) => {
			started.resolve();
			return new Promise<Response>((_resolve, reject) =>
				options?.signal?.addEventListener("abort", () => {
					aborted();
					reject(options.signal?.reason);
				}),
			);
		};
		const { model, requests } = scriptedSteps({
			calls: [{ toolCallId: "sdk-1", toolName: WEB_FETCH_TOOL, input: { url: pageUrl } }],
		});
		const { steps, authentication } = await loop.loopOver({
			model,
			egress: unimplemented(Egress.Service, { webFetch }),
		});
		const [run] = await runOnPostgres(runningTurns(chatId));
		if (!run) throw new Error("no turn running");
		const opened = await steps.open(run.request, 0);
		if (opened._tag !== "Opened") throw new Error("the turn may not run");
		const first = await authentication.authenticate(opened.turnId);
		const stale = steps.step(run.request, first, { turnId: opened.turnId, attempt: 0, step: 0 });
		await started.promise;

		// The turn resumes in another process while the call runs.
		await authentication.authenticate(opened.turnId);

		expect(await stale).toEqual({ _tag: "Superseded" });
		expect(aborted).toHaveBeenCalledOnce();
		expect(requests).toHaveLength(1);
		expect(await storedTurn(opened.turnId)).toMatchObject({ status: "running" });
		expect(await callsOf(opened.turnId)).toMatchObject([
			{ tool: WEB_FETCH_TOOL, status: "running" },
		]);
	}, 15_000);

	it.each([
		{ initialAccess: "ask", resumedAccess: "allow", sent: false },
		{ initialAccess: "allow", resumedAccess: "ask", sent: true },
		{ initialAccess: "allow", resumedAccess: "off", sent: true },
	] as const)(
		"replays a step when tool access changes from $initialAccess to $resumedAccess",
		async ({ initialAccess, resumedAccess, sent }) => {
			const fetching = Promise.withResolvers<void>();
			let comeBack = () => {};
			const cutShort = new Promise<void>((resolve) => {
				comeBack = resolve;
			});
			let fetches = 0;
			await enableWeb();
			const webFetch = async () => {
				fetches++;
				if (fetches === 1) {
					fetching.resolve();
					await cutShort;
				}
				return pageResponse();
			};
			const wipe = vi.fn(async () => ({ removed: true }));
			let access: "allow" | "ask" | "off" = initialAccess;
			// Read as each step builds its tools, so a change shows in the next step.
			const wiki: ConnectorCatalog.Interface = {
				forTurn: (...args) => wikiWipe(access, wipe).forTurn(...args),
			};
			const { model, requests } = scriptedSteps(
				{
					calls: [
						{ toolCallId: "sdk-fetch", toolName: WEB_FETCH_TOOL, input: { url: pageUrl } },
						{
							toolCallId: "sdk-wipe",
							toolName: CALL_TOOL,
							input: { tool: "wiki__wipe", arguments: {} },
						},
					],
				},
				{ text: ["Done."] },
			);
			const outside = {
				model,
				egress: unimplemented(Egress.Service, { webFetch }),
				connectorTools: wiki,
			};
			const { steps, authentication } = await loop.loopOver(outside);
			const [run] = await runOnPostgres(runningTurns(chatId));
			if (!run) throw new Error("no turn running");
			const opened = await steps.open(run.request, 0);
			if (opened._tag !== "Opened") throw new Error("the turn may not run");
			const at = { turnId: opened.turnId, attempt: 0, step: 0 };
			const first = await authentication.authenticate(opened.turnId);
			const stopped = steps.step(run.request, first, at);
			await fetching.promise;
			if (sent) {
				await vi.waitFor(
					async () =>
						expect(await callsOf(opened.turnId)).toEqual(
							expect.arrayContaining([
								expect.objectContaining({ tool: "wiki__wipe", status: "completed" }),
							]),
						),
					{ timeout: 5_000 },
				);
			}

			access = resumedAccess;
			const second = await authentication.authenticate(opened.turnId);
			const resumed = await steps.step(run.request, second, at);
			comeBack();
			expect(await stopped).toEqual({ _tag: "Superseded" });
			const calls = await callsOf(opened.turnId);

			if (sent) {
				expect(resumed).toEqual({ _tag: "Continue" });
				expect(await steps.step(run.request, second, { ...at, step: 1 })).toEqual({
					_tag: "Finished",
				});
				expect(calls).toEqual(
					expect.arrayContaining([
						expect.objectContaining({ tool: "wiki__wipe", status: "completed", approvalId: null }),
						expect.objectContaining({ tool: WEB_FETCH_TOOL, status: "completed" }),
					]),
				);
				expect(calls).toHaveLength(2);
				expect(wipe).toHaveBeenCalledOnce();
				expect(fetches).toBe(2);
				expect(JSON.stringify(requests[1]?.continuationMessages)).toContain('"removed":true');
				expect(deliveredEvents()).toContainEqual(
					expect.objectContaining({
						type: "message.execution_started",
						messageId: (await storedReply(opened.turnId))?.id,
						execution: second.executionNumber,
					}),
				);
				return;
			}

			expect(resumed).toEqual({ _tag: "Waiting", approvals: [expect.any(String)], taken: true });
			expect(wipe).not.toHaveBeenCalled();
			expect(calls).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ tool: "wiki__wipe", approvalStatus: "pending" }),
					expect.objectContaining({ tool: WEB_FETCH_TOOL, status: "completed" }),
				]),
			);
		},
		15_000,
	);

	it("never makes the calls of the turn's last step, nor asks again when that step is taken again", async () => {
		await enableWeb();
		const webFetch = vi.fn(async () => pageResponse());
		const { model, requests } = scriptedSteps({
			text: ["Here is what I found."],
			calls: [{ toolCallId: "sdk-1", toolName: WEB_FETCH_TOOL, input: { url: pageUrl } }],
		});
		const outside = {
			model,
			egress: unimplemented(Egress.Service, { webFetch }),
		};
		const { steps, authentication } = await loop.loopOver(outside);
		const [run] = await runOnPostgres(runningTurns(chatId));
		if (!run) throw new Error("no turn running");
		const opened = await steps.open(run.request, 0);
		if (opened._tag !== "Opened") throw new Error("the turn may not run");
		const last = { turnId: opened.turnId, attempt: 0, step: TURN_STEPS - 1 };
		const principal = await authentication.authenticate(opened.turnId);

		expect(await steps.step(run.request, principal, last)).toEqual({ _tag: "Finished" });
		expect(requests.map(({ lastRequest }) => lastRequest)).toEqual([true]);
		expect(webFetch).not.toHaveBeenCalled();
		expect(await storedTurn(opened.turnId)).toMatchObject({ status: "done" });
		expect(await storedReply(opened.turnId)).toMatchObject({
			status: "complete",
			content: "Here is what I found.",
		});

		// Past the last step, a step makes no request at all.
		const another = await startBotChat(chatsAs(adminId), {
			botId,
			messageId: crypto.randomUUID(),
			content: "And this?",
		});
		const [next] = await runOnPostgres(runningTurns(another.chat.id));
		if (!next) throw new Error("no turn running");
		const nextOpened = await steps.open(next.request, 0);
		if (nextOpened._tag !== "Opened") throw new Error("the turn may not run");
		const past = { turnId: nextOpened.turnId, attempt: 0, step: TURN_STEPS };
		const nextPrincipal = await authentication.authenticate(nextOpened.turnId);
		expect(await steps.step(next.request, nextPrincipal, past)).toEqual({ _tag: "Finished" });
		expect(requests).toHaveLength(1);
	});

	it("leaves a turn whose asker left to the newer execution, when an older one finds out first", async () => {
		const { model, requests } = scriptedSteps({ text: ["Hello."] });
		const { steps, authentication } = await loop.loopOver({ model });
		const [run] = await runOnPostgres(runningTurns(chatId));
		if (!run) throw new Error("no turn running");
		const opened = await steps.open(run.request, 0);
		if (opened._tag !== "Opened") throw new Error("the turn may not run");
		const at = { turnId: opened.turnId, attempt: 0, step: 0 };
		const first = await authentication.authenticate(opened.turnId);
		const second = await authentication.authenticate(opened.turnId);
		await onDatabase((db) => db.delete(membership).where(eq(membership.memberId, adminId)));

		const stale = await steps.step(run.request, first, at);

		expect(stale).toEqual({ _tag: "Superseded" });
		expect(await storedTurn(opened.turnId)).toMatchObject({ status: "running" });

		// The newer execution, which still runs the turn, ends it.
		expect(await steps.step(run.request, second, at)).toEqual({ _tag: "Finished" });
		expect(await storedTurn(opened.turnId)).toMatchObject({
			status: "failed",
			error: userText`This bot can no longer reach this chat, so it stopped.`,
		});
		expect(requests).toEqual([]);
	});

	/**
	 * Takes the next step of the turn `ran` waited in, once its parked call
	 * was decided, as the workflow does when it resumes the turn.
	 */
	const resume = async (ran: Awaited<ReturnType<typeof loop.runTurn>>, step: number) =>
		ran.steps.step(ran.run.request, await ran.authentication.authenticate(ran.turnId), {
			turnId: ran.turnId,
			attempt: 0,
			step,
		});

	/** A step calling `toolName` with `input`, then a step that says it is done. */
	const calling = (toolName: string, input: unknown) =>
		scriptedSteps({ calls: [{ toolCallId: "sdk-1", toolName, input }] }, { text: ["Done."] });

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
			await expect(
				loop.call(ran.principal, "bots.saveInstructions", written),
			).rejects.toMatchObject({ _tag: "ApprovalNeeded" });

			await chatsAs(adminId).decide({ toolCallId: parked.id, decision: "allow_once" });

			expect(await resume(ran, 1)).toEqual({ _tag: "Finished" });
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

			expect(await resume(ran, 1)).toEqual({ _tag: "Finished" });
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
				messageId: crypto.randomUUID(),
				content: "Change how you work.",
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
		/** The admin's Personal Assistant, on a model, and a chat with it they wrote in. */
		const assistantChat = async () => {
			const assistant = await seedBot(workspaceId, {
				assistantOf: adminId,
				visibility: "personal",
			});
			await onDatabase((db) => db.update(bot).set({ model: "m" }).where(eq(bot.id, assistant.id)));
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
				messageId: crypto.randomUUID(),
				content: "Please do it.",
			});
			const ran = await loop.runTurn(started.chat.id, { model: calling(toolName, input).model });
			const [parked] = await callsOf(ran.turnId);
			if (!parked) throw new Error("No call parked");
			expect(parked).toMatchObject({ tool: toolName, approvalStatus: "pending" });
			await chatsAs(memberId).decide({ toolCallId: parked.id, decision: "allow_once" });
			expect(await resume(ran, 1)).toEqual({ _tag: "Finished" });
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
			const { model, requests } = calling("create_project", input);

			const ran = await loop.runTurn(chat, { model });

			const [parked] = await callsOf(ran.turnId);
			if (!parked) throw new Error("No call parked");
			expect(ran.outcomes).toEqual([
				{ _tag: "Waiting", approvals: [parked.approvalId], taken: true },
			]);
			expect(parked).toMatchObject({ tool: "create_project", approvalStatus: "pending", input });
			expect(await projectsNamed("Launch")).toEqual([]);
			expect(deliveredEvents()).not.toContainEqual(
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
			expect(await resume(ran, 1)).toEqual({ _tag: "Finished" });

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
			expect(deliveredEvents()).toContainEqual(
				expect.objectContaining({
					type: "reach.changed",
					about: { kind: "project", projectId: made?.id },
				}),
			);
			expect(JSON.stringify(requests[1]?.continuationMessages)).toContain(made?.id);
		});

		it("joins a public project and adds a bot to one for its member, each once approved", async () => {
			const editor = await seedMember(workspaceId, "editor");
			const assistant = await seedBot(workspaceId, { assistantOf: editor, visibility: "personal" });
			await onDatabase((db) => db.update(bot).set({ model: "m" }).where(eq(bot.id, assistant.id)));
			const other = await seedBot(workspaceId, { createdById: adminId });
			const projectId = await seedProject(workspaceId, { leadBotId: botId, visibility: "public" });
			const approveAndResume = (toolName: string, input: unknown) =>
				approvedInItsOwnChat(editor, assistant.defaultProject, toolName, input);
			const inProject = () =>
				onDatabase((db) =>
					db
						.select()
						.from(projectMember)
						.where(and(eq(projectMember.projectId, projectId), eq(projectMember.memberId, editor))),
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

		it("pins and unpins a bot in its member's sidebar, each once approved", async () => {
			const { assistant } = await assistantChat();
			const other = await seedBot(workspaceId, { createdById: null });
			const pinned = () =>
				onDatabase((db) =>
					db
						.select({ memberId: pinnedBot.memberId })
						.from(pinnedBot)
						.where(eq(pinnedBot.botId, other.id)),
				);

			expect(await pinned()).toEqual([]);
			await approvedInItsOwnChat(adminId, assistant.defaultProject, "pin_bot", { botId: other.id });
			expect(await pinned()).toEqual([{ memberId: adminId }]);

			await approvedInItsOwnChat(adminId, assistant.defaultProject, "unpin_bot", {
				botId: other.id,
			});
			expect(await pinned()).toEqual([]);
		});

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
						messageId: crypto.randomUUID(),
						content: "Show me the workspace guide.",
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
});
