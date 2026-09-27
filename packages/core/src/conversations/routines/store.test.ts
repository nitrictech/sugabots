import type { AcceptedRoutineExecution } from "@sugabots/contracts";
import { handleFromName } from "@sugabots/contracts";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Database, query, transaction } from "../../database/database.ts";
import {
	agent,
	collaboration,
	job,
	message,
	pod,
	podMember,
	routine,
	routineExecution,
	thread,
	turn,
	user,
	workspace,
	workspaceMember,
} from "../../database/schema.ts";
import { closeDatabase, onDatabase, onPostgres, runOnPostgres } from "../../database/testing.ts";
import { lane, laneRequest } from "../../workflows/sql.ts";
import { turnStore as createTurnStore } from "../turns/store.ts";
import {
	queueFacilitationForTests,
	queueTurnForTests,
	releaseFacilitation,
	releaseTurn,
	runningTurns,
	turnSignalsForTests,
	waitingFacilitation,
} from "../turns/testing.ts";
import { Turn, turnLane } from "../turns/turn.workflow.ts";
import {
	InvalidRoutineExecutionCursor,
	RoutineRequiresCrewAgent,
	RoutineTriggerConflict,
	routineStore,
} from "./store.ts";
import { releaseRun, routineRunsForTests, runningRun } from "./testing.ts";

describe.skipIf(!process.env.DATABASE_URL)("Routines, against Postgres", () => {
	const routineEffects = routineStore(
		() => Effect.void,
		queueTurnForTests,
		turnSignalsForTests,
		routineRunsForTests,
	);
	const store = onPostgres(routineEffects);
	/** Starts the routine's run holding its lane, as its workflow's first step does. */
	const startRunning = async (routineId: string) => {
		const run = await runOnPostgres(runningRun(routineId));
		if (!run) throw new Error("No run of the routine is running");
		await store.startRun(run);
		const [execution] = await onDatabase((db) =>
			db.select().from(routineExecution).where(eq(routineExecution.id, run.executionId)),
		);
		if (!execution) throw new Error("The running run has no execution");
		return { run, execution };
	};
	/** Ends the turns running in the thread, as their workflows do once done. */
	const finishTurnsIn = async (threadId: string) => {
		for (const claim of await runOnPostgres(runningTurns(threadId))) {
			await runOnPostgres(releaseTurn(claim));
		}
	};
	let workspaceId: string;
	let podId: string;
	let agentId: string;
	let userId: string;

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		await onDatabase((db) => db.delete(job));
		await onDatabase((db) =>
			db
				.update(routineExecution)
				.set({ state: "cancelled", finishedAt: new Date() })
				.where(eq(routineExecution.state, "queued")),
		);
		const suffix = crypto.randomUUID();
		const [person] = await onDatabase((db) =>
			db
				.insert(user)
				.values({ name: "Routine owner", email: `routine-${suffix}@example.com` })
				.returning(),
		);
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: "Routine workspace", slug: `routine-${suffix}` })
				.returning(),
		);
		if (!person || !space) throw new Error("Could not create Routine test identity");
		userId = person.id;
		workspaceId = space.id;
		await onDatabase((db) => db.insert(workspaceMember).values({ workspaceId, userId }));
		const [room] = await onDatabase((db) =>
			db
				.insert(pod)
				.values({
					workspaceId,
					ownerId: userId,
					kind: "shared",
					name: "Routine pod",
					slug: `routine-${suffix}`,
					createdById: userId,
				})
				.returning(),
		);
		if (!room) throw new Error("Could not create Routine test pod");
		podId = room.id;
		const [owner] = await onDatabase((db) =>
			db
				.insert(agent)
				.values({
					workspaceId,
					podId,
					name: "Routine Agent",
					handle: handleFromName(`Routine Agent ${suffix}`),
					color: "green",
					face: "pill",
					model: "test/model",
					createdById: userId,
				})
				.returning(),
		);
		if (!owner) throw new Error("Could not create Routine test agent");
		agentId = owner.id;
	});

	async function createRunningExecutionWithCollaboration(status: "waiting" | "pending") {
		const created = await store.create(workspaceId, agentId, userId, {
			name: `Settlement ${crypto.randomUUID()}`,
			instructions: "Complete the delegated work.",
			trigger: { kind: "webhook" },
		});
		const requestId = crypto.randomUUID();
		const accepted = await store.acceptTrigger({
			workspaceId,
			agentId,
			routineId: created.routine.id,
			triggerIdentity: requestId,
			trigger: {
				kind: "manual",
				requestId,
				requestedAt: new Date().toISOString(),
				requestedByUserId: userId,
			},
		});
		const started = await startRunning(created.routine.id);
		if (started.execution.id !== accepted.executionId) {
			throw new Error("Could not start settlement test execution");
		}
		const [triggerMessage] = await onDatabase((db) =>
			db.select({ id: message.id }).from(message).where(eq(message.threadId, accepted.threadId)),
		);
		if (!triggerMessage) throw new Error("Settlement test trigger message is missing");
		const now = new Date();
		const [askingTurn] = await onDatabase((db) =>
			db
				.insert(turn)
				.values({
					threadId: accepted.threadId,
					agentId,
					triggerMessageId: triggerMessage.id,
					status: "done",
					model: "test/model",
					startedAt: now,
					finishedAt: now,
				})
				.returning(),
		);
		if (!askingTurn) throw new Error("Could not create settlement test turn");
		const [parentMessage] = await onDatabase((db) =>
			db
				.insert(message)
				.values({
					threadId: accepted.threadId,
					authorAgentId: agentId,
					kind: "text",
					status: "complete",
					parts: [],
					content: "Delegating.",
					turnId: askingTurn.id,
				})
				.returning(),
		);
		const [childThread] = await onDatabase((db) =>
			db
				.insert(thread)
				.values({
					workspaceId,
					podId,
					hostAgentId: agentId,
					type: "collaboration",
					title: "Delegated work",
					parentThreadId: accepted.threadId,
				})
				.returning(),
		);
		if (!parentMessage || !childThread) {
			throw new Error("Could not create settlement test collaboration thread");
		}
		const [activeCollaboration] = await onDatabase((db) =>
			db
				.insert(collaboration)
				.values({
					parentThreadId: accepted.threadId,
					parentMessageId: parentMessage.id,
					turnId: askingTurn.id,
					childThreadId: childThread.id,
					collaboratorAgentId: agentId,
					brief: "Complete delegated work",
					status,
					atOffset: 0,
				})
				.returning(),
		);
		const [runningTurn] = await runOnPostgres(runningTurns(accepted.threadId));
		if (!activeCollaboration || !runningTurn) {
			throw new Error("Could not create settlement test active work");
		}
		return { accepted, childThread, activeCollaboration, runningTurn };
	}

	it("lists the workspace's routines on bots in pods the person reaches, by name", async () => {
		const [joined] = await onDatabase((db) =>
			db
				.insert(pod)
				.values({
					workspaceId,
					ownerId: userId,
					kind: "shared",
					name: "Joined pod",
					slug: `joined-${crypto.randomUUID()}`,
					createdById: userId,
				})
				.returning(),
		);
		if (!joined) throw new Error("Could not create the joined pod");
		await onDatabase((db) =>
			db.insert(podMember).values({ workspaceId, podId: joined.id, userId }),
		);
		const [helper] = await onDatabase((db) =>
			db
				.insert(agent)
				.values({
					workspaceId,
					podId: joined.id,
					name: "Joined Agent",
					handle: handleFromName(`Joined Agent ${crypto.randomUUID()}`),
					color: "sky",
					face: "dot",
					model: "test/model",
					createdById: userId,
				})
				.returning(),
		);
		if (!helper) throw new Error("Could not create the joined agent");
		const webhook = { kind: "webhook" as const };
		await store.create(workspaceId, agentId, userId, {
			name: "Unreached",
			instructions: "In a pod this member is not in.",
			trigger: webhook,
		});
		const later = await store.create(workspaceId, helper.id, userId, {
			name: "Weekly report",
			instructions: "Summarise the week.",
			trigger: webhook,
		});
		const sooner = await store.create(workspaceId, helper.id, userId, {
			name: "Morning brief",
			instructions: "Plan the day.",
			trigger: webhook,
		});
		const removed = await store.create(workspaceId, helper.id, userId, {
			name: "Removed",
			instructions: "Gone.",
			trigger: webhook,
		});
		await store.remove(workspaceId, helper.id, removed.routine.id);

		const listed = await store.listInWorkspace(workspaceId, userId);

		expect(listed.map((item) => item.routine.id)).toEqual([sooner.routine.id, later.routine.id]);
		expect(listed[0]?.agent).toMatchObject({ id: helper.id, name: "Joined Agent", color: "sky" });
		expect(listed[0]?.pod).toEqual({ id: joined.id, slug: joined.slug });
	});

	it("creates scoped cron and webhook definitions without exposing secret hashes", async () => {
		const cron = await store.create(workspaceId, agentId, userId, {
			name: "Weekday briefing",
			instructions: "Summarise the overnight changes.",
			trigger: { kind: "cron", expression: "0 9 * * 1-5", timezone: "Australia/Sydney" },
		});
		expect(cron.secret).toBeNull();
		expect(cron.routine.trigger).toMatchObject({
			kind: "cron",
			nextScheduledAt: expect.any(String),
		});

		const webhook = await store.create(workspaceId, agentId, userId, {
			name: "Incoming alert",
			instructions: "Investigate the alert.",
			trigger: { kind: "webhook" },
		});
		expect(webhook.secret).toHaveLength(43);
		const delivery = {
			kind: "webhook" as const,
			idempotencyKey: "definition-test",
			payload: { event: "created" },
			receivedAt: new Date().toISOString(),
		};
		expect(await store.acceptWebhook(webhook.routine.id, webhook.secret ?? "", delivery)).toEqual({
			executionId: expect.any(String),
			threadId: expect.any(String),
			duplicate: false,
		});
		expect(await store.acceptWebhook(webhook.routine.id, "incorrect", delivery)).toBeUndefined();
		const rotatedSecret = await store.rotateSecret(workspaceId, agentId, webhook.routine.id);
		expect(
			await store.acceptWebhook(webhook.routine.id, webhook.secret ?? "", delivery),
		).toBeUndefined();
		expect(
			await store.acceptWebhook(webhook.routine.id, rotatedSecret, {
				...delivery,
				idempotencyKey: "after-rotation",
			}),
		).toMatchObject({ duplicate: false });
		expect(await store.acceptWebhook("not-a-uuid", "incorrect", delivery)).toBeUndefined();
		expect(await store.list(workspaceId, agentId)).toHaveLength(2);
	});

	it("rejects system agents as Routine owners", async () => {
		const suffix = crypto.randomUUID();
		// A system agent belongs to the workspace and sits in no pod, which is
		// itself why a Routine cannot name one: a Routine runs in a pod.
		const [systemAgent] = await onDatabase((db) =>
			db
				.insert(agent)
				.values({
					workspaceId,
					podId: null,
					name: `Summariser ${suffix}`,
					handle: handleFromName(`Summariser ${suffix}`),
					color: "rose",
					face: "pill",
					model: "test/model",
					createdById: userId,
					systemAgentKey: "summarise",
				})
				.returning(),
		);
		if (!systemAgent) throw new Error("Could not create system agent");
		await expect(
			store.create(workspaceId, systemAgent.id, userId, {
				name: "Forbidden",
				instructions: "Should not run.",
				trigger: { kind: "webhook" },
			}),
		).rejects.toThrow(RoutineRequiresCrewAgent);
	});

	it("accepts a manual trigger once and keeps instructions as an execution snapshot", async () => {
		const created = await store.create(workspaceId, agentId, userId, {
			name: "Check reports",
			instructions: "Use the original instructions.",
			trigger: { kind: "webhook" },
		});
		const requestId = crypto.randomUUID();
		const trigger = {
			kind: "manual" as const,
			requestId,
			requestedAt: new Date().toISOString(),
			requestedByUserId: userId,
		};
		const input = {
			workspaceId,
			agentId,
			routineId: created.routine.id,
			triggerIdentity: requestId,
			trigger,
		};
		const [first, retried] = await Promise.all([
			store.acceptTrigger(input),
			store.acceptTrigger(input),
		]);
		const original = first.duplicate ? retried : first;
		const duplicate = first.duplicate ? first : retried;
		expect(duplicate).toEqual({ ...original, duplicate: true });
		expect(
			await onDatabase((db) => db.select().from(thread).where(eq(thread.id, original.threadId))),
		).toHaveLength(1);
		expect(
			await onDatabase((db) =>
				db.select().from(message).where(eq(message.threadId, original.threadId)),
			),
		).toHaveLength(1);

		await store.update(workspaceId, agentId, created.routine.id, {
			instructions: "Use changed instructions.",
		});
		const [execution] =
			(await store.listExecutions(workspaceId, agentId, created.routine.id))?.items ?? [];
		expect(execution?.instructions).toBe("Use the original instructions.");
	});

	it("bounds execution titles derived from maximum-length Routine names", async () => {
		const created = await store.create(workspaceId, agentId, userId, {
			name: "R".repeat(80),
			instructions: "Keep the title valid.",
			trigger: { kind: "webhook" },
		});
		const requestId = crypto.randomUUID();
		const accepted = await store.acceptTrigger({
			workspaceId,
			agentId,
			routineId: created.routine.id,
			triggerIdentity: requestId,
			trigger: {
				kind: "manual",
				requestId,
				requestedAt: new Date().toISOString(),
				requestedByUserId: userId,
			},
		});
		const [executionThread] = await onDatabase((db) =>
			db.select().from(thread).where(eq(thread.id, accepted.threadId)),
		);
		expect(executionThread?.title).toHaveLength(80);
	});

	it("rejects reuse of a trigger identity with different data", async () => {
		const created = await store.create(workspaceId, agentId, userId, {
			name: "Webhook",
			instructions: "Handle input.",
			trigger: { kind: "webhook" },
		});
		const key = "delivery-1";
		await store.acceptTrigger({
			workspaceId,
			agentId,
			routineId: created.routine.id,
			triggerIdentity: key,
			trigger: {
				kind: "webhook",
				idempotencyKey: key,
				payload: { amount: 1 },
				receivedAt: new Date().toISOString(),
			},
		});
		await expect(
			store.acceptTrigger({
				workspaceId,
				agentId,
				routineId: created.routine.id,
				triggerIdentity: key,
				trigger: {
					kind: "webhook",
					idempotencyKey: key,
					payload: { amount: 2 },
					receivedAt: new Date().toISOString(),
				},
			}),
		).rejects.toThrow(RoutineTriggerConflict);
	});

	it("runs a routine's executions in order while allowing a separate Routine to run", async () => {
		const firstRoutine = await store.create(workspaceId, agentId, userId, {
			name: "First queue",
			instructions: "Run in order.",
			trigger: { kind: "webhook" },
		});
		const secondRoutine = await store.create(workspaceId, agentId, userId, {
			name: "Second queue",
			instructions: "Run independently.",
			trigger: { kind: "webhook" },
		});
		const accepted: AcceptedRoutineExecution[] = [];
		for (const routineId of [
			firstRoutine.routine.id,
			firstRoutine.routine.id,
			secondRoutine.routine.id,
		]) {
			const requestId = crypto.randomUUID();
			accepted.push(
				await store.acceptTrigger({
					workspaceId,
					agentId,
					routineId,
					triggerIdentity: requestId,
					trigger: {
						kind: "manual",
						requestId,
						requestedAt: new Date().toISOString(),
						requestedByUserId: userId,
					},
				}),
			);
		}
		const first = await startRunning(firstRoutine.routine.id);
		const second = await startRunning(secondRoutine.routine.id);
		expect(first.execution.id).toBe(accepted[0]?.executionId);
		expect(second.execution.state).toBe("running");
		const [waiting] = await onDatabase((db) =>
			db
				.select()
				.from(routineExecution)
				.where(eq(routineExecution.id, accepted[1]?.executionId ?? "")),
		);
		expect(waiting?.state).toBe("queued");
		await finishTurnsIn(first.execution.threadId);
		expect(await store.settleRun(first.run)).toBe(true);
		await runOnPostgres(releaseRun(first.run));
		const third = await startRunning(firstRoutine.routine.id);
		expect(third.execution.id).toBe(accepted[1]?.executionId);
		const queued = await onDatabase((db) =>
			db
				.select()
				.from(routineExecution)
				.where(
					and(
						eq(routineExecution.routineId, firstRoutine.routine.id),
						eq(routineExecution.state, "queued"),
					),
				),
		);
		expect(queued).toHaveLength(0);
	});

	it.each([
		{ state: "failed" as const, collaborationStatus: "waiting" as const, error: "Model failed" },
		{ state: "cancelled" as const, collaborationStatus: "pending" as const, error: undefined },
	])(
		"settles an execution as $state despite a $collaborationStatus collaboration",
		async ({ state, collaborationStatus, error }) => {
			const fixture = await createRunningExecutionWithCollaboration(collaborationStatus);
			// Asked for while the first turn runs, so it waits in the lane.
			await runOnPostgres(
				queueTurnForTests({
					threadId: fixture.accepted.threadId,
					agentId,
					triggerMessageId: crypto.randomUUID(),
					reason: "routine",
				}),
			);

			expect(await store.settleThread(fixture.childThread.id, { state, error })).toBe(true);

			const [execution] = await onDatabase((db) =>
				db
					.select()
					.from(routineExecution)
					.where(eq(routineExecution.id, fixture.accepted.executionId)),
			);
			const [settledCollaboration] = await onDatabase((db) =>
				db.select().from(collaboration).where(eq(collaboration.id, fixture.activeCollaboration.id)),
			);
			const waitingTurns = await onDatabase((db) =>
				db
					.select()
					.from(laneRequest)
					.where(
						eq(laneRequest.laneKey, turnLane({ threadId: fixture.accepted.threadId, agentId })),
					),
			);
			expect(execution).toMatchObject({
				state,
				error: error ?? null,
				finishedAt: expect.any(Date),
			});
			expect(settledCollaboration?.status).toBe("failed");
			expect(waitingTurns).toEqual([]);
		},
	);

	it("settles without waiting on the Scribe summarising the run's thread", async () => {
		const created = await store.create(workspaceId, agentId, userId, {
			name: "Summarised run",
			instructions: "Do the work.",
			trigger: { kind: "webhook" },
		});
		const requestId = crypto.randomUUID();
		const accepted = await store.acceptTrigger({
			workspaceId,
			agentId,
			routineId: created.routine.id,
			triggerIdentity: requestId,
			trigger: {
				kind: "manual",
				requestId,
				requestedAt: new Date().toISOString(),
				requestedByUserId: userId,
			},
		});
		await startRunning(created.routine.id);
		await finishTurnsIn(accepted.threadId);
		const [triggerMessage] = await onDatabase((db) =>
			db.select({ id: message.id }).from(message).where(eq(message.threadId, accepted.threadId)),
		);
		const [summaryThread] = await onDatabase((db) =>
			db
				.insert(thread)
				.values({
					workspaceId,
					podId,
					hostAgentId: agentId,
					type: "system_agent",
					systemAgentKey: "summarise",
					title: "Summary",
					parentThreadId: accepted.threadId,
				})
				.returning(),
		);
		if (!triggerMessage || !summaryThread) throw new Error("Could not create summary thread");
		await onDatabase((db) =>
			db.insert(turn).values({
				threadId: summaryThread.id,
				agentId,
				triggerMessageId: triggerMessage.id,
				status: "running",
				model: "test/model",
				startedAt: new Date(),
			}),
		);

		expect(await store.settleThread(accepted.threadId)).toBe(true);
	});

	it("does not settle normally while execution work remains active", async () => {
		const fixture = await createRunningExecutionWithCollaboration("waiting");

		expect(await store.settleThread(fixture.childThread.id)).toBe(false);

		const [execution] = await onDatabase((db) =>
			db
				.select()
				.from(routineExecution)
				.where(eq(routineExecution.id, fixture.accepted.executionId)),
		);
		const [activeCollaboration] = await onDatabase((db) =>
			db.select().from(collaboration).where(eq(collaboration.id, fixture.activeCollaboration.id)),
		);
		expect(execution).toMatchObject({ state: "running", finishedAt: null });
		expect(activeCollaboration?.status).toBe("waiting");
	});

	it("keeps an execution running while a turn lane in its thread is busy", async () => {
		const fixture = await createRunningExecutionWithCollaboration("waiting");
		await runOnPostgres(releaseTurn(fixture.runningTurn));
		await onDatabase((db) =>
			db
				.update(collaboration)
				.set({ status: "answered" })
				.where(eq(collaboration.id, fixture.activeCollaboration.id)),
		);
		const busy = {
			key: turnLane({ threadId: fixture.childThread.id, agentId }),
			subject: fixture.childThread.id,
			workflow: Turn._tag,
			state: "running" as const,
			executionId: crypto.randomUUID(),
		};
		await onDatabase((db) => db.insert(lane).values(busy));

		expect(await store.settleThread(fixture.childThread.id)).toBe(false);

		await onDatabase((db) =>
			db
				.update(lane)
				.set({ state: "idle", workflow: null, executionId: null })
				.where(eq(lane.key, busy.key)),
		);
		expect(await store.settleThread(fixture.childThread.id)).toBe(true);
	});

	it("drops a waiting facilitation and waits for the running one when an execution ends", async () => {
		const fixture = await createRunningExecutionWithCollaboration("waiting");
		await runOnPostgres(releaseTurn(fixture.runningTurn));
		await onDatabase((db) =>
			db
				.update(collaboration)
				.set({ status: "answered" })
				.where(eq(collaboration.id, fixture.activeCollaboration.id)),
		);
		const running = { threadId: fixture.childThread.id, triggerMessageId: crypto.randomUUID() };
		await runOnPostgres(queueFacilitationForTests(running));
		await runOnPostgres(
			queueFacilitationForTests({
				threadId: fixture.childThread.id,
				triggerMessageId: crypto.randomUUID(),
			}),
		);

		expect(await store.settleThread(fixture.childThread.id)).toBe(false);
		expect(
			await store.settleThread(fixture.childThread.id, { state: "failed", error: "Model failed" }),
		).toBe(false);
		expect(await runOnPostgres(waitingFacilitation(fixture.childThread.id))).toBeUndefined();

		await runOnPostgres(releaseFacilitation(running));
		expect(await store.settleThread(fixture.childThread.id)).toBe(true);
		const [execution] = await onDatabase((db) =>
			db
				.select()
				.from(routineExecution)
				.where(eq(routineExecution.id, fixture.accepted.executionId)),
		);
		expect(execution).toMatchObject({ state: "failed", error: "Model failed" });
	});

	it("tells the workflows of waiting turns to stop when an execution ends", async () => {
		const fixture = await createRunningExecutionWithCollaboration("waiting");
		await onDatabase((db) =>
			db
				.update(turn)
				.set({ status: "waiting", owner: "workflow-execution" })
				.where(eq(turn.threadId, fixture.accepted.threadId)),
		);
		const cancel = vi.fn(() => Effect.void);
		const ending = onPostgres(
			routineStore(
				() => Effect.void,
				queueTurnForTests,
				{ decide: () => Effect.void, cancel },
				routineRunsForTests,
			),
		);

		expect(await ending.settleThread(fixture.childThread.id, { state: "cancelled" })).toBe(true);

		expect(cancel).toHaveBeenCalledWith("workflow-execution");
	});

	it("waits for a running parent turn before finalizing a child failure", async () => {
		const fixture = await createRunningExecutionWithCollaboration("waiting");
		const [parentTurn] = await onDatabase((db) =>
			db.select().from(turn).where(eq(turn.threadId, fixture.accepted.threadId)),
		);
		if (!parentTurn) throw new Error("Settlement test parent turn is missing");
		await onDatabase((db) =>
			db
				.update(turn)
				.set({ status: "running", finishedAt: null })
				.where(eq(turn.id, parentTurn.id)),
		);

		expect(
			await store.settleThread(fixture.childThread.id, {
				state: "failed",
				error: "Child model failed",
			}),
		).toBe(false);

		const [pendingExecution] = await onDatabase((db) =>
			db
				.select()
				.from(routineExecution)
				.where(eq(routineExecution.id, fixture.accepted.executionId)),
		);
		const [cancelledParentTurn] = await onDatabase((db) =>
			db.select().from(turn).where(eq(turn.id, parentTurn.id)),
		);
		expect(pendingExecution).toMatchObject({
			state: "running",
			pendingTerminalState: "failed",
			pendingTerminalError: "Child model failed",
			finishedAt: null,
		});
		expect(cancelledParentTurn?.cancelRequested).toBe(true);

		await onDatabase((db) =>
			db
				.update(turn)
				.set({ status: "cancelled", finishedAt: new Date() })
				.where(eq(turn.id, parentTurn.id)),
		);
		await runOnPostgres(releaseTurn(fixture.runningTurn));
		expect(await store.settleThread(fixture.accepted.threadId)).toBe(true);

		const [settledExecution] = await onDatabase((db) =>
			db
				.select()
				.from(routineExecution)
				.where(eq(routineExecution.id, fixture.accepted.executionId)),
		);
		expect(settledExecution).toMatchObject({
			state: "failed",
			error: "Child model failed",
			pendingTerminalState: null,
			pendingTerminalError: null,
			finishedAt: expect.any(Date),
		});
	});

	it("rejects a claimed turn after terminal settlement begins", async () => {
		const fixture = await createRunningExecutionWithCollaboration("waiting");
		const [parentTurn] = await onDatabase((db) =>
			db.select().from(turn).where(eq(turn.threadId, fixture.accepted.threadId)),
		);
		if (!parentTurn) throw new Error("Settlement test parent turn is missing");
		await onDatabase((db) =>
			db
				.update(turn)
				.set({ status: "running", finishedAt: null })
				.where(eq(turn.id, parentTurn.id)),
		);
		const [childTrigger] = await onDatabase((db) =>
			db
				.insert(message)
				.values({
					threadId: fixture.childThread.id,
					authorAgentId: agentId,
					kind: "text",
					status: "complete",
					parts: [],
					content: "Start claimed child work.",
				})
				.returning(),
		);
		if (!childTrigger) throw new Error("Could not create settlement test child trigger");
		await runOnPostgres(
			queueTurnForTests({
				threadId: fixture.childThread.id,
				agentId,
				triggerMessageId: childTrigger.id,
				reason: "collaboration",
			}),
		);
		const [claimedChild] = await runOnPostgres(runningTurns(fixture.childThread.id));
		if (!claimedChild) throw new Error("Could not start settlement test child turn");

		expect(
			await store.settleThread(fixture.childThread.id, {
				state: "failed",
				error: "Child model failed",
			}),
		).toBe(false);
		const turns = onPostgres(
			createTurnStore(
				() => Effect.void,
				queueTurnForTests,
				queueFacilitationForTests,
				turnSignalsForTests,
			),
		);
		await expect(turns.prepare(claimedChild)).rejects.toThrow("The Routine execution has ended");

		await onDatabase((db) =>
			db
				.update(turn)
				.set({ status: "cancelled", finishedAt: new Date() })
				.where(eq(turn.id, parentTurn.id)),
		);
		await runOnPostgres(releaseTurn(fixture.runningTurn));
		await runOnPostgres(releaseTurn(claimedChild));
		expect(await store.settleThread(fixture.accepted.threadId)).toBe(true);
	});

	it("serializes concurrent final workers so one settles the execution", async () => {
		const fixture = await createRunningExecutionWithCollaboration("waiting");
		const [parentTurn] = await onDatabase((db) =>
			db.select().from(turn).where(eq(turn.threadId, fixture.accepted.threadId)),
		);
		if (!parentTurn) throw new Error("Settlement test parent turn is missing");
		const [childTrigger] = await onDatabase((db) =>
			db
				.insert(message)
				.values({
					threadId: fixture.childThread.id,
					authorAgentId: agentId,
					kind: "text",
					status: "complete",
					parts: [],
					content: "Start child work.",
				})
				.returning(),
		);
		if (!childTrigger) throw new Error("Could not create settlement test child trigger");
		const [childTurn] = await onDatabase((db) =>
			db
				.insert(turn)
				.values({
					threadId: fixture.childThread.id,
					agentId,
					triggerMessageId: childTrigger.id,
					status: "running",
					model: "test/model",
					startedAt: new Date(),
				})
				.returning(),
		);
		if (!childTurn) throw new Error("Could not create settlement test child turn");
		await onDatabase((db) =>
			db
				.update(turn)
				.set({ status: "running", finishedAt: null })
				.where(eq(turn.id, parentTurn.id)),
		);
		const childFacilitation = {
			threadId: fixture.childThread.id,
			triggerMessageId: childTrigger.id,
		};
		await runOnPostgres(queueFacilitationForTests(childFacilitation));
		await onDatabase((db) =>
			db
				.update(collaboration)
				.set({ status: "failed" })
				.where(eq(collaboration.id, fixture.activeCollaboration.id)),
		);

		let arrivals = 0;
		let release: (() => void) | undefined;
		const bothWorkersFinished = new Promise<void>((resolve) => {
			release = resolve;
		});
		const finish = (
			turnId: string,
			endWork: Effect.Effect<unknown, unknown, Database>,
			threadId: string,
		) =>
			runOnPostgres(
				transaction(
					Effect.gen(function* () {
						yield* query((executor) =>
							executor
								.update(turn)
								.set({ status: "done", finishedAt: new Date() })
								.where(eq(turn.id, turnId)),
						);
						yield* endWork;
						arrivals += 1;
						if (arrivals === 2) release?.();
						yield* Effect.promise(() => bothWorkersFinished);
						return yield* routineEffects.settleThread(threadId);
					}),
				),
			);

		const results = await Promise.all([
			finish(parentTurn.id, releaseTurn(fixture.runningTurn), fixture.accepted.threadId),
			finish(childTurn.id, releaseFacilitation(childFacilitation), fixture.childThread.id),
		]);
		expect(results.sort()).toEqual([false, true]);
		const [execution] = await onDatabase((db) =>
			db
				.select()
				.from(routineExecution)
				.where(eq(routineExecution.id, fixture.accepted.executionId)),
		);
		expect(execution).toMatchObject({ state: "completed", finishedAt: expect.any(Date) });
	});

	it("accepts only the latest missed cron occurrence and advances into the future", async () => {
		const created = await store.create(workspaceId, agentId, userId, {
			name: "Quarter hourly",
			instructions: "Check recent activity.",
			trigger: { kind: "cron", expression: "*/15 * * * *", timezone: "UTC" },
		});
		await onDatabase((db) =>
			db
				.update(routine)
				.set({ nextScheduledAt: new Date("2026-09-18T10:00:00Z") })
				.where(eq(routine.id, created.routine.id)),
		);
		const now = new Date("2026-09-18T12:37:40Z");
		const accepted = await store.processNextDue(now);
		expect(accepted?.duplicate).toBe(false);
		const [execution] =
			(await store.listExecutions(workspaceId, agentId, created.routine.id))?.items ?? [];
		expect(execution?.trigger).toMatchObject({
			kind: "cron",
			scheduledAt: "2026-09-18T12:30:00.000Z",
		});
		const [updated] = await onDatabase((db) =>
			db.select().from(routine).where(eq(routine.id, created.routine.id)),
		);
		expect(updated?.nextScheduledAt?.toISOString()).toBe("2026-09-18T12:45:00.000Z");
		expect(await store.processNextDue(now)).toBeUndefined();
	});

	it("pages execution history with opaque cursors", async () => {
		const created = await store.create(workspaceId, agentId, userId, {
			name: "Paged runs",
			instructions: "Run repeatedly.",
			trigger: { kind: "webhook" },
		});
		for (let index = 0; index < 3; index += 1) {
			const requestId = crypto.randomUUID();
			await store.acceptTrigger({
				workspaceId,
				agentId,
				routineId: created.routine.id,
				triggerIdentity: requestId,
				trigger: {
					kind: "manual",
					requestId,
					requestedAt: new Date().toISOString(),
					requestedByUserId: userId,
				},
			});
		}

		const first = await store.listExecutions(workspaceId, agentId, created.routine.id, {
			limit: 2,
		});
		expect(first?.items).toHaveLength(2);
		expect(first?.nextCursor).toEqual(expect.any(String));
		if (!first?.nextCursor) throw new Error("First execution page has no cursor");
		const second = await store.listExecutions(workspaceId, agentId, created.routine.id, {
			limit: 2,
			cursor: first.nextCursor,
		});
		expect(second?.items).toHaveLength(1);
		expect(second?.nextCursor).toBeNull();
		expect(second?.items[0]?.id).not.toBe(first?.items[1]?.id);
		await expect(
			store.listExecutions(workspaceId, agentId, created.routine.id, {
				limit: 2,
				cursor: "not-a-cursor",
			}),
		).rejects.toThrow(InvalidRoutineExecutionCursor);
	});
});
