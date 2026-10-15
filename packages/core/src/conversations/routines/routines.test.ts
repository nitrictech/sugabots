import { createHmac, randomBytes, scryptSync } from "node:crypto";
import type { AcceptedRoutineExecution } from "@sugabots/contracts";
import { handleFromName, MAX_ROUTINE_TRIGGERS } from "@sugabots/contracts";
import { and, eq, sql } from "drizzle-orm";
import { Context, Effect } from "effect";
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
	routineExecution,
	routineTrigger,
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
import {
	RoutineTriggerConflict,
	RoutineTriggerKindChanged,
	RoutineTriggerNotFound,
	TooManyRoutineTriggers,
	WebhookSecretTooShort,
} from "./routine.ts";
import { RoutineRunner } from "./routine-runner.ts";
import { Routines } from "./routines.ts";
import { RoutineSettlement } from "./settlement.ts";
import { aRoutineOwner, finishTurnsIn, releaseRun, startRunning } from "./testing.ts";
import type { Delivery } from "./webhook-auth.ts";

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
	/** A JSON delivery that sends `secret` as a bearer token. */
	const bearerDelivery = (
		secret: string,
		payload: unknown = {},
		headers: Record<string, string> = {},
	): Delivery => ({
		headers: { authorization: `Bearer ${secret}`, ...headers },
		body: new TextEncoder().encode(JSON.stringify(payload)),
		payload,
	});
	let podId: string;
	let agentId: string;
	let userId: string;
	/** The routine's first trigger, addressed, and the secret this write made for it, if any. */
	const firstTriggerOf = (defined: Routines.Defined) => {
		const [trigger] = defined.routine.triggers;
		if (!trigger) throw new Error("The routine has no trigger");
		const made = defined.secrets.find((secret) => secret.triggerId === trigger.id);
		return {
			addressed: { agentId, routineId: defined.routine.id, triggerId: trigger.id },
			secret: made?.secret ?? null,
		};
	};
	/** Runs the scheduler once, as if it were `now`. */
	const processDueAt = (now: Date) =>
		runOnPostgres(
			TestClock.setTime(now.getTime()).pipe(
				Effect.andThen(Context.get(conversations, RoutineRunner.Service).processNextDue()),
				Effect.provide(TestClock.layer()),
			),
		);
	/** Makes each of the routine's schedules due at `at`. */
	const makeDue = (routineId: string, at: Date) =>
		onDatabase((db) =>
			db
				.update(routineTrigger)
				.set({ nextScheduledAt: at })
				.where(eq(routineTrigger.routineId, routineId)),
		);
	const nextTimesOf = async (routineId: string) =>
		(
			await onDatabase((db) =>
				db
					.select({ id: routineTrigger.id, nextScheduledAt: routineTrigger.nextScheduledAt })
					.from(routineTrigger)
					.where(eq(routineTrigger.routineId, routineId)),
			)
		).map(({ id, nextScheduledAt }) => ({ id, at: nextScheduledAt?.toISOString() ?? null }));

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
				triggers: [{ kind: "webhook" }],
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
				triggers: [webhook],
			},
		);
		const later = await routines.create(
			{ agentId: helper.id },
			{
				name: "Weekly report",
				instructions: "Summarise the week.",
				triggers: [webhook],
			},
		);
		const sooner = await routines.create(
			{ agentId: helper.id },
			{
				name: "Morning brief",
				instructions: "Plan the day.",
				triggers: [webhook],
			},
		);
		const removed = await routines.create(
			{ agentId: helper.id },
			{
				name: "Removed",
				instructions: "Gone.",
				triggers: [webhook],
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

	it("creates scoped cron and webhook definitions, and admits a webhook's callers by its secret", async () => {
		const cron = await routines.create(
			{ agentId },
			{
				name: "Weekday briefing",
				instructions: "Summarise the overnight changes.",
				triggers: [
					{
						kind: "cron",
						schedule: { repeat: "cron", expression: "0 9 * * 1-5" },
						timezone: "Australia/Sydney",
					},
				],
			},
		);
		expect(cron.secrets).toEqual([]);
		expect(cron.routine.triggers).toMatchObject([
			{ kind: "cron", nextScheduledAt: expect.any(String) },
		]);

		const webhook = await routines.create(
			{ agentId },
			{
				name: "Incoming alert",
				instructions: "Investigate the alert.",
				triggers: [{ kind: "webhook" }],
			},
		);
		expect(webhook.routine.triggers).toEqual([
			{ id: expect.any(String), kind: "webhook", auth: { kind: "bearer" } },
		]);
		const { addressed, secret } = firstTriggerOf(webhook);
		if (secret === null) throw new Error("A new webhook gets a secret");
		expect(secret).toMatch(/^rtb_/);
		const { triggerId } = addressed;
		const payload = { event: "created" };
		expect(
			await webhooks.accept({
				triggerId,
				delivery: bearerDelivery(secret, payload, { "idempotency-key": "definition-test" }),
			}),
		).toEqual({
			kind: "run",
			execution: {
				executionId: expect.any(String),
				threadId: expect.any(String),
				duplicate: false,
			},
		});
		expect(
			await webhooks.accept({ triggerId, delivery: bearerDelivery("incorrect", payload) }),
		).toBeUndefined();
		const rotatedSecret = await routines.rotateSecret(addressed);
		if (rotatedSecret === null) throw new Error("A rotation without a secret makes one");
		expect(
			await webhooks.accept({ triggerId, delivery: bearerDelivery(secret, payload) }),
		).toBeUndefined();
		expect(
			await webhooks.accept({
				triggerId,
				delivery: bearerDelivery(rotatedSecret, payload, { "idempotency-key": "after-rotation" }),
			}),
		).toMatchObject({ kind: "run", execution: { duplicate: false } });
		expect(
			await webhooks.accept({ triggerId: "not-a-uuid", delivery: bearerDelivery(rotatedSecret) }),
		).toBeUndefined();
		expect(await view.list({ agentId })).toHaveLength(2);
	});

	it("checks a signing routine's callers by signature, with the secret its sender made", async () => {
		const linearSecret = "lin_wh_9f2c1e5a7b3d4f60";
		const created = await routines.create(
			{ agentId },
			{
				name: "Linear issues",
				instructions: "Triage the issue.",
				triggers: [{ kind: "webhook", auth: { kind: "linear" }, secret: linearSecret }],
			},
		);
		const { triggerId } = firstTriggerOf(created).addressed;
		const body = '{"action":"create","data":{"id":"ISS-1"}}';
		const signed: Delivery = {
			headers: {
				"linear-signature": createHmac("sha256", linearSecret).update(body).digest("hex"),
				"linear-delivery": "234d1a4e-b617-4388-90fe-adc3633d6b72",
			},
			body: new TextEncoder().encode(body),
			payload: JSON.parse(body),
		};

		expect(await webhooks.accept({ triggerId, delivery: signed })).toMatchObject({
			kind: "run",
			execution: { duplicate: false },
		});
		// Linear's retry of the same delivery lands on the first run.
		expect(await webhooks.accept({ triggerId, delivery: signed })).toMatchObject({
			kind: "run",
			execution: { duplicate: true },
		});
		expect(
			await webhooks.accept({ triggerId, delivery: bearerDelivery(linearSecret) }),
		).toBeUndefined();
	});

	it("keeps a webhook's secret whatever its auth becomes", async () => {
		const created = await routines.create(
			{ agentId },
			{
				name: "Signups",
				instructions: "Look up the account.",
				triggers: [{ kind: "webhook", auth: { kind: "api_key", header: "X-API-Key" } }],
			},
		);
		const { addressed, secret } = firstTriggerOf(created);
		expect(secret).toMatch(/^sk_rt_/);
		expect(await routines.getSecret(addressed)).toEqual({ kind: "set", secret });

		const renamedHeader = await routines.updateTrigger(addressed, {
			kind: "webhook",
			auth: { kind: "api_key", header: "X-Signup-Key" },
		});
		expect(renamedHeader.secrets).toEqual([]);
		expect(
			await webhooks.accept({
				triggerId: addressed.triggerId,
				delivery: { ...bearerDelivery(""), headers: { "x-signup-key": secret ?? "" } },
			}),
		).toMatchObject({ kind: "run" });

		const basic = await routines.updateTrigger(addressed, {
			kind: "webhook",
			auth: { kind: "basic", username: "sugabots" },
		});
		expect(basic.secrets).toEqual([]);
		expect(await routines.getSecret(addressed)).toEqual({ kind: "set", secret });
		const basicAuthorization = `Basic ${Buffer.from(`sugabots:${secret}`).toString("base64")}`;
		expect(
			await webhooks.accept({
				triggerId: addressed.triggerId,
				delivery: { ...bearerDelivery(""), headers: { authorization: basicAuthorization } },
			}),
		).toMatchObject({ kind: "run" });
	});

	it("keeps a schedule picked by its parts, and works out when it runs next", async () => {
		const schedule = {
			repeat: "weekly" as const,
			every: 2,
			days: ["mon" as const, "thu" as const],
			times: [9 * 60, 17 * 60 + 30],
			startsOn: "2026-10-05",
		};
		const created = await routines.create(
			{ agentId },
			{
				name: "Fortnightly",
				instructions: "Review the fortnight.",
				triggers: [{ kind: "cron", schedule, timezone: "Australia/Sydney" }],
			},
		);

		expect(created.routine.triggers).toEqual([
			{
				id: expect.any(String),
				kind: "cron",
				schedule,
				timezone: "Australia/Sydney",
				nextScheduledAt: expect.any(String),
			},
		]);
		const [stored] = await onDatabase((db) =>
			db.select().from(routineTrigger).where(eq(routineTrigger.routineId, created.routine.id)),
		);
		expect(stored?.settings).toEqual({ kind: "cron", schedule, timezone: "Australia/Sydney" });
		expect(stored?.nextScheduledAt?.getTime()).toBeGreaterThan(Date.now());
	});

	it("swaps a routine's schedule for a webhook, and back", async () => {
		const created = await routines.create(
			{ agentId },
			{
				name: "Switching",
				instructions: "Handle it.",
				triggers: [
					{
						kind: "cron",
						schedule: { repeat: "cron", expression: "0 9 * * *" },
						timezone: "UTC",
					},
				],
			},
		);
		const schedule = firstTriggerOf(created).addressed;
		const addressed = { agentId, routineId: created.routine.id };

		const withWebhook = await routines.addTrigger(addressed, { kind: "webhook" });
		const webhook = withWebhook.routine.triggers.find((trigger) => trigger.kind === "webhook");
		expect(webhook).toEqual({ id: expect.any(String), kind: "webhook", auth: { kind: "bearer" } });
		expect(withWebhook.secrets).toEqual([
			{ triggerId: webhook?.id, secret: expect.stringMatching(/^rtb_/) },
		]);
		expect(
			(await routines.removeTrigger(schedule)).triggers.map((trigger) => trigger.kind),
		).toEqual(["webhook"]);

		const scheduled = await routines.addTrigger(addressed, {
			kind: "cron",
			schedule: { repeat: "cron", expression: "0 10 * * *" },
			timezone: "UTC",
		});
		await routines.removeTrigger({ ...addressed, triggerId: webhook?.id ?? "" });
		expect((await routines.get(addressed)).triggers).toEqual([
			expect.objectContaining({
				kind: "cron",
				schedule: { repeat: "cron", expression: "0 10 * * *" },
				nextScheduledAt: expect.any(String),
			}),
		]);
		expect(scheduled.secrets).toEqual([]);
	});

	it("runs a webhook left without a secret for whoever calls its address, until one is set", async () => {
		const created = await routines.create(
			{ agentId },
			{
				name: "Open intake",
				instructions: "Handle it.",
				triggers: [
					{
						kind: "webhook",
						auth: { kind: "hmac", header: "X-Signature", algorithm: "sha256", encoding: "hex" },
						secret: null,
					},
				],
			},
		);
		const { addressed, secret: made } = firstTriggerOf(created);
		expect(made).toBeNull();
		expect(await routines.getSecret(addressed)).toEqual({ kind: "none" });
		const unsigned = { ...bearerDelivery(""), headers: {} };
		expect(
			await webhooks.accept({ triggerId: addressed.triggerId, delivery: unsigned }),
		).toMatchObject({ kind: "run" });

		// Another auth kind doesn't make a secret for a webhook left without one.
		const asBearer = await routines.updateTrigger(addressed, {
			kind: "webhook",
			auth: { kind: "bearer" },
		});
		expect(asBearer.secrets).toEqual([]);
		expect(await routines.getSecret(addressed)).toEqual({ kind: "none" });

		const secret = "a-token-chosen-for-this-routine";
		expect(await routines.rotateSecret(addressed, secret)).toBe(secret);
		expect(
			await webhooks.accept({
				triggerId: addressed.triggerId,
				delivery: { ...unsigned, headers: { "idempotency-key": "unsigned-again" } },
			}),
		).toBeUndefined();

		expect(await routines.rotateSecret(addressed, null)).toBeNull();
		expect(await routines.getSecret(addressed)).toEqual({ kind: "none" });
	});

	it("takes a sender's secret however short, and a made-up one only when hard to guess", async () => {
		const linear = await routines.create(
			{ agentId },
			{
				name: "Linear issues",
				instructions: "Triage it.",
				triggers: [{ kind: "webhook", auth: { kind: "linear" }, secret: "lin_wh_short" }],
			},
		);
		expect(firstTriggerOf(linear).secret).toBe("lin_wh_short");

		await expect(
			routines.create(
				{ agentId },
				{
					name: "Signed alerts",
					instructions: "Handle input.",
					triggers: [
						{
							kind: "webhook",
							auth: { kind: "hmac", header: "X-Signature", algorithm: "sha256", encoding: "hex" },
							secret: "too-short",
						},
					],
				},
			),
		).rejects.toThrow(WebhookSecretTooShort);

		const bearer = await routines.create(
			{ agentId },
			{
				name: "Alerts",
				instructions: "Handle input.",
				triggers: [{ kind: "webhook", auth: { kind: "bearer" } }],
			},
		);
		const { addressed, secret } = firstTriggerOf(bearer);
		await expect(routines.rotateSecret(addressed, "too-short")).rejects.toThrow(
			WebhookSecretTooShort,
		);
		expect(await routines.getSecret(addressed)).toEqual({ kind: "set", secret });
	});

	it("still admits a bearer secret hashed before secrets were sealed", async () => {
		const created = await routines.create(
			{ agentId },
			{ name: "Old alerts", instructions: "Handle input.", triggers: [{ kind: "webhook" }] },
		);
		const { triggerId } = firstTriggerOf(created).addressed;
		const legacySecret = randomBytes(32).toString("base64url");
		const salt = randomBytes(16);
		const digest = scryptSync(legacySecret, salt, 32);
		await onDatabase((db) =>
			db
				.update(routineTrigger)
				.set({
					secretEncrypted: null,
					secretDigest: `scrypt:${salt.toString("base64url")}:${digest.toString("base64url")}`,
				})
				.where(eq(routineTrigger.id, triggerId)),
		);

		expect(
			await webhooks.accept({ triggerId, delivery: bearerDelivery(legacySecret) }),
		).toMatchObject({ kind: "run" });
		expect(
			await webhooks.accept({ triggerId, delivery: bearerDelivery("incorrect") }),
		).toBeUndefined();
	});

	it("refuses a wrong webhook secret without waiting on the routine's other triggers", async () => {
		const created = await routines.create(
			{ agentId },
			{ name: "Busy", instructions: "Handle input.", triggers: [{ kind: "webhook" }] },
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
				triggerId: firstTriggerOf(created).addressed.triggerId,
				delivery: bearerDelivery("incorrect"),
			}),
			new Promise((resolve) => setTimeout(() => resolve("still waiting"), 2_000)),
		]);
		release();
		await holding;

		expect(refused).toBeUndefined();
	});

	it("keeps a secret replaced while its webhook is being edited", async () => {
		const created = await routines.create(
			{ agentId },
			{ name: "Alerts", instructions: "Handle input.", triggers: [{ kind: "webhook" }] },
		);
		const { addressed } = firstTriggerOf(created);
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
						Effect.tap((secret) => Effect.sync(() => rotated(secret ?? ""))),
						Effect.andThen(Effect.promise(() => rotationHeld)),
					),
			).pipe(CurrentActor.provide(CurrentActor.AuthenticatedUserId.vouchedFor(userId))),
		);
		const secret = await rotatedSecret;

		const edit = routines.updateTrigger(addressed, {
			kind: "webhook",
			auth: { kind: "api_key", header: "X-Alert-Key" },
		});
		await waitUntilBlocked();
		releaseRotation();
		await Promise.all([rotation, edit]);

		expect(
			await webhooks.accept({
				triggerId: addressed.triggerId,
				delivery: { ...bearerDelivery(""), headers: { "x-alert-key": secret } },
			}),
		).toMatchObject({ kind: "run", execution: { duplicate: false } });
		expect(await routines.getSecret(addressed)).toEqual({ kind: "set", secret });
	});

	it("refuses a member who may not manage routines a run, a removal or the secret, whoever asks", async () => {
		// Called directly, with no route in front: what a new entry point that
		// forgot to check would reach.
		const created = await routines.create(
			{ agentId },
			{ name: "Nightly", instructions: "Run nightly.", triggers: [{ kind: "webhook" }] },
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
		await expect(
			routinesAs(member.id).getSecret(firstTriggerOf(created).addressed),
		).rejects.toThrow(ActionForbidden);
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
					triggers: [{ kind: "webhook" }],
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
				triggers: [{ kind: "webhook" }],
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

	it("keeps a run's result where the routine sent it when the run was accepted", async () => {
		const created = await routines.create(
			{ agentId },
			{
				name: "Morning standup",
				instructions: "Ask the team what they are working on.",
				triggers: [{ kind: "webhook" }],
			},
		);
		expect(created.routine.results).toBe("keep_in_run");
		const routine = { agentId, routineId: created.routine.id };
		const changed = await routines.update(routine, { results: "post_to_chat" });
		expect(changed.routine.results).toBe("post_to_chat");
		const accepted = await routines.run({ ...routine, requestId: crypto.randomUUID() });

		const renamed = await routines.update(routine, { name: "Daily standup" });
		await routines.update(routine, { results: "keep_in_run" });

		expect(renamed.routine.results).toBe("post_to_chat");
		const [execution] = await onDatabase((db) =>
			db
				.select({ results: routineExecution.results })
				.from(routineExecution)
				.where(eq(routineExecution.id, accepted.executionId)),
		);
		expect(execution?.results).toBe("post_to_chat");
	});

	it("bounds execution titles derived from maximum-length Routine names", async () => {
		const created = await routines.create(
			{ agentId },
			{
				name: "R".repeat(80),
				instructions: "Keep the title valid.",
				triggers: [{ kind: "webhook" }],
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
				triggers: [{ kind: "webhook" }],
			},
		);
		const { addressed, secret } = firstTriggerOf(created);
		const delivery = (amount: number) =>
			bearerDelivery(secret ?? "", { amount }, { "idempotency-key": "delivery-1" });
		await webhooks.accept({ triggerId: addressed.triggerId, delivery: delivery(1) });
		await expect(
			webhooks.accept({ triggerId: addressed.triggerId, delivery: delivery(2) }),
		).rejects.toThrow(RoutineTriggerConflict);
	});

	it("runs a routine's executions in order while allowing a separate Routine to run", async () => {
		const firstRoutine = await routines.create(
			{ agentId },
			{
				name: "First queue",
				instructions: "Run in order.",
				triggers: [{ kind: "webhook" }],
			},
		);
		const secondRoutine = await routines.create(
			{ agentId },
			{
				name: "Second queue",
				instructions: "Run independently.",
				triggers: [{ kind: "webhook" }],
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
				triggers: [
					{
						kind: "cron",
						schedule: { repeat: "cron", expression: "*/15 * * * *" },
						timezone: "UTC",
					},
				],
			},
		);
		await makeDue(created.routine.id, new Date("2026-09-18T10:00:00Z"));
		const now = new Date("2026-09-18T12:37:40Z");
		const accepted = await processDueAt(now);
		expect(accepted?.duplicate).toBe(false);
		const [execution] =
			(await view.listExecutions({ agentId, routineId: created.routine.id }))?.items ?? [];
		expect(execution?.trigger).toMatchObject({
			kind: "cron",
			scheduledAt: "2026-09-18T12:30:00.000Z",
		});
		expect(await nextTimesOf(created.routine.id)).toEqual([
			{ id: expect.any(String), at: "2026-09-18T12:45:00.000Z" },
		]);
		expect(await processDueAt(now)).toBeUndefined();
	});

	it("runs each of a routine's schedules as it falls due", async () => {
		const created = await routines.create(
			{ agentId },
			{
				name: "On the hour and half past",
				instructions: "Check recent activity.",
				triggers: [
					{ kind: "cron", schedule: { repeat: "cron", expression: "0 * * * *" }, timezone: "UTC" },
					{ kind: "cron", schedule: { repeat: "cron", expression: "30 * * * *" }, timezone: "UTC" },
				],
			},
		);
		const [onTheHour, halfPast] = created.routine.triggers;
		await makeDue(created.routine.id, new Date("2026-09-18T10:00:00Z"));
		const now = new Date("2026-09-18T12:40:00Z");

		const first = await processDueAt(now);
		const second = await processDueAt(now);

		expect(first?.duplicate).toBe(false);
		expect(second?.duplicate).toBe(false);
		expect(second?.executionId).not.toBe(first?.executionId);
		const runs = (await view.listExecutions({ agentId, routineId: created.routine.id })).items;
		const scheduledTimes = runs.map((run) =>
			run.trigger.kind === "cron" ? run.trigger.scheduledAt : run.trigger.kind,
		);
		expect(scheduledTimes.sort()).toEqual(["2026-09-18T12:00:00.000Z", "2026-09-18T12:30:00.000Z"]);
		expect(await nextTimesOf(created.routine.id)).toEqual(
			expect.arrayContaining([
				{ id: onTheHour?.id, at: "2026-09-18T13:00:00.000Z" },
				{ id: halfPast?.id, at: "2026-09-18T13:30:00.000Z" },
			]),
		);
		expect(await processDueAt(now)).toBeUndefined();
	});

	it("starts a run for each schedule due at the same time, not one for both", async () => {
		const quarterHourly = {
			kind: "cron" as const,
			schedule: { repeat: "cron" as const, expression: "*/15 * * * *" },
			timezone: "UTC",
		};
		const created = await routines.create(
			{ agentId },
			{
				name: "Twice over",
				instructions: "Check recent activity.",
				triggers: [quarterHourly, quarterHourly],
			},
		);
		await makeDue(created.routine.id, new Date("2026-09-18T10:00:00Z"));
		const now = new Date("2026-09-18T12:37:40Z");

		const first = await processDueAt(now);
		const second = await processDueAt(now);

		expect([first?.duplicate, second?.duplicate]).toEqual([false, false]);
		expect(second?.executionId).not.toBe(first?.executionId);
		const runs = (await view.listExecutions({ agentId, routineId: created.routine.id })).items;
		expect(runs.map((run) => run.trigger)).toMatchObject([
			{ kind: "cron", scheduledAt: "2026-09-18T12:30:00.000Z" },
			{ kind: "cron", scheduledAt: "2026-09-18T12:30:00.000Z" },
		]);
	});

	it("pauses every schedule of a paused routine, and schedules each again once it is enabled", async () => {
		const created = await routines.create(
			{ agentId },
			{
				name: "Morning and evening",
				instructions: "Check recent activity.",
				triggers: [
					{ kind: "cron", schedule: { repeat: "cron", expression: "0 9 * * *" }, timezone: "UTC" },
					{ kind: "cron", schedule: { repeat: "cron", expression: "0 17 * * *" }, timezone: "UTC" },
					{ kind: "webhook" },
				],
			},
		);
		const addressed = { agentId, routineId: created.routine.id };
		const nextTimes = (defined: Routines.Defined) =>
			defined.routine.triggers.flatMap((trigger) =>
				trigger.kind === "cron" ? [trigger.nextScheduledAt] : [],
			);

		const paused = await routines.update(addressed, { state: "paused" });
		expect(nextTimes(paused)).toEqual([null, null]);
		expect((await nextTimesOf(created.routine.id)).map(({ at }) => at)).toEqual([null, null, null]);

		const enabled = await routines.update(addressed, { state: "enabled" });
		expect(nextTimes(enabled)).toEqual([expect.any(String), expect.any(String)]);
		expect(nextTimes(enabled)[0]).not.toBe(nextTimes(enabled)[1]);
	});

	it("keeps each webhook of a routine to its own secret, and its own deliveries", async () => {
		const created = await routines.create(
			{ agentId },
			{
				name: "Two senders",
				instructions: "Handle input.",
				triggers: [{ kind: "webhook" }, { kind: "webhook" }],
			},
		);
		const [first, second] = created.routine.triggers;
		const secretOf = (triggerId: string | undefined) =>
			created.secrets.find((made) => made.triggerId === triggerId)?.secret ?? "";
		expect(created.secrets).toHaveLength(2);
		expect(secretOf(first?.id)).not.toBe(secretOf(second?.id));
		const delivered = (triggerId: string | undefined, secret: string) =>
			webhooks.accept({
				triggerId: triggerId ?? "",
				delivery: bearerDelivery(secret, { event: "created" }, { "idempotency-key": "shared-key" }),
			});

		expect(await delivered(first?.id, secretOf(second?.id))).toBeUndefined();
		const toFirst = await delivered(first?.id, secretOf(first?.id));
		const toSecond = await delivered(second?.id, secretOf(second?.id));

		expect(toFirst).toMatchObject({ kind: "run", execution: { duplicate: false } });
		expect(toSecond).toMatchObject({ kind: "run", execution: { duplicate: false } });
		expect(toSecond?.kind === "run" && toSecond.execution.executionId).not.toBe(
			toFirst?.kind === "run" && toFirst.execution.executionId,
		);
	});

	it("keeps a trigger to its kind", async () => {
		const created = await routines.create(
			{ agentId },
			{
				name: "Scheduled",
				instructions: "Handle it.",
				triggers: [
					{ kind: "cron", schedule: { repeat: "cron", expression: "0 9 * * *" }, timezone: "UTC" },
				],
			},
		);
		const { addressed } = firstTriggerOf(created);

		await expect(routines.updateTrigger(addressed, { kind: "webhook" })).rejects.toThrow(
			RoutineTriggerKindChanged,
		);
		expect((await routines.get(addressed)).triggers).toEqual(created.routine.triggers);
	});

	it("refuses a delivery to a webhook once it is removed from its routine", async () => {
		const created = await routines.create(
			{ agentId },
			{ name: "Short-lived", instructions: "Handle input.", triggers: [{ kind: "webhook" }] },
		);
		const { addressed, secret } = firstTriggerOf(created);

		expect((await routines.removeTrigger(addressed)).triggers).toEqual([]);

		expect(
			await webhooks.accept({
				triggerId: addressed.triggerId,
				delivery: bearerDelivery(secret ?? ""),
			}),
		).toBeUndefined();
		await expect(routines.removeTrigger(addressed)).rejects.toThrow(RoutineTriggerNotFound);
	});

	it("runs a routine without triggers only when someone runs it", async () => {
		const created = await routines.create(
			{ agentId },
			{ name: "On request", instructions: "Handle it.", triggers: [] },
		);
		expect(created).toEqual({
			routine: expect.objectContaining({ triggers: [] }),
			secrets: [],
		});

		const accepted = await routines.run({
			agentId,
			routineId: created.routine.id,
			requestId: crypto.randomUUID(),
		});

		expect(accepted.duplicate).toBe(false);
		const [execution] = await onDatabase((db) =>
			db.select().from(routineExecution).where(eq(routineExecution.id, accepted.executionId)),
		);
		expect(execution).toMatchObject({ triggerKind: "manual", triggerId: null });
	});

	it("takes no more triggers than a routine may have", async () => {
		const created = await routines.create(
			{ agentId },
			{
				name: "Crowded",
				instructions: "Handle it.",
				triggers: Array.from({ length: MAX_ROUTINE_TRIGGERS }, () => ({
					kind: "webhook" as const,
					secret: null,
				})),
			},
		);

		await expect(
			routines.addTrigger({ agentId, routineId: created.routine.id }, { kind: "webhook" }),
		).rejects.toThrow(TooManyRoutineTriggers);
	});

	it("pages execution history with opaque cursors", async () => {
		const created = await routines.create(
			{ agentId },
			{
				name: "Paged runs",
				instructions: "Run repeatedly.",
				triggers: [{ kind: "webhook" }],
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
				{ name: "Reached", instructions: "Run.", triggers: [{ kind: "webhook" }] },
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
			binding: {
				kind: "connection" as const,
				connectionId: connected.id,
				connectionRevision: 1,
				remoteToolName: "create_issue",
			},
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
						remoteToolName: pending.binding.remoteToolName,
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
