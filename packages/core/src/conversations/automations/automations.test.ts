import { createHmac, randomBytes, scryptSync } from "node:crypto";
import type { AcceptedRun } from "@sugabots/contracts";
import { handleFromName, MAX_AUTOMATION_TRIGGERS } from "@sugabots/contracts";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Context, Effect } from "effect";
import { TestClock } from "effect/testing";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ActionForbidden, ResourceHidden } from "../../authorization/access.ts";
import { CurrentActor } from "../../authorization/current-actor.ts";
import { query, transaction } from "../../database/database.ts";
import { EventBus } from "../../database/events/bus.ts";
import { EventStore } from "../../database/events/store.ts";
import {
	automationRun,
	automationTrigger,
	bot,
	connection,
	conversation,
	message,
	placedConversation,
	project,
	projectBot,
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
	AutomationTriggerConflict,
	AutomationTriggerKindChanged,
	AutomationTriggerNotFound,
	TooManyAutomationTriggers,
	WebhookDeliveryIdHeaderRejected,
	WebhookSecretTooShort,
} from "./automation.ts";
import { AutomationRunner } from "./automation-runner.ts";
import { Automations } from "./automations.ts";
import { AutomationSettlement } from "./settlement.ts";
import {
	anAutomationOwner,
	defaultProjectOf,
	finishTurnsIn,
	releaseRun,
	startRunning,
} from "./testing.ts";
import type { Delivery } from "./webhook-auth.ts";

describe.skipIf(!process.env.DATABASE_URL)("Automations, against Postgres", async () => {
	const conversations = await conversationsForTests(
		EventBus.inProcess({ store: EventStore.inMemory() }),
	);
	const automationsAs = (userId: string) =>
		onPostgresAs(userId)(Context.get(conversations, Automations.Service));
	/** As the automations' owner, who administers their workspace. */
	let automations: Promised<Automations.Interface>;
	let view: Promised<Automations.Interface>;
	const webhooks = onPostgres(Context.get(conversations, Automations.Webhooks));
	const turns = onPostgres({ suspend: Context.get(conversations, TurnRepository.Service).suspend });
	const execution = onPostgres({
		prepare: Context.get(conversations, TurnExecution.Service).prepare,
	});
	const runner = onPostgres(Context.get(conversations, AutomationRunner.Service));
	const settlement = onPostgres({
		settleRun: Context.get(conversations, AutomationSettlement.Service).settleRun,
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
	let botId: string;
	let ownProjectId: string;
	let projectId: string;
	let userId: string;
	/** Makes the bot private, so only its creator reaches it. */
	const makePrivate = (id: string) =>
		onDatabase((db) => db.update(bot).set({ visibility: "private" }).where(eq(bot.id, id)));
	/** The automation's first trigger, addressed, and the secret this write made for it, if any. */
	const firstTriggerOf = (defined: Automations.Defined) => {
		const [trigger] = defined.automation.triggers;
		if (!trigger) throw new Error("The automation has no trigger");
		const made = defined.secrets.find((secret) => secret.triggerId === trigger.id);
		return {
			addressed: {
				projectId: ownProjectId,
				automationId: defined.automation.id,
				triggerId: trigger.id,
			},
			secret: made?.secret ?? null,
		};
	};
	/** Runs the scheduler once, as if it were `now`. */
	const processDueAt = (now: Date) =>
		runOnPostgres(
			TestClock.setTime(now.getTime()).pipe(
				Effect.andThen(Context.get(conversations, AutomationRunner.Service).processNextDue()),
				Effect.provide(TestClock.layer()),
			),
		);
	/** Makes each of the automation's routines due at `at`. */
	const makeDue = (automationId: string, at: Date) =>
		onDatabase((db) =>
			db
				.update(automationTrigger)
				.set({ nextScheduledAt: at })
				.where(eq(automationTrigger.automationId, automationId)),
		);
	const nextTimesOf = async (automationId: string) =>
		(
			await onDatabase((db) =>
				db
					.select({ id: automationTrigger.id, nextScheduledAt: automationTrigger.nextScheduledAt })
					.from(automationTrigger)
					.where(eq(automationTrigger.automationId, automationId)),
			)
		).map(({ id, nextScheduledAt }) => ({ id, at: nextScheduledAt?.toISOString() ?? null }));

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		({ workspaceId, botId, userId, ownProjectId, projectId } = await anAutomationOwner());
		automations = automationsAs(userId);
		view = onPostgresAs(userId)(Context.get(conversations, Automations.Service));
	});

	// A run's history holds its automation back from being deleted on its own, but
	// not from going with its workspace.
	it("goes, runs and all, with its workspace", async () => {
		const created = await automations.create(
			{ projectId: ownProjectId },
			{
				name: `Doomed ${crypto.randomUUID()}`,
				instructions: "Report.",
				triggers: [{ kind: "webhook" }],
			},
		);
		await automations.run({
			projectId: ownProjectId,
			automationId: created.automation.id,
			requestId: crypto.randomUUID(),
		});
		const runsIn = () =>
			onDatabase((db) =>
				db.select().from(automationRun).where(eq(automationRun.workspaceId, workspaceId)),
			);
		expect(await runsIn()).toHaveLength(1);

		await onDatabase((db) => db.delete(workspace).where(eq(workspace.id, workspaceId)));

		expect(await runsIn()).toEqual([]);
	});

	it("lists the workspace's automations on bots the person reaches, by name", async () => {
		const [member] = await onDatabase((db) =>
			db
				.insert(user)
				.values({ name: "Member", email: `member-${crypto.randomUUID()}@example.com` })
				.returning(),
		);
		if (!member) throw new Error("Could not create the member");
		await onDatabase((db) =>
			db.insert(workspaceMember).values({ workspaceId, userId: member.id, role: "member" }),
		);
		await makePrivate(botId);
		const [helper] = await onDatabase((db) =>
			db
				.insert(bot)
				.values({
					workspaceId,
					name: "Joined Bot",
					handle: handleFromName(`Joined Bot ${crypto.randomUUID()}`),
					color: "sky",
					face: "dot",
					model: "test/model",
					createdById: userId,
				})
				.returning(),
		);
		if (!helper) throw new Error("Could not create the joined bot");
		const helperProjectId = await defaultProjectOf(helper.id);
		const webhook = { kind: "webhook" as const };
		await automations.create(
			{ projectId: ownProjectId },
			{
				name: "Unreached",
				instructions: "On a private bot this member did not make.",
				triggers: [webhook],
			},
		);
		const later = await automations.create(
			{ projectId: helperProjectId },
			{
				name: "Weekly report",
				instructions: "Summarise the week.",
				triggers: [webhook],
			},
		);
		const sooner = await automations.create(
			{ projectId: helperProjectId },
			{
				name: "Morning brief",
				instructions: "Plan the day.",
				triggers: [webhook],
			},
		);
		const removed = await automations.create(
			{ projectId: helperProjectId },
			{
				name: "Removed",
				instructions: "Gone.",
				triggers: [webhook],
			},
		);
		await automations.remove({ projectId: helperProjectId, automationId: removed.automation.id });

		const listed = await onPostgresAs(member.id)(
			Context.get(conversations, Automations.Service),
		).listInWorkspace(workspaceId);

		expect(listed.map((item) => item.automation.id)).toEqual([
			sooner.automation.id,
			later.automation.id,
		]);
		expect(listed[0]?.bot).toMatchObject({ id: helper.id, name: "Joined Bot", color: "sky" });
	});

	it("creates scoped automations started by a routine or a webhook, and admits a webhook's callers by its secret", async () => {
		const scheduled = await automations.create(
			{ projectId: ownProjectId },
			{
				name: "Weekday briefing",
				instructions: "Summarise the overnight changes.",
				triggers: [
					{
						kind: "routine",
						schedule: { repeat: "cron", expression: "0 9 * * 1-5" },
						timezone: "Australia/Sydney",
					},
				],
			},
		);
		expect(scheduled.secrets).toEqual([]);
		expect(scheduled.automation.triggers).toMatchObject([
			{ kind: "routine", nextScheduledAt: expect.any(String) },
		]);

		const webhook = await automations.create(
			{ projectId: ownProjectId },
			{
				name: "Incoming alert",
				instructions: "Investigate the alert.",
				triggers: [{ kind: "webhook" }],
			},
		);
		expect(webhook.automation.triggers).toEqual([
			{
				id: expect.any(String),
				kind: "webhook",
				auth: { kind: "bearer" },
			},
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
			run: {
				runId: expect.any(String),
				conversationId: expect.any(String),
				duplicate: false,
			},
		});
		expect(
			await webhooks.accept({ triggerId, delivery: bearerDelivery("incorrect", payload) }),
		).toBeUndefined();
		const rotatedSecret = await automations.rotateSecret(addressed);
		if (rotatedSecret === null) throw new Error("A rotation without a secret makes one");
		expect(
			await webhooks.accept({ triggerId, delivery: bearerDelivery(secret, payload) }),
		).toBeUndefined();
		expect(
			await webhooks.accept({
				triggerId,
				delivery: bearerDelivery(rotatedSecret, payload, { "idempotency-key": "after-rotation" }),
			}),
		).toMatchObject({ kind: "run", run: { duplicate: false } });
		expect(
			await webhooks.accept({ triggerId: "not-a-uuid", delivery: bearerDelivery(rotatedSecret) }),
		).toBeUndefined();
		expect(await view.list({ projectId: ownProjectId })).toHaveLength(2);
	});

	it("runs only the calls meeting a webhook's filter, which a later write keeps unless it brings another", async () => {
		const filter = [{ path: "data.labels.name", oneOf: ["10x"] }];
		const created = await automations.create(
			{ projectId: ownProjectId },
			{
				name: "Labelled issues",
				instructions: "Pick up the issue.",
				triggers: [{ kind: "webhook", filter }],
			},
		);
		expect(created.automation.triggers).toMatchObject([{ kind: "webhook", filter }]);
		const { addressed, secret } = firstTriggerOf(created);
		const { triggerId } = addressed;
		const send = (payload: unknown) =>
			webhooks.accept({ triggerId, delivery: bearerDelivery(secret ?? "", payload) });
		const labelled = { data: { labels: [{ name: "10x" }] } };
		const unlabelled = { data: { labels: [{ name: "bug" }] } };

		expect(await send(labelled)).toMatchObject({ kind: "run" });
		expect(await send(unlabelled)).toEqual({ kind: "ignored" });

		await automations.updateTrigger(addressed, { kind: "webhook", auth: { kind: "bearer" } });
		expect(await send(unlabelled)).toEqual({ kind: "ignored" });

		const cleared = await automations.updateTrigger(addressed, { kind: "webhook", filter: [] });
		expect(cleared.automation.triggers[0]).not.toHaveProperty("filter");
		expect(await send(unlabelled)).toMatchObject({ kind: "run" });
	});

	it("answers a call with the wrong secret the same whether or not its filter would turn it away", async () => {
		const created = await automations.create(
			{ projectId: ownProjectId },
			{
				name: "Filtered and secret",
				instructions: "Handle it.",
				triggers: [{ kind: "webhook", filter: [{ path: "action", oneOf: ["create"] }] }],
			},
		);
		const { triggerId } = firstTriggerOf(created).addressed;
		for (const payload of [{ action: "create" }, { action: "remove" }]) {
			expect(
				await webhooks.accept({ triggerId, delivery: bearerDelivery("incorrect", payload) }),
			).toBeUndefined();
		}
	});

	it("checks a signing automation's callers by signature, with the secret its sender made", async () => {
		const linearSecret = "lin_wh_9f2c1e5a7b3d4f60";
		const created = await automations.create(
			{ projectId: ownProjectId },
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
			run: { duplicate: false },
		});
		// Linear's retry of the same delivery lands on the first run.
		expect(await webhooks.accept({ triggerId, delivery: signed })).toMatchObject({
			kind: "run",
			run: { duplicate: true },
		});
		expect(
			await webhooks.accept({ triggerId, delivery: bearerDelivery(linearSecret) }),
		).toBeUndefined();
	});

	it("keeps a webhook's secret whatever its auth becomes", async () => {
		const created = await automations.create(
			{ projectId: ownProjectId },
			{
				name: "Signups",
				instructions: "Look up the account.",
				triggers: [{ kind: "webhook", auth: { kind: "api_key", header: "X-API-Key" } }],
			},
		);
		const { addressed, secret } = firstTriggerOf(created);
		expect(secret).toMatch(/^sk_rt_/);
		expect(await automations.getSecret(addressed)).toEqual({ kind: "set", secret });

		const renamedHeader = await automations.updateTrigger(addressed, {
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

		const basic = await automations.updateTrigger(addressed, {
			kind: "webhook",
			auth: { kind: "basic", username: "sugabots" },
		});
		expect(basic.secrets).toEqual([]);
		expect(await automations.getSecret(addressed)).toEqual({ kind: "set", secret });
		const basicAuthorization = `Basic ${Buffer.from(`sugabots:${secret}`).toString("base64")}`;
		expect(
			await webhooks.accept({
				triggerId: addressed.triggerId,
				delivery: { ...bearerDelivery(""), headers: { authorization: basicAuthorization } },
			}),
		).toMatchObject({ kind: "run" });
	});

	it("keeps a routine picked by its parts, and works out when it runs next", async () => {
		const schedule = {
			repeat: "weekly" as const,
			every: 2,
			days: ["mon" as const, "thu" as const],
			times: [9 * 60, 17 * 60 + 30],
			startsOn: "2026-10-05",
		};
		const created = await automations.create(
			{ projectId: ownProjectId },
			{
				name: "Fortnightly",
				instructions: "Review the fortnight.",
				triggers: [{ kind: "routine", schedule, timezone: "Australia/Sydney" }],
			},
		);

		expect(created.automation.triggers).toEqual([
			{
				id: expect.any(String),
				kind: "routine",
				schedule,
				timezone: "Australia/Sydney",
				nextScheduledAt: expect.any(String),
			},
		]);
		const [stored] = await onDatabase((db) =>
			db
				.select()
				.from(automationTrigger)
				.where(eq(automationTrigger.automationId, created.automation.id)),
		);
		expect(stored?.settings).toEqual({ kind: "routine", schedule, timezone: "Australia/Sydney" });
		expect(stored?.nextScheduledAt?.getTime()).toBeGreaterThan(Date.now());
	});

	it("swaps an automation's routine for a webhook, and back", async () => {
		const created = await automations.create(
			{ projectId: ownProjectId },
			{
				name: "Switching",
				instructions: "Handle it.",
				triggers: [
					{
						kind: "routine",
						schedule: { repeat: "cron", expression: "0 9 * * *" },
						timezone: "UTC",
					},
				],
			},
		);
		const schedule = firstTriggerOf(created).addressed;
		const addressed = { projectId: ownProjectId, automationId: created.automation.id };

		const withWebhook = await automations.addTrigger(addressed, { kind: "webhook" });
		const webhook = withWebhook.automation.triggers.find((trigger) => trigger.kind === "webhook");
		expect(webhook).toEqual({
			id: expect.any(String),
			kind: "webhook",
			auth: { kind: "bearer" },
		});
		expect(withWebhook.secrets).toEqual([
			{ triggerId: webhook?.id, secret: expect.stringMatching(/^rtb_/) },
		]);
		expect(
			(await automations.removeTrigger(schedule)).triggers.map((trigger) => trigger.kind),
		).toEqual(["webhook"]);

		const scheduled = await automations.addTrigger(addressed, {
			kind: "routine",
			schedule: { repeat: "cron", expression: "0 10 * * *" },
			timezone: "UTC",
		});
		await automations.removeTrigger({ ...addressed, triggerId: webhook?.id ?? "" });
		expect((await automations.get(addressed)).triggers).toEqual([
			expect.objectContaining({
				kind: "routine",
				schedule: { repeat: "cron", expression: "0 10 * * *" },
				nextScheduledAt: expect.any(String),
			}),
		]);
		expect(scheduled.secrets).toEqual([]);
	});

	it("runs a webhook left without a secret for whoever calls its address, until one is set", async () => {
		const created = await automations.create(
			{ projectId: ownProjectId },
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
		expect(await automations.getSecret(addressed)).toEqual({ kind: "none" });
		const unsigned = { ...bearerDelivery(""), headers: {} };
		expect(
			await webhooks.accept({ triggerId: addressed.triggerId, delivery: unsigned }),
		).toMatchObject({ kind: "run" });

		// Another auth kind doesn't make a secret for a webhook left without one.
		const asBearer = await automations.updateTrigger(addressed, {
			kind: "webhook",
			auth: { kind: "bearer" },
		});
		expect(asBearer.secrets).toEqual([]);
		expect(await automations.getSecret(addressed)).toEqual({ kind: "none" });

		const secret = "a-token-chosen-for-this-automation";
		expect(await automations.rotateSecret(addressed, secret)).toBe(secret);
		expect(
			await webhooks.accept({
				triggerId: addressed.triggerId,
				delivery: { ...unsigned, headers: { "idempotency-key": "unsigned-again" } },
			}),
		).toBeUndefined();

		expect(await automations.rotateSecret(addressed, null)).toBeNull();
		expect(await automations.getSecret(addressed)).toEqual({ kind: "none" });
	});

	it("takes a sender's secret however short, and a made-up one only when hard to guess", async () => {
		const linear = await automations.create(
			{ projectId: ownProjectId },
			{
				name: "Linear issues",
				instructions: "Triage it.",
				triggers: [{ kind: "webhook", auth: { kind: "linear" }, secret: "lin_wh_short" }],
			},
		);
		expect(firstTriggerOf(linear).secret).toBe("lin_wh_short");

		await expect(
			automations.create(
				{ projectId: ownProjectId },
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

		const bearer = await automations.create(
			{ projectId: ownProjectId },
			{
				name: "Alerts",
				instructions: "Handle input.",
				triggers: [{ kind: "webhook", auth: { kind: "bearer" } }],
			},
		);
		const { addressed, secret } = firstTriggerOf(bearer);
		await expect(automations.rotateSecret(addressed, "too-short")).rejects.toThrow(
			WebhookSecretTooShort,
		);
		expect(await automations.getSecret(addressed)).toEqual({ kind: "set", secret });
	});

	it.each([
		{ auth: { kind: "bearer" } as const, deliveryIdHeader: "AUTHORIZATION" },
		{ auth: { kind: "basic", username: "alerts" } as const, deliveryIdHeader: "Authorization" },
		{ auth: { kind: "api_key", header: "X-Secret" } as const, deliveryIdHeader: "x-secret" },
	])(
		"refuses authentication headers as delivery IDs for $auth.kind",
		async ({ auth, deliveryIdHeader }) => {
			await expect(
				automations.create(
					{ projectId: ownProjectId },
					{
						name: "Incoming",
						instructions: "Handle it.",
						triggers: [{ kind: "webhook", auth, deliveryIdHeader }],
					},
				),
			).rejects.toThrow(WebhookDeliveryIdHeaderRejected);
			const created = await automations.create(
				{ projectId: ownProjectId },
				{
					name: "Incoming",
					instructions: "Handle it.",
					triggers: [{ kind: "webhook", auth }],
				},
			);
			await expect(
				automations.updateTrigger(firstTriggerOf(created).addressed, {
					kind: "webhook",
					deliveryIdHeader,
				}),
			).rejects.toThrow(WebhookDeliveryIdHeaderRejected);
		},
	);

	it("refuses an auth change that makes the saved delivery header carry the API key", async () => {
		const created = await automations.create(
			{ projectId: ownProjectId },
			{
				name: "Incoming",
				instructions: "Handle it.",
				triggers: [{ kind: "webhook", deliveryIdHeader: "X-Secret" }],
			},
		);
		await expect(
			automations.updateTrigger(firstTriggerOf(created).addressed, {
				kind: "webhook",
				auth: { kind: "api_key", header: "x-secret" },
			}),
		).rejects.toThrow(WebhookDeliveryIdHeaderRejected);
	});

	it("dedupes a generic webhook's retries by the delivery id header it is set to", async () => {
		const created = await automations.create(
			{ projectId: ownProjectId },
			{
				name: "Sentry alerts",
				instructions: "Triage the alert.",
				triggers: [{ kind: "webhook", deliveryIdHeader: "X-Request-Id" }],
			},
		);
		const { addressed, secret } = firstTriggerOf(created);
		const { triggerId } = addressed;
		const send = (headers: Record<string, string>) =>
			webhooks.accept({ triggerId, delivery: bearerDelivery(secret ?? "", {}, headers) });
		const runIdOf = (accepted: Awaited<ReturnType<typeof send>>) =>
			accepted?.kind === "run" ? accepted.run.runId : undefined;

		const first = await send({ "x-request-id": "req-1", "idempotency-key": "a" });
		const retry = await send({ "x-request-id": "req-1", "idempotency-key": "b" });
		const other = await send({ "x-request-id": "req-2", "idempotency-key": "a" });
		expect(first).toMatchObject({ kind: "run", run: { duplicate: false } });
		expect(retry).toMatchObject({
			kind: "run",
			run: { duplicate: true, runId: runIdOf(first) },
		});
		expect(other).toMatchObject({ kind: "run", run: { duplicate: false } });

		// Changing the auth keeps the header; none at all starts a run for every call.
		await automations.updateTrigger(addressed, { kind: "webhook", auth: { kind: "bearer" } });
		expect(await send({ "x-request-id": "req-1" })).toMatchObject({
			run: { duplicate: true },
		});
		const unset = await automations.updateTrigger(addressed, {
			kind: "webhook",
			deliveryIdHeader: null,
		});
		expect(unset.automation.triggers[0]).toMatchObject({ deliveryIdHeader: null });
		const again = await send({ "x-request-id": "req-1" });
		expect(again).toMatchObject({ run: { duplicate: false } });
		expect(runIdOf(again)).not.toBe(runIdOf(first));
	});

	it("keeps automatic deduplication when an existing webhook is edited", async () => {
		const created = await automations.create(
			{ projectId: ownProjectId },
			{ name: "Old alerts", instructions: "Handle input.", triggers: [{ kind: "webhook" }] },
		);
		const { addressed, secret } = firstTriggerOf(created);
		await onDatabase((db) =>
			db
				.update(automationTrigger)
				.set({ settings: { kind: "webhook", auth: { kind: "bearer" } } })
				.where(eq(automationTrigger.id, addressed.triggerId)),
		);
		await automations.updateTrigger(addressed, { kind: "webhook", auth: { kind: "bearer" } });
		for (const [headers, payload] of [
			[{ "idempotency-key": "order-1" }, {}],
			[{ "svix-id": "message-1" }, {}],
			[{ "x-shopify-webhook-id": "shopify-1" }, {}],
			[{}, { event_id: "event-1" }],
			[{}, { object: "event", id: "stripe-1" }],
		] as const) {
			const send = () =>
				webhooks.accept({
					triggerId: addressed.triggerId,
					delivery: bearerDelivery(secret ?? "", payload, headers),
				});
			expect(await send()).toMatchObject({ run: { duplicate: false } });
			expect(await send()).toMatchObject({ run: { duplicate: true } });
		}
	});

	it("still admits a bearer secret hashed before secrets were sealed", async () => {
		const created = await automations.create(
			{ projectId: ownProjectId },
			{ name: "Old alerts", instructions: "Handle input.", triggers: [{ kind: "webhook" }] },
		);
		const { triggerId } = firstTriggerOf(created).addressed;
		const legacySecret = randomBytes(32).toString("base64url");
		const salt = randomBytes(16);
		const digest = scryptSync(legacySecret, salt, 32);
		await onDatabase((db) =>
			db
				.update(automationTrigger)
				.set({
					secretEncrypted: null,
					secretDigest: `scrypt:${salt.toString("base64url")}:${digest.toString("base64url")}`,
				})
				.where(eq(automationTrigger.id, triggerId)),
		);

		expect(
			await webhooks.accept({ triggerId, delivery: bearerDelivery(legacySecret) }),
		).toMatchObject({ kind: "run" });
		expect(
			await webhooks.accept({ triggerId, delivery: bearerDelivery("incorrect") }),
		).toBeUndefined();
	});

	it("refuses a wrong webhook secret without waiting on the automation's other triggers", async () => {
		const created = await automations.create(
			{ projectId: ownProjectId },
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
				lockTriggers(created.automation.id).pipe(
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
		const created = await automations.create(
			{ projectId: ownProjectId },
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
				Context.get(conversations, Automations.Service)
					.rotateSecret(addressed)
					.pipe(
						Effect.tap((secret) => Effect.sync(() => rotated(secret ?? ""))),
						Effect.andThen(Effect.promise(() => rotationHeld)),
					),
			).pipe(CurrentActor.provide(CurrentActor.AuthenticatedUserId.vouchedFor(userId))),
		);
		const secret = await rotatedSecret;

		const edit = automations.updateTrigger(addressed, {
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
		).toMatchObject({ kind: "run", run: { duplicate: false } });
		expect(await automations.getSecret(addressed)).toEqual({ kind: "set", secret });
	});

	it("refuses a viewer a run, and anyone who did not make the bot a removal or the secret, whoever asks", async () => {
		// Called directly, with no route in front: what a new entry point that
		// forgot to check would reach.
		const created = await automations.create(
			{ projectId: ownProjectId },
			{ name: "Nightly", instructions: "Run nightly.", triggers: [{ kind: "webhook" }] },
		);
		const [member, viewer] = await onDatabase((db) =>
			db
				.insert(user)
				.values([
					{ name: "Member", email: `member-${crypto.randomUUID()}@example.com` },
					{ name: "Viewer", email: `viewer-${crypto.randomUUID()}@example.com` },
				])
				.returning(),
		);
		if (!member || !viewer) throw new Error("Could not create the people");
		await onDatabase((db) =>
			db.insert(workspaceMember).values([
				{ workspaceId, userId: member.id, role: "member" },
				{ workspaceId, userId: viewer.id, role: "viewer" },
			]),
		);
		const automation = { projectId: ownProjectId, automationId: created.automation.id };

		await expect(
			automationsAs(viewer.id).run({ ...automation, requestId: crypto.randomUUID() }),
		).rejects.toThrow(ActionForbidden);
		for (const personId of [member.id, viewer.id]) {
			await expect(automationsAs(personId).remove(automation)).rejects.toThrow(ActionForbidden);
			await expect(
				automationsAs(personId).getSecret(firstTriggerOf(created).addressed),
			).rejects.toThrow(ActionForbidden);
		}
		expect((await view.listRuns(automation))?.items).toEqual([]);
	});

	it("hides a project nobody can find", async () => {
		await expect(
			automations.create(
				{ projectId: crypto.randomUUID() },
				{
					name: "Forbidden",
					instructions: "Should not run.",
					triggers: [{ kind: "webhook" }],
				},
			),
		).rejects.toThrow(ResourceHidden);
	});

	it("is run by its project's lead bot, in the project, and not while the project has none", async () => {
		const created = await automations.create(
			{ projectId },
			{ name: "Project report", instructions: "Report.", triggers: [] },
		);
		const run = () =>
			automations.run({
				projectId,
				automationId: created.automation.id,
				requestId: crypto.randomUUID(),
			});
		await expect(run()).rejects.toMatchObject({ _tag: "AutomationProjectHasNoLead" });

		await onDatabase((db) => db.insert(projectBot).values({ workspaceId, projectId, botId }));
		await onDatabase((db) =>
			db.update(project).set({ leadBotId: botId }).where(eq(project.id, projectId)),
		);
		const accepted = await run();

		const [execution] = await onDatabase((db) =>
			db.select().from(automationRun).where(eq(automationRun.id, accepted.runId)),
		);
		expect(execution?.botId).toBe(botId);
		const [listed] = (await view.listRuns({ projectId, automationId: created.automation.id }))
			.items;
		const placed = await onDatabase((db) =>
			db
				.select({ kind: placedConversation.kind, projectId: placedConversation.projectId })
				.from(placedConversation)
				.where(
					inArray(placedConversation.id, [
						accepted.conversationId,
						listed?.rootConversationId ?? accepted.conversationId,
					]),
				),
		);
		expect(placed).toEqual(
			expect.arrayContaining([
				{ kind: "run", projectId },
				{ kind: "automation_feed", projectId },
			]),
		);
	});

	it("accepts a manual trigger once and keeps instructions as an execution snapshot", async () => {
		const created = await automations.create(
			{ projectId: ownProjectId },
			{
				name: "Check reports",
				instructions: "Use the original instructions.",
				triggers: [{ kind: "webhook" }],
			},
		);
		const input = {
			projectId: ownProjectId,
			automationId: created.automation.id,
			requestId: crypto.randomUUID(),
		};
		const [first, retried] = await Promise.all([automations.run(input), automations.run(input)]);
		const original = first.duplicate ? retried : first;
		const duplicate = first.duplicate ? first : retried;
		expect(duplicate).toEqual({ ...original, duplicate: true });
		expect(
			await onDatabase((db) =>
				db.select().from(conversation).where(eq(conversation.id, original.conversationId)),
			),
		).toHaveLength(1);
		expect(
			await onDatabase((db) =>
				db.select().from(message).where(eq(message.conversationId, original.conversationId)),
			),
		).toHaveLength(1);

		await automations.update(
			{ projectId: ownProjectId, automationId: created.automation.id },
			{
				instructions: "Use changed instructions.",
			},
		);
		const [execution] =
			(await view.listRuns({ projectId: ownProjectId, automationId: created.automation.id }))
				?.items ?? [];
		expect(execution?.instructions).toBe("Use the original instructions.");
	});

	it("bounds execution titles derived from maximum-length automation names", async () => {
		const created = await automations.create(
			{ projectId: ownProjectId },
			{
				name: "R".repeat(80),
				instructions: "Keep the title valid.",
				triggers: [{ kind: "webhook" }],
			},
		);
		const requestId = crypto.randomUUID();
		const accepted = await automations.run({
			projectId: ownProjectId,
			automationId: created.automation.id,
			requestId,
		});
		const [runConversation] = await onDatabase((db) =>
			db.select().from(conversation).where(eq(conversation.id, accepted.conversationId)),
		);
		expect(runConversation?.title).toHaveLength(80);
	});

	it("rejects reuse of a trigger identity with different data", async () => {
		const created = await automations.create(
			{ projectId: ownProjectId },
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
		).rejects.toThrow(AutomationTriggerConflict);
	});

	it("runs an automation's runs in order while allowing a separate automation to run", async () => {
		const firstAutomation = await automations.create(
			{ projectId: ownProjectId },
			{
				name: "First queue",
				instructions: "Run in order.",
				triggers: [{ kind: "webhook" }],
			},
		);
		const secondAutomation = await automations.create(
			{ projectId: ownProjectId },
			{
				name: "Second queue",
				instructions: "Run independently.",
				triggers: [{ kind: "webhook" }],
			},
		);
		const accepted: AcceptedRun[] = [];
		for (const automationId of [
			firstAutomation.automation.id,
			firstAutomation.automation.id,
			secondAutomation.automation.id,
		]) {
			const requestId = crypto.randomUUID();
			accepted.push(await automations.run({ projectId: ownProjectId, automationId, requestId }));
		}
		const first = await startRunning(runner, firstAutomation.automation.id);
		const second = await startRunning(runner, secondAutomation.automation.id);
		expect(first.execution.id).toBe(accepted[0]?.runId);
		expect(second.execution.state).toBe("running");
		const [waiting] = await onDatabase((db) =>
			db
				.select()
				.from(automationRun)
				.where(eq(automationRun.id, accepted[1]?.runId ?? "")),
		);
		expect(waiting?.state).toBe("queued");
		await finishTurnsIn(first.execution.conversationId);
		expect(await settlement.settleRun(first.run)).toBe(true);
		await runOnPostgres(releaseRun(first.run));
		const third = await startRunning(runner, firstAutomation.automation.id);
		expect(third.execution.id).toBe(accepted[1]?.runId);
		const queued = await onDatabase((db) =>
			db
				.select()
				.from(automationRun)
				.where(
					and(
						eq(automationRun.automationId, firstAutomation.automation.id),
						eq(automationRun.state, "queued"),
					),
				),
		);
		expect(queued).toHaveLength(0);
	});

	it("accepts only the latest missed occurrence of a routine and advances into the future", async () => {
		const created = await automations.create(
			{ projectId: ownProjectId },
			{
				name: "Quarter hourly",
				instructions: "Check recent activity.",
				triggers: [
					{
						kind: "routine",
						schedule: { repeat: "cron", expression: "*/15 * * * *" },
						timezone: "UTC",
					},
				],
			},
		);
		await makeDue(created.automation.id, new Date("2026-09-18T10:00:00Z"));
		const now = new Date("2026-09-18T12:37:40Z");
		const accepted = await processDueAt(now);
		expect(accepted?.duplicate).toBe(false);
		const [execution] =
			(await view.listRuns({ projectId: ownProjectId, automationId: created.automation.id }))
				?.items ?? [];
		expect(execution?.trigger).toMatchObject({
			kind: "routine",
			scheduledAt: "2026-09-18T12:30:00.000Z",
		});
		expect(await nextTimesOf(created.automation.id)).toEqual([
			{ id: expect.any(String), at: "2026-09-18T12:45:00.000Z" },
		]);
		expect(await processDueAt(now)).toBeUndefined();
	});

	it("runs each of an automation's routines as it falls due", async () => {
		const created = await automations.create(
			{ projectId: ownProjectId },
			{
				name: "On the hour and half past",
				instructions: "Check recent activity.",
				triggers: [
					{
						kind: "routine",
						schedule: { repeat: "cron", expression: "0 * * * *" },
						timezone: "UTC",
					},
					{
						kind: "routine",
						schedule: { repeat: "cron", expression: "30 * * * *" },
						timezone: "UTC",
					},
				],
			},
		);
		const [onTheHour, halfPast] = created.automation.triggers;
		await makeDue(created.automation.id, new Date("2026-09-18T10:00:00Z"));
		const now = new Date("2026-09-18T12:40:00Z");

		const first = await processDueAt(now);
		const second = await processDueAt(now);

		expect(first?.duplicate).toBe(false);
		expect(second?.duplicate).toBe(false);
		expect(second?.runId).not.toBe(first?.runId);
		const runs = (
			await view.listRuns({ projectId: ownProjectId, automationId: created.automation.id })
		).items;
		const scheduledTimes = runs.map((run) =>
			run.trigger.kind === "routine" ? run.trigger.scheduledAt : run.trigger.kind,
		);
		expect(scheduledTimes.sort()).toEqual(["2026-09-18T12:00:00.000Z", "2026-09-18T12:30:00.000Z"]);
		expect(await nextTimesOf(created.automation.id)).toEqual(
			expect.arrayContaining([
				{ id: onTheHour?.id, at: "2026-09-18T13:00:00.000Z" },
				{ id: halfPast?.id, at: "2026-09-18T13:30:00.000Z" },
			]),
		);
		expect(await processDueAt(now)).toBeUndefined();
	});

	it("starts a run for each routine due at the same time, not one for both", async () => {
		const quarterHourly = {
			kind: "routine" as const,
			schedule: { repeat: "cron" as const, expression: "*/15 * * * *" },
			timezone: "UTC",
		};
		const created = await automations.create(
			{ projectId: ownProjectId },
			{
				name: "Twice over",
				instructions: "Check recent activity.",
				triggers: [quarterHourly, quarterHourly],
			},
		);
		await makeDue(created.automation.id, new Date("2026-09-18T10:00:00Z"));
		const now = new Date("2026-09-18T12:37:40Z");

		const first = await processDueAt(now);
		const second = await processDueAt(now);

		expect([first?.duplicate, second?.duplicate]).toEqual([false, false]);
		expect(second?.runId).not.toBe(first?.runId);
		const runs = (
			await view.listRuns({ projectId: ownProjectId, automationId: created.automation.id })
		).items;
		expect(runs.map((run) => run.trigger)).toMatchObject([
			{ kind: "routine", scheduledAt: "2026-09-18T12:30:00.000Z" },
			{ kind: "routine", scheduledAt: "2026-09-18T12:30:00.000Z" },
		]);
	});

	it("pauses every routine of a paused automation, and sets when each runs next once it is enabled", async () => {
		const created = await automations.create(
			{ projectId: ownProjectId },
			{
				name: "Morning and evening",
				instructions: "Check recent activity.",
				triggers: [
					{
						kind: "routine",
						schedule: { repeat: "cron", expression: "0 9 * * *" },
						timezone: "UTC",
					},
					{
						kind: "routine",
						schedule: { repeat: "cron", expression: "0 17 * * *" },
						timezone: "UTC",
					},
					{ kind: "webhook" },
				],
			},
		);
		const addressed = { projectId: ownProjectId, automationId: created.automation.id };
		const nextTimes = (defined: Automations.Defined) =>
			defined.automation.triggers.flatMap((trigger) =>
				trigger.kind === "routine" ? [trigger.nextScheduledAt] : [],
			);

		const paused = await automations.update(addressed, { state: "paused" });
		expect(nextTimes(paused)).toEqual([null, null]);
		expect((await nextTimesOf(created.automation.id)).map(({ at }) => at)).toEqual([
			null,
			null,
			null,
		]);

		const enabled = await automations.update(addressed, { state: "enabled" });
		expect(nextTimes(enabled)).toEqual([expect.any(String), expect.any(String)]);
		expect(nextTimes(enabled)[0]).not.toBe(nextTimes(enabled)[1]);
	});

	it("keeps each webhook of an automation to its own secret, and its own deliveries", async () => {
		const created = await automations.create(
			{ projectId: ownProjectId },
			{
				name: "Two senders",
				instructions: "Handle input.",
				triggers: [{ kind: "webhook" }, { kind: "webhook" }],
			},
		);
		const [first, second] = created.automation.triggers;
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

		expect(toFirst).toMatchObject({ kind: "run", run: { duplicate: false } });
		expect(toSecond).toMatchObject({ kind: "run", run: { duplicate: false } });
		expect(toSecond?.kind === "run" && toSecond.run.runId).not.toBe(
			toFirst?.kind === "run" && toFirst.run.runId,
		);
	});

	it("keeps a trigger to its kind", async () => {
		const created = await automations.create(
			{ projectId: ownProjectId },
			{
				name: "Scheduled",
				instructions: "Handle it.",
				triggers: [
					{
						kind: "routine",
						schedule: { repeat: "cron", expression: "0 9 * * *" },
						timezone: "UTC",
					},
				],
			},
		);
		const { addressed } = firstTriggerOf(created);

		await expect(automations.updateTrigger(addressed, { kind: "webhook" })).rejects.toThrow(
			AutomationTriggerKindChanged,
		);
		expect((await automations.get(addressed)).triggers).toEqual(created.automation.triggers);
	});

	it("refuses a delivery to a webhook once it is removed from its automation", async () => {
		const created = await automations.create(
			{ projectId: ownProjectId },
			{ name: "Short-lived", instructions: "Handle input.", triggers: [{ kind: "webhook" }] },
		);
		const { addressed, secret } = firstTriggerOf(created);

		expect((await automations.removeTrigger(addressed)).triggers).toEqual([]);

		expect(
			await webhooks.accept({
				triggerId: addressed.triggerId,
				delivery: bearerDelivery(secret ?? ""),
			}),
		).toBeUndefined();
		await expect(automations.removeTrigger(addressed)).rejects.toThrow(AutomationTriggerNotFound);
	});

	it("runs an automation without triggers only when someone runs it", async () => {
		const created = await automations.create(
			{ projectId: ownProjectId },
			{ name: "On request", instructions: "Handle it.", triggers: [] },
		);
		expect(created).toEqual({
			automation: expect.objectContaining({ triggers: [] }),
			secrets: [],
		});

		const accepted = await automations.run({
			projectId: ownProjectId,
			automationId: created.automation.id,
			requestId: crypto.randomUUID(),
		});

		expect(accepted.duplicate).toBe(false);
		const [execution] = await onDatabase((db) =>
			db.select().from(automationRun).where(eq(automationRun.id, accepted.runId)),
		);
		expect(execution).toMatchObject({ triggerKind: "manual", triggerId: null });
	});

	it("takes no more triggers than an automation may have", async () => {
		const created = await automations.create(
			{ projectId: ownProjectId },
			{
				name: "Crowded",
				instructions: "Handle it.",
				triggers: Array.from({ length: MAX_AUTOMATION_TRIGGERS }, () => ({
					kind: "webhook" as const,
					secret: null,
				})),
			},
		);

		await expect(
			automations.addTrigger(
				{ projectId: ownProjectId, automationId: created.automation.id },
				{ kind: "webhook" },
			),
		).rejects.toThrow(TooManyAutomationTriggers);
	});

	it("pages execution history with opaque cursors", async () => {
		const created = await automations.create(
			{ projectId: ownProjectId },
			{
				name: "Paged runs",
				instructions: "Run repeatedly.",
				triggers: [{ kind: "webhook" }],
			},
		);
		for (let index = 0; index < 3; index += 1) {
			const requestId = crypto.randomUUID();
			await automations.run({
				projectId: ownProjectId,
				automationId: created.automation.id,
				requestId,
			});
		}

		const first = await view.listRuns(
			{ projectId: ownProjectId, automationId: created.automation.id },
			{
				limit: 2,
			},
		);
		expect(first?.items).toHaveLength(2);
		expect(first?.nextCursor).toEqual(expect.any(String));
		if (!first?.nextCursor) throw new Error("First execution page has no cursor");
		const second = await view.listRuns(
			{ projectId: ownProjectId, automationId: created.automation.id },
			{
				limit: 2,
				cursor: first.nextCursor,
			},
		);
		expect(second?.items).toHaveLength(1);
		expect(second?.nextCursor).toBeNull();
		expect(second?.items[0]?.id).not.toBe(first?.items[1]?.id);
		await expect(
			view.listRuns(
				{ projectId: ownProjectId, automationId: created.automation.id },
				{
					limit: 2,
					cursor: "not-a-cursor",
				},
			),
		).rejects.toThrow(Automations.InvalidRunCursor);
	});

	describe("who reaches an automation", () => {
		/** A person with `role` in the workspace. */
		const somebody = async (role: "admin" | "member") => {
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
			return person.id;
		};
		const anAutomationWithARun = async () => {
			const created = await automations.create(
				{ projectId: ownProjectId },
				{ name: "Reached", instructions: "Run.", triggers: [{ kind: "webhook" }] },
			);
			const automation = { projectId: ownProjectId, automationId: created.automation.id };
			await automations.run({ ...automation, requestId: crypto.randomUUID() });
			return automation;
		};
		const viewAs = (personId: string) =>
			onPostgresAs(personId)(Context.get(conversations, Automations.Service));

		it("lets an administrator read an automation and its history on a bot they did not make", async () => {
			const automation = await anAutomationWithARun();
			const admin = viewAs(await somebody("admin"));

			expect((await admin.listRuns(automation)).items).toHaveLength(1);
			expect(await admin.get(automation)).toMatchObject({ id: automation.automationId });
			expect(await admin.list({ projectId: ownProjectId })).toHaveLength(1);
		});

		it("hides a private bot's automation and its history from a member who did not make it", async () => {
			const automation = await anAutomationWithARun();
			await makePrivate(botId);
			const outsider = viewAs(await somebody("member"));

			await expect(outsider.listRuns(automation)).rejects.toThrow(ResourceHidden);
			await expect(outsider.get(automation)).rejects.toThrow(ResourceHidden);
			await expect(outsider.list({ projectId: ownProjectId })).rejects.toThrow(ResourceHidden);
		});

		it("refuses a member the approval an automation's run asks for, which only an administrator gives", async () => {
			const automation = await anAutomationWithARun();
			await startRunning(runner, automation.automationId);
			const [runConversation] = await onDatabase((db) =>
				db
					.select({ id: automationRun.conversationId })
					.from(automationRun)
					.where(eq(automationRun.automationId, automation.automationId)),
			);
			if (!runConversation) throw new Error("The run has no conversation");
			const [run] = await runOnPostgres(runningTurns(runConversation.id));
			if (!run) throw new Error("The run asked for no turn");
			const prepared = await prepareRunnable(execution, run);
			const pending = await parkForApproval(prepared);
			const decision = { toolCallId: pending.id, decision: "allow_once" as const };
			const approvalsAs = (personId: string) =>
				onPostgresAs(personId)(Context.get(conversations, Turns.Controls));

			await expect(approvalsAs(await somebody("member")).decide(decision)).rejects.toBeInstanceOf(
				Turns.ToolApprovalForbidden,
			);
			const [undecided] = await onDatabase((db) =>
				db.select().from(toolCall).where(eq(toolCall.id, pending.id)),
			);
			expect(undecided).toMatchObject({ approvalStatus: "pending", decidedById: null });
		});

		it("decides a run's approval without waiting on its turn, which settling locks first", async () => {
			const automation = await anAutomationWithARun();
			await startRunning(runner, automation.automationId);
			const [runConversation] = await onDatabase((db) =>
				db
					.select({ id: automationRun.conversationId })
					.from(automationRun)
					.where(eq(automationRun.automationId, automation.automationId)),
			);
			if (!runConversation) throw new Error("The run has no conversation");
			const [run] = await runOnPostgres(runningTurns(runConversation.id));
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
					.decide({ toolCallId: pending.id, decision: "allow_once" })
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

	/** Parks one call to a new connection of the bot's for approval, as the turn's reply. */
	async function parkForApproval(prepared: PreparedTurn) {
		const [connected] = await onDatabase((db) =>
			db
				.insert(connection)
				.values({
					workspaceId,
					projectId: prepared.context.projectId ?? "",
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
			sdkToolCallId: "sdk-automation",
			tool: "linear__create_issue",
			input: { title: "From the automation" },
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
