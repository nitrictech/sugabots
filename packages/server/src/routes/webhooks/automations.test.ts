import {
	AutomationDeliveryIdTooLong,
	WebhookRefused,
} from "@sugabots/contracts/errors/automations";
import { AUTOMATION_WEBHOOK_MAX_BODY_BYTES } from "@sugabots/contracts/http";
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
import { Secrets } from "@sugabots/core/secrets/secrets";
import { unimplemented } from "@sugabots/core/testing";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestApp, type TestApp } from "../../http/app.test-support.ts";

const OTHER_TRIGGER_ID = "0199a3a0-0000-7000-8000-000000000002";
const RUN_ID = "0199a3a0-0000-7000-8000-000000000004";

const GOOD_SECRET = "whk_good-secret";
const GOOD_AUTHORIZATION = `Bearer ${GOOD_SECRET}`;

/**
 * The webhook, with core's own webhook authenticator over the test database
 * and a trigger there whose secret is `GOOD_SECRET`, so what is under test is
 * that a call is authenticated before its operation, which is doubled, is
 * called for the principal that made.
 */
describe("Automation webhooks", () => {
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

	function webhookApp(
		answer: Operations.Interface["automations.webhook"] = () =>
			Effect.succeed({ runId: RUN_ID, duplicate: false }),
	) {
		const authenticated = vi.fn<WebhookAuthentication.Interface["trigger"]>((id, delivery) =>
			authenticator.trigger(id, delivery),
		);
		const webhook = vi.fn(answer);
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
		const challenge = "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P";
		const { app } = webhookApp(() => Effect.succeed({ challenge }));

		const response = await deliver(app, {
			authorization: GOOD_AUTHORIZATION,
			body: JSON.stringify({ challenge }),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			challenge,
		});
	});

	it("answers a call the trigger's filter turned away with 200, so its sender does not retry", async () => {
		const { app } = webhookApp(() => Effect.succeed({ ignored: true }));

		const response = await deliver(app, { authorization: GOOD_AUTHORIZATION });

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ignored: true });
	});

	it("does not reveal whether an automation exists, or runs, when a call is refused", async () => {
		const { app, webhook } = webhookApp(() => Effect.fail(new WebhookRefused()));

		const refused = await Promise.all([
			deliver(app),
			deliver(app, { authorization: "Bearer wrong-secret" }),
			deliver(app, {
				authorization: GOOD_AUTHORIZATION,
				path: `/webhooks/triggers/${OTHER_TRIGGER_ID}`,
			}),
			deliver(app, { authorization: GOOD_AUTHORIZATION }),
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

	it("starts a run for a call up to its limit, which its run's first message holds", async () => {
		const { app, webhook } = webhookApp();
		const shell = JSON.stringify({ report: "" });
		const payload = { report: "x".repeat(AUTOMATION_WEBHOOK_MAX_BODY_BYTES - shell.length) };

		const response = await deliver(app, {
			authorization: GOOD_AUTHORIZATION,
			body: JSON.stringify(payload),
		});

		expect(response.status).toBe(202);
		expect(webhook.mock.calls[0]?.[1]).toMatchObject({ payload });
	});

	it("refuses a call over its limit while reading it, before authenticating", async () => {
		const { app, authenticated } = webhookApp();
		const shell = JSON.stringify({ report: "" });

		const response = await deliver(app, {
			authorization: GOOD_AUTHORIZATION,
			body: JSON.stringify({
				report: "x".repeat(AUTOMATION_WEBHOOK_MAX_BODY_BYTES - shell.length + 1),
			}),
		});

		expect(response.status).toBe(413);
		expect(await response.json()).toMatchObject({
			message: "The request body is over the 64 KiB limit",
		});
		expect(authenticated).not.toHaveBeenCalled();
	});

	it("rejects a delivery whose id is too long", async () => {
		const { app } = webhookApp(() => Effect.fail(new AutomationDeliveryIdTooLong()));

		const response = await deliver(app, { authorization: GOOD_AUTHORIZATION });

		expect(response.status).toBe(400);
	});
});
