import { WebhookAuthentication } from "@sugabots/core/authentication/webhook";
import { Operations } from "@sugabots/core/operations/registry";
import type { WebhookCall } from "@sugabots/core/principal";
import { unimplemented } from "@sugabots/core/testing";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import { createTestApp, identifiedBy, sessionTokenIn, signedInWith } from "./app.test-support.ts";

/**
 * The addresses other systems were given before projects, over doubles of
 * core: each reaches the handler of the path that replaced it, as it was sent.
 */

const TRIGGER_ID = "0199a3a0-0000-7000-8000-000000000001";
const CONNECTOR_ID = "0199a3a0-0000-7000-8000-000000000002";
const WORKSPACE_ID = "0199a3a0-0000-7000-8000-000000000003";
const PROJECT_ID = "0199a3a0-0000-7000-8000-000000000004";
const MEMBER_ID = "0199a3a0-0000-7000-8000-000000000006";

/** A stand-in for the principal core's webhook authenticator builds; here it is only passed along. */
const admitted = Object.freeze({ _tag: "WebhookCall" }) as unknown as WebhookCall;

function oldPathsApp() {
	const automationWebhook = vi.fn<Operations.Interface["automations.webhook"]>(() =>
		Effect.succeed({ runId: "0199a3a0-0000-7000-8000-000000000005", duplicate: false }),
	);
	const gitHubDelivery = vi.fn<Operations.Interface["gitHubWebhooks.delivery"]>(() =>
		Effect.succeed({ workspaceId: WORKSPACE_ID, deliveryId: "delivery-1", activity: undefined }),
	);
	const gitHubAppMade = vi.fn<Operations.Interface["gitHubConnectors.gitHubAppMade"]>(() =>
		Effect.succeed({ kind: "next", url: "https://github.com/apps/acme/installations/new" }),
	);
	const gitHubAppInstalled = vi.fn<Operations.Interface["gitHubConnectors.gitHubAppInstalled"]>(
		() =>
			Effect.succeed({
				kind: "done",
				at: { workspaceId: WORKSPACE_ID, projectId: PROJECT_ID },
				connectorId: CONNECTOR_ID,
			}),
	);
	const app = createTestApp(
		Layer.mergeAll(
			identifiedBy(async (headers) =>
				sessionTokenIn(headers) === "good-token"
					? { id: MEMBER_ID, name: "Sam", email: "sam@example.com", image: null }
					: null,
			),
			unimplemented(WebhookAuthentication.Service, {
				trigger: () => Effect.succeed(admitted),
				github: () => Effect.succeed(admitted),
			}),
			unimplemented(Operations.Service, {
				"automations.webhook": automationWebhook,
				"gitHubWebhooks.delivery": gitHubDelivery,
				"gitHubConnectors.gitHubAppMade": gitHubAppMade,
				"gitHubConnectors.gitHubAppInstalled": gitHubAppInstalled,
			}),
		),
	);
	return { app, automationWebhook, gitHubDelivery, gitHubAppMade, gitHubAppInstalled };
}

/** A call from another system that happens to carry a browser's cookie and no origin. */
const fromAnotherSystem = (body: string) => ({
	method: "POST",
	headers: { "content-type": "application/json", cookie: "session=anything" },
	body,
});

describe("an address given out before projects", () => {
	it.each(["/hooks/triggers", "/hooks/routines"])(
		"%s reaches the trigger, free of the browser origin check as webhooks are",
		async (path) => {
			const { app, automationWebhook } = oldPathsApp();

			const response = await app.request(`${path}/${TRIGGER_ID}`, fromAnotherSystem("{}"));

			expect(response.status).toBe(202);
			expect(automationWebhook.mock.calls[0]?.[1].triggerId).toBe(TRIGGER_ID);
		},
	);

	it("reaches a GitHub app's deliveries", async () => {
		const { app, gitHubDelivery } = oldPathsApp();

		const response = await app.request(
			`/hooks/connections/${CONNECTOR_ID}`,
			fromAnotherSystem('{ "action":  "opened" }'),
		);

		expect(response.status).toBe(204);
		expect(gitHubDelivery.mock.calls[0]?.[1]).toMatchObject({
			connectorId: CONNECTOR_ID,
			body: '{ "action":  "opened" }',
		});
	});

	it("reaches a GitHub app's setup steps, with their query", async () => {
		const { app, gitHubAppMade, gitHubAppInstalled } = oldPathsApp();
		const signedIn = { headers: signedInWith("good-token") };

		const made = await app.request("/connections/github/made?code=the-code&state=s-1", signedIn);
		const installed = await app.request(
			"/connections/github/installed?installation_id=7&state=s-2",
			signedIn,
		);

		expect(made.status).toBe(302);
		expect(gitHubAppMade.mock.calls[0]?.[1]).toEqual({ code: "the-code", state: "s-1" });
		expect(installed.status).toBe(302);
		expect(gitHubAppInstalled.mock.calls[0]?.[1]).toEqual({ installationId: 7, state: "s-2" });
	});
});
