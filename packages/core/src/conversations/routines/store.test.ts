import type { AcceptedRoutineExecution } from "@sugabots/contracts";
import { handleFromName } from "@sugabots/contracts";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createEventBus } from "../../database/events/bus.ts";
import { memoryEventStore } from "../../database/events/store.ts";
import {
	agent,
	message,
	pod,
	podMember,
	routine,
	routineExecution,
	thread,
} from "../../database/schema.ts";
import { closeDatabase, onDatabase, onPostgres, runOnPostgres } from "../../database/testing.ts";
import { conversationsForTests } from "../testing.ts";
import {
	InvalidRoutineExecutionCursor,
	RoutineRequiresCrewAgent,
	RoutineTriggerConflict,
} from "./store.ts";
import { aRoutineOwner, finishTurnsIn, releaseRun, startRunning } from "./testing.ts";

describe.skipIf(!process.env.DATABASE_URL)("Routines, against Postgres", async () => {
	const conversations = await conversationsForTests(createEventBus({ store: memoryEventStore() }));
	const store = onPostgres(conversations.stores.routines);
	const settlement = onPostgres({ settleRun: conversations.settlement.settleRun });
	let workspaceId: string;
	let agentId: string;
	let userId: string;

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		({ workspaceId, agentId, userId } = await aRoutineOwner());
	});

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
		const first = await startRunning(store, firstRoutine.routine.id);
		const second = await startRunning(store, secondRoutine.routine.id);
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
		expect(await settlement.settleRun(first.run)).toBe(true);
		await runOnPostgres(releaseRun(first.run));
		const third = await startRunning(store, firstRoutine.routine.id);
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
