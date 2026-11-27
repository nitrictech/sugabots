import type { JsonValue, ToolApprovalStatus } from "@sugabots/contracts";
import { connectorToolKey, HOST_REQUEST_TOOL } from "@sugabots/contracts";
import { ApprovalRefused } from "@sugabots/contracts/errors/proofs";
import type { InputOf } from "@sugabots/contracts/operations";
import { jsonSchema, tool } from "ai";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Effect, Redacted } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	seedBot,
	seedComputer,
	seedConnector,
	seedMember,
	seedMessage,
	seedProject,
	seedProjectBotConnector,
	seedProjectChat,
	seedTurnAnswering,
	seedWorkspace,
	setRole,
} from "../authentication/seed.test-support.ts";
import { turnFacts } from "../authentication/turn-facts.ts";
import { reachesChatFor } from "../authorization/access.ts";
import { offerAugmentationTools } from "../chats/tools/augmentations.ts";
import { offeredTool } from "../chats/tools/connector-catalog.ts";
import { Turns } from "../chats/turns/turns.ts";
import { Computers } from "../computers/computers.ts";
import { inMemoryComputers } from "../computers/testing.ts";
import { Database, query } from "../database/database.ts";
import {
	computer,
	computerProvider,
	connector,
	project,
	projectBot,
	projectBotConnector,
	projectMember,
	toolCall,
	turn,
} from "../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../database/testing.ts";
import { callTool } from "../operations/connectors/call-tool.ts";
import { searchTools } from "../operations/connectors/search-tools.ts";
import { ApprovalCheckReached, type Call } from "../operations/operation.ts";
import type { Principal } from "../principal.ts";
import { ConnectorCalls } from "../providers/connectors/connector-calls.ts";
import { unimplemented } from "../testing.ts";
import {
	type ApprovalRule,
	approvalNeed,
	approvalRule,
	type OrdinaryApproval,
	proveApproved,
	proveComputerUseApproved,
	proveConnectorApproved,
} from "./approved.ts";
import { approvalAudience, approvedCalls, approverStandingIn } from "./approvers.ts";
import { proveCanDecide } from "./can-decide.ts";
import { proveCanUseChatComputer } from "./can-use-computer.ts";
import { proveCanUseConnector } from "./can-use-connector.ts";
import { proveConnectorCall } from "./connector-call.ts";
import { proveEndsTurn } from "./ends-turn.ts";
import { proveIsMember } from "./is-member.ts";
import { named } from "./proof.ts";
import { proveReachesChat } from "./reaches-chat.ts";
import { proveRunsTurn } from "./runs-turn.ts";
import { proveCanInterrupt, proveCanSteer } from "./turn-control.ts";
import {
	type Authenticators,
	authenticators,
	buildWorld,
	outcome,
	principals,
	type World,
} from "./world.test-support.ts";

describe("turns: steering, interrupting, running, ending and approvals", () => {
	let world: World;
	let auth: Authenticators;
	let as: ReturnType<typeof principals>;

	beforeAll(async () => {
		world = await buildWorld();
		auth = await authenticators();
		as = principals(auth);
	});

	afterAll(async () => {
		await closeDatabase();
	});

	/** A tool call in `bot`'s turn, waiting on or decided as `fields` say. */
	const seedToolCall = async (
		bot: { readonly chat: string; readonly turn: string; readonly bot: string },
		fields: {
			readonly tool?: string;
			readonly computerProjectId?: string;
			readonly status?: ToolApprovalStatus;
			readonly decidedBy?: string;
			readonly input?: JsonValue;
		} = {},
	) => {
		const reply = await seedMessage(bot.chat, { bot: bot.bot, turn: bot.turn });
		const input = fields.input ?? { title: "Ship it", labels: ["now"] };
		const [row] = await onDatabase((db) =>
			db
				.insert(toolCall)
				.values({
					chatId: bot.chat,
					messageId: reply,
					turnId: bot.turn,
					tool: fields.tool ?? "create_issue",
					approvalComputerProjectId: fields.computerProjectId ?? null,
					input,
					executionInput: input,
					approvalStatus: fields.status ?? "pending",
					decidedById: fields.decidedBy ?? null,
					status: "awaiting_approval",
					atOffset: 0,
				})
				.returning({ id: toolCall.id }),
		);
		if (!row) throw new Error("fixture");
		return row.id;
	};

	const endTurn = (turnId: string) =>
		onDatabase((db) =>
			db.update(turn).set({ status: "done", finishedAt: new Date() }).where(eq(turn.id, turnId)),
		);

	describe("CanSteer and CanInterrupt", () => {
		const steers = (principal: Principal, chatId: string, turnId: string) =>
			outcome(
				named(principal, chatId, turnId, (p, c, t) =>
					proveReachesChat(p, c).pipe(
						Effect.flatMap((reach) => proveCanSteer(reach, t)),
						Effect.asVoid,
					),
				),
			);
		const interrupts = (principal: Principal, chatId: string, turnId: string) =>
			outcome(
				named(principal, chatId, turnId, (p, c, t) =>
					Effect.gen(function* () {
						const isMember = yield* proveIsMember(p);
						yield* proveCanInterrupt(isMember, yield* proveReachesChat(p, c), t);
					}),
				),
			);

		it("lets only a turn's asker steer it", async () => {
			const { a } = world;
			const edsBot = await as.botFor(a.ed, a.pub.id, a.chat);
			expect(await steers(await as.member(a.ed), a.chat, edsBot.turn)).toBe("ok");
			expect(await steers(await as.member(a.vi), a.chat, edsBot.turn)).toBe("ActionForbidden");
			expect(await steers(await as.member(a.owner), a.chat, edsBot.turn)).toBe("ActionForbidden");
			expect(await steers(await as.member(a.ed), a.otherChat, edsBot.turn)).toBe("ResourceHidden");
		});

		it("lets its asker, and whoever manages its project and reaches its chat, interrupt it", async () => {
			const { a } = world;
			const edsBot = await as.botFor(a.ed, a.pub.id, a.chat);
			const cases: Array<[string, string]> = [
				[a.ed, "ok"],
				[a.owner, "ok"],
				[a.admin, "ok"],
				[a.vi, "ActionForbidden"],
				[a.quinn, "ActionForbidden"],
				[a.erin, "ResourceHidden"],
			];
			for (const [memberId, result] of cases) {
				expect(await interrupts(await as.member(memberId), a.chat, edsBot.turn)).toBe(result);
			}
			expect(await interrupts(edsBot, a.chat, edsBot.turn)).toBe("ActionForbidden");
		});

		it("lets nobody steer a run's turns, not even those who may interrupt them", async () => {
			const { a } = world;
			const { run, turnId } = await as.run(a.workspace, a.project, a.pub.id);
			for (const memberId of [a.ed, a.admin, a.owner]) {
				expect(await steers(await as.member(memberId), run.chat, turnId)).toBe("ActionForbidden");
			}
		});

		it("runs a personal bot's automations for its creator, who steers their turns, in member bounds unless started from outside", async () => {
			const { a } = world;
			const expectedBounds = { routine: "member", manual: "member", webhook: "chat" } as const;
			for (const bot of [a.assistant, a.personal]) {
				for (const [startedBy, bounds] of Object.entries(expectedBounds)) {
					const { run, turnId, principal } = await as.run(
						a.workspace,
						bot.defaultProject,
						bot.id,
						startedBy as keyof typeof expectedBounds,
					);
					const asked = principal._tag === "BotForAsker" ? principal : undefined;
					expect({ asker: asked?.asker, bounds: asked?.bounds.kind }, startedBy).toEqual({
						asker: a.ed,
						bounds,
					});
					expect(await steers(await as.member(a.ed), run.chat, turnId)).toBe("ok");
				}
			}
		});

		it("runs a public bot's automations in its own chats for no member, not even its creator", async () => {
			const { a } = world;
			const { run, turnId, principal } = await as.run(
				a.workspace,
				a.pub.defaultProject,
				a.pub.id,
				"routine",
			);
			expect(principal._tag).toBe("AutomationRun");
			expect(await steers(await as.member(a.ed), run.chat, turnId)).toBe("ActionForbidden");
		});

		it("lets those who may approve a run's calls interrupt its turns", async () => {
			const { a } = world;
			const { run, turnId } = await as.run(a.workspace, a.project, a.pub.id);
			expect(await interrupts(await as.member(a.ed), run.chat, turnId)).toBe("ok");
			expect(await interrupts(await as.member(a.admin), run.chat, turnId)).toBe("ok");
			expect(await interrupts(await as.member(a.quinn), run.chat, turnId)).toBe("ActionForbidden");
		});
	});

	describe("RunsTurn and EndsTurn", () => {
		const runs = (principal: Principal, chatId: string, turnId: string) =>
			outcome(
				named(principal, chatId, turnId, (p, _chat, t) => proveRunsTurn(p, t).pipe(Effect.asVoid)),
			);
		const ends = (principal: Principal, turnId: string) =>
			outcome(named(principal, turnId, (p, t) => proveEndsTurn(p, t).pipe(Effect.asVoid)));

		it("holds for a turn's own principal while it runs, and not for another turn", async () => {
			const { a } = world;
			const edsBot = await as.botFor(a.ed, a.pub.id, a.chat);
			const other = await as.botFor(a.ed, a.pub.id, a.chat);
			expect(await runs(edsBot, a.chat, edsBot.turn)).toBe("ok");
			expect(await runs(edsBot, a.chat, other.turn)).toBe("ResourceHidden");
			expect(await ends(edsBot, edsBot.turn)).toBe("ok");
			expect(await ends(edsBot, other.turn)).toBe("ResourceHidden");
			expect(await ends(await as.member(a.ed), edsBot.turn)).toBe("ResourceHidden");

			await endTurn(edsBot.turn);
			expect(await runs(edsBot, a.chat, edsBot.turn)).toBe("TurnEnded");
			expect(await ends(edsBot, edsBot.turn)).toBe("TurnEnded");
		});

		it("lets an admitted turn carry on after its asker loses reach", async () => {
			const { a } = world;
			const projectId = await seedProject(a.workspace, {
				leadBotId: a.pub.id,
				members: [a.quinn],
			});
			const chatId = await seedProjectChat(a.workspace, projectId, a.quinn);
			const quinnsBot = await as.botFor(a.quinn, a.pub.id, chatId);
			await onDatabase((db) =>
				db
					.delete(projectMember)
					.where(and(eq(projectMember.projectId, projectId), eq(projectMember.memberId, a.quinn))),
			);
			expect(await runs(quinnsBot, chatId, quinnsBot.turn)).toBe("ok");
			expect(await ends(quinnsBot, quinnsBot.turn)).toBe("ok");
		});

		it("holds for a run's own turns", async () => {
			const { a } = world;
			const { principal, run, turnId } = await as.run(a.workspace, a.project, a.pub.id);
			expect(await runs(principal, run.chat, turnId)).toBe("ok");
		});
	});

	describe("CanDecide", () => {
		const decides = (principal: Principal, callId: string) =>
			outcome(
				named(principal, callId, (p, x) =>
					proveIsMember(p).pipe(
						Effect.flatMap((isMember) => proveCanDecide(isMember, x)),
						Effect.asVoid,
					),
				),
			);

		it("lets only the asker decide a turn's call, hiding it from those who don't reach the chat", async () => {
			const { a } = world;
			const edsBot = await as.botFor(a.ed, a.pub.id, a.chat);
			const callId = await seedToolCall(edsBot);
			expect(await decides(await as.member(a.ed), callId)).toBe("ok");
			expect(await decides(await as.member(a.owner), callId)).toBe("ActionForbidden");
			expect(await decides(await as.member(a.erin), callId)).toBe("ResourceHidden");
			expect(await decides(edsBot, callId)).toBe("ActionForbidden");
		});

		it("lets those who manage the project decide a request to change its computer", async () => {
			const { a } = world;
			const edsBot = await as.botFor(a.ed, a.pub.id, a.chat);
			const callId = await seedToolCall(edsBot, {
				tool: HOST_REQUEST_TOOL,
				computerProjectId: a.project,
			});
			expect(await decides(await as.member(a.owner), callId)).toBe("ok");
			expect(await decides(await as.member(a.admin), callId)).toBe("ok");
			expect(await decides(await as.member(a.ed), callId)).toBe("ActionForbidden");
		});

		it("lets a viewer, and nobody else, decide a request to change the computer of a personal bot of their own", async () => {
			const { a } = world;
			const viewerId = await seedMember(a.workspace, "viewer");
			const viewer = await as.member(viewerId);
			const requestIn = async (bot: { readonly id: string; readonly defaultProject: string }) => {
				const chat = await seedProjectChat(a.workspace, bot.defaultProject, viewerId);
				const asking = await as.botFor(viewerId, bot.id, chat);
				return seedToolCall(asking, {
					tool: HOST_REQUEST_TOOL,
					computerProjectId: bot.defaultProject,
				});
			};
			const assistant = await seedBot(a.workspace, {
				assistantOf: viewerId,
				visibility: "personal",
			});
			const personalBot = await seedBot(a.workspace, {
				createdById: viewerId,
				visibility: "personal",
			});

			const assistantsRequest = await requestIn(assistant);
			const personalBotsRequest = await requestIn(personalBot);
			expect(await decides(viewer, assistantsRequest)).toBe("ok");
			expect(await decides(viewer, personalBotsRequest)).toBe("ok");
			const askedOf = async (callId: string) =>
				(await onDatabase((db) => approvalAudience(db, [callId]))).map(({ memberId }) => memberId);
			expect(await askedOf(assistantsRequest)).toEqual([viewerId]);
			expect(await askedOf(personalBotsRequest)).toEqual([viewerId]);
			expect(
				await onDatabase((db) => approvalAudience(db, [personalBotsRequest], viewerId)),
			).toEqual([
				expect.objectContaining({
					memberId: viewerId,
					reachesChat: true,
					calls: [expect.objectContaining({ id: personalBotsRequest })],
				}),
			]);
			expect(
				await onDatabase((db) => approvalAudience(db, [personalBotsRequest], a.admin)),
			).toEqual([]);
		});

		it("lets admins and the run's bot's managers who reach its chat decide a run's call", async () => {
			const { a } = world;
			const { run, turnId } = await as.run(a.workspace, a.project, a.pub.id);
			const callId = await seedToolCall({ chat: run.chat, turn: turnId, bot: a.pub.id });
			expect(await decides(await as.member(a.admin), callId)).toBe("ok");
			expect(await decides(await as.member(a.ed), callId)).toBe("ok");
			expect(await decides(await as.member(a.quinn), callId)).toBe("ActionForbidden");
			expect(await decides(await as.member(a.erin), callId)).toBe("ResourceHidden");
		});

		it("uses the same bot and project standing for decisions, lists and notifications", async () => {
			const { a } = world;
			const privateBot = await seedBot(a.workspace, {
				createdById: a.quinn,
				visibility: "private",
				members: [a.quinn, a.ed],
			});
			await onDatabase((db) =>
				db.insert(projectBot).values({
					workspaceId: a.workspace,
					projectId: a.project,
					botId: privateBot.id,
				}),
			);
			const { run, turnId } = await as.run(a.workspace, a.project, privateBot.id);
			const runCall = await seedToolCall({ chat: run.chat, turn: turnId, bot: privateBot.id });
			const computerCall = await seedToolCall(
				{ chat: run.chat, turn: turnId, bot: privateBot.id },
				{ tool: HOST_REQUEST_TOOL, computerProjectId: privateBot.defaultProject },
			);
			const projectCall = await seedToolCall(
				{ chat: run.chat, turn: turnId, bot: privateBot.id },
				{ tool: HOST_REQUEST_TOOL, computerProjectId: a.project },
			);
			const cases = [
				{ call: runCall, expected: [a.quinn, a.admin, a.owner, a.otherAdmin] },
				{ call: computerCall, expected: [a.quinn, a.admin, a.owner, a.otherAdmin] },
				{ call: projectCall, expected: [a.admin, a.owner, a.otherAdmin] },
			];

			const expectApprovers = async (callId: string, expected: readonly string[]) => {
				const audience = await onDatabase((db) => approvalAudience(db, [callId]));
				expect(new Set(audience.map(({ memberId }) => memberId))).toEqual(new Set(expected));
				for (const member of [a.quinn, a.ed, a.vi, a.erin, a.admin, a.owner, a.otherAdmin]) {
					const shouldApprove = expected.includes(member);
					expect((await decides(await as.member(member), callId)) === "ok").toBe(shouldApprove);
					const listed = await onDatabase((db) =>
						Effect.gen(function* () {
							const standing = yield* approverStandingIn(db, a.workspace, member, (chat) =>
								reachesChatFor(chat, member),
							);
							const calls = db.select().from(toolCall).where(eq(toolCall.id, callId));
							return yield* db.execute(approvedCalls(standing, calls), "objects");
						}),
					);
					expect(listed).toHaveLength(shouldApprove ? 1 : 0);
				}
			};
			for (const { call, expected } of cases) await expectApprovers(call, expected);

			await onDatabase((db) =>
				db.update(project).set({ deleting: true }).where(eq(project.id, privateBot.defaultProject)),
			);
			await expectApprovers(runCall, [a.admin, a.owner, a.otherAdmin]);
			await expectApprovers(computerCall, []);
		});

		it("lets only its creator decide a Personal Assistant's call", async () => {
			const { a } = world;
			const assistant = await as.botFor(a.ed, a.assistant.id, a.assistantChat);
			const callId = await seedToolCall(assistant);
			expect(await decides(await as.member(a.ed), callId)).toBe("ok");
			expect(await decides(await as.member(a.owner), callId)).toBe("ResourceHidden");
		});

		it("lets a personal bot's creator decide its runs' calls even as a viewer, and nobody else", async () => {
			const { a } = world;
			const viewersBot = await seedBot(a.workspace, {
				createdById: a.viewerCreator,
				visibility: "personal",
			});
			const { run, turnId } = await as.run(
				a.workspace,
				viewersBot.defaultProject,
				viewersBot.id,
				"routine",
			);
			const callId = await seedToolCall({ chat: run.chat, turn: turnId, bot: viewersBot.id });
			expect(await decides(await as.member(a.viewerCreator), callId)).toBe("ok");
			expect(await decides(await as.member(a.admin), callId)).toBe("ResourceHidden");
		});
	});

	describe("Approved", () => {
		const never: ApprovalRule<OrdinaryApproval, "web.search"> = {
			operation: "web.search",
			tool: "create_issue",
			approval: { kind: "never" },
			changes: true,
			personalBotAsks: true,
		};
		const always: ApprovalRule<OrdinaryApproval, "web.search"> = {
			operation: "web.search",
			tool: "create_issue",
			approval: { kind: "always", approvers: "turn" },
			changes: true,
			personalBotAsks: true,
		};
		const approved = (
			principal: Principal,
			call: Call,
			rule: ApprovalRule<OrdinaryApproval, "web.search">,
			input: InputOf<"web.search">,
		) =>
			outcome(
				named(principal, call, input, "workspace", (p, x, input, workspace) =>
					proveApproved(p, x, rule, input, workspace).pipe(Effect.asVoid),
				),
			);
		const decidedBy = (
			principal: Principal,
			call: Call,
			rule: ApprovalRule<OrdinaryApproval, "web.search">,
			input: InputOf<"web.search">,
		) =>
			runOnPostgres(
				named(principal, call, input, "workspace", (p, x, input, workspace) =>
					proveApproved(p, x, rule, input, workspace).pipe(Effect.map((proof) => proof.decidedBy)),
				),
			);
		const toolCallOf = (id: string): Call => ({ kind: "toolCall", toolCall: id });
		const input = { query: "Ship it", count: 5 };
		const seedApprovalCall: typeof seedToolCall = (bot, fields) =>
			seedToolCall(bot, { input, ...fields });

		it("needs no approval for a member acting for themselves, or a call that needs none", async () => {
			const { a } = world;
			const request: Call = { kind: "request" };
			expect(await approved(await as.member(a.vi), request, always, input)).toBe("ok");
			expect(await approved(await as.botFor(a.ed, a.pub.id, a.chat), request, never, input)).toBe(
				"ok",
			);
		});

		it("refuses other non-bot principals", async () => {
			const { a } = world;
			const request: Call = { kind: "request" };
			const principals = [
				await as.webhook(a.workspace, a.project),
				await as.compaction(a.chat, a.pub.id),
				await as.page(a.chat, a.ed),
			];
			for (const principal of principals) {
				expect(await approved(principal, request, never, input)).toBe("ApprovalRefused");
			}
		});

		it("refuses approval when the input names a different chat from the target", async () => {
			const { a } = world;
			const member = await as.member(a.ed);
			const request: Call = { kind: "request" };
			const input = { chatId: a.chat, resolved: true };
			const approveFor = (target: string) =>
				outcome(
					named(member, request, input, target, (principal, call, input, chat) =>
						proveApproved(principal, call, approvalRule("chats.setResolved"), input, chat).pipe(
							Effect.asVoid,
						),
					),
				);

			expect(await approveFor(a.chat)).toBe("ok");
			expect(await approveFor(a.otherChat)).toBe("ApprovalRefused");
		});

		it("runs a call only with its recorded decision and the arguments allowed", async () => {
			const { a } = world;
			const edsBot = await as.botFor(a.ed, a.pub.id, a.chat);
			const pending = await seedApprovalCall(edsBot);
			const allowed = await seedApprovalCall(edsBot, { status: "allowed", decidedBy: a.ed });
			const denied = await seedApprovalCall(edsBot, { status: "denied", decidedBy: a.ed });
			const otherTool = await seedApprovalCall(edsBot, {
				status: "allowed",
				decidedBy: a.ed,
				tool: "other_tool",
			});

			expect(await approved(edsBot, { kind: "request" }, always, input)).toBe("ApprovalNeeded");
			expect(await approved(edsBot, toolCallOf(pending), always, input)).toBe("ApprovalNeeded");
			expect(
				await decidedBy(edsBot, toolCallOf(allowed), always, { count: 5, query: "Ship it" }),
			).toBe(a.ed);
			expect(
				await approved(edsBot, toolCallOf(allowed), always, { ...input, query: "Ship all of it" }),
			).toBe("ApprovalRefused");
			expect(await approved(edsBot, toolCallOf(denied), always, input)).toBe("ApprovalRefused");
			expect(await approved(edsBot, toolCallOf(otherTool), always, input)).toBe("ApprovalRefused");
			const other = await as.botFor(a.ed, a.pub.id, a.chat);
			expect(await approved(other, toolCallOf(allowed), always, input)).toBe("ApprovalNeeded");
		});

		it("takes the allowed arguments as the same whatever order their keys come in", async () => {
			const { a } = world;
			const edsBot = await as.botFor(a.ed, a.pub.id, a.chat);
			// Two keys a locale's collation ranks equal, which the database keeps in its own order.
			const combining = "á";
			const precomposed = "á";
			const allowed = await seedApprovalCall(edsBot, {
				status: "allowed",
				decidedBy: a.ed,
				input: { [precomposed]: 2, [combining]: 1 },
			});
			const asked = Object.fromEntries<unknown>([
				[combining, 1],
				[precomposed, 2],
			]) as InputOf<"web.search">;

			expect(await decidedBy(edsBot, toolCallOf(allowed), always, asked)).toBe(a.ed);
		});

		it("follows a connector tool's access as it stands: Allow runs, Ask waits, Off refuses", async () => {
			const { a } = world;
			const edsBot = await as.botFor(a.ed, a.pub.id, a.chat);
			const connectorId = await seedConnector(a.workspace, a.project, {
				tools: [
					{ name: "list", description: null, readOnly: true, destructive: null },
					{ name: "create", description: null, readOnly: false, destructive: null },
					{ name: "remove", description: null, readOnly: false, destructive: null },
				],
				toolAccess: { remove: "off" },
			});
			const [installed] = await onDatabase((db) =>
				db.select().from(connector).where(eq(connector.id, connectorId)),
			);
			if (!installed) throw new Error("No connector");
			const send = async (name: string, approvalStatus: ToolApprovalStatus | null) => {
				const tool = connectorToolKey(installed.handle, name);
				const callId = await seedApprovalCall(edsBot, { tool, input });
				await onDatabase((db) =>
					db
						.update(toolCall)
						.set({
							status: "running",
							approvalStatus,
							approvalConnectorAccess: approvalStatus === "allowed" ? "ask" : null,
							decidedById: approvalStatus === "allowed" ? a.ed : null,
							connectorId,
							connectorRevision: installed.configurationRevision,
							remoteToolName: name,
							sentInExecution: edsBot.executionNumber,
							writeOrDelete: name !== "list",
						})
						.where(eq(toolCall.id, callId)),
				);
				return outcome(
					named(
						edsBot,
						toolCallOf(callId),
						connectorId,
						edsBot.turn,
						{ connectorId, tool: name, arguments: input },
						(principal, call, connector, turn, input) =>
							Effect.gen(function* () {
								const use = yield* proveCanUseConnector(principal, connector, name);
								yield* proveConnectorApproved(principal, call, input, turn, use);
							}),
					),
				);
			};
			expect(await send("list", null)).toBe("ok");
			expect(await send("create", "pending")).toBe("ApprovalNeeded");
			expect(await send("remove", null)).toBe("ApprovalRefused");
			expect(await send("create", "allowed")).toBe("ok");
		});

		it("reads a connector tool's access as each call starts, not as it was when the call was recorded", async () => {
			const { a } = world;
			const edsBot = await as.botFor(a.ed, a.pub.id, a.chat);
			const connectorId = await seedConnector(a.workspace, a.project, {
				tools: [{ name: "list", description: null, readOnly: true, destructive: null }],
			});
			const [installed] = await onDatabase((db) =>
				db.select().from(connector).where(eq(connector.id, connectorId)),
			);
			if (!installed) throw new Error("No connector");
			const callId = await seedApprovalCall(edsBot, {
				tool: connectorToolKey(installed.handle, "list"),
				input,
			});
			await onDatabase((db) =>
				db
					.update(toolCall)
					.set({
						status: "running",
						approvalStatus: null,
						connectorId,
						connectorRevision: installed.configurationRevision,
						remoteToolName: "list",
						sentInExecution: edsBot.executionNumber,
						writeOrDelete: false,
					})
					.where(eq(toolCall.id, callId)),
			);
			const starts = async (access: "allow" | "ask" | "off") => {
				await onDatabase((db) =>
					db
						.update(connector)
						.set({ toolAccess: { list: access } })
						.where(eq(connector.id, connectorId)),
				);
				return outcome(
					named(
						edsBot,
						toolCallOf(callId),
						connectorId,
						edsBot.turn,
						{ connectorId, tool: "list", arguments: input },
						(principal, call, connector, turn, input) =>
							Effect.gen(function* () {
								const use = yield* proveCanUseConnector(principal, connector, "list");
								yield* proveConnectorApproved(principal, call, input, turn, use);
							}),
					),
				);
			};
			expect(await starts("allow")).toBe("ok");
			expect(await starts("ask")).toBe("ApprovalNeeded");
			expect(await starts("off")).toBe("ApprovalRefused");
		});

		it("searches only connector tools that are still available in the project", async () => {
			const { a } = world;
			const acting = await as.botFor(a.ed, a.pub.id, a.chat);
			const described = {
				name: "list_routes",
				readOnly: true,
				destructive: null,
				description: "List delivery routes",
			};
			const invoices = Array.from({ length: 100 }, (_, index) => ({
				...described,
				name: `view_invoice_${index}`,
				description: "View an invoice",
			}));
			const own = await seedConnector(a.workspace, a.pub.defaultProject, { tools: [described] });
			const local = await seedConnector(a.workspace, a.project, {
				tools: [described, ...invoices],
			});
			await seedProjectBotConnector(a.workspace, a.project, a.pub.id, own);
			const installed = await onDatabase((db) =>
				db
					.select()
					.from(connector)
					.where(inArray(connector.id, [own, local])),
			);
			const tools = Object.fromEntries(
				installed.flatMap((row) =>
					row.tools.map((description) =>
						offeredTool(
							{ ...row, connectorId: row.id },
							description,
							tool({
								description: description.description ?? "",
								inputSchema: jsonSchema({ type: "object" }),
							}),
						),
					),
				),
			);
			const calls = ConnectorCalls.from({
				forTurn: () =>
					Effect.succeed({
						tools,
						unavailable: [],
						signInExpired: [],
						instructions: {},
						addable: [],
						fromProjectAndBot: true,
						close: async () => {},
					}),
			});
			await runOnPostgres(
				calls.offer(
					acting,
					{ projectId: a.project, ownProjectId: a.pub.defaultProject },
					{
						files: { read: () => Effect.die("Search does not read files") },
						computer: undefined,
						computerSignsIn: false,
					},
				),
			);
			const search = (query: string) =>
				runOnPostgres(
					Effect.gen(function* () {
						const database = yield* Database;
						let reads = 0;
						const result = yield* searchTools.run(acting, { query }, { kind: "request" }).pipe(
							Effect.provideService(ConnectorCalls.Service, calls),
							Effect.provideService(Database, {
								...database,
								execute: (run) => {
									reads += 1;
									return database.execute(run);
								},
							}),
						);
						expect(reads).toBeLessThanOrEqual(10);
						return result;
					}),
				);
			const keyFor = (id: string, name = described.name) => {
				const row = installed.find((row) => row.id === id);
				if (!row) throw new Error("Expected an installed connector");
				return connectorToolKey(row.handle, name);
			};
			const ownTool = keyFor(own);
			const localTool = keyFor(local);
			expect(await search("list_routes")).toMatchObject({
				tools: expect.arrayContaining([
					expect.objectContaining({ tool: ownTool, inputSchema: { type: "object" } }),
					expect.objectContaining({ tool: localTool, inputSchema: { type: "object" } }),
				]),
			});

			await onDatabase((db) =>
				db.delete(projectBotConnector).where(eq(projectBotConnector.connectorId, own)),
			);
			expect(await search("list_routes")).toMatchObject({
				tools: [expect.objectContaining({ tool: localTool })],
			});
			expect(await search("zxqwvv")).toMatchObject({ catalog: expect.stringContaining(localTool) });
			expect(await search("zxqwvv")).toMatchObject({
				catalog: expect.not.stringContaining(ownTool),
			});

			await onDatabase((db) =>
				db
					.update(connector)
					.set({ toolAccess: { list_routes: "off" } })
					.where(eq(connector.id, local)),
			);
			expect(await search("list_routes")).toMatchObject({ tools: [] });
			expect(await search("view_invoice_0")).toMatchObject({
				tools: expect.arrayContaining([
					expect.objectContaining({ tool: keyFor(local, "view_invoice_0") }),
				]),
			});
			await onDatabase((db) =>
				db
					.update(connector)
					.set({ toolAccess: {}, configurationRevision: 99 })
					.where(eq(connector.id, local)),
			);
			expect(await search("list_routes")).toMatchObject({ tools: [] });
		});

		it("keeps a decision made before its approver was demoted", async () => {
			const { a } = world;
			const { principal, run, turnId } = await as.run(a.workspace, a.project, a.pub.id);
			const approver = await seedMember(a.workspace, "admin");
			const allowed = await seedApprovalCall(
				{ chat: run.chat, turn: turnId, bot: a.pub.id },
				{ status: "allowed", decidedBy: approver },
			);
			expect(await approved(principal, toolCallOf(allowed), always, input)).toBe("ok");
			await setRole(a.workspace, approver, "editor");
			expect(await approved(principal, toolCallOf(allowed), always, input)).toBe("ok");
		});

		it("lets a turn end while GitHub resolves an approval target", async () => {
			const { a } = world;
			const principal = await as.botFor(a.ed, a.pub.id, a.chat);
			const tool = "open_pull_request";
			const connectorId = await seedConnector(a.workspace, a.project, {
				toolAccess: { [tool]: "ask" },
				github: { appCredentialEncrypted: "unused" },
			});
			const input = { connectorId, tool, arguments: { repository: "acme/web" } };
			const lookupStarted = Promise.withResolvers<void>();
			const baseBranch = Promise.withResolvers<string>();
			const approval = runOnPostgres(
				named(
					principal,
					principal.turn,
					connectorId,
					{ kind: "approvalCheck" } as Call,
					input,
					(acting, turnId, connector, calling, input) =>
						Effect.gen(function* () {
							const running = yield* proveRunsTurn(acting, turnId);
							yield* proveConnectorCall(running, connector, calling, input, {
								revision: 1,
								described: { name: tool, readOnly: false, destructive: false },
								usesComputer: false,
								resolveApprovalTargets: () =>
									Effect.tryPromise({
										try: async () => {
											lookupStarted.resolve();
											return { gitHubBaseBranch: await baseBranch.promise };
										},
										catch: () => new ApprovalRefused(),
									}),
							});
						}),
				),
			);
			void approval.catch(() => {});
			try {
				await Promise.race([lookupStarted.promise, approval]);
				await onDatabase((db) =>
					db
						.update(turn)
						.set({ status: "done", finishedAt: new Date() })
						.where(sql`${turn.id} = (select id from ${turn}
							where ${turn.id} = ${principal.turn} for update nowait)`),
				);
			} finally {
				baseBranch.resolve("main");
				await approval.catch(() => {});
			}
			await expect(approval).rejects.toMatchObject({ _tag: "TurnEnded" });
		});

		it("binds a connector upload to the approved machine and checks the one actually opened", async () => {
			const workspaceId = await seedWorkspace();
			const asker = await seedMember(workspaceId, "editor");
			const bot = await seedBot(workspaceId, { createdById: asker, usesComputer: true });
			const projectId = bot.defaultProject;
			const record = await seedComputer(workspaceId, projectId);
			const [machine] = await onDatabase((db) =>
				db.select().from(computer).where(eq(computer.id, record)),
			);
			if (!machine) throw new Error("Missing computer");
			await onDatabase((db) =>
				db
					.update(computerProvider)
					.set({ enabled: true })
					.where(eq(computerProvider.id, machine.computerProviderId)),
			);
			const acting = await as.botFor(
				asker,
				bot.id,
				await seedProjectChat(workspaceId, projectId, asker),
			);
			const connectorId = await seedConnector(workspaceId, projectId, {
				toolAccess: { upload_file: "ask" },
			});
			const url = "https://mcp.linear.app/mcp";
			const [installed] = await onDatabase((db) =>
				db.update(connector).set({ url }).where(eq(connector.id, connectorId)).returning(),
			);
			if (!installed) throw new Error("Missing connector");

			const read: string[] = [];
			const uploaded: Uint8Array[] = [];
			const content = new Uint8Array([1, 2, 3]);
			const computers = await Effect.runPromise(
				Computers.Service.pipe(Effect.provide(inMemoryComputers().layer)),
			);
			const provider = computers.forAccess({
				provider: "opensandbox",
				baseUrl: "https://computers.example.com",
				image: "debian",
				apiKey: Redacted.make("unused"),
				size: { cpuCount: 1, memoryGiB: 1 },
				networkMode: "open",
			});
			const providerComputer = await Effect.runPromise(
				provider.create({
					workName: "uploads",
					labels: {},
					reach: { kind: "open", blockedHosts: [] },
				}),
			);
			let openedMachine = machine.providerComputerId;
			const side = {
				chatId: acting.chat,
				files: { read: () => Effect.die("Unexpected chat file read") },
				run: Effect.runPromise,
				computer: {
					place: { folder: "/workspace/chat", home: "/workspace/home", previousChatIds: [] },
					run: Effect.runPromise,
					open: async () => ({
						record,
						providerId: machine.computerProviderId,
						arrival: "running" as const,
						madeInStep: false,
						computer: {
							...providerComputer,
							id: openedMachine,
							readFile: (path: string, maxBytes: number) =>
								Effect.sync(() => {
									read.push(path);
									return { content: content.subarray(0, maxBytes), sizeBytes: content.byteLength };
								}),
						},
					}),
				},
				upload: {
					for: () => async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
						uploaded.push(init?.body as Uint8Array);
						return new Response(null, { status: 200 });
					},
				},
			};
			const tools = offerAugmentationTools(
				{
					connectorId,
					handle: installed.handle,
					kind: "mcp",
					url,
					auth: "header",
					headers: {},
					toolAccess: installed.toolAccess,
					configurationRevision: installed.configurationRevision,
					configurationUpdatedAt: installed.updatedAt,
				},
				[],
				side,
			);
			const calls = ConnectorCalls.from({
				forTurn: () =>
					Effect.succeed({
						tools,
						unavailable: [],
						signInExpired: [],
						instructions: {},
						addable: [],
						fromProjectAndBot: false,
						close: async () => {},
					}),
			});
			await runOnPostgres(
				calls.offer(
					acting,
					{ projectId, ownProjectId: projectId },
					{
						...side,
						computerSignsIn: false,
					},
				),
			);
			const args = {
				path: "report.txt",
				uploadUrl: "https://storage.googleapis.com/uploads.linear.app/example",
				headers: {},
			};
			const input = { connectorId, tool: "upload_file", arguments: args };
			const call = (call: Call) =>
				callTool
					.run(acting, input, call)
					.pipe(
						Effect.provideService(ConnectorCalls.Service, calls),
						Effect.provide(unimplemented(Turns.Records.Service, { markActed: () => Effect.void })),
					);
			const checked = await runOnPostgres(
				call({ kind: "approvalCheck" }).pipe(
					Effect.catchTag("ApprovalNeeded", (error) => Effect.succeed(error)),
				),
			);
			if (!(checked instanceof ApprovalCheckReached))
				throw new Error("Approval check did not reach approval");
			const approved = await seedApprovalCall(acting, {
				tool: connectorToolKey(installed.handle, input.tool),
				status: "allowed",
				decidedBy: asker,
				input: args,
			});
			await onDatabase((db) =>
				db
					.update(toolCall)
					.set({
						status: "running",
						approvalResolvedTargets: checked.details.resolvedTargets ?? null,
						approvalConnectorAccess: "ask",
						connectorId,
						connectorRevision: installed.configurationRevision,
						remoteToolName: input.tool,
						sentInExecution: acting.executionNumber,
						writeOrDelete: true,
					})
					.where(eq(toolCall.id, approved)),
			);

			expect(await runOnPostgres(call(toolCallOf(approved)))).toMatchObject({ status: "uploaded" });
			expect(uploaded).toEqual([content]);
			expect(read).toEqual(["/workspace/chat/report.txt", "/workspace/chat/report.txt"]);

			openedMachine = Computers.ComputerId("replacement");
			await expect(runOnPostgres(call(toolCallOf(approved)))).rejects.toMatchObject({
				_tag: "ApprovalNeeded",
			});
			expect(uploaded).toHaveLength(1);
			expect(read).toHaveLength(2);

			await onDatabase((db) =>
				db
					.update(computer)
					.set({ providerComputerId: openedMachine })
					.where(eq(computer.id, record)),
			);
			expect(await outcome(call(toolCallOf(approved)))).toBe("ApprovalNeeded");
		});

		it("takes an approval to work on a computer as covering only the machine it was on", async () => {
			const { a } = world;
			const computerBot = await seedBot(a.workspace, { createdById: a.ed, usesComputer: true });
			const project = await seedProject(a.workspace, {
				leadBotId: computerBot.id,
				members: [a.ed],
			});
			const computerId = await seedComputer(a.workspace, project);
			const edsBot = await as.botFor(
				a.ed,
				computerBot.id,
				await seedProjectChat(a.workspace, project, a.ed),
			);
			const rule = approvalRule("computers.runCommand");
			const command = { command: "make deploy", timeout_seconds: 60 };
			const approvedFor = (call: Call) =>
				named(edsBot, edsBot.chat, call, command, (principal, chat, call, input) =>
					Effect.gen(function* () {
						const canUse = yield* proveCanUseChatComputer(principal, chat);
						yield* proveComputerUseApproved(principal, call, rule, input, canUse);
					}),
				);
			const checked = await runOnPostgres(
				approvedFor({ kind: "approvalCheck" }).pipe(
					Effect.flip,
					Effect.map((reached) =>
						reached instanceof ApprovalCheckReached ? reached.details : undefined,
					),
				),
			);
			const allowed = await seedApprovalCall(edsBot, {
				tool: rule.tool,
				status: "allowed",
				decidedBy: a.ed,
				input: command,
			});
			await onDatabase((db) =>
				db
					.update(toolCall)
					.set({ approvalResolvedTargets: checked?.resolvedTargets ?? null })
					.where(eq(toolCall.id, allowed)),
			);
			expect(await outcome(approvedFor(toolCallOf(allowed)))).toBe("ok");

			// Its provider recovered it onto another machine, under the same record.
			await onDatabase((db) =>
				db
					.update(computer)
					.set({ providerComputerId: "another-machine" as Computers.ComputerId })
					.where(eq(computer.id, computerId)),
			);
			expect(await outcome(approvedFor(toolCallOf(allowed)))).toBe("ApprovalNeeded");
		});

		it("needs a fresh browser approval after a tab change or a reload at the same URL", async () => {
			const { a } = world;
			const computerBot = await seedBot(a.workspace, { createdById: a.ed, usesComputer: true });
			const project = await seedProject(a.workspace, {
				leadBotId: computerBot.id,
				members: [a.ed],
			});
			await seedComputer(a.workspace, project);
			const edsBot = await as.botFor(
				a.ed,
				computerBot.id,
				await seedProjectChat(a.workspace, project, a.ed),
			);
			const rule = approvalRule("computers.useBrowser");
			const input = { tool: "browser_click", arguments: { target: "Submit" } };
			let browserTab = "tab-1";
			let browserDocument = "document-1";
			const approvedFor = (call: Call) =>
				named(edsBot, edsBot.chat, call, input, (principal, chat, call, approvedInput) =>
					Effect.gen(function* () {
						const canUse = yield* proveCanUseChatComputer(principal, chat);
						yield* proveComputerUseApproved(
							principal,
							call,
							rule,
							approvedInput,
							canUse,
							Effect.sync(() => ({
								computer: canUse.computer,
								machine: canUse.machine,
								provider: canUse.provider,
								browserTab,
								browserDocument,
								browserUrl: "https://example.com/checkout",
							})),
						);
					}),
				);
			const checked = await runOnPostgres(
				approvedFor({ kind: "approvalCheck" }).pipe(
					Effect.flip,
					Effect.map((reached) =>
						reached instanceof ApprovalCheckReached ? reached.details : undefined,
					),
				),
			);
			const allowed = await seedApprovalCall(edsBot, {
				tool: input.tool,
				status: "allowed",
				decidedBy: a.ed,
				input: input.arguments,
			});
			await onDatabase((db) =>
				db
					.update(toolCall)
					.set({ approvalResolvedTargets: checked?.resolvedTargets ?? null })
					.where(eq(toolCall.id, allowed)),
			);
			expect(await outcome(approvedFor(toolCallOf(allowed)))).toBe("ok");

			browserTab = "tab-2";
			expect(await outcome(approvedFor(toolCallOf(allowed)))).toBe("ApprovalNeeded");

			browserTab = "tab-1";
			browserDocument = "document-2";
			expect(await outcome(approvedFor(toolCallOf(allowed)))).toBe("ApprovalNeeded");
		});

		it("requires a fresh approval after a provider change before a computer is made", async () => {
			const { a } = world;
			const computerBot = await seedBot(a.workspace, { usesComputer: true });
			const project = await seedProject(a.workspace, {
				leadBotId: computerBot.id,
				members: [a.ed],
			});
			const edsBot = await as.botFor(
				a.ed,
				computerBot.id,
				await seedProjectChat(a.workspace, project, a.ed),
			);
			const rule = approvalRule("computers.runCommand");
			const command = { command: "ls", timeout_seconds: 30 };
			const approvedFor = (call: Call) =>
				named(edsBot, edsBot.chat, call, command, (principal, chat, call, input) =>
					Effect.gen(function* () {
						const canUse = yield* proveCanUseChatComputer(principal, chat);
						yield* proveComputerUseApproved(principal, call, rule, input, canUse);
					}),
				);
			const provider = (enabled: boolean) =>
				onDatabase((db) =>
					db
						.insert(computerProvider)
						.values({
							workspaceId: a.workspace,
							enabled,
							settings: {
								builtIn: "opensandbox",
								serverUrl: "http://computers.test",
								image: "debian",
							},
						})
						.returning({ id: computerProvider.id }),
				);
			const [first] = await provider(true);
			const [second] = await provider(false);
			if (!first || !second) throw new Error("fixture");
			const checked = await runOnPostgres(approvedFor({ kind: "approvalCheck" }).pipe(Effect.flip));
			if (!(checked instanceof ApprovalCheckReached)) throw checked;
			const allowed = await seedApprovalCall(edsBot, {
				tool: rule.tool,
				status: "allowed",
				decidedBy: a.ed,
				input: command,
			});
			await onDatabase((db) =>
				db
					.update(toolCall)
					.set({ approvalResolvedTargets: checked.details.resolvedTargets })
					.where(eq(toolCall.id, allowed)),
			);
			expect(await outcome(approvedFor(toolCallOf(allowed)))).toBe("ok");

			await onDatabase((db) =>
				db
					.update(computerProvider)
					.set({ enabled: false })
					.where(eq(computerProvider.id, first.id)),
			);
			await onDatabase((db) =>
				db
					.update(computerProvider)
					.set({ enabled: true })
					.where(eq(computerProvider.id, second.id)),
			);

			expect(await outcome(approvedFor(toolCallOf(allowed)))).toBe("ApprovalNeeded");
		});

		it("makes a personal bot ask its creator before any change, and before every call of a run from outside", async () => {
			const { a } = world;
			const request: Call = { kind: "request" };
			const personalBots = [
				{ bot: a.assistant, chat: a.assistantChat },
				{ bot: a.personal, chat: a.personalChat },
			];
			for (const { bot, chat } of personalBots) {
				const personalBot = await as.botFor(a.ed, bot.id, chat);
				expect(await approved(personalBot, request, never, input)).toBe("ApprovalNeeded");
				expect(
					await approved(personalBot, request, { ...never, personalBotAsks: false }, input),
				).toBe("ok");
				const allowed = await seedApprovalCall(personalBot, { status: "allowed", decidedBy: a.ed });
				expect(await approved(personalBot, toolCallOf(allowed), never, input)).toBe("ok");

				const { principal: fromOutside } = await as.run(
					a.workspace,
					bot.defaultProject,
					bot.id,
					"webhook",
				);
				expect(
					await approved(fromOutside, request, { ...never, personalBotAsks: false }, input),
				).toBe("ApprovalNeeded");
			}
		});

		it("makes a personal bot ask its creator before it shares a file from its computer", async () => {
			const { a } = world;
			const personalBot = await as.botFor(a.ed, a.personal.id, a.personalChat);
			const facts = await runOnPostgres(query((db) => turnFacts(db, personalBot.turn)));
			if (!facts) throw new Error("fixture");
			expect(approvalNeed(facts, approvalRule("computers.shareFile"))).toBe("approver");
		});

		it("makes a turn a personal bot's brief started ask before any change, as the personal bot would", async () => {
			const { a } = world;
			const request: Call = { kind: "request" };
			const briefedBy = async (writerId: string) => {
				const briefed = await seedProjectChat(a.workspace, a.pub.defaultProject, a.ed);
				return as.turn(
					await seedTurnAnswering(briefed, a.pub.id, { bot: writerId }, { reason: "brief" }),
				);
			};
			expect(await approved(await briefedBy(a.personal.id), request, never, input)).toBe(
				"ApprovalNeeded",
			);
			expect(await approved(await briefedBy(a.helper.id), request, never, input)).toBe("ok");
		});
	});
});
