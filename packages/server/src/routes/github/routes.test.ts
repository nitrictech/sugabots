import type { GitHubSetupOutcome, RepositoryActivity } from "@sugabots/contracts";
import { GitHubDeliveryIdInvalid } from "@sugabots/contracts/errors/connectors";
import { WebhookAuthentication } from "@sugabots/core/authentication/webhook";
import { Operations } from "@sugabots/core/operations/registry";
import type { WebhookCall } from "@sugabots/core/principal";
import { unimplemented } from "@sugabots/core/testing";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
	createTestApp,
	identifiedBy,
	sessionTokenIn,
	signedInWith,
} from "../../http/app.test-support.ts";

/**
 * The GitHub routes over doubles of core: which operation each request
 * calls, with what, and where GitHub's callbacks send the browser; and for a
 * delivery, that core's webhook authenticator admits it before its operation
 * reads it and its automations run.
 */

const CONNECTOR_ID = "0199a3a0-0000-7000-8000-000000000001";
const WORKSPACE_ID = "0199a3a0-0000-7000-8000-000000000002";
const USER_ID = "0199a3a0-0000-7000-8000-000000000004";
const GOOD_SIGNATURE = "sha256=good";
/** The bot's default project, which holds its GitHub app. */
const PROJECT_ID = "0199a3a0-0000-7000-8000-000000000005";
const ofProject = { workspaceId: WORKSPACE_ID, projectId: PROJECT_ID };

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
) =>
	app.request(`/webhooks/connectors/${connectorId}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: '{ "action":  "opened" }',
	});

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

/** The app as someone signed in, with GitHub's setup steps answered by `operations`. */
const setupApp = (operations: Partial<Operations.Interface>) =>
	createTestApp(
		Layer.mergeAll(
			identifiedBy(async (headers) =>
				sessionTokenIn(headers) === "good-token"
					? { id: USER_ID, name: "Sam", email: "sam@example.com", image: null }
					: null,
			),
			unimplemented(Operations.Service, operations),
		),
	);

const signedIn = { headers: signedInWith("good-token") };

describe("Setting up a bot's GitHub App", () => {
	it("sends the browser on to GitHub's next page", async () => {
		const response = await setupApp({
			"gitHubConnectors.gitHubAppMade": () =>
				Effect.succeed({ kind: "next", url: "https://github.com/apps/acme/installations/new" }),
		}).request("/connectors/github/made?code=the-code&state=s-1", signedIn);

		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe("https://github.com/apps/acme/installations/new");
	});

	it("sends the browser back to the project's new connector once the app is installed", async () => {
		const installed = vi.fn<Operations.Interface["gitHubConnectors.gitHubAppInstalled"]>(() =>
			Effect.succeed({ kind: "done", at: ofProject, connectorId: CONNECTOR_ID }),
		);

		const response = await setupApp({ "gitHubConnectors.gitHubAppInstalled": installed }).request(
			"/connectors/github/installed?installation_id=7&state=s-1",
			signedIn,
		);

		expect(installed.mock.calls[0]?.[1]).toEqual({ installationId: 7, state: "s-1" });
		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe(
			`http://localhost:5173/connectors/github/return?workspace=${WORKSPACE_ID}&project=${PROJECT_ID}&connector=${CONNECTOR_ID}`,
		);
	});

	it("sends the browser back with why setup stopped, naming the bot only when the step was the caller's", async () => {
		const back = (outcome: GitHubSetupOutcome) =>
			setupApp({ "gitHubConnectors.gitHubAppMade": () => Effect.succeed(outcome) })
				.request("/connectors/github/made?state=s-1", signedIn)
				.then((response) => response.headers.get("location"));

		expect(await back({ kind: "failed", at: ofProject, failure: "cancelled" })).toBe(
			`http://localhost:5173/connectors/github/return?workspace=${WORKSPACE_ID}&project=${PROJECT_ID}&github_error=cancelled`,
		);
		expect(await back({ kind: "failed", at: undefined, failure: "expired" })).toBe(
			"http://localhost:5173/connectors/github/return?github_error=expired",
		);
	});

	it("does not spend GitHub's one-time code on HEAD", async () => {
		const made = vi.fn<Operations.Interface["gitHubConnectors.gitHubAppMade"]>();

		const response = await setupApp({ "gitHubConnectors.gitHubAppMade": made }).request(
			"/connectors/github/made?code=the-code&state=s-1",
			{ ...signedIn, method: "HEAD" },
		);

		expect(response.status).toBe(405);
		expect(made).not.toHaveBeenCalled();
	});
});
