import { Routines } from "@sugabots/core/conversations/routines/routines";
import { GitHubApps } from "@sugabots/core/providers/connections/github/github-app";
import {
	DeliveryRefused,
	GitHubConnections,
} from "@sugabots/core/providers/connections/github/github-connections";
import type { RepositoryActivity } from "@sugabots/core/providers/connections/github/github-events";
import { unimplemented } from "@sugabots/core/testing";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import { createTestApp, identifiedBy } from "../../http/app.test-support.ts";

const CONNECTION_ID = "0199a3a0-0000-7000-8000-000000000001";
const WORKSPACE_ID = "0199a3a0-0000-7000-8000-000000000002";
const POD_ID = "0199a3a0-0000-7000-8000-000000000003";
const USER_ID = "0199a3a0-0000-7000-8000-000000000004";
const GOOD_SIGNATURE = "sha256=good";
const inPod = { workspaceId: WORKSPACE_ID, podId: POD_ID };

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
 * The app with a GitHub connection that admits deliveries with the good
 * signature, and says a `pull_request` event opened a pull request.
 */
function hookApp() {
	const receiveDelivery = vi.fn<GitHubConnections.Interface["receiveDelivery"]>(
		({ connectionId, headers }) =>
			headers["x-hub-signature-256"] === GOOD_SIGNATURE
				? Effect.succeed({
						workspaceId: WORKSPACE_ID,
						connectionId,
						deliveryId: headers["x-github-delivery"],
						activity: headers["x-github-event"] === "pull_request" ? opened : undefined,
					})
				: Effect.fail(new DeliveryRefused({ connectionId })),
	);
	const accept = vi.fn<Routines.ConnectionEventsInterface["accept"]>(() => Effect.succeed([]));
	const app = createTestApp(
		Layer.mergeAll(
			unimplemented(GitHubConnections.Service, { receiveDelivery }),
			unimplemented(Routines.ConnectionEvents, { accept }),
		),
	);
	return { app, receiveDelivery, accept };
}

const deliver = (app: ReturnType<typeof hookApp>["app"], headers: Record<string, string>) =>
	app.request(`/hooks/connections/${CONNECTION_ID}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: '{ "action":  "opened" }',
	});

describe("A GitHub connection's deliveries", () => {
	it("hands the connection the exact body, and the routines what it says happened", async () => {
		const { app, receiveDelivery, accept } = hookApp();

		const response = await deliver(app, {
			"x-github-event": "pull_request",
			"x-github-delivery": "delivery-1",
			"x-hub-signature-256": GOOD_SIGNATURE,
		});

		expect(response.status).toBe(204);
		expect(receiveDelivery.mock.calls[0]?.[0]).toMatchObject({
			connectionId: CONNECTION_ID,
			body: '{ "action":  "opened" }',
		});
		expect(accept).toHaveBeenCalledWith({
			workspaceId: WORKSPACE_ID,
			connectionId: CONNECTION_ID,
			deliveryId: "delivery-1",
			activity: opened,
		});
	});

	it("refuses a delivery its app didn't sign, and runs nothing", async () => {
		const { app, accept } = hookApp();

		const response = await deliver(app, {
			"x-github-event": "pull_request",
			"x-github-delivery": "delivery-1",
			"x-hub-signature-256": "sha256=forged",
		});

		expect(response.status).toBe(401);
		expect(accept).not.toHaveBeenCalled();
	});

	it("acknowledges an event no routine runs on", async () => {
		const { app, accept } = hookApp();

		const response = await deliver(app, {
			"x-github-event": "ping",
			"x-hub-signature-256": GOOD_SIGNATURE,
		});

		expect(response.status).toBe(204);
		expect(accept).not.toHaveBeenCalled();
	});
});

/** The app as someone signed in, with GitHub's setup steps answered by `gitHubApps`. */
const setupApp = (gitHubApps: Partial<GitHubApps.Interface>) =>
	createTestApp(
		Layer.mergeAll(
			identifiedBy(async (headers) =>
				headers.get("authorization") === "Bearer good-token"
					? { id: USER_ID, name: "Sam", email: "sam@example.com", image: null }
					: null,
			),
			unimplemented(GitHubApps.Service, gitHubApps),
		),
	);

const signedIn = { headers: { authorization: "Bearer good-token" } };

describe("Setting up a pod's GitHub App", () => {
	it("sends the browser on to GitHub's next page", async () => {
		const response = await setupApp({
			made: () =>
				Effect.succeed({ kind: "next", url: "https://github.com/apps/acme/installations/new" }),
		}).request("/connections/github/made?code=the-code&state=s-1", signedIn);

		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe("https://github.com/apps/acme/installations/new");
	});

	it("sends the browser back to the pod's new connection once the app is installed", async () => {
		const installed = vi.fn<GitHubApps.Interface["installed"]>(() =>
			Effect.succeed({ kind: "done", pod: inPod, connectionId: CONNECTION_ID }),
		);

		const response = await setupApp({ installed }).request(
			"/connections/github/installed?installation_id=7&state=s-1",
			signedIn,
		);

		expect(installed).toHaveBeenCalledWith({ installationId: 7, state: "s-1" });
		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe(
			`http://localhost:5173/connections/github/return?workspace=${WORKSPACE_ID}&pod=${POD_ID}&connection=${CONNECTION_ID}`,
		);
	});

	it("sends the browser back with why setup stopped, naming the pod only when the step was the caller's", async () => {
		const back = (outcome: GitHubApps.SetupOutcome) =>
			setupApp({ made: () => Effect.succeed(outcome) })
				.request("/connections/github/made?state=s-1", signedIn)
				.then((response) => response.headers.get("location"));

		expect(await back({ kind: "failed", pod: inPod, failure: "cancelled" })).toBe(
			`http://localhost:5173/connections/github/return?workspace=${WORKSPACE_ID}&pod=${POD_ID}&github_error=cancelled`,
		);
		expect(await back({ kind: "failed", pod: undefined, failure: "expired" })).toBe(
			"http://localhost:5173/connections/github/return?github_error=expired",
		);
	});

	it("does not spend GitHub's one-time code on HEAD", async () => {
		const made = vi.fn<GitHubApps.Interface["made"]>();

		const response = await setupApp({ made }).request(
			"/connections/github/made?code=the-code&state=s-1",
			{ ...signedIn, method: "HEAD" },
		);

		expect(response.status).toBe(405);
		expect(made).not.toHaveBeenCalled();
	});
});
