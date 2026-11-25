import { WebToolOff } from "@sugabots/contracts/errors/web";
import { WEB_FETCH_TOOL, WEB_SEARCH_TOOL } from "@sugabots/contracts/operations/web";
import {
	seedAutomation,
	seedBot,
	seedMember,
	seedRun,
} from "@sugabots/core/authentication/seed.test-support";
import { aChatAwaitingReply } from "@sugabots/core/chats/turns/testing";
import { Turns } from "@sugabots/core/chats/turns/turns";
import type { CommittedEvent } from "@sugabots/core/database/events/outbox";
import { bot, workspace } from "@sugabots/core/database/schema";
import { closeDatabase, onDatabase, runOnPostgres } from "@sugabots/core/database/testing";
import { asMember } from "@sugabots/core/operations/chats/testing";
import { Egress } from "@sugabots/core/providers/network/egress";
import { unimplemented } from "@sugabots/core/testing";
import { eq } from "drizzle-orm";
import { Context } from "effect";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	botLoopOnPostgres,
	callsOf,
	enableWebSearch,
	examplePage,
	scriptedSteps,
	searchBaseUrl,
	storedReply,
} from "./testing.ts";

/**
 * The web tools through the bot loop on Postgres: web_fetch and web_search
 * through egress, what the model is given back, and when a run's calls wait
 * for approval or are refused.
 */
describe.skipIf(!process.env.DATABASE_URL)("a turn's web tools, against Postgres", async () => {
	const delivered: CommittedEvent[] = [];
	let afterCommit: ((events: readonly CommittedEvent[]) => Promise<void>) | undefined;
	const loop = await botLoopOnPostgres(delivered, async (events) => afterCommit?.(events));
	const chatsAs = (memberId: string) => asMember(loop.call, memberId);
	let chatId: string;
	let workspaceId: string;
	let adminId: string;

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		({ chatId, workspaceId, adminId } = await aChatAwaitingReply(chatsAs));
		delivered.length = 0;
		afterCommit = undefined;
	});

	const fetchedPage = {
		ok: true,
		page: {
			url: examplePage.url,
			finalUrl: examplePage.url,
			title: null,
			contentType: "text/plain",
			text: "Hello!",
			truncated: false,
		},
	};

	it("calls web_fetch through egress and gives the next model request its recorded result", async () => {
		await enableWebSearch(workspaceId, adminId);
		const webFetch = vi.fn(async () => examplePage.response());
		const { model, requests } = scriptedSteps(
			{
				text: ["Looking. "],
				calls: [{ toolCallId: "sdk-1", toolName: WEB_FETCH_TOOL, input: { url: examplePage.url } }],
			},
			{ text: ["Found it."] },
		);

		const ran = await loop.runTurn(chatId, {
			model,
			egress: unimplemented(Egress.Service, { webFetch }),
		});

		expect(webFetch).toHaveBeenCalledExactlyOnceWith(
			new URL(examplePage.url),
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
				input: { url: examplePage.url },
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
		await enableWebSearch(workspaceId, adminId);
		const result = {
			title: "Example",
			url: examplePage.url,
			snippet: "A sample page",
			published: null,
		};
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
		await enableWebSearch(workspaceId, adminId);
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
			if (disabledFor === "bot") await enableWebSearch(workspaceId, adminId);
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
						{ toolCallId: "fetch", toolName: WEB_FETCH_TOOL, input: { url: examplePage.url } },
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
			await enableWebSearch(workspaceId, adminId);
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
});
