import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { HOST_REQUEST_TOOL, memberStream } from "@sugabots/contracts";
import { ComputerHostBlocked, NoComputerProvider } from "@sugabots/contracts/errors/computers";
import { ActionForbidden } from "@sugabots/contracts/errors/proofs";
import {
	seedAutomation,
	seedMember,
	seedProject,
	seedRun,
} from "@sugabots/core/authentication/seed.test-support";
import { seedChat } from "@sugabots/core/chats/seed.test-support";
import { aChatAwaitingReply, runningTurns } from "@sugabots/core/chats/turns/testing";
import { Turns } from "@sugabots/core/chats/turns/turns";
import { ComputerNetwork } from "@sugabots/core/computers/computer-network";
import { ComputerProviderStore } from "@sugabots/core/computers/computer-provider-store";
import { ComputerSignIn } from "@sugabots/core/computers/computer-sign-in";
import { Computers } from "@sugabots/core/computers/computers";
import { noComputers } from "@sugabots/core/computers/testing";
import type { CommittedEvent } from "@sugabots/core/database/events/outbox";
import {
	blockedHost,
	bot,
	computer,
	membership,
	projectAllowedHost,
	toolCall,
	turn,
} from "@sugabots/core/database/schema";
import { closeDatabase, onDatabase, runOnPostgres } from "@sugabots/core/database/testing";
import { asMember } from "@sugabots/core/operations/chats/testing";
import { proveCanDecide } from "@sugabots/core/proofs/can-decide";
import { proveIsMember } from "@sugabots/core/proofs/is-member";
import { named } from "@sugabots/core/proofs/proof";
import { authenticators, principals } from "@sugabots/core/proofs/world.test-support";
import { Egress } from "@sugabots/core/providers/network/egress";
import { unimplemented } from "@sugabots/core/testing";
import { defaultProjectOf } from "@sugabots/core/workspaces/projects/project-reads";
import { and, eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { botLoopOnPostgres, callsOf, parkedCallOf, scriptedSteps } from "./testing.ts";

/**
 * A bot's computer tools, and its host requests, through the bot loop over
 * the real operations on Postgres: who may use the computer, and who decides
 * a request to reach another host.
 */
// Each case runs a turn or two, each building the bot loop afresh, which takes seconds under load.
const CASE_TIMEOUT = 30_000;

describe.skipIf(!process.env.DATABASE_URL)(
	"a bot's computer, through the bot loop",
	{ timeout: CASE_TIMEOUT },
	async () => {
		const delivered: CommittedEvent[] = [];
		const loop = await botLoopOnPostgres(delivered);
		const chatsAs = (memberId: string) => asMember(loop.call, memberId);
		let signedIn: ReturnType<typeof principals>;
		let chatId: string;
		let workspaceId: string;
		let botId: string;
		let adminId: string;

		beforeAll(async () => {
			signedIn = principals(await authenticators());
		});

		afterAll(async () => {
			await closeDatabase();
		});

		beforeEach(async () => {
			({ chatId, workspaceId, botId, adminId } = await aChatAwaitingReply(chatsAs));
			await setComputerUse(true);
			delivered.length = 0;
		});

		const setComputerUse = (usesComputer: boolean) =>
			onDatabase((db) => db.update(bot).set({ usesComputer }).where(eq(bot.id, botId)));

		const projectHosts = () =>
			onDatabase((db) =>
				db.select().from(projectAllowedHost).where(eq(projectAllowedHost.workspaceId, workspaceId)),
			);

		/** Configures the workspace's provider. Tests that use it supply its responses. */
		const enableComputers = async (
			networkMode: "allowed-hosts-only" | "open" = "allowed-hosts-only",
		) => {
			const providers = await runOnPostgres(
				Effect.provide(ComputerProviderStore.Service, ComputerProviderStore.layer),
			);
			return runOnPostgres(
				providers.create(workspaceId, {
					createdById: adminId,
					provider: {
						settings: {
							builtIn: "opensandbox",
							serverUrl: "https://computers.example.com",
							image: "sugabots-computer:dev",
							networkMode,
						},
						enabled: true,
						apiKey: "never-used",
					},
				}),
			);
		};

		/** A model that makes `call` with `input`, then finishes. */
		const calling = (toolName: string, input: unknown) =>
			scriptedSteps({ calls: [{ toolCallId: "computer", toolName, input }] }, { text: ["Done."] });

		const command = { command: "ls", timeout_seconds: 30 };

		it.each([
			["a viewer's bot", "viewer"],
			["a bot whose computer use is off", "computer use off"],
		] as const)("refuses %s its computer, and tells the model why", async (_case, why) => {
			if (why === "viewer") {
				await onDatabase((db) =>
					db.update(membership).set({ role: "viewer" }).where(eq(membership.memberId, adminId)),
				);
			} else {
				await setComputerUse(false);
			}
			const { model, requests } = calling("run_command", command);

			const ran = await loop.runTurn(chatId, { model });

			const error = new ActionForbidden({ proof: "CanUseComputer" }).userMessage;
			expect(requests[0]?.tools).toHaveProperty("run_command");
			expect(await callsOf(ran.turnId)).toMatchObject([
				{ tool: "run_command", status: "failed", error, approvalStatus: null },
			]);
			expect(JSON.stringify(requests[1]?.continuationMessages)).toContain(error);
		});

		it("tells the bot to have a computer provider enabled when the workspace has none", async () => {
			const { model, requests } = calling("read_file", { path: "notes.txt" });

			const ran = await loop.runTurn(chatId, { model });

			const error = new NoComputerProvider().userMessage;
			expect(await callsOf(ran.turnId)).toMatchObject([
				{ tool: "read_file", status: "failed", error },
			]);
			expect(JSON.stringify(requests[1]?.continuationMessages)).toContain(error);
		});

		it.each([
			["open", false],
			["allowed-hosts-only", true],
		] as const)(
			"offers the browser's tools under their own names, and host requests only in allowed-hosts-only mode (%s)",
			async (networkMode, asksForHosts) => {
				await enableComputers(networkMode);
				const { model, requests } = scriptedSteps({ text: ["Hello."] });

				await loop.runTurn(chatId, { model });

				expect(requests[0]?.tools).toHaveProperty("browser_navigate");
				expect(requests[0]?.tools).not.toHaveProperty("browser_take_screenshot");
				expect(Object.hasOwn(requests[0]?.tools ?? {}, HOST_REQUEST_TOOL)).toBe(asksForHosts);
			},
		);

		const queueOutsideRun = async (projectId: string, source: "github" | "webhook") => {
			const automationId = await seedAutomation(workspaceId, projectId);
			await onDatabase((db) =>
				seedChat(db, { workspaceId, kind: "automation_feed", automationId, title: "Checks" }),
			);
			const started = await seedRun(workspaceId, automationId, botId, source);
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

		it.each([
			["github", "open", true],
			["github", "allowed-hosts-only", true],
			["webhook", "allowed-hosts-only", true],
			["chat", "open", false],
		] as const)(
			"uses the computer from %s with %s reach (approval required: %s)",
			async (source, networkMode, asks) => {
				const projectId = await runOnPostgres(defaultProjectOf(botId));
				const provider = await enableComputers(networkMode);
				const providerComputerId = Computers.ComputerId("desktop");
				await onDatabase((db) =>
					db.insert(computer).values({
						workspaceId,
						projectId,
						computerProviderId: provider.id,
						providerComputerId,
						image: "sugabots-computer:dev",
					}),
				);

				const sourceChat = source === "chat" ? chatId : await queueOutsideRun(projectId, source);

				const providerFetch = computerService(providerComputerId, networkMode);
				const input = { command: "pwd", timeout_seconds: 30 };
				const workflow = await loop.runWorkflow(sourceChat, {
					model: calling("run_command", input).model,
					egress: unimplemented(Egress.Service, { providers: { for: () => providerFetch } }),
					computerSignIn: ComputerSignIn.none,
				});

				if (asks) {
					await workflow.suspended();
					const { parked } = await parkedCallOf(workflow.executionId);
					expect(providerFetch).not.toHaveBeenCalled();
					expect((await chatsAs(adminId).approvals(workspaceId)).waiting).toMatchObject([
						{ call: { id: parked.id, tool: "run_command", input } },
					]);
					await chatsAs(adminId).decide({ toolCallId: parked.id, decision: "allow_once" });
					await workflow.completed();
				} else {
					await Promise.race([
						workflow.completed(),
						workflow.suspended().then(() => {
							throw new Error("Computer command asked for approval");
						}),
					]);
				}

				const [opened] = await onDatabase((db) =>
					db.select({ id: turn.id }).from(turn).where(eq(turn.executionId, workflow.executionId)),
				);
				if (!opened) throw new Error("No turn opened");
				expect(await callsOf(opened.id)).toMatchObject([
					{
						status: "completed",
						approvalStatus: asks ? "allowed" : null,
						output: { stdout: "/workspace\n" },
					},
				]);
			},
		);

		it("closes a command approval when the workspace disables its computer provider", async () => {
			const provider = await enableComputers();
			const source = await queueOutsideRun(await runOnPostgres(defaultProjectOf(botId)), "github");
			const { model, requests } = calling("run_command", command);
			const workflow = await loop.runWorkflow(source, { model });
			await workflow.suspended();
			const { turnId, parked } = await parkedCallOf(workflow.executionId);

			await loop.call(await signedIn.member(adminId), "computerProviders.update", {
				workspace: workspaceId,
				providerId: provider.id,
				changes: { enabled: false },
			});

			const error =
				"This approval was closed because the workspace has no enabled computer provider.";
			await expect(
				chatsAs(adminId).decide({ toolCallId: parked.id, decision: "allow_once" }),
			).rejects.toMatchObject({ _tag: "ToolApprovalConflict", userMessage: error });
			await workflow.completed();
			expect(await callsOf(turnId)).toMatchObject([
				{ id: parked.id, status: "failed", approvalStatus: "denied", decidedById: null, error },
			]);
			expect(await chatsAs(adminId).approvals(workspaceId)).toMatchObject({
				waiting: [],
				answered: [
					{
						call: { id: parked.id, approval: { closedBecause: "settingsChanged" }, error },
						answer: { status: "closed" },
					},
				],
			});
			expect(JSON.stringify(requests[1]?.continuationMessages)).toContain(error);
		});

		it.each(["computer", "machine"] as const)(
			"closes a command approval when its %s is replaced before Allow",
			async (replacement) => {
				const provider = await enableComputers();
				const projectId = await runOnPostgres(defaultProjectOf(botId));
				const providerComputerId = Computers.ComputerId("desktop");
				const original = {
					workspaceId,
					projectId,
					computerProviderId: provider.id,
					providerComputerId,
					image: "sugabots-computer:dev",
				};
				await onDatabase((db) => db.insert(computer).values(original));
				const source = await queueOutsideRun(projectId, "github");
				const { model, requests } = calling("run_command", command);
				const providerFetch = computerService(providerComputerId, "allowed-hosts-only");
				const workflow = await loop.runWorkflow(source, {
					model,
					egress: unimplemented(Egress.Service, { providers: { for: () => providerFetch } }),
					computerSignIn: ComputerSignIn.none,
				});
				await workflow.suspended();
				const { turnId, parked } = await parkedCallOf(workflow.executionId);

				if (replacement === "computer") {
					await onDatabase((db) => db.delete(computer).where(eq(computer.projectId, projectId)));
					await onDatabase((db) => db.insert(computer).values(original));
				} else {
					await onDatabase((db) =>
						db
							.update(computer)
							.set({ providerComputerId: Computers.ComputerId("new-desktop") })
							.where(eq(computer.projectId, projectId)),
					);
				}

				const error =
					"This approval was closed because the computer the bot wanted to use changed.";
				await expect(
					chatsAs(adminId).decide({ toolCallId: parked.id, decision: "allow_once" }),
				).rejects.toMatchObject({ _tag: "ToolApprovalConflict", userMessage: error });
				await workflow.completed();
				expect(await callsOf(turnId)).toMatchObject([
					{ id: parked.id, status: "failed", approvalStatus: "denied", decidedById: null, error },
				]);
				expect(JSON.stringify(requests[1]?.continuationMessages)).toContain(error);
				expect(providerFetch).not.toHaveBeenCalled();
			},
		);

		it.each([
			["write_file", { path: "notes.txt", content: "Notes" }],
			["copy_file_to_computer", { file: "example-file" }],
		] as const)(
			"asks before %s in a GitHub run with allowed hosts only",
			async (toolName, input) => {
				await enableComputers("allowed-hosts-only");
				const runChat = await queueOutsideRun(
					await runOnPostgres(defaultProjectOf(botId)),
					"github",
				);
				const workflow = await loop.runWorkflow(runChat, { model: calling(toolName, input).model });

				await workflow.suspended();
				const { turnId, parked } = await parkedCallOf(workflow.executionId);
				expect(parked).toMatchObject({ tool: toolName, input, approvalStatus: "pending" });
				await chatsAs(adminId).decide({ toolCallId: parked.id, decision: "deny" });
				await workflow.completed();
				expect(await callsOf(turnId)).toMatchObject([{ approvalStatus: "denied" }]);
			},
		);

		const prepareBrowserRun = async (browser: ReturnType<typeof standInBrowser>) => {
			const projectId = await runOnPostgres(defaultProjectOf(botId));
			const provider = await enableComputers();
			const providerComputerId = Computers.ComputerId("desktop");
			await onDatabase((db) =>
				db.insert(computer).values({
					workspaceId,
					projectId,
					computerProviderId: provider.id,
					providerComputerId,
					image: "sugabots-computer:dev",
				}),
			);
			const providerFetch = computerService(
				providerComputerId,
				"allowed-hosts-only",
				browser.fetch,
			);
			return {
				projectId,
				egress: unimplemented(Egress.Service, {
					providers: { for: () => providerFetch },
					validateProviderUrl: () => Effect.void,
				}),
				computerSignIn: ComputerSignIn.none,
			};
		};

		const runBrowserWorkflow = async (
			model: ReturnType<typeof scriptedSteps>["model"],
			browser: ReturnType<typeof standInBrowser>,
		) => {
			const { projectId, ...outside } = await prepareBrowserRun(browser);
			const runChat = await queueOutsideRun(projectId, "github");
			return loop.runWorkflow(runChat, { ...outside, model });
		};

		const stepBrowserRun = async (
			model: ReturnType<typeof scriptedSteps>["model"],
			browser: ReturnType<typeof standInBrowser>,
		) => {
			const outside = await prepareBrowserRun(browser);
			const [run] = await runOnPostgres(runningTurns(chatId));
			if (!run) throw new Error("No browser turn running");
			const { steps, authentication } = await loop.loopOver({ ...outside, model });
			const opened = await steps.open(run.request, 0);
			if (opened._tag !== "Opened") throw new Error("The browser turn could not open");
			const principal = await authentication.authenticate(opened.turnId);
			return {
				turnId: opened.turnId,
				step: (step: number) =>
					steps.step(run.request, principal, { turnId: opened.turnId, attempt: 0, step }),
			};
		};

		const listTabs = (toolCallId: string) => ({
			calls: [{ toolCallId, toolName: "browser_tabs", input: { action: "list" } }],
		});

		const setNaturalBrowsing = (naturalBrowsing: boolean) =>
			onDatabase((db) => db.update(bot).set({ naturalBrowsing }).where(eq(bot.id, botId)));

		it.each([
			["enables", false],
			["disables", true],
		] as const)("%s natural browsing on the same desktop", async (_change, initiallyEnabled) => {
			await setNaturalBrowsing(initiallyEnabled);
			const browser = standInBrowser();
			const { model } = scriptedSteps(listTabs("before"), listTabs("after"), { text: ["Done."] });
			const run = await stepBrowserRun(model, browser);

			await run.step(0);
			const [session] = browser.sessions.keys();
			if (!session) throw new Error("No browser session opened");
			expect(browser.sessions.get(session)?.showsCursor()).toBe(initiallyEnabled);

			await setNaturalBrowsing(!initiallyEnabled);
			await run.step(1);
			await run.step(2);
			expect([...browser.sessions.keys()]).toEqual([session]);
			expect(browser.sessions.get(session)?.showsCursor()).toBe(!initiallyEnabled);
		});

		it("opens a fresh MCP session when the cached session has expired", async () => {
			const browser = standInBrowser();
			const { model } = scriptedSteps(listTabs("before"), listTabs("after"), { text: ["Done."] });
			const run = await stepBrowserRun(model, browser);

			await run.step(0);
			const [session] = browser.sessions.keys();
			if (!session) throw new Error("No browser session opened");
			browser.sessions.delete(session);
			expect((await browser.ping(session)).status).toBe(404);

			await run.step(1);
			await run.step(2);
			expect(browser.sessions.size).toBe(1);
			expect(browser.sessions.has(session)).toBe(false);
			expect(await callsOf(run.turnId)).toMatchObject([
				{ tool: "browser_tabs", status: "completed" },
				{ tool: "browser_tabs", status: "completed" },
			]);
		});

		it("terminates the remote MCP session when closing the browser", async () => {
			const browser = standInBrowser();
			const { model } = scriptedSteps(
				listTabs("before"),
				{ calls: [{ toolCallId: "close", toolName: "browser_close", input: {} }] },
				{ text: ["Done."] },
			);
			const run = await stepBrowserRun(model, browser);

			await run.step(0);
			const [session] = browser.sessions.keys();
			if (!session) throw new Error("No browser session opened");
			expect((await browser.ping(session)).status).toBe(200);

			await run.step(1);
			await run.step(2);
			expect(await callsOf(run.turnId)).toMatchObject([
				{ tool: "browser_tabs", status: "completed" },
				{ tool: "browser_close", status: "completed" },
			]);
			expect((await browser.ping(session)).status).toBe(404);
		});

		it("asks again before clicking in a different tab with the same address", async () => {
			const browser = standInBrowser();
			const input = { target: "Submit order" };
			const workflow = await runBrowserWorkflow(calling("browser_click", input).model, browser);

			await workflow.suspended();
			const { parked } = await parkedCallOf(workflow.executionId);
			const approvals = () => chatsAs(adminId).approvals(workspaceId);
			expect((await approvals()).waiting).toMatchObject([
				{
					call: {
						id: parked.id,
						tool: "browser_click",
						input,
						approval: { browserUrl: browser.url },
					},
				},
			]);

			browser.selectTab("tab-2");
			await chatsAs(adminId).decide({ toolCallId: parked.id, decision: "allow_once" });
			await workflow.suspended();
			const [fresh] = (await approvals()).waiting;
			expect(fresh?.call.approval?.id).toBeDefined();
			expect(fresh?.call.approval?.id).not.toBe(parked.approvalId);
			expect(browser.clicked).toEqual([]);

			if (!fresh) throw new Error("No fresh approval");
			await chatsAs(adminId).decide({ toolCallId: fresh.call.id, decision: "allow_once" });
			await workflow.completed();
			expect(browser.clicked).toEqual(["tab-2"]);
		});

		it.each([
			["browser_handle_dialog", { accept: true }],
			["browser_file_upload", { paths: ["/workspace/chats/order/receipt.txt"] }],
		] as const)("asks before %s and runs it with the modal open", async (toolName, input) => {
			const browser = standInBrowser(toolName);
			const { model, requests } = scriptedSteps(
				{
					calls: [
						{ toolCallId: "open", toolName: "browser_click", input: { target: "Attach receipt" } },
					],
				},
				{ calls: [{ toolCallId: "modal", toolName, input }] },
				{ text: ["Done."] },
			);
			const workflow = await runBrowserWorkflow(model, browser);
			await workflow.suspended();
			const { parked } = await parkedCallOf(workflow.executionId);
			await chatsAs(adminId).decide({ toolCallId: parked.id, decision: "allow_once" });

			await workflow.suspended();
			let [waiting] = (await chatsAs(adminId).approvals(workspaceId)).waiting;
			expect(waiting?.call).toMatchObject({
				tool: toolName,
				input,
				approval: { browserUrl: browser.url },
			});
			expect(browser.handled).toEqual([]);
			if (!waiting) throw new Error("No modal approval");
			const [session] = browser.sessions.keys();
			if (!session) throw new Error("No browser session opened");
			await setNaturalBrowsing(true);

			if (toolName === "browser_handle_dialog") {
				browser.replaceDialog("Discard the receipt?");
				await chatsAs(adminId).decide({ toolCallId: waiting.call.id, decision: "allow_once" });
				await workflow.suspended();
				const [fresh] = (await chatsAs(adminId).approvals(workspaceId)).waiting;
				expect(fresh?.call.approval?.id).toBeDefined();
				expect(fresh?.call.approval?.id).not.toBe(waiting.call.approval?.id);
				expect(browser.handled).toEqual([]);
				if (!fresh) throw new Error("No fresh modal approval");
				waiting = fresh;
			}

			await chatsAs(adminId).decide({ toolCallId: waiting.call.id, decision: "allow_once" });
			await workflow.completed();
			expect(browser.handled).toEqual([{ tool: toolName, input }]);
			expect(JSON.stringify(requests.at(-1)?.continuationMessages)).toContain("Handled modal");
			expect([...browser.sessions.keys()]).toEqual([session]);
			expect(browser.sessions.get(session)?.showsCursor()).toBe(true);
		});

		describe("asking for a host", () => {
			beforeEach(() => enableComputers());

			/** A project members made, led by the bot, with a chat an editor in it asked the bot in. */
			const anEditorsChat = async () => {
				const editorId = await seedMember(workspaceId, "editor");
				const projectId = await seedProject(workspaceId, { leadBotId: botId, members: [editorId] });
				const started = await chatsAs(editorId).startProjectChat({
					projectId,
					retryKey: crypto.randomUUID(),
					message: "Fetch the docs from api.example.com.",
				});
				return { editorId, projectId, chatId: started.chat.id };
			};

			it("waits for someone who manages the project, whose decision adds the host, then tells the bot", async () => {
				const asked = await anEditorsChat();
				const input = { host: "api.example.com" };
				const { model, requests } = calling(HOST_REQUEST_TOOL, input);

				const ran = await loop.runTurn(asked.chatId, { model });

				const [parked] = await callsOf(ran.turnId);
				if (!parked) throw new Error("No call parked");
				expect(ran.outcomes).toEqual([
					{ _tag: "Waiting", approvals: [parked.approvalId], taken: true },
				]);
				expect(parked).toMatchObject({ tool: HOST_REQUEST_TOOL, approvalStatus: "pending", input });
				expect(await projectHosts()).toEqual([]);
				expect(delivered.filter(({ event }) => event.type === "approvals.changed")).toContainEqual(
					expect.objectContaining({
						stream: memberStream(adminId),
						event: expect.objectContaining({ toolCallId: parked.id }),
					}),
				);
				expect(delivered.filter(({ stream }) => stream === memberStream(asked.editorId))).toEqual(
					[],
				);
				await expect(
					loop.call(ran.principal, "computers.requestHost", input),
				).rejects.toMatchObject({ _tag: "ApprovalNeeded" });

				// The editor asked, but doesn't manage the project, so isn't its approver.
				await expect(
					chatsAs(asked.editorId).decide({ toolCallId: parked.id, decision: "allow_once" }),
				).rejects.toMatchObject({ _tag: "ActionForbidden" });
				expect(await projectHosts()).toEqual([]);

				await chatsAs(adminId).decide({ toolCallId: parked.id, decision: "allow_once" });
				expect(await projectHosts()).toMatchObject([
					{ projectId: asked.projectId, host: input.host, addedById: adminId },
				]);

				const principal = await ran.authentication.authenticate(ran.turnId);
				expect(
					await ran.steps.step(ran.run.request, principal, {
						turnId: ran.turnId,
						attempt: 0,
						step: 1,
					}),
				).toEqual({ _tag: "Finished" });
				expect(await callsOf(ran.turnId)).toMatchObject([
					{
						approvalStatus: "allowed",
						decidedById: adminId,
						status: "completed",
						output: { status: "allowed", host: input.host },
					},
				]);
				expect(JSON.stringify(requests[1]?.continuationMessages)).toContain(
					"Your computer can connect to it now.",
				);
			});

			it("asks the Personal Assistant’s member before running a computer command", async () => {
				await onDatabase((db) =>
					db
						.update(bot)
						.set({ assistantOf: adminId, visibility: "personal" })
						.where(eq(bot.id, botId)),
				);
				const { model, requests } = calling("run_command", command);
				const ran = await loop.runTurn(chatId, { model });
				const [parked] = await callsOf(ran.turnId);
				if (!parked) throw new Error("No command parked");
				expect(requests[0]?.tools).toHaveProperty("run_command");
				expect(parked).toMatchObject({
					tool: "run_command",
					input: command,
					approvalStatus: "pending",
				});
				await chatsAs(adminId).decide({ toolCallId: parked.id, decision: "deny" });
				const principal = await ran.authentication.authenticate(ran.turnId);
				expect(
					await ran.steps.step(ran.run.request, principal, {
						turnId: ran.turnId,
						attempt: 0,
						step: 1,
					}),
				).toEqual({ _tag: "Finished" });
				expect(JSON.stringify(requests[1]?.continuationMessages)).toContain("denied");
			});

			it.each(["before the call", "while opening"] as const)(
				"asks again before running an approved command on a computer replaced %s",
				async (when) => {
					await onDatabase((db) =>
						db
							.update(bot)
							.set({ assistantOf: adminId, visibility: "personal" })
							.where(eq(bot.id, botId)),
					);
					const projectId = await runOnPostgres(defaultProjectOf(botId));
					const providerId = (
						await runOnPostgres(
							Effect.provide(ComputerProviderStore.Service, ComputerProviderStore.layer).pipe(
								Effect.flatMap((providers) => providers.enabled(workspaceId)),
							),
						)
					)?.id;
					if (!providerId) throw new Error("No provider");
					const makeComputer = (name: string) =>
						onDatabase((db) =>
							db.insert(computer).values({
								workspaceId,
								projectId,
								computerProviderId: providerId,
								providerComputerId: Computers.ComputerId(name),
								image: "sugabots-computer:dev",
							}),
						);
					await makeComputer("first");
					const approvedCommand = { ...command, command: "echo approved-command" };
					const { model } = calling("run_command", approvedCommand);
					const opening = Promise.withResolvers<void>();
					const missing = Promise.withResolvers<void>();
					onTestFinished(() => missing.resolve());
					const replacement = Computers.ComputerId("replacement");
					const service = computerService(replacement, "allowed-hosts-only");
					const commandOnReplacement = vi.fn();
					const providerFetch: typeof fetch = async (request, init) => {
						const url = new URL(request instanceof Request ? request.url : request.toString());
						const method = request instanceof Request ? request.method : init?.method;
						if (url.hostname === "computers.example.com" && url.pathname.endsWith("/first")) {
							if (method === "DELETE") return new Response(null, { status: 204 });
							opening.resolve();
							await missing.promise;
							return Response.json({ code: "NOT_FOUND", message: "Missing" }, { status: 404 });
						}
						if (url.hostname === "computers.example.com" && method === "POST") {
							return Response.json(
								{
									id: replacement,
									status: { state: "Running" },
									createdAt: "2026-01-01T00:00:00Z",
								},
								{ status: 202 },
							);
						}
						if (url.pathname === "/command") {
							const body =
								request instanceof Request
									? await request.clone().json()
									: JSON.parse(String(init?.body));
							if (String(body.command).includes(approvedCommand.command)) commandOnReplacement();
						}
						return service(request);
					};
					const ran = await loop.runTurn(chatId, {
						model,
						egress: unimplemented(Egress.Service, { providers: { for: () => providerFetch } }),
						computerSignIn: ComputerSignIn.none,
					});
					const [parked] = await callsOf(ran.turnId);
					if (!parked) throw new Error("No command parked");
					await chatsAs(adminId).decide({ toolCallId: parked.id, decision: "allow_once" });

					if (when === "before the call") {
						await onDatabase((db) => db.delete(computer).where(eq(computer.projectId, projectId)));
						await makeComputer(replacement);
					}
					const principal = await ran.authentication.authenticate(ran.turnId);
					const resuming = ran.steps.step(ran.run.request, principal, {
						turnId: ran.turnId,
						attempt: 0,
						step: 1,
					});
					try {
						if (when === "while opening") {
							await Promise.race([
								opening.promise,
								resuming.then(() => {
									throw new Error("The call did not open the approved computer");
								}),
							]);
						}
					} finally {
						missing.resolve();
						await resuming;
					}

					expect(commandOnReplacement).not.toHaveBeenCalled();
					expect(await resuming).toMatchObject({ _tag: "Waiting" });
					const [reparked] = await callsOf(ran.turnId);
					expect(reparked).toMatchObject({ id: parked.id, approvalStatus: "pending" });
					expect(reparked?.approvalId).not.toBe(parked.approvalId);
				},
			);

			it("keeps a host decision when its approver is demoted before the turn resumes", async () => {
				const asked = await anEditorsChat();
				const { model, requests } = calling(HOST_REQUEST_TOOL, { host: "api.example.com" });
				const ran = await loop.runTurn(asked.chatId, { model });
				const [approved] = await callsOf(ran.turnId);
				if (!approved) throw new Error("No host call");
				expect(approved.approvalComputerProjectId).toBe(asked.projectId);
				// Display input is bounded separately from the approved arguments.
				await onDatabase((db) =>
					db
						.update(toolCall)
						.set({ input: { truncated: true } })
						.where(eq(toolCall.id, approved.id)),
				);
				await chatsAs(adminId).decide({ toolCallId: approved.id, decision: "allow_once" });
				expect(await projectHosts()).toMatchObject([
					{ host: "api.example.com", addedById: adminId },
				]);
				await onDatabase((db) =>
					db
						.update(membership)
						.set({ role: "editor" })
						.where(and(eq(membership.workspaceId, workspaceId), eq(membership.memberId, adminId))),
				);
				const resume = async () =>
					ran.steps.step(ran.run.request, await ran.authentication.authenticate(ran.turnId), {
						turnId: ran.turnId,
						attempt: 0,
						step: 1,
					});
				expect(await resume()).toEqual({ _tag: "Finished" });
				expect(requests).toHaveLength(2);
				expect(await callsOf(ran.turnId)).toMatchObject([
					{ status: "completed", decidedById: adminId },
				]);
			});

			it.each([
				[
					"computer use is off",
					"This approval was closed because the bot can no longer use the computer.",
				],
				[
					"the host is blocked",
					"This approval was closed because the workspace now blocks the requested host.",
				],
				[
					"the provider is disabled",
					"This approval was closed because the workspace has no enabled computer provider.",
				],
			] as const)("closes the host request and wakes the turn when %s", async (change, error) => {
				const asked = await anEditorsChat();
				const { model, requests } = calling(HOST_REQUEST_TOOL, { host: "api.example.com" });
				const workflow = await loop.runWorkflow(asked.chatId, { model });
				await workflow.suspended();
				const { turnId, parked } = await parkedCallOf(workflow.executionId);

				if (change === "computer use is off") {
					await setComputerUse(false);
				} else if (change === "the host is blocked") {
					await onDatabase((db) =>
						db
							.insert(blockedHost)
							.values({ workspaceId, host: "example.com", blockedById: adminId }),
					);
				} else {
					const admin = await signedIn.member(adminId);
					const [provider] = await loop.call(admin, "computerProviders.list", {
						workspace: workspaceId,
					});
					if (!provider) throw new Error("No computer provider");
					await loop.call(admin, "computerProviders.update", {
						workspace: workspaceId,
						providerId: provider.id,
						changes: { enabled: false },
					});
				}

				await expect(
					chatsAs(adminId).decide({ toolCallId: parked.id, decision: "allow_once" }),
				).rejects.toMatchObject({ _tag: "ToolApprovalConflict", userMessage: error });
				await workflow.completed();
				expect(await projectHosts()).toEqual([]);
				expect(await callsOf(turnId)).toMatchObject([
					{ id: parked.id, status: "failed", approvalStatus: "denied", decidedById: null, error },
				]);
				expect(JSON.stringify(requests[1]?.continuationMessages)).toContain(error);
			});

			it("adds nothing when the host is denied", async () => {
				const asked = await anEditorsChat();
				const { model } = calling(HOST_REQUEST_TOOL, { host: "api.example.com" });
				const ran = await loop.runTurn(asked.chatId, { model });
				const [parked] = await callsOf(ran.turnId);
				if (!parked) throw new Error("No call parked");

				await chatsAs(adminId).decide({ toolCallId: parked.id, decision: "deny" });

				expect(await projectHosts()).toEqual([]);
			});

			it("refuses a host the workspace blocked at once, asking nobody", async () => {
				await onDatabase((db) =>
					db.insert(blockedHost).values({ workspaceId, host: "example.com", blockedById: adminId }),
				);
				const { model, requests } = calling(HOST_REQUEST_TOOL, { host: "api.example.com" });

				const ran = await loop.runTurn(chatId, { model });

				const error = new ComputerHostBlocked({ host: "api.example.com", by: "example.com" })
					.userMessage;
				expect(ran.outcomes).toEqual([{ _tag: "Continue" }, { _tag: "Finished" }]);
				expect(await callsOf(ran.turnId)).toMatchObject([
					{ tool: HOST_REQUEST_TOOL, approvalStatus: null, status: "failed", error },
				]);
				expect(JSON.stringify(requests[1]?.continuationMessages)).toContain(error);
				expect(await projectHosts()).toEqual([]);
			});

			it("lets an admitted decision finish after its approver is demoted", async () => {
				const asked = await anEditorsChat();
				const { model } = calling(HOST_REQUEST_TOOL, { host: "api.example.com" });
				const ran = await loop.runTurn(asked.chatId, { model });
				const [parked] = await callsOf(ran.turnId);
				if (!parked) throw new Error("No call parked");
				const admin = await signedIn.member(adminId);
				const decided = runOnPostgres(
					Effect.gen(function* () {
						const controls = yield* Turns.Controls;
						const network = yield* ComputerNetwork.Service;
						return yield* named(admin, parked.id, (principal, call) =>
							Effect.gen(function* () {
								const isMember = yield* proveIsMember(principal);
								const canDecide = yield* proveCanDecide(isMember, call);
								// Made an editor after they were found the approver, before they decide.
								yield* Effect.promise(() =>
									onDatabase((db) =>
										db
											.update(membership)
											.set({ role: "editor" })
											.where(
												and(
													eq(membership.memberId, adminId),
													eq(membership.workspaceId, workspaceId),
												),
											),
									),
								);
								return yield* controls.decide(
									isMember,
									canDecide,
									parked.approvalId ?? "",
									"allow_once",
									(approver) =>
										network
											.grantHostRequest(isMember, approver)
											.pipe(Effect.as(undefined), Effect.orDie),
								);
							}),
						);
					}).pipe(
						Effect.provide(
							Layer.mergeAll(Turns.controlsLayer, ComputerNetwork.layer).pipe(
								Layer.provide([Layer.succeedContext(loop.services), noComputers]),
							),
						),
					),
				);

				await decided;
				expect(await projectHosts()).toHaveLength(1);
				expect(await callsOf(ran.turnId)).toMatchObject([{ approvalStatus: "allowed" }]);
			});
		});
	},
);

function computerService(
	id: Computers.ComputerId,
	mode: "open" | "allowed-hosts-only",
	browser?: (request: Request) => Promise<Response>,
) {
	return vi.fn(async (...[request, init]: Parameters<typeof fetch>) => {
		const url = new URL(request instanceof Request ? request.url : request.toString());
		if (url.origin === "https://computers.example.com") {
			if (url.pathname.includes(`/${id}/endpoints/`)) {
				return Response.json({ endpoint: "computer.example.com", headers: {} });
			}
			if (url.pathname.endsWith(`/${id}`)) {
				return Response.json({
					id,
					status: { state: "Running" },
					createdAt: "2026-01-01T00:00:00Z",
				});
			}
			if (url.pathname.endsWith(`/${id}/networkpolicy`)) return new Response(null, { status: 204 });
		}
		if (url.origin === "https://computer.example.com") {
			switch (url.pathname) {
				case "/ping":
					return new Response("ok");
				case "/policy":
					return Response.json({
						policy: { defaultAction: mode === "open" ? "allow" : "deny", egress: [] },
					});
				case "/credential-vault":
					return Response.json({ code: "NOT_FOUND", message: "Missing" }, { status: 404 });
				case "/mcp":
					if (browser) return browser(new Request(request, init));
					break;
				case "/command":
					return new Response(
						[
							`data: ${JSON.stringify({
								type: "stdout",
								text: browser
									? "viewer=5900 watch=5901 browser=8930 password=control watch-password=watch"
									: "/workspace",
							})}`,
							'data: {"type":"execution_complete","execution_time":1}',
							"",
						].join("\n\n"),
						{ headers: { "content-type": "text/event-stream" } },
					);
			}
		}
		throw new Error(`Unexpected computer service request to ${url}`);
	});
}

function standInBrowser(modalTool?: "browser_handle_dialog" | "browser_file_upload") {
	let tab = "tab-1";
	const url = "https://shop.example.com/checkout";
	const clicked: string[] = [];
	const handled: { tool: string; input: unknown }[] = [];
	const sessions = new Map<string, ReturnType<typeof standInBrowserPage>>();
	let sessionCount = 0;
	let modalSession: string | null = null;
	let dialogMessage = "Submit the receipt?";
	const browser = {
		url,
		clicked,
		handled,
		sessions,
		selectTab: (selected: string) => {
			tab = selected;
		},
		replaceDialog: (message: string) => {
			dialogMessage = message;
		},
		fetch: async (request: Request) => {
			const session = request.headers.get("mcp-session-id");
			const browserPage = session === null ? undefined : sessions.get(session);
			if (session !== null && !browserPage) return new Response(null, { status: 404 });
			if (request.method === "DELETE" && session !== null) {
				sessions.delete(session);
				if (modalSession === session) modalSession = null;
				return new Response(null, { status: 204 });
			}
			if (request.method !== "POST") return new Response(null, { status: 405 });
			const { id, method, params } = (await request.json()) as {
				id?: number;
				method: string;
				params?: { protocolVersion?: string; name?: string; arguments?: unknown };
			};
			const result = (value: unknown, headers?: Record<string, string>) =>
				Response.json({ jsonrpc: "2.0", id, result: value }, { headers });
			if (method === "initialize") {
				const opened = `session-${++sessionCount}`;
				sessions.set(
					opened,
					standInBrowserPage(() => tab, url),
				);
				return result(
					{
						protocolVersion: params?.protocolVersion,
						capabilities: { tools: {} },
						serverInfo: { name: "browser-test", version: "1" },
					},
					{ "mcp-session-id": opened },
				);
			}
			if (session === null || !browserPage) return new Response(null, { status: 400 });
			if (method === "notifications/initialized") return new Response(null, { status: 202 });
			if (method === "ping") return result({});
			const modalOpen = modalSession !== null && modalSession === session;
			const modalDescription =
				modalTool === "browser_handle_dialog"
					? `"confirm" dialog with message "${dialogMessage}"`
					: "File chooser";
			const modalState = modalOpen
				? `\n### Modal state\n- [${modalDescription}]: can be handled by ${modalTool}`
				: "";
			const reply = (message: string, isError = false) =>
				result({ content: [{ type: "text", text: message + modalState }], isError });
			switch (params?.name) {
				case "browser_run_code_unsafe": {
					if (modalOpen)
						return reply(
							'### Error\nError: Tool "browser_run_code_unsafe" does not handle the modal state.',
							true,
						);
					const { code } = params.arguments as { code: string };
					const value = await browserPage.run(code);
					return reply(value === undefined ? "" : `### Result\n${JSON.stringify(value)}`);
				}
				case "browser_tabs":
					return reply(`### Result\n- 0: (current) [](${url})`);
				case "browser_close":
					return reply("Closed browser");
				case "browser_click":
					clicked.push(tab);
					modalSession = modalTool ? session : null;
					return reply("Clicked");
				case "browser_handle_dialog":
				case "browser_file_upload":
					if (!modalOpen || modalTool !== params.name)
						return reply(
							`### Error\nError: The tool "${params.name}" can only be used when there is related modal state present.`,
							true,
						);
					modalSession = null;
					handled.push({ tool: params.name, input: params.arguments });
					return reply("Handled modal");
				default:
					throw new Error(`Unexpected browser request ${method}`);
			}
		},
	};
	return {
		...browser,
		ping: (session: string) =>
			browser.fetch(
				new Request("https://computer.example.com/mcp", {
					method: "POST",
					headers: { "mcp-session-id": session },
					body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
				}),
			),
	};
}

function standInBrowserPage(currentTab: () => string, url: string) {
	let cursorVisible = false;
	const pages: object[] = [];
	const context = Object.assign(new EventEmitter(), {
		pages: () => pages,
		newCDPSession: async () => ({
			send: async (method: string) => {
				if (method === "Target.getTargetInfo") return { targetInfo: { targetId: currentTab() } };
				if (method === "Page.getFrameTree")
					return { frameTree: { frame: { loaderId: currentTab(), url } } };
				throw new Error(`Unexpected browser protocol request ${method}`);
			},
			detach: async () => {},
		}),
	});
	class Locator {}
	const page = {
		context: () => context,
		locator: () => new Locator(),
		screencast: {
			showActions: async () => {
				cursorVisible = true;
			},
			hideActions: async () => {
				cursorVisible = false;
			},
		},
	};
	pages.push(page);
	return {
		showsCursor: () => cursorVisible,
		run: (code: string) => {
			const runCode = runInNewContext(`(${code})`) as (
				browserPage: typeof page,
			) => Promise<unknown>;
			return runCode(page);
		},
	};
}
