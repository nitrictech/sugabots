import type { RepositoryActivity } from "@sugabots/contracts";
import { GitHubDeliveryIdInvalid } from "@sugabots/contracts/errors/connectors";
import { GITHUB_DELIVERY_MAX_BODY_BYTES } from "@sugabots/contracts/http";
import { WebhookAuthentication } from "@sugabots/core/authentication/webhook";
import { Operations } from "@sugabots/core/operations/registry";
import type { WebhookCall } from "@sugabots/core/principal";
import { unimplemented } from "@sugabots/core/testing";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import { createTestApp } from "../../http/app.test-support.ts";

/**
 * A GitHub connector's deliveries over doubles of core: that core's webhook
 * authenticator admits a delivery before its operation reads it and its
 * automations run.
 */

const CONNECTOR_ID = "0199a3a0-0000-7000-8000-000000000001";
const WORKSPACE_ID = "0199a3a0-0000-7000-8000-000000000002";
const GOOD_SIGNATURE = "sha256=good";

const opened: RepositoryActivity = {
	event: "pull_request_opened",
	repository: "acme/web",
	sender: "octocat",
	url: "https://github.com/acme/web/pull/3",
	number: 3,
	title: "Fix the login",
	text: null,
	branch: "fix-login",
};

/**
 * A stand-in for the principal core's webhook authenticator builds for a
 * delivery the app of `CONNECTOR_ID` signed. Only core builds a real one;
 * here it is only passed from the authenticator to the operation.
 */
const signedByTheApp = Object.freeze({ _tag: "WebhookCall" }) as unknown as WebhookCall;

function hookApp({
	authentication = Effect.succeed(signedByTheApp),
	delivery = Effect.die("Unexpected delivery"),
}: {
	authentication?: ReturnType<WebhookAuthentication.Interface["github"]>;
	delivery?: ReturnType<Operations.Interface["gitHubWebhooks.delivery"]>;
} = {}) {
	const authenticate = vi.fn<WebhookAuthentication.Interface["github"]>(() => authentication);
	const read = vi.fn<Operations.Interface["gitHubWebhooks.delivery"]>(() => delivery);
	const app = createTestApp(
		Layer.mergeAll(
			unimplemented(WebhookAuthentication.Service, { github: authenticate }),
			unimplemented(Operations.Service, { "gitHubWebhooks.delivery": read }),
		),
	);
	return { app, authenticate, read };
}

const deliver = (
	app: ReturnType<typeof hookApp>["app"],
	headers: Record<string, string>,
	connectorId = CONNECTOR_ID,
	body = '{ "action":  "opened" }',
) =>
	app.request(`/webhooks/connectors/${connectorId}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body,
	});

/** A delivery of `bytes` bytes, as GitHub sends a push with a long list of commits. */
const deliveryOf = (bytes: number) => {
	const shell = '{ "action": "opened", "commits": "" }';
	return shell.replace('""', `"${"x".repeat(bytes - shell.length)}"`);
};

const signedHeaders = {
	"x-github-event": "pull_request",
	"x-github-delivery": "delivery-1",
	"x-hub-signature-256": GOOD_SIGNATURE,
};

describe("A GitHub connector's deliveries", () => {
	it("admits the exact body by its signature, and hands it to the delivery operation", async () => {
		const connectorId = "0199a3a0-0000-7000-8000-000000000003";
		const deliveryId = "delivery-1";
		const { app, authenticate, read } = hookApp({
			delivery: Effect.succeed({ workspaceId: WORKSPACE_ID, deliveryId, activity: opened }),
		});

		const response = await deliver(
			app,
			{
				"x-github-event": "pull_request",
				"x-github-delivery": deliveryId,
				"x-hub-signature-256": GOOD_SIGNATURE,
			},
			connectorId,
		);

		expect(response.status).toBe(204);
		expect(authenticate).toHaveBeenCalledExactlyOnceWith(
			connectorId,
			expect.objectContaining({
				headers: expect.objectContaining({ "x-hub-signature-256": GOOD_SIGNATURE }),
				body: '{ "action":  "opened" }',
			}),
		);
		expect(read.mock.calls[0]?.[0]).toBe(signedByTheApp);
		expect(read.mock.calls[0]?.[1]).toEqual({
			connectorId,
			event: "pull_request",
			deliveryId,
			body: '{ "action":  "opened" }',
		});
	});

	it("admits a delivery far over the API's usual body limit, as GitHub sends up to 25 MiB", async () => {
		const { app, authenticate, read } = hookApp({
			delivery: Effect.succeed({
				workspaceId: WORKSPACE_ID,
				deliveryId: "delivery-1",
				activity: opened,
			}),
		});
		const body = deliveryOf(5 * 1024 * 1024);

		const response = await deliver(app, signedHeaders, CONNECTOR_ID, body);

		expect(response.status).toBe(204);
		expect(authenticate.mock.calls[0]?.[1].body).toBe(body);
		expect(read.mock.calls[0]?.[1]).toMatchObject({ body });
	});

	it("refuses a delivery over 25 MiB while reading it, before its signature is checked", async () => {
		const { app, authenticate } = hookApp();

		const response = await deliver(
			app,
			signedHeaders,
			CONNECTOR_ID,
			deliveryOf(GITHUB_DELIVERY_MAX_BODY_BYTES + 1),
		);

		expect(response.status).toBe(413);
		expect(await response.json()).toMatchObject({
			_tag: "PayloadTooLarge",
			message: "The request body is over the 25 MiB limit",
		});
		expect(authenticate).not.toHaveBeenCalled();
	});

	it("refuses a delivery its app didn't sign, and reads nothing", async () => {
		const { app, read } = hookApp({
			authentication: Effect.fail(new WebhookAuthentication.WebhookRefused()),
		});

		const response = await deliver(app, {
			"x-github-event": "pull_request",
			"x-github-delivery": "delivery-1",
			"x-hub-signature-256": "sha256=forged",
		});

		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({
			_tag: "Unauthorized",
		});
		expect(read).not.toHaveBeenCalled();
	});

	it("refuses an activity GitHub gave no usable id, since a retry couldn't be told apart", async () => {
		const refusal = new GitHubDeliveryIdInvalid();
		const { app } = hookApp({ delivery: Effect.fail(refusal) });

		const response = await deliver(app, {
			"x-github-event": "pull_request",
			"x-hub-signature-256": GOOD_SIGNATURE,
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ message: refusal.userMessage });
	});
});
