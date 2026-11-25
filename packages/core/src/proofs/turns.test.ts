import type { JsonValue, ToolApprovalStatus } from "@sugabots/contracts";
import { connectorToolKey, HOST_REQUEST_TOOL } from "@sugabots/contracts";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedConnector, seedMessage } from "../authentication/seed.test-support.ts";
import { connector, projectMember, toolCall, turn } from "../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../database/testing.ts";
import type { Call } from "../operations/operation.ts";
import type { BotForAsker, Principal } from "../principal.ts";
import { type ApprovalRule, type OrdinaryApproval, proveApproved } from "./approved.ts";
import { proveCanDecide } from "./can-decide.ts";
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

		it("lets a Personal Assistant's member steer its runs' turns, which act for them", async () => {
			const { a } = world;
			for (const startedBy of ["routine", "manual"] as const) {
				const { run, turnId, principal } = await as.run(
					a.workspace,
					a.assistant.defaultProject,
					a.assistant.id,
					startedBy,
				);
				expect(principal._tag).toBe("BotForAsker");
				expect(await steers(await as.member(a.ed), run.chat, turnId)).toBe("ok");
			}
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
		const runs = (principal: BotForAsker | Principal, chatId: string, turnId: string) =>
			outcome(
				named(principal, chatId, turnId, (p, c, t) =>
					proveReachesChat(p, c).pipe(
						Effect.flatMap((reach) => proveRunsTurn(reach, t)),
						Effect.asVoid,
					),
				),
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

		it("stops a turn whose asker lost the chat from running, but lets it end", async () => {
			const { a } = world;
			const quinnsBot = await as.botFor(a.quinn, a.pub.id, a.chat);
			await onDatabase((db) =>
				db
					.delete(projectMember)
					.where(and(eq(projectMember.projectId, a.project), eq(projectMember.memberId, a.quinn))),
			);
			expect(await runs(quinnsBot, a.chat, quinnsBot.turn)).toBe("ResourceHidden");
			expect(await ends(quinnsBot, quinnsBot.turn)).toBe("ok");
			await onDatabase((db) =>
				db
					.insert(projectMember)
					.values({ workspaceId: a.workspace, projectId: a.project, memberId: a.quinn }),
			);
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

		it("lets admins and the run's bot's managers who reach its chat decide a run's call", async () => {
			const { a } = world;
			const { run, turnId } = await as.run(a.workspace, a.project, a.pub.id);
			const callId = await seedToolCall({ chat: run.chat, turn: turnId, bot: a.pub.id });
			expect(await decides(await as.member(a.admin), callId)).toBe("ok");
			expect(await decides(await as.member(a.ed), callId)).toBe("ok");
			expect(await decides(await as.member(a.quinn), callId)).toBe("ActionForbidden");
			expect(await decides(await as.member(a.erin), callId)).toBe("ResourceHidden");
		});

		it("lets only its member decide a Personal Assistant's call", async () => {
			const { a } = world;
			const assistant = await as.botFor(a.ed, a.assistant.id, a.assistantChat);
			const callId = await seedToolCall(assistant);
			expect(await decides(await as.member(a.ed), callId)).toBe("ok");
			expect(await decides(await as.member(a.owner), callId)).toBe("ResourceHidden");
		});
	});

	describe("Approved", () => {
		const never: ApprovalRule<OrdinaryApproval> = {
			tool: "create_issue",
			approval: { kind: "never" },
			changes: true,
		};
		const always: ApprovalRule<OrdinaryApproval> = {
			tool: "create_issue",
			approval: { kind: "always", approvers: "turn" },
			changes: true,
		};
		const approved = (
			principal: Principal,
			call: Call,
			rule: ApprovalRule<OrdinaryApproval>,
			input: unknown,
		) =>
			outcome(
				named(principal, call, (p, x) => proveApproved(p, x, rule, input).pipe(Effect.asVoid)),
			);
		const decidedBy = (
			principal: Principal,
			call: Call,
			rule: ApprovalRule<OrdinaryApproval>,
			input: unknown,
		) =>
			runOnPostgres(
				named(principal, call, (p, x) =>
					proveApproved(p, x, rule, input).pipe(Effect.map((proof) => proof.decidedBy)),
				),
			);
		const toolCallOf = (id: string): Call => ({ kind: "toolCall", toolCall: id });
		const input = { title: "Ship it", labels: ["now"] };

		it("needs no approval for a member acting for themselves, or a call that needs none", async () => {
			const { a } = world;
			const request: Call = { kind: "request", request: "request-1" };
			expect(await approved(await as.member(a.vi), request, always, input)).toBe("ok");
			expect(await approved(await as.botFor(a.ed, a.pub.id, a.chat), request, never, input)).toBe(
				"ok",
			);
		});

		it("runs a call only once an approver still allows it, with the arguments they allowed", async () => {
			const { a } = world;
			const edsBot = await as.botFor(a.ed, a.pub.id, a.chat);
			const pending = await seedToolCall(edsBot);
			const allowed = await seedToolCall(edsBot, { status: "allowed", decidedBy: a.ed });
			const byOwner = await seedToolCall(edsBot, { status: "allowed", decidedBy: a.owner });
			const denied = await seedToolCall(edsBot, { status: "denied", decidedBy: a.ed });
			const otherTool = await seedToolCall(edsBot, {
				status: "allowed",
				decidedBy: a.ed,
				tool: "other_tool",
			});

			expect(await approved(edsBot, { kind: "request", request: "request-2" }, always, input)).toBe(
				"ApprovalNeeded",
			);
			expect(await approved(edsBot, toolCallOf(pending), always, input)).toBe("ApprovalNeeded");
			expect(
				await decidedBy(edsBot, toolCallOf(allowed), always, { labels: ["now"], title: "Ship it" }),
			).toBe(a.ed);
			expect(await approved(edsBot, toolCallOf(byOwner), always, input)).toBe("ApprovalNeeded");
			expect(
				await approved(edsBot, toolCallOf(allowed), always, { ...input, title: "Ship all of it" }),
			).toBe("ApprovalRefused");
			expect(await approved(edsBot, toolCallOf(denied), always, input)).toBe("ApprovalRefused");
			expect(await approved(edsBot, toolCallOf(otherTool), always, input)).toBe("ApprovalRefused");
			const other = await as.botFor(a.ed, a.pub.id, a.chat);
			expect(await approved(other, toolCallOf(allowed), always, input)).toBe("ApprovalNeeded");
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
				const callId = await seedToolCall(edsBot, { tool, input });
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
				const rule: ApprovalRule<OrdinaryApproval> = {
					tool,
					approval: { kind: "byToolAccess" },
					changes: true,
				};
				return outcome(
					named(edsBot, toolCallOf(callId), connectorId, (principal, call, connector) =>
						Effect.gen(function* () {
							const use = yield* proveCanUseConnector(principal, connector, name);
							yield* proveApproved(principal, call, rule, input, use);
						}),
					),
				);
			};
			expect(await send("list", null)).toBe("ok");
			expect(await send("create", "pending")).toBe("ApprovalNeeded");
			expect(await send("remove", null)).toBe("ApprovalRefused");
			expect(await send("create", "allowed")).toBe("ok");
		});

		it("makes a Personal Assistant ask its member before any change, and before every call of a run from outside", async () => {
			const { a } = world;
			const assistant = await as.botFor(a.ed, a.assistant.id, a.assistantChat);
			const request: Call = { kind: "request", request: "request-4" };
			expect(await approved(assistant, request, never, input)).toBe("ApprovalNeeded");
			expect(await approved(assistant, request, { ...never, changes: false }, input)).toBe("ok");
			const allowed = await seedToolCall(assistant, { status: "allowed", decidedBy: a.ed });
			expect(await approved(assistant, toolCallOf(allowed), never, input)).toBe("ok");

			const { principal: fromOutside } = await as.run(
				a.workspace,
				a.assistant.defaultProject,
				a.assistant.id,
				"webhook",
			);
			expect(await approved(fromOutside, request, { ...never, changes: false }, input)).toBe(
				"ApprovalNeeded",
			);
		});

		it("takes a run's call as approved only from an admin or a manager of its bot", async () => {
			const { a } = world;
			const { principal, run, turnId } = await as.run(a.workspace, a.project, a.pub.id);
			const byAdmin = await seedToolCall(
				{ chat: run.chat, turn: turnId, bot: a.pub.id },
				{ status: "allowed", decidedBy: a.admin },
			);
			const byQuinn = await seedToolCall(
				{ chat: run.chat, turn: turnId, bot: a.pub.id },
				{ status: "allowed", decidedBy: a.quinn },
			);
			expect(await approved(principal, toolCallOf(byAdmin), always, input)).toBe("ok");
			expect(await approved(principal, toolCallOf(byQuinn), always, input)).toBe("ApprovalNeeded");
		});
	});
});
