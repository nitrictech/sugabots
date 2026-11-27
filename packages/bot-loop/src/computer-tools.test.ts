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
import { aChatAwaitingReply } from "@sugabots/core/chats/turns/testing";
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
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

		it.each([
			["write_file", { path: "notes.txt", content: "Notes" }],
			["copy_file_to_computer", { file: "example-file" }],
			["browser_navigate", { url: "https://example.com/" }],
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

			it("asks again before running an approved command on a computer made since in its place", async () => {
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
				const { model } = calling("run_command", command);
				const ran = await loop.runTurn(chatId, { model });
				const [parked] = await callsOf(ran.turnId);
				if (!parked) throw new Error("No command parked");
				await chatsAs(adminId).decide({ toolCallId: parked.id, decision: "allow_once" });

				// The computer is reset after the approval: a new one takes its place.
				await onDatabase((db) => db.delete(computer).where(eq(computer.projectId, projectId)));
				await makeComputer("replacement");
				const principal = await ran.authentication.authenticate(ran.turnId);
				const resumed = await ran.steps.step(ran.run.request, principal, {
					turnId: ran.turnId,
					attempt: 0,
					step: 1,
				});

				const [reparked] = await callsOf(ran.turnId);
				expect(reparked).toMatchObject({ id: parked.id, approvalStatus: "pending" });
				expect(resumed).toMatchObject({ _tag: "Waiting" });
			});

			it("asks again when the approver loses authority before the turn resumes", async () => {
				const asked = await anEditorsChat();
				const nextApprover = await seedMember(workspaceId, "admin");
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
				const waiting = await resume();
				const [reparked] = await callsOf(ran.turnId);
				if (!reparked) throw new Error("No renewed host call");
				expect(reparked).toMatchObject({
					id: approved.id,
					approvalStatus: "pending",
					decidedById: null,
				});
				expect(reparked.approvalId).not.toBe(approved.approvalId);
				expect(waiting).toEqual({
					_tag: "Waiting",
					approvals: [reparked.approvalId],
					taken: false,
				});
				expect(requests).toHaveLength(1);
				await chatsAs(nextApprover).decide({ toolCallId: approved.id, decision: "allow_once" });
				expect(await resume()).toEqual({ _tag: "Finished" });
				expect(await callsOf(ran.turnId)).toMatchObject([
					{ status: "completed", decidedById: nextApprover },
				]);
			});

			it("adds nothing when the bot that asked lost its computer use while the request waited", async () => {
				const asked = await anEditorsChat();
				const { model } = calling(HOST_REQUEST_TOOL, { host: "api.example.com" });
				const ran = await loop.runTurn(asked.chatId, { model });
				const [parked] = await callsOf(ran.turnId);
				if (!parked) throw new Error("No call parked");

				await setComputerUse(false);
				await chatsAs(adminId).decide({ toolCallId: parked.id, decision: "allow_once" });

				expect(await projectHosts()).toEqual([]);
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

			it("proves its approver again as the decision is made, so one who lost the standing adds nothing", async () => {
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
									(approver) => network.grantHostRequest(isMember, approver),
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

				await expect(decided).rejects.toMatchObject({ _tag: "ActionForbidden" });
				expect(await projectHosts()).toEqual([]);
				expect(await callsOf(ran.turnId)).toMatchObject([{ approvalStatus: "pending" }]);
			});
		});
	},
);

function computerService(id: Computers.ComputerId, mode: "open" | "allowed-hosts-only") {
	return vi.fn(async (request: Parameters<typeof fetch>[0]) => {
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
				case "/command":
					return new Response(
						[
							'data: {"type":"stdout","text":"/workspace"}',
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
