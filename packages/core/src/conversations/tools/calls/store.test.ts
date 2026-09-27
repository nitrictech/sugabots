import { handleFromName } from "@sugabots/contracts";
import { eq } from "drizzle-orm";
import { Effect, Layer, ManagedRuntime } from "effect";
import { WorkflowEngine } from "effect/unstable/workflow";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../../../database/events/bus.ts";
import { eventPublisher } from "../../../database/events/publish.ts";
import { memoryEventStore } from "../../../database/events/store.ts";
import {
	agent,
	connection,
	pod,
	podMember,
	toolCall,
	turn,
	user,
	workspace,
	workspaceMember,
} from "../../../database/schema.ts";
import {
	closeDatabase,
	onDatabase,
	onPostgres,
	type Promised,
	runOnPostgres,
} from "../../../database/testing.ts";
import { Lanes } from "../../../workflows/lanes.ts";
import { chatStore } from "../../chats/store.ts";
import { threadStore } from "../../threads/store.ts";
import { turnSignals } from "../../turns/signals.ts";
import {
	MAX_TURN_RUNS,
	type PreparedTurn,
	runsAgainAfterFailure,
	type TurnCheckpoint,
	turnStore,
} from "../../turns/store.ts";
import {
	queueFacilitationForTests,
	queueTurnForTests,
	runningTurns,
	turnSignalsForTests,
} from "../../turns/testing.ts";
import {
	type SegmentOutcome,
	Turn,
	type TurnRequest,
	TurnSteps,
	turnWorkflow,
} from "../../turns/turn.workflow.ts";
import {
	type PendingToolApproval,
	ToolApprovalConflict,
	ToolApprovalNotFound,
	type ToolApprovalStore,
	toolApprovalStore,
} from "../approvals/store.ts";
import {
	boundedJson,
	MAX_STORED_JSON_CHARACTERS,
	type ToolCallStore,
	toolCallStore,
} from "./store.ts";

/**
 * Tool calls against Postgres: what `open` and `close` write, how the reply
 * reads them back where they were made, and what a turn ending early does to
 * calls still running.
 */
describe.skipIf(!process.env.DATABASE_URL)("tool calls, against Postgres", () => {
	const publishEvents = eventPublisher(createEventBus({ store: memoryEventStore() }));
	const calls: Promised<ToolCallStore> = onPostgres(toolCallStore(publishEvents));
	const approvals: Promised<ToolApprovalStore> = onPostgres(
		toolApprovalStore(publishEvents, turnSignalsForTests),
	);
	const threads = onPostgres(threadStore());
	const chats = onPostgres(chatStore(publishEvents, queueTurnForTests, queueFacilitationForTests));
	const store = turnStore(
		publishEvents,
		queueTurnForTests,
		queueFacilitationForTests,
		turnSignalsForTests,
	);
	const turns = onPostgres(store);
	let workspaceId: string;
	let podId: string;
	let memberId: string;
	let hostId: string;
	let threadId: string;
	let connectionId: string;
	let prepared: PreparedTurn;

	/** Records a person allowing the call, as the turn's workflow does once told. */
	const allow = (pending: PendingToolApproval) =>
		approvals.record({
			threadId,
			approvalId: pending.approvalId,
			decision: { decision: "allow_once", userId: memberId },
		});

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: `Tool calls ${suffix}`, slug: `tool-calls-${suffix}` })
				.returning(),
		);
		const [member] = await onDatabase((db) =>
			db
				.insert(user)
				.values({ name: "Sam", email: `tool-calls-${suffix}@example.com` })
				.returning(),
		);
		if (!space || !member) throw new Error("fixture");
		workspaceId = space.id;
		memberId = member.id;
		// An admin, because granting a standing approval in a shared pod is
		// administration; the ordinary-approval path is covered by the route tests.
		await onDatabase((db) =>
			db.insert(workspaceMember).values({ workspaceId, userId: memberId, role: "admin" }),
		);
		const [room] = await onDatabase((db) =>
			db
				.insert(pod)
				.values({
					workspaceId,
					kind: "shared",
					name: "Room",
					slug: `room-${suffix}`,
					createdById: memberId,
				})
				.returning(),
		);
		if (!room) throw new Error("fixture");
		podId = room.id;
		await onDatabase((db) => db.insert(podMember).values({ workspaceId, podId, userId: memberId }));
		const [host] = await onDatabase((db) =>
			db
				.insert(agent)
				.values({
					workspaceId,
					podId,
					name: `Host ${suffix}`,
					handle: handleFromName(`Host ${suffix}`),
					color: "rose",
					face: "pill",
					model: "m",
					createdById: memberId,
				})
				.returning({ id: agent.id }),
		);
		if (!host) throw new Error("fixture");
		hostId = host.id;
		const [connected] = await onDatabase((db) =>
			db
				.insert(connection)
				.values({
					workspaceId,
					podId,
					name: `Linear ${suffix}`,
					handle: `linear-${suffix}`,
					url: "https://linear.example.com/mcp",
					authKind: "header",
					access: "allow",
					createdById: memberId,
				})
				.returning({ id: connection.id }),
		);
		if (!connected) throw new Error("fixture");
		connectionId = connected.id;
		const opened = await chats.getOrCreate({
			workspaceId,
			podId,
			hostAgentId: hostId,
			userId: memberId,
		});
		await chats.sendMain({
			chatId: opened.id,
			author: { id: memberId, name: "Sam", image: null },
			messageId: crypto.randomUUID(),
			content: "What does example.com say?",
		});
		threadId = opened.mainThreadId;
		prepared = await openReply();
	});

	/** Prepares the turn running for the thread's host, so a reply message exists. */
	async function openReply(): Promise<PreparedTurn> {
		const [claim] = await runOnPostgres(runningTurns(threadId));
		if (!claim) throw new Error("no turn running");
		return turns.prepare(claim);
	}

	const from = (atOffset: number) => ({
		threadId,
		messageId: prepared.responseMessage.id,
		turnId: prepared.turnId,
		tool: "web_fetch",
		input: { url: "https://example.com" },
		atOffset,
	});

	const checkpoint = (overrides: Partial<TurnCheckpoint> = {}): TurnCheckpoint => ({
		messages: [],
		approvals: [],
		modelInput: { model: "test", system: "test", messages: [] },
		reply: { content: "Waiting.", collaborations: [], toolCalls: [] },
		accounting: { usage: {} },
		...overrides,
	});

	it("opens a running call and closes it with its output", async () => {
		const opened = await calls.open(from(4));
		expect(opened).toMatchObject({
			type: "tool_call",
			tool: "web_fetch",
			input: { url: "https://example.com" },
			output: null,
			status: "running",
			error: null,
			mutating: false,
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

	it("parks an approval and, once it is allowed, claims its execution once", async () => {
		const pending = {
			id: crypto.randomUUID(),
			approvalId: `approval-${crypto.randomUUID()}`,
			sdkToolCallId: "sdk-create-1",
			tool: "linear__create_issue",
			input: { title: "Fix mobile navigation" },
			connectionId,
			connectionRevision: 1,
			remoteToolName: "create_issue",
			mutating: true,
			atOffset: 7,
		};
		await turns.suspend(
			prepared,
			{
				messages: [],
				approvals: [
					{
						approvalId: pending.approvalId,
						tool: pending.tool,
						connectionId,
						connectionRevision: 1,
						remoteToolName: pending.remoteToolName,
					},
				],
				modelInput: { model: "test", system: "test", messages: [] },
				reply: {
					content: "I can do that.",
					collaborations: [],
					toolCalls: [{ id: pending.id, atOffset: 7 }],
				},
				accounting: { usage: { modelCalls: 1 } },
			},
			[pending],
		);
		await allow(pending);
		const [allowedCall] = await onDatabase((db) =>
			db.select().from(toolCall).where(eq(toolCall.id, pending.id)),
		);
		expect(allowedCall).toMatchObject({ approvalStatus: "allowed", decidedById: memberId });
		prepared = await turns.prepare(prepared.claim);

		const execution = {
			threadId,
			messageId: prepared.responseMessage.id,
			turnId: prepared.turnId,
			sdkToolCallId: "sdk-create-1",
			tool: "linear__create_issue",
			input: { title: "Fix mobile navigation" },
			atOffset: 7,
			connectionId,
			connectionRevision: 1,
			remoteToolName: "create_issue",
		};
		await expect(
			approvals.beginExecution({ ...execution, input: { title: "A different issue" } }),
		).rejects.toThrow("already claimed");
		const running = await approvals.beginExecution(execution);
		expect(running.status).toBe("running");
		await expect(
			approvals.beginExecution({
				threadId,
				messageId: prepared.responseMessage.id,
				turnId: prepared.turnId,
				sdkToolCallId: "sdk-create-1",
				tool: "linear__create_issue",
				input: { title: "Fix mobile navigation" },
				atOffset: 7,
				connectionId,
				connectionRevision: 1,
				remoteToolName: "create_issue",
			}),
		).rejects.toThrow("not approved for execution");
		await expect(
			approvals.beginExecution({ ...execution, sdkToolCallId: "sdk-create-never-parked" }),
		).rejects.toThrow("no approval record");
	});

	/** Parks `pending` as the turn's one approval, allows it, and resumes the turn. */
	async function allowAndResume(pending: PendingToolApproval) {
		await turns.suspend(
			prepared,
			checkpoint({
				approvals: [
					{
						approvalId: pending.approvalId,
						tool: pending.tool,
						connectionId,
						connectionRevision: 1,
						remoteToolName: pending.remoteToolName,
					},
				],
				reply: { content: "", collaborations: [], toolCalls: [{ id: pending.id, atOffset: 0 }] },
			}),
			[pending],
		);
		await allow(pending);
		prepared = await turns.prepare(prepared.claim);
		return {
			threadId,
			messageId: prepared.responseMessage.id,
			turnId: prepared.turnId,
			sdkToolCallId: pending.sdkToolCallId,
			tool: pending.tool,
			input: pending.input,
			atOffset: 0,
			connectionId,
			connectionRevision: 1,
			remoteToolName: pending.remoteToolName,
		};
	}

	describe("when a workflow owns the turn", () => {
		const segment = vi.fn((_request: TurnRequest) =>
			Effect.succeed<SegmentOutcome>({ _tag: "Finished" }),
		);
		// Recording decisions and cancellations is real; the segments are not.
		const recorder = onPostgres(toolApprovalStore(publishEvents, turnSignalsForTests));
		const steps = TurnSteps.of({
			segment,
			decide: (request, decided) =>
				Effect.promise(() => recorder.record({ threadId: request.threadId, ...decided })),
			stopWaiting: (request) => Effect.promise(() => turns.stopWaiting(request)),
			abandon: () => Effect.void,
			settleRoutine: () => Effect.void,
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
				Turn.execute(
					{
						threadId,
						agentId: prepared.claim.payload.agentId,
						triggerMessageId: prepared.claim.payload.triggerMessageId,
						reason: "mention",
					},
					{ discard: true },
				),
			);
			await vi.waitFor(() => expect(segment).toHaveBeenCalledTimes(1));
			await onDatabase((db) =>
				db.update(turn).set({ owner: executionId }).where(eq(turn.id, prepared.turnId)),
			);
			await turns.suspend(
				prepared,
				checkpoint({
					approvals: [
						{
							approvalId: pending.approvalId,
							tool: pending.tool,
							connectionId,
							connectionRevision: 1,
							remoteToolName: pending.remoteToolName,
						},
					],
				}),
				[pending],
			);
			const engine = await workflows.runPromise(Effect.service(WorkflowEngine.WorkflowEngine));
			return turnSignals(engine);
		}

		const pendingCall = (): PendingToolApproval => ({
			id: crypto.randomUUID(),
			approvalId: `approval-${crypto.randomUUID()}`,
			sdkToolCallId: "sdk-workflow",
			tool: "linear__create_issue",
			input: { title: "Workflow" },
			connectionId,
			connectionRevision: 1,
			remoteToolName: "create_issue",
			mutating: true,
			atOffset: 0,
		});

		it("sends a decision to the workflow, which records it and runs on", async () => {
			const pending = pendingCall();
			const signals = await parkInWorkflow(pending);

			await onPostgres(toolApprovalStore(publishEvents, signals)).decide({
				workspaceId,
				podId,
				toolCallId: pending.id,
				userId: memberId,
				decision: "allow_once",
			});

			await vi.waitFor(() => expect(segment).toHaveBeenCalledTimes(2));
			const [decided] = await onDatabase((db) =>
				db.select().from(toolCall).where(eq(toolCall.id, pending.id)),
			);
			expect(decided).toMatchObject({ approvalStatus: "allowed", decidedById: memberId });
		});

		it("tells a second person the approval is already decided", async () => {
			const pending = pendingCall();
			const signals = await parkInWorkflow(pending);
			const deciding = onPostgres(toolApprovalStore(publishEvents, signals));
			const decide = (decision: "allow_once" | "deny") =>
				deciding.decide({ workspaceId, podId, toolCallId: pending.id, userId: memberId, decision });

			await decide("allow_once");

			await expect(decide("deny")).rejects.toBeInstanceOf(ToolApprovalConflict);
		});

		it("sends a cancel to the workflow, which records it and ends", async () => {
			const signals = await parkInWorkflow(pendingCall());

			expect(
				await onPostgres(
					turnStore(publishEvents, queueTurnForTests, queueFacilitationForTests, signals),
				).requestCancel(prepared.turnId, memberId),
			).toBe(true);

			// Marked at once, so a segment starting as the signal lands stops too.
			const [marked] = await onDatabase((db) =>
				db.select().from(turn).where(eq(turn.id, prepared.turnId)),
			);
			expect(marked?.cancelRequested).toBe(true);
			await vi.waitFor(async () => {
				const [cancelled] = await onDatabase((db) =>
					db.select().from(turn).where(eq(turn.id, prepared.turnId)),
				);
				expect(cancelled?.status).toBe("cancelled");
			});
			expect(segment).toHaveBeenCalledTimes(1);
		});
	});

	it("refuses an allowed call once its connection is turned off", async () => {
		const execution = await allowAndResume({
			id: crypto.randomUUID(),
			approvalId: `approval-${crypto.randomUUID()}`,
			sdkToolCallId: "sdk-turned-off",
			tool: "linear__create_issue",
			input: { title: "Switched off meanwhile" },
			connectionId,
			connectionRevision: 1,
			remoteToolName: "create_issue",
			mutating: true,
			atOffset: 0,
		});
		await onDatabase((db) =>
			db.update(connection).set({ access: "off" }).where(eq(connection.id, connectionId)),
		);

		await expect(approvals.beginExecution(execution)).rejects.toThrow("configuration changed");
	});

	it("runs an allowed read from a connection that asks, without counting it as a change", async () => {
		await onDatabase((db) =>
			db.update(connection).set({ access: "ask" }).where(eq(connection.id, connectionId)),
		);
		const execution = await allowAndResume({
			id: crypto.randomUUID(),
			approvalId: `approval-${crypto.randomUUID()}`,
			sdkToolCallId: "sdk-read",
			tool: "linear__list_issues",
			input: {},
			connectionId,
			connectionRevision: 1,
			remoteToolName: "list_issues",
			mutating: false,
			atOffset: 0,
		});

		const running = await approvals.beginExecution(execution);

		expect(running.status).toBe("running");
		const [resumed] = await onDatabase((db) =>
			db
				.select({ mutationStarted: turn.mutationStarted })
				.from(turn)
				.where(eq(turn.id, prepared.turnId)),
		);
		expect(resumed?.mutationStarted).toBe(false);
	});

	it("conceals a pending approval from somebody who cannot reach the pod", async () => {
		const pending = {
			id: crypto.randomUUID(),
			approvalId: `approval-${crypto.randomUUID()}`,
			sdkToolCallId: "sdk-stranger",
			tool: "linear__create_issue",
			input: { title: "Not yours" },
			connectionId,
			connectionRevision: 1,
			remoteToolName: "create_issue",
			mutating: true,
			atOffset: 0,
		};
		await turns.suspend(
			prepared,
			checkpoint({
				approvals: [
					{
						approvalId: pending.approvalId,
						tool: pending.tool,
						connectionId,
						connectionRevision: 1,
						remoteToolName: pending.remoteToolName,
					},
				],
				reply: { content: "", collaborations: [], toolCalls: [{ id: pending.id, atOffset: 0 }] },
			}),
			[pending],
		);
		const [stranger] = await onDatabase((db) =>
			db
				.insert(user)
				.values({ name: "Kim", email: `stranger-${crypto.randomUUID()}@example.com` })
				.returning(),
		);
		if (!stranger) throw new Error("fixture");
		await onDatabase((db) =>
			db.insert(workspaceMember).values({ workspaceId, userId: stranger.id, role: "member" }),
		);

		await expect(
			approvals.decide({
				workspaceId,
				podId,
				toolCallId: pending.id,
				userId: stranger.id,
				decision: "allow_once",
			}),
		).rejects.toBeInstanceOf(ToolApprovalNotFound);
	});

	it("gives up on a turn that keeps stopping before it gets anywhere", async () => {
		await onDatabase((db) =>
			db.update(turn).set({ runs: MAX_TURN_RUNS }).where(eq(turn.id, prepared.turnId)),
		);

		await expect(turns.prepare(prepared.claim)).rejects.toMatchObject({
			_tag: "TurnNotRunnable",
			terminalOutcome: { state: "failed" },
		});
		const [stopped] = await onDatabase((db) =>
			db.select().from(turn).where(eq(turn.id, prepared.turnId)),
		);
		expect(stopped?.status).toBe("failed");
	});

	it("counts a turn's runs again from its last stop for approvals", async () => {
		const [started] = await onDatabase((db) =>
			db.select().from(turn).where(eq(turn.id, prepared.turnId)),
		);
		expect(started?.runs).toBe(1);

		await turns.suspend(prepared, checkpoint(), []);

		const [waiting] = await onDatabase((db) =>
			db.select().from(turn).where(eq(turn.id, prepared.turnId)),
		);
		expect(waiting?.runs).toBe(0);
	});

	it("recovers a checkpointed turn left running by a stopped worker", async () => {
		const saved = checkpoint();
		expect(await turns.suspend(prepared, saved, [])).toBe(true);
		await onDatabase((db) =>
			db.update(turn).set({ status: "running" }).where(eq(turn.id, prepared.turnId)),
		);

		const resumed = await turns.prepare(prepared.claim);

		expect(resumed.turnId).toBe(prepared.turnId);
		expect(resumed.checkpoint).toEqual(saved);
	});

	it("finalizes a durable cancellation instead of reopening it after a crash", async () => {
		await onDatabase((db) =>
			db.update(turn).set({ cancelRequested: true }).where(eq(turn.id, prepared.turnId)),
		);

		await expect(turns.prepare(prepared.claim)).rejects.toMatchObject({
			_tag: "TurnNotRunnable",
			terminalOutcome: { state: "cancelled" },
		});
		const [stopped] = await onDatabase((db) =>
			db.select().from(turn).where(eq(turn.id, prepared.turnId)),
		);
		expect(stopped).toMatchObject({ status: "cancelled", checkpoint: null });
	});

	it("rejects an approved call after the reviewed connection configuration changes", async () => {
		const pending = {
			id: crypto.randomUUID(),
			approvalId: `approval-${crypto.randomUUID()}`,
			sdkToolCallId: "sdk-revision",
			tool: "linear__create_issue",
			input: { title: "Reviewed target" },
			connectionId,
			connectionRevision: 1,
			remoteToolName: "create_issue",
			mutating: true,
			atOffset: 0,
		};
		await turns.suspend(
			prepared,
			checkpoint({
				approvals: [
					{
						approvalId: pending.approvalId,
						tool: pending.tool,
						connectionId,
						connectionRevision: 1,
						remoteToolName: pending.remoteToolName,
					},
				],
				reply: {
					content: "",
					collaborations: [],
					toolCalls: [{ id: pending.id, atOffset: 0 }],
				},
			}),
			[pending],
		);
		await allow(pending);
		prepared = await turns.prepare(prepared.claim);
		await onDatabase((db) =>
			db
				.update(connection)
				.set({ configurationRevision: 2 })
				.where(eq(connection.id, connectionId)),
		);

		await expect(
			approvals.beginExecution({
				threadId,
				messageId: prepared.responseMessage.id,
				turnId: prepared.turnId,
				sdkToolCallId: pending.sdkToolCallId,
				tool: pending.tool,
				input: pending.input,
				atOffset: 0,
				connectionId,
				connectionRevision: 1,
				remoteToolName: pending.remoteToolName,
			}),
		).rejects.toThrow("configuration changed");
	});

	it("closes a failed call with the error and no output", async () => {
		const opened = await calls.open(from(0));

		const closed = await calls.close(opened.id, { error: "Host did not resolve" });

		expect(closed).toMatchObject({ status: "failed", output: null, error: "Host did not resolve" });
	});

	it("composes the call into the reply's parts where it was made", async () => {
		const opened = await calls.open(from(7));
		await calls.close(opened.id, { output: { title: "Example Domain" } });
		await turns.saveStreamingMessage(prepared, {
			content: "Looking now. Found it.",
			collaborations: [],
			toolCalls: [{ id: opened.id, atOffset: 7 }],
		});

		const details = await threads.getVisible(threadId, memberId);
		const reply = details?.messages.find((message) => message.id === prepared.responseMessage.id);

		expect(reply?.parts).toEqual([
			{ type: "text", text: "Looking" },
			expect.objectContaining({ type: "tool_call", id: opened.id, status: "completed" }),
			{ type: "text", text: " now. Found it." },
		]);
	});

	it("marks calls still running as failed when the turn fails or is cancelled", async () => {
		const opened = await calls.open(from(0));

		await turns.cancel(prepared, { content: "", collaborations: [], toolCalls: [] });

		const [row] = await onDatabase((db) =>
			db.select().from(toolCall).where(eq(toolCall.id, opened.id)),
		);
		expect(row).toMatchObject({ status: "failed", error: "Turn cancelled" });
		expect(row?.finishedAt).not.toBeNull();
		expect(await calls.close(opened.id, { output: { late: true } })).toBeUndefined();
		const [stillFailed] = await onDatabase((db) =>
			db.select().from(toolCall).where(eq(toolCall.id, opened.id)),
		);
		expect(stillFailed).toMatchObject({ status: "failed", error: "Turn cancelled" });
	});

	it("runs a failed turn again while no tool that changes things has run and it has runs left", async () => {
		const empty = { content: "", collaborations: [], toolCalls: [] };

		expect(prepared.runs).toBe(1);
		expect(runsAgainAfterFailure(prepared, empty)).toBe(true);
		await turns.fail(prepared, empty, "provider down", true);
		const second = await turns.prepare(prepared.claim);
		expect(second).toMatchObject({ turnId: prepared.turnId, runs: 2 });
		// Running again could act again, so the turn stops here for a person (ADR 002).
		expect(runsAgainAfterFailure(second, { ...empty, acted: true })).toBe(false);

		await turns.fail(second, empty, "provider down", true);
		const last = await turns.prepare(prepared.claim);
		expect(last.runs).toBe(MAX_TURN_RUNS);
		expect(runsAgainAfterFailure(last, empty)).toBe(false);
	});

	it("forgets the previous attempt's calls when a turn is retried", async () => {
		const opened = await calls.open(from(0));
		await turns.fail(
			prepared,
			{ content: "", collaborations: [], toolCalls: [] },
			"provider down",
			true,
		);

		await turns.prepare(prepared.claim);

		const rows = await onDatabase((db) =>
			db.select().from(toolCall).where(eq(toolCall.id, opened.id)),
		);
		expect(rows).toEqual([]);
	});
});

describe("boundedJson", () => {
	it("cuts a value that does not fit and says so", () => {
		const large = "x".repeat(MAX_STORED_JSON_CHARACTERS + 10);

		expect(boundedJson(large)).toEqual({
			truncated: true,
			characters: large.length + 2,
			preview: `"${"x".repeat(MAX_STORED_JSON_CHARACTERS - 1)}`,
		});
	});
});
