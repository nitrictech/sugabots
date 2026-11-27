import type { JsonValue, ToolApprovalStatus } from "@sugabots/contracts";
import { connectorToolKey, HOST_REQUEST_TOOL } from "@sugabots/contracts";
import type { InputOf } from "@sugabots/contracts/operations";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	seedBot,
	seedComputer,
	seedConnector,
	seedMember,
	seedMessage,
	seedProject,
	seedProjectChat,
	seedTurnAnswering,
	setRole,
} from "../authentication/seed.test-support.ts";
import { turnFacts } from "../authentication/turn-facts.ts";
import type { Computers } from "../computers/computers.ts";
import { query } from "../database/database.ts";
import {
	computer,
	computerProvider,
	connector,
	projectMember,
	toolCall,
	turn,
} from "../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../database/testing.ts";
import { ApprovalCheckReached, type Call } from "../operations/operation.ts";
import type { Principal } from "../principal.ts";
import {
	type ApprovalRule,
	approvalNeed,
	approvalRule,
	type OrdinaryApproval,
	proveApproved,
	proveComputerUseApproved,
	proveConnectorApproved,
} from "./approved.ts";
import { approvalAudience } from "./approvers.ts";
import { proveCanDecide } from "./can-decide.ts";
import { proveCanUseChatComputer } from "./can-use-computer.ts";
import { proveCanUseConnector } from "./can-use-connector.ts";
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
