import type { GitHubSetupOutcome } from "@sugabots/contracts";
import { Operations } from "@sugabots/core/operations/registry";
import type { Principal } from "@sugabots/core/principal";
import { unimplemented } from "@sugabots/core/testing";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
	createTestApp,
	identifiedBy,
	type MemberResolver,
	sessionTokenIn,
	signedInWith,
} from "../../http/app.test-support.ts";

/**
 * Where a sign-in finishes, over doubles of its operations: what each
 * callback hands its operation, for whom, and where it sends the browser.
 * How a sign-in goes is decided, and tested, in core.
 */

const WORKSPACE_ID = "0199a3a0-0000-7000-8000-000000000001";
const USER_ID = "0199a3a0-0000-7000-8000-000000000002";
const CONNECTOR_ID = "0199a3a0-0000-7000-8000-000000000003";
/** The bot's default project, which holds its connectors. */
const PROJECT_ID = "0199a3a0-0000-7000-8000-000000000005";
const ofProject = { workspaceId: WORKSPACE_ID, projectId: PROJECT_ID };
const signedIn = { headers: signedInWith("good-token") };

const resolveMember: MemberResolver = async (headers) =>
	sessionTokenIn(headers) === "good-token"
		? { id: USER_ID, name: "Sam", email: "sam@example.com", image: null }
		: null;

/** The member a principal is signed in as, as the session authenticator built it. */
const memberOf = (principal: Principal) =>
	principal._tag === "MemberSession" ? principal.member : undefined;

/** The app as someone signed in, with `operations` as the only operations it has. */
const app = (operations: Partial<Operations.Interface>) =>
	createTestApp(
		Layer.merge(identifiedBy(resolveMember), unimplemented(Operations.Service, operations)),
	);

describe("a connector's sign-in", () => {
	it.each(["/connectors/oauth/callback", "/connections/oauth/callback"])(
		"finishes at %s and sends the browser back to the project",
		async (path) => {
			const calls: unknown[] = [];
			const back = await app({
				"connectors.oauthCallback": (principal, input) =>
					Effect.sync(() => {
						calls.push({ input, memberId: memberOf(principal) });
						return { kind: "done", at: ofProject } as const;
					}),
			}).request(`${path}?code=the-code&state=s-1`, signedIn);

			expect(back.status).toBe(302);
			expect(back.headers.get("location")).toBe(
				`http://localhost:5173/connectors/oauth/return?workspace=${WORKSPACE_ID}&project=${PROJECT_ID}`,
			);
			expect(calls).toEqual([{ input: { code: "the-code", state: "s-1" }, memberId: USER_ID }]);
		},
	);

	it("sends a failed sign-in back with a code, and nothing the authorization server wrote", async () => {
		const back = await app({
			"connectors.oauthCallback": () =>
				Effect.succeed({ kind: "failed", failure: "refused", at: ofProject } as const),
		}).request(
			"/connectors/oauth/callback?error=access_denied&error_description=Visit+evil.example&state=s-1",
			signedIn,
		);

		const location = new URL(back.headers.get("location") ?? "");
		expect(location.searchParams.get("oauth_error")).toBe("refused");
		expect(location.toString()).not.toContain("evil");
	});
});

describe("setting up a bot's GitHub App", () => {
	it("sends the browser on to GitHub's next page", async () => {
		const response = await app({
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

		const response = await app({ "gitHubConnectors.gitHubAppInstalled": installed }).request(
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
			app({ "gitHubConnectors.gitHubAppMade": () => Effect.succeed(outcome) })
				.request("/connectors/github/made?state=s-1", signedIn)
				.then((response) => response.headers.get("location"));

		expect(await back({ kind: "failed", at: ofProject, failure: "cancelled" })).toBe(
			`http://localhost:5173/connectors/github/return?workspace=${WORKSPACE_ID}&project=${PROJECT_ID}&github_error=cancelled`,
		);
		expect(await back({ kind: "failed", at: undefined, failure: "expired" })).toBe(
			"http://localhost:5173/connectors/github/return?github_error=expired",
		);
	});
});

it.each([
	["connectors.oauthCallback", "/connectors/oauth/callback?code=the-code&state=s-1"],
	["gitHubConnectors.gitHubAppMade", "/connectors/github/made?code=the-code&state=s-1"],
	[
		"gitHubConnectors.gitHubAppInstalled",
		"/connectors/github/installed?installation_id=7&state=s-1",
	],
] as const)("doesn't spend %s's one-time code on HEAD", async (operation, path) => {
	const finish = vi.fn(() => Effect.die("A HEAD finished a sign-in"));

	const response = await app({ [operation]: finish }).request(path, {
		...signedIn,
		method: "HEAD",
	});

	expect(response.status).toBe(405);
	expect(response.headers.get("allow")).toBe("GET");
	expect(finish).not.toHaveBeenCalled();
});
