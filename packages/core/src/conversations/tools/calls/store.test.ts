import { handleFromName } from "@sugabots/contracts";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createEventBus } from "../../../database/events/bus.ts";
import { eventPublisher } from "../../../database/events/publish.ts";
import { memoryEventStore } from "../../../database/events/store.ts";
import {
	agent,
	connection,
	job,
	pod,
	podMember,
	toolCall,
	turn,
	user,
	workspace,
	workspaceMember,
} from "../../../database/schema.ts";
import { closeDatabase, onDatabase, onPostgres, type Promised } from "../../../database/testing.ts";
import { chatStore } from "../../chats/store.ts";
import { threadStore } from "../../threads/store.ts";
import { type PreparedTurn, type TurnCheckpoint, turnStore } from "../../turns/store.ts";
import {
	type PendingToolApproval,
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
	const approvals: Promised<ToolApprovalStore> = onPostgres(toolApprovalStore(publishEvents));
	const threads = onPostgres(threadStore());
	const chats = onPostgres(chatStore(publishEvents));
	const turns = onPostgres(turnStore(publishEvents));
	let workspaceId: string;
	let podId: string;
	let memberId: string;
	let hostId: string;
	let threadId: string;
	let connectionId: string;
	let prepared: PreparedTurn;

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
					color: "green",
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

	/** Claims the queued turn for the thread's host and prepares it, so a reply message exists. */
	async function openReply(): Promise<PreparedTurn> {
		const [queued] = await onDatabase((db) =>
			db
				.select()
				.from(job)
				.where(and(eq(job.threadId, threadId), eq(job.status, "queued"))),
		);
		if (!queued || !("agentId" in queued.payload && "triggerMessageId" in queued.payload))
			throw new Error("no turn queued");
		await onDatabase((db) =>
			db.update(job).set({ status: "running", attempts: 1 }).where(eq(job.id, queued.id)),
		);
		return turns.prepare({
			id: queued.id,
			threadId,
			payload: queued.payload,
			dedupeKey: queued.dedupeKey,
			attempts: 1,
		});
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

	it("parks an approval, wakes the same job once allowed, and claims execution once", async () => {
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
		const [otherWaitingJob] = await onDatabase((db) =>
			db
				.insert(job)
				.values({
					kind: "turn",
					threadId,
					payload: {
						agentId: hostId,
						triggerMessageId: prepared.job.payload.triggerMessageId,
					},
					dedupeKey: `other-waiting-${crypto.randomUUID()}`,
					status: "waiting",
				})
				.returning({ id: job.id }),
		);
		if (!otherWaitingJob) throw new Error("other waiting job was not created");

		const decided = await approvals.decide({
			workspaceId,
			podId,
			toolCallId: pending.id,
			userId: memberId,
			decision: "allow_once",
		});
		expect(decided.approval?.status).toBe("allowed");
		const [queued] = await onDatabase((db) =>
			db.select({ status: job.status }).from(job).where(eq(job.id, prepared.job.id)),
		);
		expect(queued?.status).toBe("queued");
		const [stillWaiting] = await onDatabase((db) =>
			db.select({ status: job.status }).from(job).where(eq(job.id, otherWaitingJob.id)),
		);
		expect(stillWaiting?.status).toBe("waiting");
		await onDatabase((db) =>
			db.update(job).set({ status: "running", attempts: 1 }).where(eq(job.id, prepared.job.id)),
		);
		prepared = await turns.prepare({ ...prepared.job, attempts: 1 });

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
		await approvals.decide({
			workspaceId,
			podId,
			toolCallId: pending.id,
			userId: memberId,
			decision: "allow_once",
		});
		await onDatabase((db) =>
			db.update(job).set({ status: "running", attempts: 1 }).where(eq(job.id, prepared.job.id)),
		);
		prepared = await turns.prepare({ ...prepared.job, attempts: 1 });
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

	it("recovers a checkpointed turn left running by a stopped worker", async () => {
		const saved = checkpoint();
		expect(await turns.suspend(prepared, saved, [])).toBe(true);
		await onDatabase((db) =>
			db.update(job).set({ status: "running", attempts: 1 }).where(eq(job.id, prepared.job.id)),
		);
		await onDatabase((db) =>
			db.update(turn).set({ status: "running" }).where(eq(turn.id, prepared.turnId)),
		);

		const resumed = await turns.prepare({ ...prepared.job, attempts: 1 });

		expect(resumed.turnId).toBe(prepared.turnId);
		expect(resumed.checkpoint).toEqual(saved);
	});

	it("runs coalesced work after an approval continuation finishes", async () => {
		const deferredPayload = {
			agentId: hostId,
			triggerMessageId: prepared.job.payload.triggerMessageId,
			reason: "mention" as const,
		};
		await onDatabase((db) =>
			db.insert(job).values({
				kind: "turn",
				threadId,
				payload: deferredPayload,
				dedupeKey: prepared.job.dedupeKey,
			}),
		);
		const saved = checkpoint();
		await turns.suspend(prepared, saved, []);
		const [waiting] = await onDatabase((db) =>
			db.select().from(job).where(eq(job.id, prepared.job.id)),
		);
		expect(waiting).toMatchObject({ status: "waiting", deferredPayload });

		await onDatabase((db) =>
			db.update(job).set({ status: "running", attempts: 1 }).where(eq(job.id, prepared.job.id)),
		);
		const resumed = await turns.prepare({ ...prepared.job, attempts: 1 });
		await turns.complete(resumed, saved.reply, { usage: {} });

		const [next] = await onDatabase((db) =>
			db
				.select()
				.from(job)
				.where(and(eq(job.dedupeKey, prepared.job.dedupeKey), eq(job.status, "queued"))),
		);
		expect(next?.payload).toEqual(deferredPayload);
	});

	it("finalizes a durable cancellation instead of reopening it after a crash", async () => {
		await onDatabase((db) =>
			db.update(turn).set({ cancelRequested: true }).where(eq(turn.id, prepared.turnId)),
		);

		await expect(turns.prepare(prepared.job)).rejects.toMatchObject({
			_tag: "JobNotRunnable",
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
		await approvals.decide({
			workspaceId,
			podId,
			toolCallId: pending.id,
			userId: memberId,
			decision: "allow_once",
		});
		await onDatabase((db) =>
			db.update(job).set({ status: "running", attempts: 1 }).where(eq(job.id, prepared.job.id)),
		);
		prepared = await turns.prepare({ ...prepared.job, attempts: 1 });
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

	it("cancels only the waiting job owned by the selected turn", async () => {
		await turns.suspend(
			prepared,
			{
				messages: [],
				approvals: [],
				modelInput: { model: "test", system: "test", messages: [] },
				reply: { content: "Waiting.", collaborations: [], toolCalls: [] },
				accounting: { usage: {} },
			},
			[],
		);
		const [otherWaitingJob] = await onDatabase((db) =>
			db
				.insert(job)
				.values({
					kind: "turn",
					threadId,
					payload: {
						agentId: hostId,
						triggerMessageId: prepared.job.payload.triggerMessageId,
					},
					dedupeKey: `other-cancel-${crypto.randomUUID()}`,
					status: "waiting",
				})
				.returning({ id: job.id }),
		);
		if (!otherWaitingJob) throw new Error("other waiting job was not created");

		expect(await turns.requestCancel(prepared.turnId, memberId)).toBe(true);

		const rows = await onDatabase((db) =>
			db
				.select({ id: job.id, status: job.status })
				.from(job)
				.where(inArray(job.id, [prepared.job.id, otherWaitingJob.id])),
		);
		expect(rows).toEqual(
			expect.arrayContaining([
				{ id: prepared.job.id, status: "cancelled" },
				{ id: otherWaitingJob.id, status: "waiting" },
			]),
		);
	});

	it("retries a failed turn unless a tool that changes things had run", async () => {
		const empty = { content: "", collaborations: [], toolCalls: [] };

		expect(await turns.fail(prepared, empty, "provider down")).toBe(true);
		let [row] = await onDatabase((db) => db.select().from(job).where(eq(job.id, prepared.job.id)));
		expect(row?.status).toBe("queued");

		await onDatabase((db) =>
			db.update(job).set({ status: "running", attempts: 2 }).where(eq(job.id, prepared.job.id)),
		);
		const retried = await turns.prepare({ ...prepared.job, attempts: 2 });

		// The retry could act again, so the job stops here for a person (ADR 002).
		expect(await turns.fail(retried, { ...empty, acted: true }, "provider down")).toBe(false);
		[row] = await onDatabase((db) => db.select().from(job).where(eq(job.id, prepared.job.id)));
		expect(row?.status).toBe("failed");
	});

	it("forgets the previous attempt's calls when a turn is retried", async () => {
		const opened = await calls.open(from(0));
		await turns.fail(prepared, { content: "", collaborations: [], toolCalls: [] }, "provider down");
		await onDatabase((db) =>
			db.update(job).set({ status: "running", attempts: 2 }).where(eq(job.id, prepared.job.id)),
		);

		await turns.prepare({ ...prepared.job, attempts: 2 });

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
