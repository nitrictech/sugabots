import type { AcceptedRoutineExecution } from "@sugabots/contracts";
import { handleFromName } from "@sugabots/contracts";
import { and, eq, sql } from "drizzle-orm";
import { Context, Effect, Redacted } from "effect";
import { TestClock } from "effect/testing";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ActionForbidden, ResourceHidden } from "../../authorization/access.ts";
import { CurrentActor } from "../../authorization/current-actor.ts";
import { query, transaction } from "../../database/database.ts";
import { EventBus } from "../../database/events/bus.ts";
import { EventStore } from "../../database/events/store.ts";
import {
	agent,
	connection,
	message,
	pod,
	podMember,
	routine,
	routineExecution,
	thread,
	toolCall,
	turn,
	user,
	workspace,
	workspaceMember,
} from "../../database/schema.ts";
import {
	closeDatabase,
	onDatabase,
	onPostgres,
	type Promised,
	runOnPostgres,
} from "../../database/testing.ts";
import { onPostgresAs } from "../../workspaces/testing.ts";
import { conversationsForTests } from "../testing.ts";
import {
	type PreparedTurn,
	prepareRunnable,
	replyTurnOf,
	runningTurns,
	TurnExecution,
	TurnRepository,
} from "../turns/testing.ts";
import { Turns } from "../turns/turns.ts";
import { lockTriggers } from "./acceptance.ts";
import { RoutineTriggerConflict } from "./routine.ts";
import { RoutineRunner } from "./routine-runner.ts";
import { Routines } from "./routines.ts";
import { RoutineSettlement } from "./settlement.ts";
import { aRoutineOwner, finishTurnsIn, releaseRun, startRunning } from "./testing.ts";

describe.skipIf(!process.env.DATABASE_URL)("Routines, against Postgres", async () => {
	const conversations = await conversationsForTests(
		EventBus.inProcess({ store: EventStore.inMemory() }),
	);
	const routinesAs = (userId: string) =>
		onPostgresAs(userId)(Context.get(conversations, Routines.Service));
	/** As the routines' owner, who administers their workspace. */
	let routines: Promised<Routines.Interface>;
	let view: Promised<Routines.Interface>;
	const webhooks = onPostgres(Context.get(conversations, Routines.Webhooks));
	const turns = onPostgres({ suspend: Context.get(conversations, TurnRepository.Service).suspend });
	const execution = onPostgres({
		prepare: Context.get(conversations, TurnExecution.Service).prepare,
	});
	const runner = onPostgres(Context.get(conversations, RoutineRunner.Service));
	const settlement = onPostgres({
		settleRun: Context.get(conversations, RoutineSettlement.Service).settleRun,
	});
	let workspaceId: string;
	let podId: string;
	let agentId: string;
	let userId: string;

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		({ workspaceId, podId, agentId, userId } = await aRoutineOwner());
		routines = routinesAs(userId);
		view = onPostgresAs(userId)(Context.get(conversations, Routines.Service));
	});

	// A run's history holds its routine back from being deleted on its own, but
	// not from going with its workspace.
	it("goes, runs and all, with its workspace", async () => {
		const created = await routines.create(
			{ agentId },
			{
				name: `Doomed ${crypto.randomUUID()}`,
				instructions: "Report.",
				trigger: { kind: "webhook" },
			},
		);
		await routines.run({ agentId, routineId: created.routine.id, requestId: crypto.randomUUID() });
		const runsIn = () =>
			onDatabase((db) =>
				db.select().from(routineExecution).where(eq(routineExecution.workspaceId, workspaceId)),
			);
		expect(await runsIn()).toHaveLength(1);

		await onDatabase((db) => db.delete(workspace).where(eq(workspace.id, workspaceId)));

		expect(await runsIn()).toEqual([]);
	});

	it("lists the workspace's routines on bots in pods the person reaches, by name", async () => {
		const [member] = await onDatabase((db) =>
			db
				.insert(user)
				.values({ name: "Pod member", email: `member-${crypto.randomUUID()}@example.com` })
				.returning(),
		);
		if (!member) throw new Error("Could not create the member");
		await onDatabase((db) =>
			db.insert(workspaceMember).values({ workspaceId, userId: member.id, role: "member" }),
		);
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
			db.insert(podMember).values({ workspaceId, podId: joined.id, userId: member.id }),
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
		await routines.create(
			{ agentId },
			{
				name: "Unreached",
				instructions: "In a pod this member is not in.",
				trigger: webhook,
			},
		);
		const later = await routines.create(
			{ agentId: helper.id },
			{
				name: "Weekly report",
				instructions: "Summarise the week.",
				trigger: webhook,
			},
		);
		const sooner = await routines.create(
			{ agentId: helper.id },
			{
				name: "Morning brief",
				instructions: "Plan the day.",
				trigger: webhook,
			},
		);
		const removed = await routines.create(
			{ agentId: helper.id },
			{
				name: "Removed",
				instructions: "Gone.",
				trigger: webhook,
			},
		);
		await routines.remove({ agentId: helper.id, routineId: removed.routine.id });

		const listed = await onPostgresAs(member.id)(
			Context.get(conversations, Routines.Service),
		).listInWorkspace(workspaceId);

		expect(listed.map((item) => item.routine.id)).toEqual([sooner.routine.id, later.routine.id]);
		expect(listed[0]?.agent).toMatchObject({ id: helper.id, name: "Joined Agent", color: "sky" });
		expect(listed[0]?.pod).toEqual({ id: joined.id, slug: joined.slug });
	});

	it("creates scoped cron and webhook definitions without exposing secret hashes", async () => {
		const cron = await routines.create(
			{ agentId },
			{
				name: "Weekday briefing",
				instructions: "Summarise the overnight changes.",
				trigger: { kind: "cron", expression: "0 9 * * 1-5", timezone: "Australia/Sydney" },
			},
		);
		expect(cron.secret).toBeNull();
		expect(cron.routine.trigger).toMatchObject({
			kind: "cron",
			nextScheduledAt: expect.any(String),
		});

		const webhook = await routines.create(
			{ agentId },
			{
				name: "Incoming alert",
				instructions: "Investigate the alert.",
				trigger: { kind: "webhook" },
			},
		);
		expect(webhook.secret).toHaveLength(43);
		const delivery = {
			kind: "webhook" as const,
			idempotencyKey: "definition-test",
			payload: { event: "created" },
			receivedAt: new Date().toISOString(),
		};
		expect(
			await webhooks.accept({
				routineId: webhook.routine.id,
				secret: Redacted.make(webhook.secret ?? ""),
				trigger: delivery,
			}),
		).toEqual({
			executionId: expect.any(String),
			threadId: expect.any(String),
			duplicate: false,
		});
		expect(
			await webhooks.accept({
				routineId: webhook.routine.id,
				secret: Redacted.make("incorrect"),
				trigger: delivery,
			}),
		).toBeUndefined();
		const rotatedSecret = await routines.rotateSecret({ agentId, routineId: webhook.routine.id });
		expect(
			await webhooks.accept({
				routineId: webhook.routine.id,
				secret: Redacted.make(webhook.secret ?? ""),
				trigger: delivery,
			}),
		).toBeUndefined();
		expect(
			await webhooks.accept({
				routineId: webhook.routine.id,
				secret: Redacted.make(rotatedSecret),
				trigger: { ...delivery, idempotencyKey: "after-rotation" },
			}),
		).toMatchObject({ duplicate: false });
		expect(
			await webhooks.accept({
				routineId: "not-a-uuid",
				secret: Redacted.make("incorrect"),
				trigger: delivery,
			}),
		).toBeUndefined();
		expect(await view.list({ agentId })).toHaveLength(2);
	});

	it("refuses a wrong webhook secret without waiting on the routine's other triggers", async () => {
		const created = await routines.create(
			{ agentId },
			{ name: "Busy", instructions: "Handle input.", trigger: { kind: "webhook" } },
		);
		let release = () => {};
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		let locked = () => {};
		const lockHeld = new Promise<void>((resolve) => {
			locked = resolve;
		});
		const holding = runOnPostgres(
			transaction(
				lockTriggers(created.routine.id).pipe(
					Effect.tap(() => Effect.sync(locked)),
					Effect.andThen(Effect.promise(() => released)),
				),
			),
		);
		await lockHeld;

		const refused = await Promise.race([
			webhooks.accept({
				routineId: created.routine.id,
				secret: Redacted.make("incorrect"),
				trigger: {
					kind: "webhook",
					idempotencyKey: null,
					payload: {},
					receivedAt: new Date().toISOString(),
				},
			}),
			new Promise((resolve) => setTimeout(() => resolve("still waiting"), 2_000)),
		]);
		release();
		await holding;

		expect(refused).toBeUndefined();
	});

	it("keeps a secret replaced while the routine is being edited", async () => {
		const created = await routines.create(
			{ agentId },
			{ name: "Alerts", instructions: "Handle input.", trigger: { kind: "webhook" } },
		);
		const addressed = { agentId, routineId: created.routine.id };
		let releaseRotation = () => {};
		const rotationHeld = new Promise<void>((resolve) => {
			releaseRotation = resolve;
		});
		let rotated = (_secret: string) => {};
		const rotatedSecret = new Promise<string>((resolve) => {
			rotated = resolve;
		});
		// The new secret is written but not committed until the edit is waiting.
		const rotation = runOnPostgres(
			transaction(
				Context.get(conversations, Routines.Service)
					.rotateSecret(addressed)
					.pipe(
						Effect.tap((secret) => Effect.sync(() => rotated(secret))),
						Effect.andThen(Effect.promise(() => rotationHeld)),
					),
			).pipe(CurrentActor.provide(CurrentActor.AuthenticatedUserId.vouchedFor(userId))),
		);
		const secret = await rotatedSecret;

		const edit = routines.update(addressed, { name: "Renamed alerts" });
		await waitUntilBlocked();
		releaseRotation();
		await Promise.all([rotation, edit]);

		const delivery = {
			kind: "webhook" as const,
			idempotencyKey: null,
			payload: {},
			receivedAt: new Date().toISOString(),
		};
		expect(
			await webhooks.accept({
				routineId: created.routine.id,
				secret: Redacted.make(secret),
				trigger: delivery,
			}),
		).toMatchObject({
			duplicate: false,
		});
		expect(await view.get(addressed)).toMatchObject({ name: "Renamed alerts" });
	});

	it("refuses a run to a member who may not run routines, whoever asks for it", async () => {
		// Called directly, with no route in front: what a new entry point that
		// forgot to check would reach.
		const created = await routines.create(
			{ agentId },
			{ name: "Nightly", instructions: "Run nightly.", trigger: { kind: "webhook" } },
		);
		const [member] = await onDatabase((db) =>
			db
				.insert(user)
				.values({ name: "Pod member", email: `member-${crypto.randomUUID()}@example.com` })
				.returning(),
		);
		if (!member) throw new Error("Could not create the member");
		await onDatabase((db) =>
			db.insert(workspaceMember).values({ workspaceId, userId: member.id, role: "member" }),
		);
		await onDatabase((db) =>
			db.insert(podMember).values({ workspaceId, podId, userId: member.id }),
		);
		const routine = { agentId, routineId: created.routine.id };

		await expect(
			routinesAs(member.id).run({ ...routine, requestId: crypto.randomUUID() }),
		).rejects.toThrow(ActionForbidden);
		await expect(routinesAs(member.id).remove(routine)).rejects.toThrow(ActionForbidden);
		expect((await view.listExecutions(routine))?.items).toEqual([]);
	});

	it("hides a system agent, which sits in no pod, from a Routine", async () => {
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
			routines.create(
				{ agentId: systemAgent.id },
				{
					name: "Forbidden",
					instructions: "Should not run.",
					trigger: { kind: "webhook" },
				},
			),
		).rejects.toThrow(ResourceHidden);
	});

	it("accepts a manual trigger once and keeps instructions as an execution snapshot", async () => {
		const created = await routines.create(
			{ agentId },
			{
				name: "Check reports",
				instructions: "Use the original instructions.",
				trigger: { kind: "webhook" },
			},
		);
		const input = { agentId, routineId: created.routine.id, requestId: crypto.randomUUID() };
		const [first, retried] = await Promise.all([routines.run(input), routines.run(input)]);
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

		await routines.update(
			{ agentId, routineId: created.routine.id },
			{
				instructions: "Use changed instructions.",
			},
		);
		const [execution] =
			(await view.listExecutions({ agentId, routineId: created.routine.id }))?.items ?? [];
		expect(execution?.instructions).toBe("Use the original instructions.");
	});

	it("bounds execution titles derived from maximum-length Routine names", async () => {
		const created = await routines.create(
			{ agentId },
			{
				name: "R".repeat(80),
				instructions: "Keep the title valid.",
				trigger: { kind: "webhook" },
			},
		);
		const requestId = crypto.randomUUID();
		const accepted = await routines.run({ agentId, routineId: created.routine.id, requestId });
		const [executionThread] = await onDatabase((db) =>
			db.select().from(thread).where(eq(thread.id, accepted.threadId)),
		);
		expect(executionThread?.title).toHaveLength(80);
	});

	it("rejects reuse of a trigger identity with different data", async () => {
		const created = await routines.create(
			{ agentId },
			{
				name: "Webhook",
				instructions: "Handle input.",
				trigger: { kind: "webhook" },
			},
		);
		const delivery = (amount: number) => ({
			kind: "webhook" as const,
			idempotencyKey: "delivery-1",
			payload: { amount },
			receivedAt: new Date().toISOString(),
		});
		await webhooks.accept({
			routineId: created.routine.id,
			secret: Redacted.make(created.secret ?? ""),
			trigger: delivery(1),
		});
		await expect(
			webhooks.accept({
				routineId: created.routine.id,
				secret: Redacted.make(created.secret ?? ""),
				trigger: delivery(2),
			}),
		).rejects.toThrow(RoutineTriggerConflict);
	});

	it("runs a routine's executions in order while allowing a separate Routine to run", async () => {
		const firstRoutine = await routines.create(
			{ agentId },
			{
				name: "First queue",
				instructions: "Run in order.",
				trigger: { kind: "webhook" },
			},
		);
		const secondRoutine = await routines.create(
			{ agentId },
			{
				name: "Second queue",
				instructions: "Run independently.",
				trigger: { kind: "webhook" },
			},
		);
		const accepted: AcceptedRoutineExecution[] = [];
		for (const routineId of [
			firstRoutine.routine.id,
			firstRoutine.routine.id,
			secondRoutine.routine.id,
		]) {
			const requestId = crypto.randomUUID();
			accepted.push(await routines.run({ agentId, routineId, requestId }));
		}
		const first = await startRunning(runner, firstRoutine.routine.id);
		const second = await startRunning(runner, secondRoutine.routine.id);
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
		const third = await startRunning(runner, firstRoutine.routine.id);
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
		const created = await routines.create(
			{ agentId },
			{
				name: "Quarter hourly",
				instructions: "Check recent activity.",
				trigger: { kind: "cron", expression: "*/15 * * * *", timezone: "UTC" },
			},
		);
		await onDatabase((db) =>
			db
				.update(routine)
				.set({ nextScheduledAt: new Date("2026-09-18T10:00:00Z") })
				.where(eq(routine.id, created.routine.id)),
		);
		const processDueAt = (now: Date) =>
			runOnPostgres(
				TestClock.setTime(now.getTime()).pipe(
					Effect.andThen(Context.get(conversations, RoutineRunner.Service).processNextDue()),
					Effect.provide(TestClock.layer()),
				),
			);
		const now = new Date("2026-09-18T12:37:40Z");
		const accepted = await processDueAt(now);
		expect(accepted?.duplicate).toBe(false);
		const [execution] =
			(await view.listExecutions({ agentId, routineId: created.routine.id }))?.items ?? [];
		expect(execution?.trigger).toMatchObject({
			kind: "cron",
			scheduledAt: "2026-09-18T12:30:00.000Z",
		});
		const [updated] = await onDatabase((db) =>
			db.select().from(routine).where(eq(routine.id, created.routine.id)),
		);
		expect(updated?.nextScheduledAt?.toISOString()).toBe("2026-09-18T12:45:00.000Z");
		expect(await processDueAt(now)).toBeUndefined();
	});

	it("pages execution history with opaque cursors", async () => {
		const created = await routines.create(
			{ agentId },
			{
				name: "Paged runs",
				instructions: "Run repeatedly.",
				trigger: { kind: "webhook" },
			},
		);
		for (let index = 0; index < 3; index += 1) {
			const requestId = crypto.randomUUID();
			await routines.run({ agentId, routineId: created.routine.id, requestId });
		}

		const first = await view.listExecutions(
			{ agentId, routineId: created.routine.id },
			{
				limit: 2,
			},
		);
		expect(first?.items).toHaveLength(2);
		expect(first?.nextCursor).toEqual(expect.any(String));
		if (!first?.nextCursor) throw new Error("First execution page has no cursor");
		const second = await view.listExecutions(
			{ agentId, routineId: created.routine.id },
			{
				limit: 2,
				cursor: first.nextCursor,
			},
		);
		expect(second?.items).toHaveLength(1);
		expect(second?.nextCursor).toBeNull();
		expect(second?.items[0]?.id).not.toBe(first?.items[1]?.id);
		await expect(
			view.listExecutions(
				{ agentId, routineId: created.routine.id },
				{
					limit: 2,
					cursor: "not-a-cursor",
				},
			),
		).rejects.toThrow(Routines.InvalidRoutineExecutionCursor);
	});

	describe("who reaches a routine", () => {
		/** A person with `role` in the workspace, and in the routine's pod if `inPod`. */
		const somebody = async (role: "admin" | "member", inPod: boolean) => {
			const [person] = await onDatabase((db) =>
				db
					.insert(user)
					.values({ name: role, email: `${role}-${crypto.randomUUID()}@example.com` })
					.returning(),
			);
			if (!person) throw new Error("Could not create the person");
			await onDatabase((db) =>
				db.insert(workspaceMember).values({ workspaceId, userId: person.id, role }),
			);
			if (inPod) {
				await onDatabase((db) =>
					db.insert(podMember).values({ workspaceId, podId, userId: person.id }),
				);
			}
			return person.id;
		};
		const aRoutineWithARun = async () => {
			const created = await routines.create(
				{ agentId },
				{ name: "Reached", instructions: "Run.", trigger: { kind: "webhook" } },
			);
			const routine = { agentId, routineId: created.routine.id };
			await routines.run({ ...routine, requestId: crypto.randomUUID() });
			return routine;
		};
		const viewAs = (personId: string) =>
			onPostgresAs(personId)(Context.get(conversations, Routines.Service));

		it("lets an administrator read a routine and its history in a pod they are not in", async () => {
			const routine = await aRoutineWithARun();
			const admin = viewAs(await somebody("admin", false));

			expect((await admin.listExecutions(routine)).items).toHaveLength(1);
			expect(await admin.get(routine)).toMatchObject({ id: routine.routineId });
			expect(await admin.list({ agentId })).toHaveLength(1);
		});

		it("hides a routine and its history from a member outside its pod", async () => {
			const routine = await aRoutineWithARun();
			const outsider = viewAs(await somebody("member", false));

			await expect(outsider.listExecutions(routine)).rejects.toThrow(ResourceHidden);
			await expect(outsider.get(routine)).rejects.toThrow(ResourceHidden);
			await expect(outsider.list({ agentId })).rejects.toThrow(ResourceHidden);
		});

		it("refuses a member the approval a routine's run asks for, which only an administrator gives", async () => {
			const routine = await aRoutineWithARun();
			await startRunning(runner, routine.routineId);
			const [executionThread] = await onDatabase((db) =>
				db
					.select({ id: routineExecution.threadId })
					.from(routineExecution)
					.where(eq(routineExecution.routineId, routine.routineId)),
			);
			if (!executionThread) throw new Error("The run has no thread");
			const [run] = await runOnPostgres(runningTurns(executionThread.id));
			if (!run) throw new Error("The run asked for no turn");
			const prepared = await prepareRunnable(execution, run);
			const pending = await parkForApproval(prepared);
			const decision = { podId, toolCallId: pending.id, decision: "allow_once" as const };
			const approvalsAs = (personId: string) =>
				onPostgresAs(personId)(Context.get(conversations, Turns.Controls));

			await expect(
				approvalsAs(await somebody("member", true)).decide(decision),
			).rejects.toBeInstanceOf(Turns.ToolApprovalForbidden);
			const [undecided] = await onDatabase((db) =>
				db.select().from(toolCall).where(eq(toolCall.id, pending.id)),
			);
			expect(undecided).toMatchObject({ approvalStatus: "pending", decidedById: null });
		});

		it("decides a run's approval without waiting on its turn, which settling locks first", async () => {
			const routine = await aRoutineWithARun();
			await startRunning(runner, routine.routineId);
			const [executionThread] = await onDatabase((db) =>
				db
					.select({ id: routineExecution.threadId })
					.from(routineExecution)
					.where(eq(routineExecution.routineId, routine.routineId)),
			);
			if (!executionThread) throw new Error("The run has no thread");
			const [run] = await runOnPostgres(runningTurns(executionThread.id));
			if (!run) throw new Error("The run asked for no turn");
			const prepared = await prepareRunnable(execution, run);
			const pending = await parkForApproval(prepared);
			let releaseTurn = () => {};
			const turnHeld = new Promise<void>((resolve) => {
				releaseTurn = resolve;
			});
			let locked = () => {};
			const turnLocked = new Promise<void>((resolve) => {
				locked = resolve;
			});
			const holding = runOnPostgres(
				transaction(
					Effect.gen(function* () {
						yield* query((db) =>
							db.select().from(turn).where(eq(turn.id, prepared.turnId)).for("update"),
						);
						locked();
						yield* Effect.promise(() => turnHeld);
					}),
				),
			);
			await turnLocked;

			const decided = await Promise.race([
				onPostgresAs(userId)(Context.get(conversations, Turns.Controls))
					.decide({ podId, toolCallId: pending.id, decision: "allow_once" })
					.then(() => "decided"),
				new Promise((resolve) => setTimeout(() => resolve("still waiting"), 2_000)),
			]);
			releaseTurn();
			await holding;

			expect(decided).toBe("decided");
		});
	});

	/** Waits until another connection to the test database is waiting on a lock. */
	async function waitUntilBlocked() {
		for (let attempt = 0; attempt < 100; attempt++) {
			const [waiting] = await onDatabase((db) =>
				db.execute<{ count: number }>(
					sql`select count(*)::int as count from pg_stat_activity
						where datname = current_database() and wait_event_type = 'Lock'`,
					"objects",
				),
			);
			if ((waiting?.count ?? 0) > 0) return;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		throw new Error("Nothing waited on a lock");
	}

	/** Parks one call to a new connection in the pod for approval, as the turn's reply. */
	async function parkForApproval(prepared: PreparedTurn) {
		const [connected] = await onDatabase((db) =>
			db
				.insert(connection)
				.values({
					workspaceId,
					podId,
					name: `Linear ${crypto.randomUUID()}`,
					handle: `linear-${crypto.randomUUID().slice(0, 8)}`,
					url: "https://linear.example.com/mcp",
					authKind: "header",
					createdById: userId,
				})
				.returning({ id: connection.id }),
		);
		if (!connected) throw new Error("Could not create the connection");
		const pending = {
			id: crypto.randomUUID(),
			approvalId: `approval-${crypto.randomUUID()}`,
			sdkToolCallId: "sdk-routine",
			tool: "linear__create_issue",
			input: { title: "From the routine" },
			connectionId: connected.id,
			connectionRevision: 1,
			remoteToolName: "create_issue",
			mutating: true,
			atOffset: 0,
		};
		const parked = await turns.suspend(
			replyTurnOf(prepared),
			{
				messages: [],
				approvals: [
					{
						approvalId: pending.approvalId,
						tool: pending.tool,
						connectionId: connected.id,
						connectionRevision: 1,
						remoteToolName: pending.remoteToolName,
					},
				],
				modelInput: { model: "test", system: "test", messages: [] },
				reply: { content: "", collaborations: [], toolCalls: [{ id: pending.id, atOffset: 0 }] },
				modelCalls: 1,
			},
			[pending],
		);
		if (!parked) throw new Error("The turn did not park");
		return pending;
	}
});
