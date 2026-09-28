import { eq } from "drizzle-orm";
import { Effect, Layer, ManagedRuntime } from "effect";
import { WorkflowEngine } from "effect/unstable/workflow";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommittedEvent } from "../../../database/events/outbox.ts";
import { connection, toolCall, turn, user, workspaceMember } from "../../../database/schema.ts";
import {
	closeDatabase,
	onDatabase,
	onPostgres,
	type Promised,
	runOnPostgres,
} from "../../../database/testing.ts";
import { UserMessage } from "../../../user-message.ts";
import { Lanes } from "../../../workflows/lanes.ts";
import { conversationsForTests } from "../../testing.ts";
import { type PreparedTurn, replyTurnOf } from "../../turns/execution.ts";
import type { TurnCheckpoint } from "../../turns/repository.ts";
import { TurnSignals } from "../../turns/signals.ts";
import { aChatAwaitingReply, prepareRunnable, runningTurns } from "../../turns/testing.ts";
import {
	type SegmentOutcome,
	Turn,
	type TurnRequest,
	TurnSteps,
	turnWorkflow,
} from "../../turns/turn.workflow.ts";
import {
	ToolApprovalConflict,
	ToolApprovalNotFound,
	type ToolApprovalStore,
} from "../approvals/store.ts";
import {
	boundedJson,
	MAX_STORED_JSON_CHARACTERS,
	type PendingToolApproval,
	type ToolCallRepository,
} from "./repository.ts";

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
	const { repositories, stores } = await conversationsForTests(bus);
	const calls: Promised<ToolCallRepository> = onPostgres(repositories.toolCalls);
	const turns = onPostgres(repositories.turns);
	const approvals: Promised<ToolApprovalStore> = onPostgres(stores.approvals);
	const threads = onPostgres(stores.threads);
	const chats = onPostgres(stores.chats);
	const execution = onPostgres(stores.turns);
	let workspaceId: string;
	let podId: string;
	let memberId: string;
	let threadId: string;
	let connectionId: string;
	let prepared: PreparedTurn;

	/** Records a person allowing the call, as the turn's workflow does once told. */
	const allow = (pending: PendingToolApproval) =>
		calls.recordDecision({
			threadId,
			approvalId: pending.approvalId,
			decision: { decision: "allow_once", userId: memberId },
		});

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		({ workspaceId, podId, memberId, threadId, connectionId } = await aChatAwaitingReply(chats));
		const [run] = await runOnPostgres(runningTurns(threadId));
		if (!run) throw new Error("no turn running");
		prepared = await prepareRunnable(execution, run);
		delivered = [];
	});

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

	const pendingCall = (overrides: Partial<PendingToolApproval> = {}): PendingToolApproval => ({
		id: crypto.randomUUID(),
		approvalId: `approval-${crypto.randomUUID()}`,
		sdkToolCallId: "sdk-create-1",
		tool: "linear__create_issue",
		input: { title: "Fix mobile navigation" },
		connectionId,
		connectionRevision: 1,
		remoteToolName: "create_issue",
		mutating: true,
		atOffset: 0,
		...overrides,
	});

	/** Parks `pending` as the turn's one approval. */
	const park = (pending: PendingToolApproval) =>
		turns.suspend(
			replyTurnOf(prepared),
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
			threadId,
			messageId: prepared.responseMessage.id,
			turnId: prepared.turnId,
			sdkToolCallId: pending.sdkToolCallId,
			tool: pending.tool,
			input: pending.input,
			atOffset: pending.atOffset,
			connectionId,
			connectionRevision: 1,
			remoteToolName: pending.remoteToolName,
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

	it("closes a failed call with the error and no output", async () => {
		const opened = await calls.open(from(0));

		const closed = await calls.close(opened.id, { error: UserMessage.of`Host did not resolve` });

		expect(closed).toMatchObject({ status: "failed", output: null, error: "Host did not resolve" });
	});

	it("composes the call into the reply's parts where it was made", async () => {
		const opened = await calls.open(from(7));
		await calls.close(opened.id, { output: { title: "Example Domain" } });
		await turns.saveReply(replyTurnOf(prepared), {
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

	it("parks an approval and, once it is allowed, starts it once, as it was approved", async () => {
		const execution = await allowAndResume(pendingCall({ atOffset: 7 }));
		const [allowed] = await onDatabase((db) =>
			db.select().from(toolCall).where(eq(toolCall.sdkToolCallId, "sdk-create-1")),
		);
		expect(allowed).toMatchObject({ approvalStatus: "allowed", decidedById: memberId });

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

	it("records that the turn acted once an allowed call that changes things starts", async () => {
		const execution = await allowAndResume(pendingCall());

		await approvals.beginExecution(execution);

		const [acted] = await onDatabase((db) =>
			db
				.select({ mutationStarted: turn.mutationStarted })
				.from(turn)
				.where(eq(turn.id, prepared.turnId)),
		);
		expect(acted?.mutationStarted).toBe(true);
	});

	it("runs an allowed read from a connection that asks, without counting it as a change", async () => {
		await onDatabase((db) =>
			db.update(connection).set({ access: "ask" }).where(eq(connection.id, connectionId)),
		);
		const execution = await allowAndResume(
			pendingCall({
				sdkToolCallId: "sdk-read",
				tool: "linear__list_issues",
				input: {},
				remoteToolName: "list_issues",
				mutating: false,
			}),
		);

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

	it("refuses an allowed call once its connection is turned off", async () => {
		const execution = await allowAndResume(pendingCall({ sdkToolCallId: "sdk-turned-off" }));
		await onDatabase((db) =>
			db.update(connection).set({ access: "off" }).where(eq(connection.id, connectionId)),
		);

		await expect(approvals.beginExecution(execution)).rejects.toThrow("configuration changed");
	});

	it("refuses an allowed call after the reviewed connection configuration changes", async () => {
		const execution = await allowAndResume(pendingCall({ sdkToolCallId: "sdk-revision" }));
		await onDatabase((db) =>
			db
				.update(connection)
				.set({ configurationRevision: 2 })
				.where(eq(connection.id, connectionId)),
		);

		await expect(approvals.beginExecution(execution)).rejects.toThrow("configuration changed");
	});

	it("conceals a pending approval from somebody who cannot reach the pod", async () => {
		const pending = pendingCall({ sdkToolCallId: "sdk-stranger" });
		await park(pending);
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

	it("fails calls still running when their turn is cancelled, and keeps them failed", async () => {
		const opened = await calls.open(from(0));

		await turns.cancel(replyTurnOf(prepared), { content: "", collaborations: [], toolCalls: [] });

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
			{ content: "", collaborations: [], toolCalls: [] },
			UserMessage.of`provider down`,
		);

		await prepareRunnable(execution, prepared.run);

		const rows = await onDatabase((db) =>
			db.select().from(toolCall).where(eq(toolCall.id, opened.id)),
		);
		expect(rows).toEqual([]);
	});

	describe("when a workflow owns the turn", () => {
		const segment = vi.fn((_request: TurnRequest) =>
			Effect.succeed<SegmentOutcome>({ _tag: "Finished" }),
		);
		// Recording decisions and cancellations is real; the segments are not.
		const steps = TurnSteps.of({
			segment,
			decide: (request, decided) =>
				Effect.promise(() => calls.recordDecision({ threadId: request.threadId, ...decided })),
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
				Turn.execute(prepared.run.request, { discard: true }),
			);
			await vi.waitFor(() => expect(segment).toHaveBeenCalledTimes(1));
			await onDatabase((db) =>
				db.update(turn).set({ owner: executionId }).where(eq(turn.id, prepared.turnId)),
			);
			await park(pending);
			return workflows.runPromise(TurnSignals.make);
		}

		const workflowCall = () =>
			pendingCall({ sdkToolCallId: "sdk-workflow", input: { title: "Workflow" } });

		it("sends a decision to the workflow, which records it and runs on", async () => {
			const pending = workflowCall();
			const signals = await parkInWorkflow(pending);

			await onPostgres((await conversationsForTests(bus, signals)).stores.approvals).decide({
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
			const pending = workflowCall();
			const signals = await parkInWorkflow(pending);
			const deciding = onPostgres((await conversationsForTests(bus, signals)).stores.approvals);
			const decide = (decision: "allow_once" | "deny") =>
				deciding.decide({ workspaceId, podId, toolCallId: pending.id, userId: memberId, decision });

			await decide("allow_once");

			await expect(decide("deny")).rejects.toBeInstanceOf(ToolApprovalConflict);
		});

		it("sends a cancel to the workflow, which records it and ends", async () => {
			const signals = await parkInWorkflow(workflowCall());

			expect(
				await onPostgres((await conversationsForTests(bus, signals)).stores.turns).requestCancel(
					prepared.turnId,
					memberId,
				),
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
