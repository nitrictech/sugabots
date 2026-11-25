import type { Automation } from "@sugabots/contracts";
import {
	AutomationDeliveryIdTooLong,
	AutomationTriggerKindChanged,
	AutomationTriggerNotFound,
	WebhookDeliveryIdHeaderRejected,
	WebhookRefused,
} from "@sugabots/contracts/errors/automations";
import { ActionForbidden } from "@sugabots/contracts/errors/proofs";
import {
	seedAutomation,
	seedBot,
	seedProject,
	seedWebhookTrigger,
	seedWorkspace,
} from "@sugabots/core/authentication/seed.test-support";
import { WebhookAuthentication } from "@sugabots/core/authentication/webhook";
import { closeDatabase, runOnPostgres } from "@sugabots/core/database/testing";
import { Operations } from "@sugabots/core/operations/registry";
import type { Principal } from "@sugabots/core/principal";
import { Secrets } from "@sugabots/core/secrets/secrets";
import { unimplemented } from "@sugabots/core/testing";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	createTestApp,
	identifiedBy,
	signedInWith,
	type TestApp,
} from "../../http/app.test-support.ts";
import { MAX_JSON_BODY_BYTES } from "../../http/validation.ts";

const AUTOMATION_ID = "0199a3a0-0000-7000-8000-000000000001";
const TRIGGER_ID = "0199a3a0-0000-7000-8000-000000000003";
const OTHER_TRIGGER_ID = "0199a3a0-0000-7000-8000-000000000002";
const WORKSPACE_ID = "0199a3a0-0000-7000-8000-000000000006";
const PROJECT_ID = "0199a3a0-0000-7000-8000-000000000007";
const USER_ID = "0199a3a0-0000-7000-8000-000000000008";
const RUN_ID = "0199a3a0-0000-7000-8000-000000000004";
const CHAT_ID = "0199a3a0-0000-7000-8000-000000000005";

const GOOD_SECRET = "whk_good-secret";
const GOOD_AUTHORIZATION = `Bearer ${GOOD_SECRET}`;

/**
 * The webhook, with core's own webhook authenticator over the test database
 * and a trigger there whose secret is `GOOD_SECRET`, so what is under test is
 * that a call is authenticated before its operation, which is doubled, is
 * called for the principal that made.
 */
describe.skipIf(!process.env.DATABASE_URL)("Automation webhooks", () => {
	let authenticator: WebhookAuthentication.Interface;
	let triggerId: string;

	beforeAll(async () => {
		authenticator = await runOnPostgres(
			Effect.provide(WebhookAuthentication.Service, WebhookAuthentication.layer),
		);
		const secrets = await runOnPostgres(Effect.service(Secrets.Service));
		const workspaceId = await seedWorkspace();
		const lead = await seedBot(workspaceId);
		const projectId = await seedProject(workspaceId, { leadBotId: lead.id });
		const automationId = await seedAutomation(workspaceId, projectId);
		triggerId = await seedWebhookTrigger(
			automationId,
			workspaceId,
			{ kind: "bearer" },
			secrets.encrypt(GOOD_SECRET),
		);
	});

	afterAll(async () => {
		await closeDatabase();
	});

	/**
	 * The app with the real authenticator, recording what it is handed, and an
	 * `automations.webhook` double that answers a `challenge` body with it,
	 * turns away an `ignore` one, refuses a `tooLong` one's id, refuses a
	 * `paused` one as its automation would, and starts a run for any other.
	 */
	function webhookApp() {
		const authenticated = vi.fn<WebhookAuthentication.Interface["trigger"]>((id, delivery) =>
			authenticator.trigger(id, delivery),
		);
		const webhook = vi.fn<Operations.Interface["automations.webhook"]>((_principal, input) => {
			const payload = input.payload as {
				challenge?: string;
				tooLong?: boolean;
				ignore?: boolean;
				paused?: boolean;
			};
			if (payload.tooLong) return Effect.fail(new AutomationDeliveryIdTooLong());
			if (payload.paused) return Effect.fail(new WebhookRefused());
			if (payload.ignore) return Effect.succeed({ ignored: true as const });
			if (payload.challenge) return Effect.succeed({ challenge: payload.challenge });
			return Effect.succeed({ runId: RUN_ID, duplicate: false });
		});
		const app = createTestApp(
			Layer.mergeAll(
				Layer.succeed(WebhookAuthentication.Service, { ...authenticator, trigger: authenticated }),
				unimplemented(Operations.Service, { "automations.webhook": webhook }),
			),
		);
		return { app, authenticated, webhook };
	}

	function deliver(
		app: TestApp,
		options: {
			authorization?: string;
			contentType?: string;
			body?: string;
			path?: string;
		} = {},
	) {
		const headers: Record<string, string> = {
			"content-type": options.contentType ?? "application/json",
		};
		if (options.authorization) headers.authorization = options.authorization;
		return app.request(options.path ?? `/webhooks/triggers/${triggerId}`, {
			method: "POST",
			headers,
			body: options.body ?? JSON.stringify({ orderId: 42 }),
		});
	}

	it("authenticates the call by its exact body, then starts its run for the webhook call it is", async () => {
		const { app, authenticated, webhook } = webhookApp();
		// Spacing a signature covers, which re-encoding the JSON would lose.
		const body = '{ "orderId":  42 }';

		const response = await deliver(app, {
			authorization: GOOD_AUTHORIZATION,
			body,
			path: `/webhooks/triggers/${triggerId.toUpperCase()}`,
		});

		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({ runId: RUN_ID, duplicate: false });
		const [, delivery] = authenticated.mock.calls[0] ?? [];
		expect(new TextDecoder().decode(delivery?.body)).toBe(body);
		const [principal, input] = webhook.mock.calls[0] ?? [];
		expect(principal?._tag).toBe("WebhookCall");
		expect(input?.triggerId).toBe(triggerId);
		expect(input?.headers.authorization).toBe(GOOD_AUTHORIZATION);
		expect(input?.payload).toEqual({ orderId: 42 });
	});

	it("answers Slack's URL check with its challenge", async () => {
		const { app } = webhookApp();

		const response = await deliver(app, {
			authorization: GOOD_AUTHORIZATION,
			body: JSON.stringify({ challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P" }),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P",
		});
	});

	it("answers a call the trigger's filter turned away with 200, so its sender does not retry", async () => {
		const { app } = webhookApp();

		const response = await deliver(app, {
			authorization: GOOD_AUTHORIZATION,
			body: JSON.stringify({ ignore: true }),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ignored: true });
	});

	it("does not reveal whether an automation exists, or runs, when a call is refused", async () => {
		const { app, webhook } = webhookApp();

		const refused = await Promise.all([
			deliver(app),
			deliver(app, { authorization: "Bearer wrong-secret" }),
			deliver(app, {
				authorization: GOOD_AUTHORIZATION,
				path: `/webhooks/triggers/${OTHER_TRIGGER_ID}`,
			}),
			deliver(app, { authorization: GOOD_AUTHORIZATION, body: JSON.stringify({ paused: true }) }),
		]);

		expect(refused.map(({ status }) => status)).toEqual([401, 401, 401, 401]);
		const bodies = await Promise.all(refused.map((response) => response.json()));
		for (const body of bodies) expect(body).toEqual(bodies[0]);
		expect(webhook).toHaveBeenCalledTimes(1);
	});

	it("rejects non-JSON content before authenticating", async () => {
		const { app, authenticated, webhook } = webhookApp();

		const notJson = await deliver(app, {
			authorization: GOOD_AUTHORIZATION,
			contentType: "text/plain",
		});
		const malformed = await deliver(app, { authorization: GOOD_AUTHORIZATION, body: "{" });

		expect(notJson.status).toBe(400);
		expect(malformed.status).toBe(400);
		expect(authenticated).not.toHaveBeenCalled();
		expect(webhook).not.toHaveBeenCalled();
	});

	it("rejects oversized JSON before authenticating", async () => {
		const { app, authenticated } = webhookApp();

		const response = await deliver(app, {
			authorization: GOOD_AUTHORIZATION,
			body: JSON.stringify({ payload: "x".repeat(MAX_JSON_BODY_BYTES) }),
		});

		expect(response.status).toBe(413);
		expect(authenticated).not.toHaveBeenCalled();
	});

	it("rejects a delivery whose id is too long", async () => {
		const { app } = webhookApp();

		const response = await deliver(app, {
			authorization: GOOD_AUTHORIZATION,
			body: JSON.stringify({ tooLong: true }),
		});

		expect(response.status).toBe(400);
	});
});

/** The app as Ada, with `operations` as the only operations it has. */
function appAs(operations: Partial<Operations.Interface> = {}) {
	return createTestApp(
		Layer.mergeAll(
			identifiedBy(async () => ({
				id: USER_ID,
				name: "Ada",
				email: "ada@example.com",
				image: null,
			})),
			unimplemented(Operations.Service, operations),
		),
	);
}

const session = { ...signedInWith("session"), "content-type": "application/json" };

/** Records the member a double was called for, alongside what it was given. */
const asked = <Input>(
	calls: Array<{ input: Input; memberId: string | undefined }>,
	principal: Principal,
	input: Input,
) =>
	Effect.sync(() => {
		calls.push({
			input,
			memberId: principal._tag === "MemberSession" ? principal.member : undefined,
		});
	});

describe("an automation's runs", () => {
	it("starts a run by hand for the member asking", async () => {
		const calls: Array<{ input: unknown; memberId: string | undefined }> = [];
		const requestId = "0199a3a0-0000-7000-8000-0000000000c1";
		const response = await appAs({
			"automations.run": (principal, input) =>
				Effect.as(asked(calls, principal, input), {
					runId: RUN_ID,
					chatId: CHAT_ID,
					duplicate: false,
				}),
		}).request(`/projects/${PROJECT_ID}/automations/${AUTOMATION_ID}/run`, {
			method: "POST",
			headers: session,
			body: JSON.stringify({ requestId }),
		});

		expect(response.status).toBe(202);
		expect(calls).toEqual([
			{
				input: { projectId: PROJECT_ID, automationId: AUTOMATION_ID, requestId },
				memberId: USER_ID,
			},
		]);
	});

	it("answers a run the caller may not start as forbidden", async () => {
		const response = await appAs({
			"automations.run": () => Effect.fail(new ActionForbidden({ proof: "CanRunAutomations" })),
		}).request(`/projects/${PROJECT_ID}/automations/${AUTOMATION_ID}/run`, {
			method: "POST",
			headers: session,
			body: JSON.stringify({ requestId: "0199a3a0-0000-7000-8000-0000000000c1" }),
		});

		expect(response.status).toBe(403);
	});
});

describe("an automation's triggers", () => {
	const triggerPath = `/projects/${PROJECT_ID}/automations/${AUTOMATION_ID}/triggers/${TRIGGER_ID}`;

	it("changes the trigger in the path, for the member asking", async () => {
		const calls: Array<{ input: unknown; memberId: string | undefined }> = [];
		const input = { kind: "webhook" as const, auth: { kind: "bearer" as const } };
		const response = await appAs({
			"automations.updateTrigger": (principal, changed) =>
				Effect.as(asked(calls, principal, changed), {
					automation: anAutomation(),
					secrets: [],
				}),
		}).request(triggerPath, { method: "PUT", headers: session, body: JSON.stringify(input) });

		expect(response.status).toBe(200);
		expect(calls).toEqual([
			{
				input: {
					projectId: PROJECT_ID,
					automationId: AUTOMATION_ID,
					triggerId: TRIGGER_ID,
					trigger: input,
				},
				memberId: USER_ID,
			},
		]);
	});

	it("refuses a change to a trigger's kind as a bad request", async () => {
		const response = await appAs({
			"automations.updateTrigger": () => Effect.fail(new AutomationTriggerKindChanged()),
		}).request(triggerPath, {
			method: "PUT",
			headers: session,
			body: JSON.stringify({ kind: "webhook" }),
		});

		expect(response.status).toBe(400);
	});

	it("answers a delivery ID header conflicting with auth as a bad request", async () => {
		const response = await appAs({
			"automations.updateTrigger": () => Effect.fail(new WebhookDeliveryIdHeaderRejected()),
		}).request(triggerPath, {
			method: "PUT",
			headers: session,
			body: JSON.stringify({ kind: "webhook", deliveryIdHeader: "Authorization" }),
		});
		expect(response.status).toBe(400);
	});

	it("answers a trigger the automation does not have as not found", async () => {
		const response = await appAs({
			"automations.removeTrigger": () => Effect.fail(new AutomationTriggerNotFound()),
		}).request(triggerPath, { method: "DELETE", headers: session });

		expect(response.status).toBe(404);
	});
});

function anAutomation(): Automation {
	return {
		id: AUTOMATION_ID,
		workspaceId: WORKSPACE_ID,
		projectId: PROJECT_ID,
		name: "Alerts",
		instructions: "Handle input.",
		triggers: [
			{ id: TRIGGER_ID, kind: "webhook", auth: { kind: "bearer" }, deliveryIdHeader: null },
		],
		state: "enabled",
		createdById: USER_ID,
		pausedAfterFailures: false,
		createdAt: "2026-10-15T00:00:00.000Z",
		updatedAt: "2026-10-15T00:00:00.000Z",
	};
}
