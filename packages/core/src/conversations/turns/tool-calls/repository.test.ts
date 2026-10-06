import { eq } from "drizzle-orm";
import { Context, Effect, Layer, ManagedRuntime } from "effect";
import { WorkflowEngine } from "effect/unstable/workflow";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ActionForbidden, ResourceHidden } from "../../../authorization/access.ts";
import type { CommittedEvent } from "../../../database/events/outbox.ts";
import {
	connection,
	podMember,
	toolCall,
	turn,
	user,
	workspaceMember,
} from "../../../database/schema.ts";
import {
	closeDatabase,
	onDatabase,
	onPostgres,
	type Promised,
	runOnPostgres,
} from "../../../database/testing.ts";
import { UserMessage } from "../../../user-message.ts";
import { Lanes } from "../../../workflows/lanes.ts";
import { onPostgresAs } from "../../../workspaces/testing.ts";
import { Chats } from "../../chats/chats.ts";
import { conversationsForTests } from "../../testing.ts";
import { ThreadView } from "../../thread-view.ts";
import { ApprovedToolCalls } from "../approvals/approved-calls.ts";
import { ToolApprovalConflict } from "../controls.ts";
import { type PreparedTurn, replyTurnOf, TurnExecution } from "../execution.ts";
import { type TurnCheckpoint, TurnRepository } from "../repository.ts";
import { TurnSignals } from "../signals.ts";
import { aChatAwaitingReply, prepareRunnable, runningTurns } from "../testing.ts";
import {
	type SegmentOutcome,
	Turn,
	type TurnRequest,
	TurnSteps,
	turnWorkflow,
} from "../turn.workflow.ts";
import { Turns } from "../turns.ts";
import {
	boundedJson,
	MAX_STORED_JSON_CHARACTERS,
	type PendingToolApproval,
	ToolCallRepository,
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
	const conversations = await conversationsForTests(bus);
	const calls: Promised<ToolCallRepository.Interface> = onPostgres(
		Context.get(conversations, ToolCallRepository.Service),
	);
	const turns = onPostgres(Context.get(conversations, TurnRepository.Service));
	const approvalsAs = (userId: string): Promised<Turns.ControlsInterface> =>
		onPostgresAs(userId)(Context.get(conversations, Turns.Controls));
	const approvals = onPostgres({
		beginExecution: Context.get(conversations, ApprovedToolCalls.Service).beginExecution,
	});
	const threadsAs = (userId: string) =>
		onPostgresAs(userId)(Context.get(conversations, ThreadView.Service));
	const chatsAs = (userId: string) =>
		onPostgresAs(userId)(Context.get(conversations, Chats.Service));
	const execution = onPostgres({
		prepare: Context.get(conversations, TurnExecution.Service).prepare,
	});
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
		({ workspaceId, podId, memberId, threadId, connectionId } = await aChatAwaitingReply(chatsAs));
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
		connectionToolMode: "direct",
		modelCalls: 1,
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

		const details = await threadsAs(memberId).get(threadId);
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

	it("runs an allowed read that asked first, without counting it as a change", async () => {
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

	it("refuses an allowed call to a tool somebody turned off after it was allowed", async () => {
		const execution = await allowAndResume(pendingCall({ sdkToolCallId: "sdk-turned-off" }));
		await onDatabase((db) =>
			db
				.update(connection)
				.set({ toolAccess: { create_issue: "off" } })
				.where(eq(connection.id, connectionId)),
		);

		await expect(approvals.beginExecution(execution)).rejects.toThrow("turned off");
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
			approvalsAs(stranger.id).decide({ podId, toolCallId: pending.id, decision: "allow_once" }),
		).rejects.toBeInstanceOf(ResourceHidden);
	});

	it("refuses a decision to somebody in the pod who may not decide", async () => {
		const pending = pendingCall({ sdkToolCallId: "sdk-viewer" });
		await park(pending);
		const [viewer] = await onDatabase((db) =>
			db
				.insert(user)
				.values({ name: "Lee", email: `viewer-${crypto.randomUUID()}@example.com` })
				.returning(),
		);
		if (!viewer) throw new Error("fixture");
		await onDatabase((db) =>
			db.insert(workspaceMember).values({ workspaceId, userId: viewer.id, role: "viewer" }),
		);
		await onDatabase((db) =>
			db.insert(podMember).values({ workspaceId, podId, userId: viewer.id }),
		);

		await expect(
			approvalsAs(viewer.id).decide({ podId, toolCallId: pending.id, decision: "allow_once" }),
		).rejects.toBeInstanceOf(ActionForbidden);
		const [undecided] = await onDatabase((db) =>
			db.select().from(toolCall).where(eq(toolCall.id, pending.id)),
		);
		expect(undecided).toMatchObject({ approvalStatus: "pending", decidedById: null });
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
			{ userMessage: UserMessage.of`provider down`, mayRunAgain: true },
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
		// Recording cancellations is real; the segments are not.
		const steps = TurnSteps.of({
			segment,
			cancelWaiting: (request) => Effect.promise(() => turns.cancelWaiting(request)),
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
				db.update(turn).set({ owner: executionId }).where(eq(turn.id, prepared.turnId)),
			);
			await park(pending);
			return workflows.runPromise(TurnSignals.make);
		}

		const workflowCall = () =>
			pendingCall({ sdkToolCallId: "sdk-workflow", input: { title: "Workflow" } });

		it("records a decision and sends it to the workflow, which runs on", async () => {
			const pending = workflowCall();
			const signals = await parkInWorkflow(pending);

			await onPostgresAs(memberId)(
				Context.get(await conversationsForTests(bus, signals), Turns.Controls),
			).decide({ podId, toolCallId: pending.id, decision: "allow_once" });

			await vi.waitFor(() => expect(segment).toHaveBeenCalledTimes(2));
			const [decided] = await onDatabase((db) =>
				db.select().from(toolCall).where(eq(toolCall.id, pending.id)),
			);
			expect(decided).toMatchObject({ approvalStatus: "allowed", decidedById: memberId });
		});

		it("takes the decision of an administrator who is not in the pod", async () => {
			const pending = workflowCall();
			const signals = await parkInWorkflow(pending);
			const [administrator] = await onDatabase((db) =>
				db
					.insert(user)
					.values({ name: "Ada", email: `admin-${crypto.randomUUID()}@example.com` })
					.returning(),
			);
			if (!administrator) throw new Error("fixture");
			await onDatabase((db) =>
				db.insert(workspaceMember).values({ workspaceId, userId: administrator.id, role: "admin" }),
			);

			await onPostgresAs(administrator.id)(
				Context.get(await conversationsForTests(bus, signals), Turns.Controls),
			).decide({ podId, toolCallId: pending.id, decision: "allow_once" });

			await vi.waitFor(() => expect(segment).toHaveBeenCalledTimes(2));
			const [decided] = await onDatabase((db) =>
				db.select().from(toolCall).where(eq(toolCall.id, pending.id)),
			);
			expect(decided).toMatchObject({ approvalStatus: "allowed", decidedById: administrator.id });
		});

		it("tells a second person the approval is already decided", async () => {
			const pending = workflowCall();
			const signals = await parkInWorkflow(pending);
			const deciding = onPostgresAs(memberId)(
				Context.get(await conversationsForTests(bus, signals), Turns.Controls),
			);
			const decide = (decision: "allow_once" | "deny") =>
				deciding.decide({ podId, toolCallId: pending.id, decision });

			await decide("allow_once");

			await expect(decide("deny")).rejects.toBeInstanceOf(ToolApprovalConflict);
		});

		it("tells the thread's watchers of a decision before the workflow hears it", async () => {
			const pending = workflowCall();
			const signals = await parkInWorkflow(pending);
			const unheard = TurnSignals.Service.of({ ...signals, decide: () => Effect.void });
			delivered = [];

			await onPostgresAs(memberId)(
				Context.get(await conversationsForTests(bus, unheard), Turns.Controls),
			).decide({ podId, toolCallId: pending.id, decision: "allow_once" });

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

		it("sends a cancel to the workflow, which records it and ends", async () => {
			const signals = await parkInWorkflow(workflowCall());

			expect(
				await onPostgresAs(memberId)(
					Context.get(await conversationsForTests(bus, signals), Turns.Controls),
				).cancel(prepared.turnId),
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

		it("sends a cancel again when the first never reached the workflow", async () => {
			const signals = await parkInWorkflow(workflowCall());
			// Cancelled and committed, but the process stopped before the signal left.
			await onDatabase((db) =>
				db.update(turn).set({ cancelRequested: true }).where(eq(turn.id, prepared.turnId)),
			);

			await runOnPostgres(
				Turns.resendLostCancels.pipe(Effect.provideService(TurnSignals.Service, signals)),
			);

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
