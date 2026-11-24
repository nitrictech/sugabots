import type { Connector } from "@sugabots/contracts";
import { ActionForbidden } from "@sugabots/core/authorization/access";
import { CurrentActor } from "@sugabots/core/authorization/current-actor";
import { ConnectorSetup } from "@sugabots/core/providers/connectors/connector-setup";
import { unimplemented } from "@sugabots/core/testing";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { MemberResolver } from "../../http/app.test-support.ts";
import {
	createTestApp,
	identifiedBy,
	sessionTokenIn,
	signedInWith,
} from "../../http/app.test-support.ts";

/**
 * The connector routes over doubles of `ConnectorSetup`: what each request
 * asks of it, as whom, and where a sign-in sends the browser.
 * The setup itself runs against Postgres and a real MCP server in
 * `connectors/connector-setup.test.ts`.
 */

const WORKSPACE_ID = "0199a3a0-0000-7000-8000-000000000001";
const USER_ID = "0199a3a0-0000-7000-8000-000000000002";
const CONNECTOR_ID = "0199a3a0-0000-7000-8000-000000000003";
/** The bot's default project, which holds its connectors. */
const PROJECT_ID = "0199a3a0-0000-7000-8000-000000000005";
const root = `/projects/${PROJECT_ID}/connectors`;
const headers = { ...signedInWith("good-token"), "content-type": "application/json" };
const ofProject = { workspaceId: WORKSPACE_ID, projectId: PROJECT_ID };

const resolveMember: MemberResolver = async (requestHeaders) =>
	sessionTokenIn(requestHeaders) === "good-token"
		? { id: USER_ID, name: "Sam", email: "sam@example.com", image: null }
		: null;

/** What a double saw: its input, and who it was asked as. */
const asked = <Input>(calls: Array<{ input: Input; memberId: string }>, input: Input) =>
	Effect.map(CurrentActor.Service, ({ memberId }) => {
		calls.push({ input, memberId });
	});

const wiki: Connector = {
	id: CONNECTOR_ID,
	workspaceId: WORKSPACE_ID,
	projectId: PROJECT_ID,
	name: "Wiki",
	handle: "wiki",
	url: "https://wiki.example.com/mcp",
	kind: "mcp",
	auth: "header",
	signedIn: true,
	signInExpired: false,
	secretHeader: null,
	hasSecret: false,
	appSettingsUrl: null,
	status: "connected",
	toolCounts: { allow: 0, ask: 0, off: 0 },
	lastTestError: null,
	connectedBy: null,
	signedInAs: null,
	createdAt: "2026-09-14T00:00:00.000Z",
};

const app = (connectors: Partial<ConnectorSetup.Interface>) =>
	createTestApp(
		Layer.merge(identifiedBy(resolveMember), unimplemented(ConnectorSetup.Service, connectors)),
	);

describe("a bot's connectors", () => {
	it("adds a server as the member asking, for the bot it is posted to", async () => {
		const calls: Array<{ input: unknown; memberId: string }> = [];
		const response = await app({
			create: (input) => Effect.as(asked(calls, input), wiki),
		}).request(root, {
			method: "POST",
			headers,
			body: JSON.stringify({ name: "Wiki", url: "https://wiki.example.com/mcp" }),
		});

		expect(response.status).toBe(201);
		expect(calls).toEqual([
			{
				input: {
					projectId: PROJECT_ID,
					connector: { name: "Wiki", url: "https://wiki.example.com/mcp" },
				},
				memberId: USER_ID,
			},
		]);
	});

	it("adds an HTTP endpoint as one", async () => {
		const calls: Array<{ input: unknown; memberId: string }> = [];
		const endpoint = {
			kind: "http",
			name: "Alerts",
			url: "https://alerts.example.com/v2",
		} as const;
		const response = await app({
			create: (input) => Effect.as(asked(calls, input), { ...wiki, ...endpoint }),
		}).request(root, { method: "POST", headers, body: JSON.stringify(endpoint) });

		expect(response.status).toBe(201);
		expect(calls).toEqual([
			{ input: { projectId: PROJECT_ID, connector: endpoint }, memberId: USER_ID },
		]);
	});

	it("answers a change the caller may not make as forbidden", async () => {
		const response = await app({
			create: () => Effect.fail(new ActionForbidden({ permission: "connector.manage" })),
		}).request(root, {
			method: "POST",
			headers,
			body: JSON.stringify({ name: "Docs", url: "https://docs.example.com/mcp" }),
		});

		expect(response.status).toBe(403);
	});

	it("says when there is no such connector to remove", async () => {
		const response = await app({
			remove: () => Effect.fail(new ConnectorSetup.ConnectorNotFound()),
		}).request(`${root}/${CONNECTOR_ID}`, { method: "DELETE", headers });

		expect(response.status).toBe(404);
	});
});

describe("signing a connector in", () => {
	it("hands back the address the browser should go to", async () => {
		const response = await app({
			startOAuth: () =>
				Effect.succeed({ authorizationUrl: "https://auth.example/authorize?state=s-1" }),
		}).request(`${root}/${CONNECTOR_ID}/oauth/start`, { method: "POST", headers });

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			authorizationUrl: "https://auth.example/authorize?state=s-1",
		});
	});

	it("keeps why a sign-in could not start out of the response", async () => {
		const response = await app({
			connectBuiltIn: () =>
				Effect.fail(new ConnectorSetup.ConnectorOAuthStartFailed({ reason: "unknown" })),
		}).request(`${root}/connect`, {
			method: "POST",
			headers,
			body: JSON.stringify({ name: "GitHub", url: "https://api.githubcopilot.com/mcp/" }),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			_tag: "BadRequest",
			message:
				"The server didn't start a sign-in. Try again, or connect it with an access token from the server instead.",
		});
	});

	it("finishes at the callback and sends the browser back to the project", async () => {
		const calls: Array<{ input: unknown; memberId: string }> = [];
		const back = await app({
			completeOAuth: (input) => Effect.as(asked(calls, input), { at: ofProject }),
		}).request("/connectors/oauth/callback?code=the-code&state=s-1", { headers });

		expect(back.status).toBe(302);
		expect(back.headers.get("location")).toBe(
			`http://localhost:5173/connectors/oauth/return?workspace=${WORKSPACE_ID}&project=${PROJECT_ID}`,
		);
		expect(calls).toEqual([
			{ input: { callback: { code: "the-code", state: "s-1" } }, memberId: USER_ID },
		]);
	});

	it("sends a failed sign-in back with a code, and nothing the authorization server wrote", async () => {
		const back = await app({
			completeOAuth: () => Effect.succeed({ failure: "refused", at: ofProject }),
		}).request(
			"/connectors/oauth/callback?error=access_denied&error_description=Visit+evil.example&state=s-1",
			{ headers },
		);

		const location = new URL(back.headers.get("location") ?? "");
		expect(location.searchParams.get("oauth_error")).toBe("refused");
		expect(location.toString()).not.toContain("evil");
	});

	it("does not consume an OAuth callback on HEAD", async () => {
		const completeOAuth = vi.fn<ConnectorSetup.Interface["completeOAuth"]>();

		const response = await app({ completeOAuth }).request(
			"/connectors/oauth/callback?code=the-code&state=s-1",
			{ method: "HEAD", headers },
		);

		expect(response.status).toBe(405);
		expect(response.headers.get("allow")).toBe("GET");
		expect(completeOAuth).not.toHaveBeenCalled();
	});
});
