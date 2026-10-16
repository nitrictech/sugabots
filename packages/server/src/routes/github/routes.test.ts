import { GitHubApps } from "@sugabots/core/providers/connections/github/github-app";
import { unimplemented } from "@sugabots/core/testing";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import { createTestApp, identifiedBy } from "../../http/app.test-support.ts";

const CONNECTION_ID = "0199a3a0-0000-7000-8000-000000000001";
const WORKSPACE_ID = "0199a3a0-0000-7000-8000-000000000002";
const POD_ID = "0199a3a0-0000-7000-8000-000000000003";
const USER_ID = "0199a3a0-0000-7000-8000-000000000004";
const inPod = { workspaceId: WORKSPACE_ID, podId: POD_ID };

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
