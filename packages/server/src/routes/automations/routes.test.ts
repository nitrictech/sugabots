import type { Automation } from "@sugabots/contracts";
import { ActionForbidden } from "@sugabots/core/authorization/access";
import { CurrentActor } from "@sugabots/core/authorization/current-actor";
import {
	AutomationDeliveryIdTooLong,
	AutomationTriggerKindChanged,
	AutomationTriggerNotFound,
	WebhookDeliveryIdHeaderRejected,
} from "@sugabots/core/chats/automations/automation";
import { Automations } from "@sugabots/core/chats/automations/automations";
import { unimplemented } from "@sugabots/core/testing";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import { createTestApp, identifiedBy } from "../../http/app.test-support.ts";
import { MAX_JSON_BODY_BYTES } from "../../http/validation.ts";

const AUTOMATION_ID = "0199a3a0-0000-7000-8000-000000000001";
const TRIGGER_ID = "0199a3a0-0000-7000-8000-000000000003";
const OTHER_TRIGGER_ID = "0199a3a0-0000-7000-8000-000000000002";
const WORKSPACE_ID = "0199a3a0-0000-7000-8000-000000000006";
const PROJECT_ID = "0199a3a0-0000-7000-8000-000000000007";
const USER_ID = "0199a3a0-0000-7000-8000-000000000008";
const RUN_ID = "0199a3a0-0000-7000-8000-000000000004";
const CHAT_ID = "0199a3a0-0000-7000-8000-000000000005";

const GOOD_AUTHORIZATION = "Bearer good-secret";

/**
 * The app with a webhook double that admits deliveries to `TRIGGER_ID` with
 * the good authorization, answers a `challenge` body with it, turns away an
 * `ignore` one, and refuses a `tooLong` one's id.
 */
function webhookApp() {
	const accept = vi.fn<Automations.WebhooksInterface["accept"]>(({ triggerId, delivery }) => {
		if (triggerId !== TRIGGER_ID || delivery.headers.authorization !== GOOD_AUTHORIZATION) {
			return Effect.succeed(undefined);
		}
		const payload = delivery.payload as { challenge?: string; tooLong?: boolean; ignore?: boolean };
		if (payload.tooLong) return Effect.fail(new AutomationDeliveryIdTooLong());
		if (payload.ignore) return Effect.succeed({ kind: "ignored" as const });
		if (payload.challenge) {
			return Effect.succeed({ kind: "challenge" as const, challenge: payload.challenge });
		}
		return Effect.succeed({
			kind: "run" as const,
			run: { runId: RUN_ID, chatId: CHAT_ID, duplicate: false },
		});
	});
	return {
		app: createTestApp(unimplemented(Automations.Webhooks, { accept })),
		accept,
	};
}

function deliver(
	app: ReturnType<typeof webhookApp>["app"],
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
	return app.request(options.path ?? `/webhooks/triggers/${TRIGGER_ID}`, {
		method: "POST",
		headers,
		body: options.body ?? JSON.stringify({ orderId: 42 }),
	});
}

describe("Automation webhooks", () => {
	it("hands the trigger the delivery's headers, exact body and JSON", async () => {
		const { app, accept } = webhookApp();
		// Spacing a signature covers, which re-encoding the JSON would lose.
		const body = '{ "orderId":  42 }';

		const response = await deliver(app, { authorization: GOOD_AUTHORIZATION, body });

		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({ runId: RUN_ID, duplicate: false });
		const [input] = accept.mock.calls[0] ?? [];
		expect(input?.triggerId).toBe(TRIGGER_ID);
		expect(input?.delivery.headers.authorization).toBe(GOOD_AUTHORIZATION);
		expect(new TextDecoder().decode(input?.delivery.body)).toBe(body);
		expect(input?.delivery.payload).toEqual({ orderId: 42 });
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

	it("does not reveal whether an automation exists when authentication fails", async () => {
		const { app } = webhookApp();

		const missing = await deliver(app);
		const invalid = await deliver(app, { authorization: "Bearer wrong-secret" });
		const unknown = await deliver(app, {
			authorization: GOOD_AUTHORIZATION,
			path: `/webhooks/triggers/${OTHER_TRIGGER_ID}`,
		});

		expect([missing.status, invalid.status, unknown.status]).toEqual([401, 401, 401]);
		const [missingBody, invalidBody, unknownBody] = await Promise.all(
			[missing, invalid, unknown].map((response) => response.json()),
		);
		expect(missingBody).toEqual(invalidBody);
		expect(invalidBody).toEqual(unknownBody);
	});

	it("rejects non-JSON content before authenticating", async () => {
		const { app, accept } = webhookApp();

		const notJson = await deliver(app, {
			authorization: GOOD_AUTHORIZATION,
			contentType: "text/plain",
		});
		const malformed = await deliver(app, { authorization: GOOD_AUTHORIZATION, body: "{" });

		expect(notJson.status).toBe(400);
		expect(malformed.status).toBe(400);
		expect(accept).not.toHaveBeenCalled();
	});

	it("rejects oversized JSON before accepting a trigger", async () => {
		const { app, accept } = webhookApp();

		const response = await deliver(app, {
			authorization: GOOD_AUTHORIZATION,
			body: JSON.stringify({ payload: "x".repeat(MAX_JSON_BODY_BYTES) }),
		});

		expect(response.status).toBe(413);
		expect(accept).not.toHaveBeenCalled();
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

/** The app as Ada, with `automations` as the only automation methods it has. */
function appAs(services: { automations?: Partial<Automations.Interface> } = {}) {
	return createTestApp(
		Layer.mergeAll(
			identifiedBy(async () => ({
				id: USER_ID,
				name: "Ada",
				email: "ada@example.com",
				image: null,
			})),
			unimplemented(Automations.Service, { ...services.automations }),
		),
	);
}

const session = { authorization: "Bearer session", "content-type": "application/json" };

/** The actor a double was called as, alongside what it was given. */
const asked = <Input>(calls: Array<{ input: Input; personId: string }>, input: Input) =>
	Effect.map(CurrentActor.Service, ({ personId }) => {
		calls.push({ input, personId });
	});

describe("an automation's runs", () => {
	it("starts a run by hand as the person asking", async () => {
		const calls: Array<{ input: unknown; personId: string }> = [];
		const requestId = "0199a3a0-0000-7000-8000-0000000000c1";
		const response = await appAs({
			automations: {
				run: (input) =>
					Effect.as(asked(calls, input), {
						runId: RUN_ID,
						chatId: CHAT_ID,
						duplicate: false,
					}),
			},
		}).request(`/projects/${PROJECT_ID}/automations/${AUTOMATION_ID}/run`, {
			method: "POST",
			headers: session,
			body: JSON.stringify({ requestId }),
		});

		expect(response.status).toBe(202);
		expect(calls).toEqual([
			{
				input: { projectId: PROJECT_ID, automationId: AUTOMATION_ID, requestId },
				personId: USER_ID,
			},
		]);
	});

	it("answers a run the caller may not start as forbidden", async () => {
		const response = await appAs({
			automations: {
				run: () => Effect.fail(new ActionForbidden({ permission: "automation.run" })),
			},
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

	it("changes the trigger in the path, as the person asking", async () => {
		const calls: Array<{ input: unknown; personId: string }> = [];
		const input = { kind: "webhook" as const, auth: { kind: "bearer" as const } };
		const response = await appAs({
			automations: {
				updateTrigger: (trigger, changed) =>
					Effect.as(asked(calls, { trigger, changed }), {
						automation: anAutomation(),
						secrets: [],
					}),
			},
		}).request(triggerPath, { method: "PUT", headers: session, body: JSON.stringify(input) });

		expect(response.status).toBe(200);
		expect(calls).toEqual([
			{
				input: {
					trigger: { projectId: PROJECT_ID, automationId: AUTOMATION_ID, triggerId: TRIGGER_ID },
					changed: input,
				},
				personId: USER_ID,
			},
		]);
	});

	it("refuses a change to a trigger's kind as a bad request", async () => {
		const response = await appAs({
			automations: { updateTrigger: () => Effect.fail(new AutomationTriggerKindChanged()) },
		}).request(triggerPath, {
			method: "PUT",
			headers: session,
			body: JSON.stringify({ kind: "webhook" }),
		});

		expect(response.status).toBe(400);
	});

	it("answers a delivery ID header conflicting with auth as a bad request", async () => {
		const response = await appAs({
			automations: { updateTrigger: () => Effect.fail(new WebhookDeliveryIdHeaderRejected()) },
		}).request(triggerPath, {
			method: "PUT",
			headers: session,
			body: JSON.stringify({ kind: "webhook", deliveryIdHeader: "Authorization" }),
		});
		expect(response.status).toBe(400);
	});

	it("answers a trigger the automation does not have as not found", async () => {
		const response = await appAs({
			automations: { removeTrigger: () => Effect.fail(new AutomationTriggerNotFound()) },
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
		triggers: [{ id: TRIGGER_ID, kind: "webhook", auth: { kind: "bearer" } }],
		state: "enabled",
		createdById: USER_ID,
		pausedAfterFailures: false,
		createdAt: "2026-10-15T00:00:00.000Z",
		updatedAt: "2026-10-15T00:00:00.000Z",
	};
}
