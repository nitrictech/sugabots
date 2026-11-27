import { createHmac } from "node:crypto";
import type {
	AcceptedRun,
	AutomationTriggerInput,
	AutomationUpdate,
	AutomationWriteResult,
	RunPageQuery,
} from "@sugabots/contracts";
import {
	DEFAULT_DELIVERY_ID_HEADER,
	DEFAULT_RUN_PAGE_LIMIT,
	MAX_AUTOMATION_TRIGGERS,
} from "@sugabots/contracts";
import { WebhookRefused } from "@sugabots/contracts/errors/automations";
import { ActionForbidden, ResourceHidden } from "@sugabots/contracts/errors/proofs";
import type { InputOf, RequestOperationName } from "@sugabots/contracts/operations";
import { userText } from "@sugabots/errors";
import { and, eq, inArray } from "drizzle-orm";
import { Context, Effect, Layer, type Schema } from "effect";
import { TestClock } from "effect/testing";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Accounts } from "../../accounts/accounts.ts";
import { query } from "../../database/database.ts";
import { EventBus } from "../../database/events/bus.ts";
import { EventStore } from "../../database/events/store.ts";
import {
	automationRun,
	automationTrigger,
	bot,
	chat,
	connector,
	membership,
	message,
	placedChat,
	projectMember,
	toolCall,
	turn,
	workspace,
} from "../../database/schema.ts";
import {
	closeDatabase,
	holdTransaction,
	onDatabase,
	onPostgres,
	runOnPostgres,
	waitUntilWaitingOnLocks,
} from "../../database/testing.ts";
import { createTestMember } from "../../database/workspace.test-support.ts";
import { Email } from "../../email/email.ts";
import { asMember } from "../../operations/chats/testing.ts";
import { layer as operationsLayer } from "../../operations/layer.ts";
import type { Call } from "../../operations/operation.ts";
import { Operations } from "../../operations/registry.ts";
import { servedOperations } from "../../operations/testing.ts";
import type { MemberSession } from "../../principal.ts";
import { authenticators, principals } from "../../proofs/world.test-support.ts";
import { Models } from "../../providers/models/models.ts";
import { unusedModel } from "../../providers/models/testing.ts";
import { unimplemented } from "../../testing.ts";
import { chatServicesForTests } from "../testing.ts";
import {
	type PreparedTurnForTests,
	parkTurn,
	prepareTurn,
	runningTurns,
	runOver,
} from "../turns/testing.ts";
import { LAST_REPLY_DESTINATION } from "./acceptance.ts";
import {
	AutomationTriggerConflict,
	AutomationTriggerKindChanged,
	lockTriggers,
	TooManyAutomationTriggers,
	WebhookDeliveryIdHeaderRejected,
	WebhookSecretTooShort,
} from "./automation.ts";
import { AutomationRunner } from "./automation-runner.ts";
import { AutomationSettlement } from "./settlement.ts";
import {
	anAutomationAdmin,
	automationsAs as createAndListAs,
	finishTurnsIn,
	releaseRun,
	startRunning,
} from "./testing.ts";
import type { Delivery } from "./webhook-auth.ts";

type AutomationAddress = Pick<InputOf<"automations.update">, "projectId" | "automationId">;

describe.skipIf(!process.env.DATABASE_URL)("Automations, against Postgres", async () => {
	const bus = EventBus.inProcess();
	const services = await chatServicesForTests(bus);
	const call = await servedOperations({ chats: services });
	/**
	 * The operation registry over the same chat services, whose runs the cases
	 * drive, and over nobody's accounts or email, which no case here reaches.
	 */
	const operations = await runOnPostgres(
		Effect.provide(
			Operations.Service,
			operationsLayer.pipe(
				Layer.provide(
					Layer.mergeAll(
						Layer.succeedContext(services),
						Layer.succeed(EventBus.Service, bus),
						EventStore.layer,
						unimplemented(Accounts.Service),
						unimplemented(Email.Service),
						// No case here makes a turn's model request.
						Layer.succeed(Models.Service, unusedModel()),
					),
				),
			),
		),
	);
	const auth = await authenticators();
	const signedIn = principals(auth);
	const sessions = new Map<string, Promise<MemberSession>>();
	/** `memberId`, signed in once for the file. */
	const signIn = (memberId: string) => {
		const session = sessions.get(memberId) ?? signedIn.member(memberId);
		sessions.set(memberId, session);
		return session;
	};
	/** A call of its own, as each HTTP request is. */
	const aRequest = (): Call => ({ kind: "request" });
	/**
	 * The automations operations, each called for `memberId` signed in, by
	 * the names and shapes these cases use.
	 */
	const automationsAs = (memberId: string) => {
		const as =
			<Name extends RequestOperationName>(name: Name) =>
			async (input: InputOf<Name>) =>
				runOnPostgres(operations[name](await signIn(memberId), input, aRequest()));
		return {
			...createAndListAs(call, memberId),
			update: (automation: AutomationAddress, changes: AutomationUpdate) =>
				as("automations.update")({ ...automation, changes }),
			remove: as("automations.remove"),
			run: as("automations.run"),
			addTrigger: (automation: AutomationAddress, trigger: AutomationTriggerInput) =>
				as("automations.addTrigger")({ ...automation, trigger }),
			updateTrigger: (
				addressed: AutomationAddress & { triggerId: string },
				trigger: AutomationTriggerInput,
			) => as("automations.updateTrigger")({ ...addressed, trigger }),
			removeTrigger: as("automations.removeTrigger"),
			getSecret: as("automations.getSecret"),
			rotateSecret: async (
				addressed: AutomationAddress & { triggerId: string },
				secret?: string | null,
			) => (await as("automations.rotateSecret")({ ...addressed, secret })).secret,
			listProjectRuns: (
				{ projectId }: { projectId: string },
				page: RunPageQuery = { limit: DEFAULT_RUN_PAGE_LIMIT },
			) => as("automations.projectRuns")({ projectId, ...page }),
		};
	};
	/** As an admin of the automations' workspace. */
	let automations: ReturnType<typeof automationsAs>;
	/**
	 * A call to a webhook as its route makes it: authenticated by the webhook
	 * authenticator, then its operation called for the call that made. A
	 * refusal is `undefined`, as its caller is told the same whatever it was.
	 */
	const webhooks = {
		accept: async ({ triggerId, delivery }: { triggerId: string; delivery: Delivery }) => {
			const refusedAsUndefined = (failure: unknown) =>
				failure instanceof WebhookRefused ? undefined : Promise.reject(failure);
			const principal = await runOnPostgres(auth.webhook.trigger(triggerId, delivery)).catch(
				refusedAsUndefined,
			);
			if (!principal) return undefined;
			const headers = Object.fromEntries(
				Object.entries(delivery.headers).flatMap(([name, value]) =>
					value === undefined ? [] : [[name, value]],
				),
			);
			const input = { triggerId, headers, payload: delivery.payload as Schema.Json };
			const answer = await runOnPostgres(
				operations["automations.webhook"](principal, input, aRequest()),
			).catch(refusedAsUndefined);
			if (!answer) return undefined;
			if ("runId" in answer) return { kind: "run" as const, run: answer };
			if ("ignored" in answer) return { kind: "ignored" as const };
			return { kind: "challenge" as const, challenge: answer.challenge };
		},
	};
	const drive = runOver(services);
	const runner = onPostgres(Context.get(services, AutomationRunner.Service));
	const settlement = onPostgres({
		settleRun: Context.get(services, AutomationSettlement.Service).settleRun,
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
	let memberId: string;
	/** Makes the bot personal, so only its creator reaches it. */
	const makePersonal = (id: string) =>
		onDatabase((db) => db.update(bot).set({ visibility: "personal" }).where(eq(bot.id, id)));
	/** The automation's first trigger, addressed, and the secret this write made for it, if any. */
	const firstTriggerOf = (defined: AutomationWriteResult) => {
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
	/** The automation's runs, newest first, as the project's runs list them. */
	const runsOf = async (addressed: { projectId: string; automationId: string }) =>
		(await automations.listProjectRuns({ projectId: addressed.projectId })).items.filter(
			(run) => run.automationId === addressed.automationId,
		);
	/** The automation's triggers, as its project's automations list them. */
	const triggersOf = async (addressed: { projectId: string; automationId: string }) =>
		(await automations.list({ projectId: addressed.projectId }))
			.filter((listed) => "triggers" in listed)
			.find((listed) => listed.id === addressed.automationId)?.triggers;
	/** Runs the scheduler once, as if it were `now`. */
	const processDueAt = (now: Date) =>
		runOnPostgres(
			Effect.gen(function* () {
				yield* TestClock.setTime(now.getTime());
				const triggerId = yield* auth.systemWork.nextDueRoutineId();
				if (!triggerId) return undefined;
				const principal = yield* auth.systemWork.dueRoutine(triggerId);
				const accepted = yield* operations["automations.runDueRoutine"](
					principal,
					{ triggerId },
					aRequest(),
				);
				if (accepted === "skipped" || accepted === "retry") throw new Error("Routine did not run");
				return accepted;
			}).pipe(Effect.provide(TestClock.layer())),
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
		({ workspaceId, botId, memberId, ownProjectId, projectId } = await anAutomationAdmin());
		automations = automationsAs(memberId);
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

	it("refuses new runs and changes after a member is demoted", async () => {
		const created = await automations.create(
			{ projectId: ownProjectId },
			{ name: "Report", instructions: "Report.", triggers: [{ kind: "webhook" }] },
		);
		const address = { projectId: ownProjectId, automationId: created.automation.id };
		const before = await automations.list({ projectId: ownProjectId });
		await onDatabase((db) =>
			db
				.update(membership)
				.set({ role: "viewer" })
				.where(and(eq(membership.workspaceId, workspaceId), eq(membership.memberId, memberId))),
		);

		const calls = [
			automations.run({ ...address, requestId: crypto.randomUUID() }),
			automations.update(address, { name: "Renamed" }),
			automations.addTrigger(address, { kind: "webhook" }),
			automations.remove(address),
			automations.create(
				{ projectId: ownProjectId },
				{ name: "Another", instructions: "Report.", triggers: [] },
			),
		];

		for (const outcome of await Promise.allSettled(calls)) {
			expect(outcome).toMatchObject({ status: "rejected", reason: expect.any(ActionForbidden) });
		}
		expect(
			await onDatabase((db) =>
				db
					.select()
					.from(automationRun)
					.where(eq(automationRun.automationId, created.automation.id)),
			),
		).toEqual([]);
		await onDatabase((db) =>
			db.update(membership).set({ role: "admin" }).where(eq(membership.memberId, memberId)),
		);
		expect(await automations.list({ projectId: ownProjectId })).toEqual(before);
	});

	it("lists an automation with a routine and gives it no webhook secret", async () => {
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

		expect(await automations.list({ projectId: ownProjectId })).toMatchObject([
			{ id: scheduled.automation.id },
		]);
	});

	it("admits webhook calls only with the current secret", async () => {
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
				deliveryIdHeader: DEFAULT_DELIVERY_ID_HEADER,
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
		expect(await automations.list({ projectId: ownProjectId })).toMatchObject([
			{ id: webhook.automation.id },
		]);
	});

	it("tells the bot its last reply goes to the automation's feed", async () => {
		const { automation } = await automations.create(
			{ projectId: ownProjectId },
			{
				name: "Overnight briefing",
				instructions: "Check for new releases.",
				triggers: [{ kind: "webhook" }],
			},
		);
		const accepted = await automations.run({
			projectId: ownProjectId,
			automationId: automation.id,
			requestId: crypto.randomUUID(),
		});
		const details = await asMember(call, memberId).get(accepted.chatId);

		const instruction = details.messages.find(({ author }) => author.kind === "automation_trigger");
		expect(instruction?.content).toContain(LAST_REPLY_DESTINATION);
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

	it("requires a valid Linear signature and a recent timestamp in the signed body", async () => {
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
		const now = Date.now();
		const signedDelivery = (webhookTimestamp?: number): Delivery => {
			const payload = { action: "create", data: { id: "ISS-1" }, webhookTimestamp };
			const body = JSON.stringify(payload);
			return {
				headers: {
					"linear-signature": createHmac("sha256", linearSecret).update(body).digest("hex"),
					"linear-delivery": "234d1a4e-b617-4388-90fe-adc3633d6b72",
					"linear-timestamp": String(now),
				},
				body: new TextEncoder().encode(body),
				payload: JSON.parse(body),
			};
		};
		for (const timestamp of [undefined, now - 120_000, now + 120_000]) {
			expect(
				await webhooks.accept({ triggerId, delivery: signedDelivery(timestamp) }),
			).toBeUndefined();
		}
		const signed = signedDelivery(now);

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

		const [read] =
			(await triggersOf({ projectId: ownProjectId, automationId: created.automation.id })) ?? [];
		expect(read).toEqual({
			id: expect.any(String),
			kind: "routine",
			schedule,
			timezone: "Australia/Sydney",
			nextScheduledAt: expect.any(String),
		});
		expect(read?.kind === "routine" && Date.parse(read.nextScheduledAt ?? "")).toBeGreaterThan(
			Date.now(),
		);
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
			deliveryIdHeader: DEFAULT_DELIVERY_ID_HEADER,
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
		expect(await triggersOf(addressed)).toEqual([
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

	it("takes a webhook source's secret however short, and a made-up one only when hard to guess", async () => {
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

	it("refuses a wrong webhook secret without waiting on the automation's other triggers", async () => {
		const created = await automations.create(
			{ projectId: ownProjectId },
			{ name: "Busy", instructions: "Handle input.", triggers: [{ kind: "webhook" }] },
		);
		const holding = holdTransaction(lockTriggers(created.automation.id));
		await holding.held;

		// Answers while the triggers are still locked: a wait here would never end.
		expect(
			await webhooks.accept({
				triggerId: firstTriggerOf(created).addressed.triggerId,
				delivery: bearerDelivery("incorrect"),
			}),
		).toBeUndefined();
		await holding.release();
	});

	it("keeps a secret replaced while its webhook is being edited", async () => {
		const created = await automations.create(
			{ projectId: ownProjectId },
			{ name: "Alerts", instructions: "Handle input.", triggers: [{ kind: "webhook" }] },
		);
		const { addressed } = firstTriggerOf(created);
		// The new secret is written but not committed until the edit is waiting.
		const admin = await signIn(memberId);
		const rotation = holdTransaction(
			operations["automations.rotateSecret"](admin, addressed, aRequest()).pipe(
				Effect.map(({ secret }) => secret),
			),
		);
		const secret = (await rotation.held) ?? "";

		const edit = automations.updateTrigger(addressed, {
			kind: "webhook",
			auth: { kind: "api_key", header: "X-Alert-Key" },
		});
		await waitUntilWaitingOnLocks(1);
		await Promise.all([rotation.release(), edit]);

		expect(
			await webhooks.accept({
				triggerId: addressed.triggerId,
				delivery: { ...bearerDelivery(""), headers: { "x-alert-key": secret } },
			}),
		).toMatchObject({ kind: "run", run: { duplicate: false } });
		expect(await automations.getSecret(addressed)).toEqual({ kind: "set", secret });
	});

	it("refuses a viewer a run, and anyone who did not make the bot a removal or the secret, whoever asks", async () => {
		// Called directly, with no route in front: what a new entrypoint that
		// forgot to check would reach.
		const created = await automations.create(
			{ projectId: ownProjectId },
			{ name: "Nightly", instructions: "Run nightly.", triggers: [{ kind: "webhook" }] },
		);
		const editor = await createTestMember({ name: "Editor" }, { workspaceId, role: "editor" });
		const viewer = await createTestMember({ name: "Viewer" }, { workspaceId, role: "viewer" });
		const automation = { projectId: ownProjectId, automationId: created.automation.id };

		await expect(
			automationsAs(viewer.id).run({ ...automation, requestId: crypto.randomUUID() }),
		).rejects.toThrow(ActionForbidden);
		for (const memberId of [editor.id, viewer.id]) {
			await expect(automationsAs(memberId).remove(automation)).rejects.toThrow(ActionForbidden);
			await expect(
				automationsAs(memberId).getSecret(firstTriggerOf(created).addressed),
			).rejects.toThrow(ActionForbidden);
		}
		expect(await runsOf(automation)).toEqual([]);
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

	it("is run by its project's lead bot, in the project", async () => {
		const created = await automations.create(
			{ projectId },
			{ name: "Project report", instructions: "Report.", triggers: [] },
		);
		const accepted = await automations.run({
			projectId,
			automationId: created.automation.id,
			requestId: crypto.randomUUID(),
		});

		const [execution] = await onDatabase((db) =>
			db.select().from(automationRun).where(eq(automationRun.id, accepted.runId)),
		);
		expect(execution?.botId).toBe(botId);
		const [listed] = await runsOf({ projectId, automationId: created.automation.id });
		const placed = await onDatabase((db) =>
			db
				.select({ kind: placedChat.kind, projectId: placedChat.projectId })
				.from(placedChat)
				.where(inArray(placedChat.id, [accepted.chatId, listed?.rootChatId ?? accepted.chatId])),
		);
		expect(placed).toEqual(
			expect.arrayContaining([
				{ kind: "run", projectId },
				{ kind: "automation_feed", projectId },
			]),
		);
	});

	it("accepts a manual trigger once and keeps the instructions the run was given", async () => {
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
			await onDatabase((db) => db.select().from(chat).where(eq(chat.id, original.chatId))),
		).toHaveLength(1);
		expect(
			await onDatabase((db) =>
				db.select().from(message).where(eq(message.chatId, original.chatId)),
			),
		).toHaveLength(1);

		await automations.update(
			{ projectId: ownProjectId, automationId: created.automation.id },
			{
				instructions: "Use changed instructions.",
			},
		);
		const [execution] = await runsOf({
			projectId: ownProjectId,
			automationId: created.automation.id,
		});
		expect(execution?.instructions).toBe("Use the original instructions.");
	});

	it("bounds run titles made from maximum-length automation names", async () => {
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
		const [runChat] = await onDatabase((db) =>
			db.select().from(chat).where(eq(chat.id, accepted.chatId)),
		);
		expect(runChat?.title).toHaveLength(80);
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
		await finishTurnsIn(first.execution.chatId);
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
		const [execution] = await runsOf({
			projectId: ownProjectId,
			automationId: created.automation.id,
		});
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
		const runs = await runsOf({ projectId: ownProjectId, automationId: created.automation.id });
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
		const runs = await runsOf({ projectId: ownProjectId, automationId: created.automation.id });
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
		const nextTimes = (defined: Awaited<ReturnType<typeof automations.update>>) => {
			if (!("triggers" in defined.automation)) throw new Error("Expected automation settings");
			return defined.automation.triggers.flatMap((trigger) =>
				trigger.kind === "routine" ? [trigger.nextScheduledAt] : [],
			);
		};

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
				name: "Two callers",
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
		expect(await triggersOf(addressed)).toEqual(created.automation.triggers);
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
		await expect(automations.removeTrigger(addressed)).rejects.toThrow(ResourceHidden);
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

	it("pages a project's run history with opaque cursors", async () => {
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

		const first = await automations.listProjectRuns(
			{ projectId: ownProjectId },
			{
				limit: 2,
			},
		);
		expect(first?.items).toHaveLength(2);
		expect(first?.nextCursor).toEqual(expect.any(String));
		if (!first?.nextCursor) throw new Error("First execution page has no cursor");
		const second = await automations.listProjectRuns(
			{ projectId: ownProjectId },
			{
				limit: 2,
				cursor: first.nextCursor,
			},
		);
		expect(second?.items).toHaveLength(1);
		expect(second?.nextCursor).toBeNull();
		expect(second?.items[0]?.id).not.toBe(first?.items[1]?.id);
		await expect(
			automations.listProjectRuns(
				{ projectId: ownProjectId },
				{
					limit: 2,
					cursor: "not-a-cursor",
				},
			),
		).rejects.toMatchObject({ _tag: "InvalidCursor" });
	});

	it("lists the runs of every automation of a project, removed ones' included, newest first", async () => {
		const runOnce = async (as: typeof automations, projectId: string, name: string) => {
			const { automation } = await as.create(
				{ projectId },
				{ name, instructions: "Handle it.", triggers: [{ kind: "webhook" }] },
			);
			const { runId } = await as.run({
				projectId,
				automationId: automation.id,
				requestId: crypto.randomUUID(),
			});
			return { automationId: automation.id, runId };
		};
		const other = await anAutomationAdmin();
		const first = await runOnce(automations, ownProjectId, "Kept");
		const second = await runOnce(automations, ownProjectId, "Removed");
		await runOnce(automationsAs(other.memberId), other.ownProjectId, "Elsewhere");
		await automations.remove({ projectId: ownProjectId, automationId: second.automationId });

		const page = await automations.listProjectRuns({ projectId: ownProjectId });

		expect(page.items).toMatchObject([
			{ id: second.runId, automationId: second.automationId, automationName: "Removed" },
			{ id: first.runId, automationId: first.automationId, automationName: "Kept" },
		]);
		expect(page.nextCursor).toBeNull();
	});

	describe("who reaches an automation", () => {
		/** A member with `role` in the workspace. */
		const somebody = async (role: "admin" | "editor") => {
			const somebody = await createTestMember(
				{ name: role, email: `${role}-${crypto.randomUUID()}@example.com` },
				{ workspaceId, role },
			);
			return somebody.id;
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
		const viewAs = automationsAs;

		it("lets an administrator read an automation and its history on a bot they did not make", async () => {
			await anAutomationWithARun();
			const admin = viewAs(await somebody("admin"));

			expect((await admin.listProjectRuns({ projectId: ownProjectId })).items).toHaveLength(1);
			expect(await admin.list({ projectId: ownProjectId })).toHaveLength(1);
		});

		it("lists how each automation stands for those who read its runs, and not for an administrator of a personal bot", async () => {
			const automation = await anAutomationWithARun();
			const runError = userText`It broke.`;
			const neverRun = await automations.create(
				{ projectId: ownProjectId },
				{ name: "Unrun", instructions: "Run.", triggers: [{ kind: "webhook" }] },
			);
			await onDatabase((db) =>
				db
					.update(automationRun)
					.set({ state: "failed", error: runError, finishedAt: new Date() })
					.where(eq(automationRun.automationId, automation.automationId)),
			);
			const statusOf = (listed: Awaited<ReturnType<typeof automations.list>>, id: string) =>
				listed.filter((one) => "instructions" in one).find((one) => one.id === id)?.status;

			const listed = await automations.list({ projectId: ownProjectId });
			expect(statusOf(listed, automation.automationId)).toEqual({
				failing: true,
				latestRun: {
					id: expect.any(String),
					state: "failed",
					posted: false,
					acceptedAt: expect.any(String),
					error: runError,
				},
			});
			expect(statusOf(listed, neverRun.automation.id)).toEqual({ failing: false, latestRun: null });

			// Paused by hand, it is not failing, whatever its last run did.
			await automations.update(automation, { state: "paused" });
			expect(
				statusOf(await automations.list({ projectId: ownProjectId }), automation.automationId),
			).toEqual(expect.objectContaining({ failing: false }));

			await makePersonal(botId);
			const admin = viewAs(await somebody("admin"));
			expect((await admin.list({ projectId: ownProjectId })).map((one) => "status" in one)).toEqual(
				[false, false],
			);
		});

		it("hides a personal bot's automation and its history from an editor who did not make it", async () => {
			await anAutomationWithARun();
			await makePersonal(botId);
			const outsider = viewAs(await somebody("editor"));

			await expect(outsider.listProjectRuns({ projectId: ownProjectId })).rejects.toThrow(
				ResourceHidden,
			);
			await expect(outsider.list({ projectId: ownProjectId })).rejects.toThrow(ResourceHidden);
		});

		it("refuses an editor the approval an automation's run asks for, which only an administrator gives", async () => {
			const automation = await anAutomationWithARun();
			const { pending } = await startAndParkRun(automation.automationId);
			const decision = { toolCallId: pending.id, decision: "allow_once" as const };
			const approvalsAs = (memberId: string) => asMember(call, memberId);

			await expect(approvalsAs(await somebody("editor")).decide(decision)).rejects.toMatchObject({
				_tag: "ActionForbidden",
			});
			const [undecided] = await onDatabase((db) =>
				db.select().from(toolCall).where(eq(toolCall.id, pending.id)),
			);
			expect(undecided).toMatchObject({ approvalStatus: "pending", decidedById: null });
		});

		it("lets the lead bot's creator and admins decide what a project's run asks, and no other editor or viewer", async () => {
			// The lead bot is an editor's, and both editors are in the project members made.
			const creator = await somebody("editor");
			const otherEditor = await somebody("editor");
			await onDatabase((db) =>
				db.update(bot).set({ createdById: creator }).where(eq(bot.id, botId)),
			);
			await onDatabase((db) =>
				db
					.insert(projectMember)
					.values([creator, otherEditor].map((id) => ({ workspaceId, projectId, memberId: id }))),
			);
			const created = await automations.create(
				{ projectId },
				{ name: "Project's", instructions: "Run.", triggers: [{ kind: "webhook" }] },
			);
			const automationId = created.automation.id;
			await automations.run({ projectId, automationId, requestId: crypto.randomUUID() });
			const { chatId, pending } = await startAndParkRun(automationId);
			const [parked] = await onDatabase((db) =>
				db.select({ reply: toolCall.messageId }).from(toolCall).where(eq(toolCall.id, pending.id)),
			);
			if (!parked) throw new Error("The call was not recorded");
			const decision = { toolCallId: pending.id, decision: "allow_once" as const };
			const approvalsAs = (id: string) => asMember(call, id);
			const chatViewAs = (id: string) => asMember(call, id);
			/** What `id` sees of the call: on the Approvals page, in the count, in the run's chat and on its project. */
			const seenBy = async (id: string) => {
				const view = chatViewAs(id);
				const details = await view.get(chatId);
				const marks = await view.attentionMarks(workspaceId);
				return {
					waiting: (await view.approvals(workspaceId)).waiting.map(({ call }) => call.id),
					counted: (await view.attention(workspaceId)).waitingApprovals,
					mayDecideInChat: details.permissions?.approveToolCallsIn.includes(parked.reply),
					projectNeedsApproval: marks.projects[projectId]?.needsApproval ?? false,
				};
			};
			const deciding = {
				waiting: [pending.id],
				counted: 1,
				mayDecideInChat: true,
				projectNeedsApproval: true,
			};
			const notDeciding = {
				waiting: [],
				counted: 0,
				mayDecideInChat: false,
				projectNeedsApproval: false,
			};
			const roleOf = (id: string, role: "editor" | "viewer") =>
				onDatabase((db) =>
					db
						.update(membership)
						.set({ role })
						.where(and(eq(membership.workspaceId, workspaceId), eq(membership.memberId, id))),
				);

			expect(await seenBy(creator)).toEqual(deciding);
			expect(await seenBy(memberId)).toEqual(deciding);
			expect(await seenBy(otherEditor)).toEqual(notDeciding);
			await expect(approvalsAs(otherEditor).decide(decision)).rejects.toMatchObject({
				_tag: "ActionForbidden",
			});

			// A viewer manages no bot, the one they made included.
			await roleOf(creator, "viewer");
			expect(await seenBy(creator)).toEqual(notDeciding);
			await expect(approvalsAs(creator).decide(decision)).rejects.toMatchObject({
				_tag: "ActionForbidden",
			});

			await roleOf(creator, "editor");
			await approvalsAs(creator).decide(decision);
			const [decided] = await onDatabase((db) =>
				db.select().from(toolCall).where(eq(toolCall.id, pending.id)),
			);
			expect(decided).toMatchObject({ approvalStatus: "allowed", decidedById: creator });
		});

		it("decides a run's approval once whoever holds its turn's row lets go, as settling does", async () => {
			const automation = await anAutomationWithARun();
			const { prepared, pending } = await startAndParkRun(automation.automationId);
			const holding = holdTransaction(
				query((db) => db.select().from(turn).where(eq(turn.id, prepared.turnId)).for("update")),
			);
			await holding.held;

			// A decision locks the turn's row first, as ending the turn does, so it
			// waits rather than racing whatever holds it.
			let decided = false;
			const deciding = asMember(call, memberId)
				.decide({ toolCallId: pending.id, decision: "allow_once" })
				.then(() => {
					decided = true;
				});
			await waitUntilWaitingOnLocks(1);
			expect(decided).toBe(false);

			await holding.release();
			await deciding;
			expect(decided).toBe(true);
		});
	});

	async function startAndParkRun(automationId: string) {
		const { execution } = await startRunning(runner, automationId);
		const [run] = await runOnPostgres(runningTurns(execution.chatId));
		if (!run) throw new Error("The run asked for no turn");
		const prepared = await drive(prepareTurn(run));
		const pending = await parkForApproval(prepared);
		return { chatId: execution.chatId, prepared, pending };
	}

	/** Parks one call to a new connector of the bot's for approval, as the turn's step does. */
	async function parkForApproval(prepared: PreparedTurnForTests) {
		const [connected] = await onDatabase((db) =>
			db
				.insert(connector)
				.values({
					workspaceId,
					projectId: prepared.context.projectId ?? "",
					name: `Linear ${crypto.randomUUID()}`,
					handle: `linear-${crypto.randomUUID().slice(0, 8)}`,
					url: "https://linear.example.com/mcp",
					authKind: "header",
					createdById: memberId,
				})
				.returning({ id: connector.id }),
		);
		if (!connected) throw new Error("Could not create the connector");
		const parked = await drive(
			parkTurn(prepared, [
				{
					toolCallId: "sdk-automation",
					tool: "linear__create_issue",
					input: { title: "From the automation" },
					binding: {
						kind: "connector",
						connectorId: connected.id,
						connectorRevision: 1,
						remoteToolName: "create_issue",
					},
					writeOrDelete: true,
				},
			]),
		);
		const [approvalId] = parked._tag === "Waiting" ? parked.approvals : [];
		if (!approvalId) throw new Error("The turn did not park");
		const [pending] = await onDatabase((db) =>
			db.select({ id: toolCall.id }).from(toolCall).where(eq(toolCall.approvalId, approvalId)),
		);
		if (!pending) throw new Error("The turn parked no call");
		return pending;
	}
});
