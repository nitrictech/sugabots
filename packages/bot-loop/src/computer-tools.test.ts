import { HOST_REQUEST_TOOL, memberStream } from "@sugabots/contracts";
import { ComputerHostBlocked, NoComputerProvider } from "@sugabots/contracts/errors/computers";
import { ActionForbidden } from "@sugabots/contracts/errors/proofs";
import { seedMember, seedProject } from "@sugabots/core/authentication/seed.test-support";
import { aChatAwaitingReply } from "@sugabots/core/chats/turns/testing";
import { Turns } from "@sugabots/core/chats/turns/turns";
import { ComputerNetwork } from "@sugabots/core/computers/computer-network";
import { ComputerProviderStore } from "@sugabots/core/computers/computer-provider-store";
import { noComputers } from "@sugabots/core/computers/testing";
import type { CommittedEvent } from "@sugabots/core/database/events/outbox";
import {
	blockedHost,
	bot,
	membership,
	projectAllowedHost,
	toolCall,
} from "@sugabots/core/database/schema";
import { closeDatabase, onDatabase, runOnPostgres } from "@sugabots/core/database/testing";
import { asMember } from "@sugabots/core/operations/chats/testing";
import { proveCanDecide } from "@sugabots/core/proofs/can-decide";
import { proveIsMember } from "@sugabots/core/proofs/is-member";
import { named } from "@sugabots/core/proofs/proof";
import { authenticators, principals } from "@sugabots/core/proofs/world.test-support";
import { and, eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { botLoopOnPostgres, scriptedSteps } from "./testing.ts";

/**
 * A bot's computer tools, and its host requests, through the bot loop over
 * the real operations on Postgres: who may use the computer, and who decides
 * a request to reach another host. No computer is ever made: each case is
 * refused, or asks for a host, before one would be.
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

		const callsOf = (turnId: string) =>
			onDatabase((db) => db.select().from(toolCall).where(eq(toolCall.turnId, turnId)));

		const projectHosts = () =>
			onDatabase((db) =>
				db.select().from(projectAllowedHost).where(eq(projectAllowedHost.workspaceId, workspaceId)),
			);

		/** An OpenSandbox provider for the workspace, letting computers reach only allowed hosts, never reached. */
		const enableComputers = async () => {
			const providers = await runOnPostgres(
				Effect.provide(ComputerProviderStore.Service, ComputerProviderStore.layer),
			);
			await runOnPostgres(
				providers.create(workspaceId, {
					createdById: adminId,
					provider: {
						settings: {
							builtIn: "opensandbox",
							serverUrl: "https://computers.example.com",
							image: "sugabots-computer:dev",
							networkMode: "allowed-hosts-only",
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

		it("offers the browser's tools under their own names, but no host requests while the computer reaches every host", async () => {
			const { model, requests } = scriptedSteps({ text: ["Hello."] });

			await loop.runTurn(chatId, { model });

			expect(requests[0]?.tools).toHaveProperty("browser_navigate");
			expect(requests[0]?.tools).not.toHaveProperty("browser_take_screenshot");
			expect(requests[0]?.tools).not.toHaveProperty("browser_*");
			expect(requests[0]?.tools).not.toHaveProperty(HOST_REQUEST_TOOL);
		});

		describe("asking for a host", () => {
			beforeEach(enableComputers);

			/** A project members made, led by the bot, with a chat an editor in it asked the bot in. */
			const anEditorsChat = async () => {
				const editorId = await seedMember(workspaceId, "editor");
				const projectId = await seedProject(workspaceId, { leadBotId: botId, members: [editorId] });
				const started = await chatsAs(editorId).startProjectChat({
					projectId,
					messageId: crypto.randomUUID(),
					content: "Fetch the docs from api.example.com.",
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
								return yield* controls.decide(isMember, canDecide, "allow_once", (approver) =>
									network.grantHostRequest(isMember, approver),
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
