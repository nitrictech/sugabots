import { ToolApprovalConflict } from "@sugabots/contracts/errors/approvals";
import { ActionForbidden, ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { userText } from "@sugabots/errors";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer, ManagedRuntime } from "effect";
import { WorkflowEngine } from "effect/unstable/workflow";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommittedEvent } from "../../../database/events/outbox.ts";
import { bot, connector, member, membership, toolCall, turn } from "../../../database/schema.ts";
import {
	closeDatabase,
	onDatabase,
	onPostgres,
	type Promised,
	runOnPostgres,
} from "../../../database/testing.ts";
import { asMember } from "../../../operations/chats/testing.ts";
import { type CallOperation, servedOperations } from "../../../operations/testing.ts";
import { Lanes } from "../../../workflows/lanes.ts";
import { chatServicesForTests } from "../../testing.ts";
import { ApprovedToolCalls } from "../approvals/approved-calls.ts";
import { type PreparedTurn, replyTurnOf, TurnExecution } from "../execution.ts";
import { TurnSignals } from "../signals.ts";
import { type TurnCheckpoint, TurnStore } from "../store.ts";
import { aChatAwaitingReply, prepareRunnable, runningTurns } from "../testing.ts";
import {
	type SegmentOutcome,
	Turn,
	type TurnRequest,
	TurnSteps,
	turnWorkflow,
} from "../turn.workflow.ts";
import { Turns } from "../turns.ts";
import { type ApprovalBinding, type PendingToolApproval, ToolCallStore } from "./store.ts";

/**
 * Tool calls against Postgres: what `open` and `close` write, how the reply
 * reads them back where they were made, how an approval is parked, decided and
 * run, and what a turn ending early does to calls still running.
 */
describe.skipIf(!process.env.DATABASE_URL)("tool calls, against Postgres", async () => {
	let delivered: CommittedEvent[] = [];
	const bus = {
		publishCommitted: async (events: CommittedEvent[]) => {
			delivered.push(...events);
		},
	};
	const services = await chatServicesForTests(bus);
	const calls: Promised<ToolCallStore.Interface> = onPostgres(
		Context.get(services, ToolCallStore.Service),
	);
	const turns = onPostgres(Context.get(services, TurnStore.Service));
	const call = await servedOperations({ chats: services });
	/** `memberId`, signed in, deciding through the chat services `over`. */
	const approvalsAs = (memberId: string, over: CallOperation = call) => asMember(over, memberId);
	/** The operations over chat services whose turns' workflows hear decisions through `signals`. */
	const signalledBy = async (signals: TurnSignals.Interface) =>
		servedOperations({ chats: await chatServicesForTests(bus, signals) });
	const approvals = onPostgres({
		beginExecution: Context.get(services, ApprovedToolCalls.Service).beginExecution,
	});
	const detailsAs = (memberId: string) => asMember(call, memberId);
	const chatsAs = (memberId: string) => asMember(call, memberId);
	const execution = onPostgres({
		prepare: Context.get(services, TurnExecution.Service).prepare,
	});
	let workspaceId: string;
	let botId: string;
	let adminId: string;
	let chatId: string;
	let connectorId: string;
	let prepared: PreparedTurn;

	/** Records a member allowing the call, as the turn's workflow does once told. */
	const allow = (pending: PendingToolApproval) =>
		calls.recordDecision({
			chatId,
			approvalId: pending.approvalId,
			decision: { decision: "allow_once", memberId: adminId },
		});

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		({ workspaceId, botId, adminId, chatId, connectorId } = await aChatAwaitingReply(chatsAs));
		const [run] = await runOnPostgres(runningTurns(chatId));
		if (!run) throw new Error("no turn running");
		prepared = await prepareRunnable(execution, run);
		delivered = [];
	});

	const from = (atOffset: number) => ({
		chatId,
		messageId: prepared.responseMessage.id,
		turnId: prepared.turnId,
		tool: "web_fetch",
		input: { url: "https://example.com" },
		atOffset,
		writeOrDelete: false,
	});

	const checkpoint = (overrides: Partial<TurnCheckpoint> = {}): TurnCheckpoint => ({
		messages: [],
		approvals: [],
		modelInput: { model: "test", system: "test", messages: [] },
		reply: { content: "Waiting.", toolCalls: [] },
		modelRequests: 1,
		...overrides,
	});

	const pendingCall = (overrides: Partial<PendingToolApproval> = {}): PendingToolApproval => ({
		id: crypto.randomUUID(),
		approvalId: `approval-${crypto.randomUUID()}`,
		sdkToolCallId: "sdk-create-1",
		tool: "linear__create_issue",
		input: { title: "Fix mobile navigation" },
		binding: connectorBinding("create_issue"),
		writeOrDelete: true,
		atOffset: 0,
		...overrides,
	});

	const connectorBinding = (remoteToolName: string): ApprovalBinding => ({
		kind: "connector",
		connectorId,
		connectorRevision: 1,
		remoteToolName,
	});

	/** Parks `pending` as the turn's one approval. */
	const park = (pending: PendingToolApproval) =>
		turns.suspend(
			replyTurnOf(prepared),
			checkpoint({
				approvals: [
					{ approvalId: pending.approvalId, tool: pending.tool, binding: pending.binding },
				],
				reply: {
					content: "",
					toolCalls: [{ id: pending.id, atOffset: pending.atOffset }],
				},
			}),
			[pending],
		);

	/** Parks `pending`, allows it, and resumes the turn; returns the call as it would run. */
	async function allowAndResume(pending: PendingToolApproval) {
		await park(pending);
		await allow(pending);
		prepared = await prepareRunnable(execution, prepared.run);
		return {
			chatId,
			messageId: prepared.responseMessage.id,
			turnId: prepared.turnId,
			sdkToolCallId: pending.sdkToolCallId,
			tool: pending.tool,
			input: pending.input,
			atOffset: pending.atOffset,
			binding: pending.binding,
		};
	}

	it("opens a running call and closes it with its output", async () => {
		const opened = await calls.open(from(4));
		expect(opened).toMatchObject({
			type: "tool_call",
			tool: "web_fetch",
			input: { url: "https://example.com" },
			output: null,
			status: "running",
			error: null,
			atOffset: 4,
			finishedAt: null,
		});

		const closed = await calls.close(opened.id, { output: { title: "Example Domain" } });

		expect(closed).toMatchObject({
			id: opened.id,
			status: "completed",
			output: { title: "Example Domain" },
			error: null,
		});
		expect(closed?.finishedAt).not.toBeNull();
	});

	it("keeps the images a call showed the model counted, not their data", async () => {
		const opened = await calls.open(from(0));

		const closed = await calls.close(opened.id, {
			output: {
				text: "The image chart.png.",
				images: [{ data: "iVBORw0KGgo".repeat(10_000), mediaType: "image/png" }],
			},
		});

		expect(closed?.output).toEqual({ text: "The image chart.png.", images: "1 shown" });
	});

	it("closes a failed call with the error and no output", async () => {
		const opened = await calls.open(from(0));

		const closed = await calls.close(opened.id, { error: userText`Host did not resolve` });

		expect(closed).toMatchObject({ status: "failed", output: null, error: "Host did not resolve" });
	});

	it("composes the call into the reply's parts where it was made", async () => {
		const opened = await calls.open(from(7));
		await calls.close(opened.id, { output: { title: "Example Domain" } });
		await turns.saveReply(replyTurnOf(prepared), {
			content: "Looking now. Found it.",
			toolCalls: [{ id: opened.id, atOffset: 7 }],
		});

		const details = await detailsAs(adminId).get(chatId);
		const reply = details?.messages.find((message) => message.id === prepared.responseMessage.id);

		expect(reply?.parts).toEqual([
			{ type: "text", text: "Looking" },
			expect.objectContaining({ type: "tool_call", id: opened.id, status: "completed" }),
			{ type: "text", text: " now. Found it." },
		]);
	});

	it("parks an approval and, once it is allowed, starts it once, as it was approved", async () => {
		const execution = await allowAndResume(pendingCall({ atOffset: 7 }));
		const [allowed] = await onDatabase((db) =>
			db.select().from(toolCall).where(eq(toolCall.sdkToolCallId, "sdk-create-1")),
		);
		expect(allowed).toMatchObject({ approvalStatus: "allowed", decidedById: adminId });

		await expect(
			approvals.beginExecution({ ...execution, input: { title: "A different issue" } }),
		).rejects.toThrow("already claimed");
		const running = await approvals.beginExecution(execution);
		expect(running.status).toBe("running");
		await expect(approvals.beginExecution(execution)).rejects.toThrow("not approved for execution");
		await expect(
			approvals.beginExecution({ ...execution, sdkToolCallId: "sdk-create-never-parked" }),
		).rejects.toThrow("no approval record");
	});

	it("starts an allowed call to a built-in tool, which no connector's settings bind", async () => {
		const execution = await allowAndResume(
			pendingCall({
				sdkToolCallId: "sdk-built-in",
				tool: "request_host",
				input: { host: "api.example.com" },
				binding: { kind: "built-in" },
			}),
		);
		await onDatabase((db) =>
			db
				.update(connector)
				.set({ toolAccess: { create_issue: "off" } })
				.where(eq(connector.id, connectorId)),
		);

		const running = await approvals.beginExecution(execution);

		expect(running.status).toBe("running");
	});

	it("refuses an allowed call after the reviewed connector configuration changes", async () => {
		const execution = await allowAndResume(pendingCall({ sdkToolCallId: "sdk-revision" }));
		await onDatabase((db) =>
			db.update(connector).set({ configurationRevision: 2 }).where(eq(connector.id, connectorId)),
		);

		await expect(approvals.beginExecution(execution)).rejects.toThrow("configuration changed");
	});

	it("refuses an allowed call to a tool somebody turned off after it was allowed", async () => {
		const execution = await allowAndResume(pendingCall({ sdkToolCallId: "sdk-turned-off" }));
		await onDatabase((db) =>
			db
				.update(connector)
				.set({ toolAccess: { create_issue: "off" } })
				.where(eq(connector.id, connectorId)),
		);

		await expect(approvals.beginExecution(execution)).rejects.toThrow("turned off");
	});

	it("conceals a pending approval from somebody who cannot reach the bot", async () => {
		const pending = pendingCall({ sdkToolCallId: "sdk-stranger" });
		await park(pending);
		// A personal bot, which only its creator reaches.
		await onDatabase((db) =>
			db.update(bot).set({ visibility: "personal" }).where(eq(bot.id, botId)),
		);
		const [stranger] = await onDatabase((db) =>
			db
				.insert(member)
				.values({ name: "Kim", email: `stranger-${crypto.randomUUID()}@example.com` })
				.returning(),
		);
		if (!stranger) throw new Error("fixture");
		await onDatabase((db) =>
			db.insert(membership).values({ workspaceId, memberId: stranger.id, role: "editor" }),
		);

		await expect(
			approvalsAs(stranger.id).decide({ toolCallId: pending.id, decision: "allow_once" }),
		).rejects.toBeInstanceOf(ResourceHidden);
	});

	it("refuses a decision to somebody who reaches the bot but may not decide", async () => {
		const pending = pendingCall({ sdkToolCallId: "sdk-viewer" });
		await park(pending);
		const [viewer] = await onDatabase((db) =>
			db
				.insert(member)
				.values({ name: "Lee", email: `viewer-${crypto.randomUUID()}@example.com` })
				.returning(),
		);
		if (!viewer) throw new Error("fixture");
		await onDatabase((db) =>
			db.insert(membership).values({ workspaceId, memberId: viewer.id, role: "viewer" }),
		);

		await expect(
			approvalsAs(viewer.id).decide({ toolCallId: pending.id, decision: "allow_once" }),
		).rejects.toBeInstanceOf(ActionForbidden);
		const [undecided] = await onDatabase((db) =>
			db.select().from(toolCall).where(eq(toolCall.id, pending.id)),
		);
		expect(undecided).toMatchObject({ approvalStatus: "pending", decidedById: null });
	});

	it("fails calls still running when their turn is cancelled, and keeps them failed", async () => {
		const opened = await calls.open(from(0));

		await turns.cancel(replyTurnOf(prepared), { content: "", toolCalls: [] });

		const [row] = await onDatabase((db) =>
			db.select().from(toolCall).where(eq(toolCall.id, opened.id)),
		);
		expect(row).toMatchObject({ status: "failed", error: "Turn cancelled" });
		expect(row?.finishedAt).not.toBeNull();
		expect(delivered.map(({ event }) => event)).toContainEqual(
			expect.objectContaining({
				type: "tool_call.completed",
				toolCall: expect.objectContaining({ id: opened.id, status: "failed" }),
			}),
		);
		expect(await calls.close(opened.id, { output: { late: true } })).toBeUndefined();
		const [stillFailed] = await onDatabase((db) =>
			db.select().from(toolCall).where(eq(toolCall.id, opened.id)),
		);
		expect(stillFailed).toMatchObject({ status: "failed", error: "Turn cancelled" });
	});

	it("forgets the last run's calls when a turn runs again", async () => {
		const opened = await calls.open(from(0));
		await turns.fail(
			replyTurnOf(prepared),
			{ content: "", toolCalls: [] },
			{ userMessage: userText`provider down`, mayRunAgain: true },
		);

		await prepareRunnable(execution, prepared.run);

		const rows = await onDatabase((db) =>
			db.select().from(toolCall).where(eq(toolCall.id, opened.id)),
		);
		expect(rows).toEqual([]);
	});

	describe("when a workflow owns the turn", () => {
		const segment = vi.fn((_turn: TurnRequest) =>
			Effect.succeed<SegmentOutcome>({ _tag: "Finished" }),
		);
		const cancelWaiting = vi.fn((stored: TurnRequest) =>
			Effect.promise(() => turns.cancelWaiting(stored)),
		);
		// Recording cancellations is real; the segments are not.
		const steps = TurnSteps.of({
			segment,
			cancelWaiting,
			abandon: () => Effect.void,
			announceReleased: () => Effect.void,
		});
		const workflows = ManagedRuntime.make(
			turnWorkflow.layer.pipe(
				Layer.provideMerge(Layer.succeed(TurnSteps, steps)),
				Layer.provideMerge(
					Layer.succeed(
						Lanes.Service,
						Lanes.Service.of({
							admit: () => Effect.die("unused"),
							release: () => Effect.void,
							dropWaiting: () => Effect.die("unused"),
							reconcile: Effect.void,
						}),
					),
				),
				Layer.provideMerge(WorkflowEngine.layerMemory),
			),
		);
		afterAll(() => workflows.dispose());

		/** Runs the turn's workflow to its first segment, which parks `pending` for approval. */
		async function parkInWorkflow(pending: PendingToolApproval) {
			segment.mockClear();
			segment.mockReturnValueOnce(
				Effect.succeed({ _tag: "Suspended", approvals: [pending.approvalId] }),
			);
			const executionId = await workflows.runPromise(
				Turn.execute(prepared.run.request, { discard: true }),
			);
			await vi.waitFor(() => expect(segment).toHaveBeenCalledTimes(1));
			await onDatabase((db) =>
				db.update(turn).set({ executionId }).where(eq(turn.id, prepared.turnId)),
			);
			await park(pending);
			return workflows.runPromise(TurnSignals.make);
		}

		const workflowCall = () =>
			pendingCall({ sdkToolCallId: "sdk-workflow", input: { title: "Workflow" } });

		it("records a decision and sends it to the workflow, which runs on", async () => {
			const pending = workflowCall();
			const signals = await parkInWorkflow(pending);

			await approvalsAs(adminId, await signalledBy(signals)).decide({
				toolCallId: pending.id,
				decision: "allow_once",
			});

			await vi.waitFor(() => expect(segment).toHaveBeenCalledTimes(2));
			const [decided] = await onDatabase((db) =>
				db.select().from(toolCall).where(eq(toolCall.id, pending.id)),
			);
			expect(decided).toMatchObject({ approvalStatus: "allowed", decidedById: adminId });
		});

		it("leaves a call to the member its turn acts for, not another administrator", async () => {
			const pending = workflowCall();
			const signals = await parkInWorkflow(pending);
			const [administrator] = await onDatabase((db) =>
				db
					.insert(member)
					.values({ name: "Ada", email: `admin-${crypto.randomUUID()}@example.com` })
					.returning(),
			);
			if (!administrator) throw new Error("fixture");
			await onDatabase((db) =>
				db.insert(membership).values({ workspaceId, memberId: administrator.id, role: "admin" }),
			);

			await expect(
				approvalsAs(administrator.id, await signalledBy(signals)).decide({
					toolCallId: pending.id,
					decision: "allow_once",
				}),
			).rejects.toBeInstanceOf(ActionForbidden);
			const [undecided] = await onDatabase((db) =>
				db.select().from(toolCall).where(eq(toolCall.id, pending.id)),
			);
			expect(undecided).toMatchObject({ approvalStatus: "pending", decidedById: null });
		});

		it("tells a second member the approval is already decided", async () => {
			const pending = workflowCall();
			const signals = await parkInWorkflow(pending);
			const deciding = approvalsAs(adminId, await signalledBy(signals));
			const decide = (decision: "allow_once" | "deny") =>
				deciding.decide({ toolCallId: pending.id, decision });

			await decide("allow_once");

			await expect(decide("deny")).rejects.toBeInstanceOf(ToolApprovalConflict);
		});

		it("tells the chat's watchers of a decision before the workflow hears it", async () => {
			const pending = workflowCall();
			const signals = await parkInWorkflow(pending);
			const unheard = TurnSignals.Service.of({ ...signals, decide: () => Effect.void });
			delivered = [];

			await approvalsAs(adminId, await signalledBy(unheard)).decide({
				toolCallId: pending.id,
				decision: "allow_once",
			});

			expect(delivered.map(({ event }) => event)).toContainEqual(
				expect.objectContaining({
					type: "tool_call.updated",
					toolCall: expect.objectContaining({
						id: pending.id,
						approval: expect.objectContaining({ status: "allowed" }),
					}),
				}),
			);
			expect(segment).toHaveBeenCalledTimes(1);
		});

		it("sends a cancel again when the first never reached the workflow", async () => {
			const signals = await parkInWorkflow(workflowCall());
			cancelWaiting.mockClear();
			// Cancelled as its automation run ended and committed, but the process
			// stopped before the signal left.
			await onDatabase((db) =>
				db
					.update(turn)
					.set({ status: "cancelled", interruptRequested: true })
					.where(eq(turn.id, prepared.turnId)),
			);

			await runOnPostgres(
				Turns.resendLostCancels.pipe(Effect.provideService(TurnSignals.Service, signals)),
			);

			// The workflow heard it and stopped waiting.
			await vi.waitFor(() => expect(cancelWaiting).toHaveBeenCalledTimes(1));
			expect(segment).toHaveBeenCalledTimes(1);
		});
	});
});
