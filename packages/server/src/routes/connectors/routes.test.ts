import type { Connector } from "@sugabots/contracts";
import {
	ConnectorNotFound,
	ConnectorOAuthStartFailed,
} from "@sugabots/contracts/errors/connectors";
import { Operations } from "@sugabots/core/operations/registry";
import type { Principal } from "@sugabots/core/principal";
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
 * The connector routes over doubles of the connectors operations: which
 * operation each request calls, with what, for whom, and where a sign-in
 * sends the browser. Who may do what is decided, and tested, in core.
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

/** The member a principal is signed in as, as the session authenticator built it. */
const memberOf = (principal: Principal) =>
	principal._tag === "MemberSession" ? principal.member : undefined;

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

/** The app with `operations` as the only operations it has. */
const app = (operations: Partial<Operations.Interface>) =>
	createTestApp(
		Layer.merge(identifiedBy(resolveMember), unimplemented(Operations.Service, operations)),
	);

describe("a bot's connectors", () => {
	it("adds a server for the member asking, to the project it is posted to", async () => {
		const calls: unknown[] = [];
		const response = await app({
			"connectors.create": (principal, input) =>
				Effect.sync(() => {
					calls.push({ input, memberId: memberOf(principal) });
					return wiki;
				}),
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
		const calls: unknown[] = [];
		const endpoint = {
			kind: "http",
			name: "Alerts",
			url: "https://alerts.example.com/v2",
		} as const;
		const response = await app({
			"connectors.create": (_principal, input) =>
				Effect.sync(() => {
					calls.push(input);
					return { ...wiki, ...endpoint };
				}),
		}).request(root, { method: "POST", headers, body: JSON.stringify(endpoint) });

		expect(response.status).toBe(201);
		expect(calls).toEqual([{ projectId: PROJECT_ID, connector: endpoint }]);
	});

	it("tests an unsaved address with the project's id beside it", async () => {
		const calls: unknown[] = [];
		const response = await app({
			"connectors.testUnsaved": (_principal, input) =>
				Effect.sync(() => {
					calls.push(input);
					return { reachable: true, latencyMs: 12, tools: 3 };
				}),
		}).request(`${root}/test`, {
			method: "POST",
			headers,
			body: JSON.stringify({ url: "https://wiki.example.com/mcp" }),
		});

		expect(response.status).toBe(200);
		expect(calls).toEqual([{ projectId: PROJECT_ID, url: "https://wiki.example.com/mcp" }]);
	});

	it("says when there is no such connector to remove", async () => {
		const response = await app({
			"connectors.remove": () => Effect.fail(new ConnectorNotFound()),
		}).request(`${root}/${CONNECTOR_ID}`, { method: "DELETE", headers });

		expect(response.status).toBe(404);
	});
});

describe("signing a connector in", () => {
	it("hands back the address the browser should go to", async () => {
		const response = await app({
			"connectors.startOAuth": () =>
				Effect.succeed({ authorizationUrl: "https://auth.example/authorize?state=s-1" }),
		}).request(`${root}/${CONNECTOR_ID}/oauth/start`, { method: "POST", headers });

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			authorizationUrl: "https://auth.example/authorize?state=s-1",
		});
	});

	it("keeps why a sign-in could not start out of the response", async () => {
		const error = new ConnectorOAuthStartFailed({ reason: "unknown" });
		const response = await app({
			"connectors.connectBuiltIn": () => Effect.fail(error),
		}).request(`${root}/connect`, {
			method: "POST",
			headers,
			body: JSON.stringify({ name: "GitHub", url: "https://api.githubcopilot.com/mcp/" }),
		});

		expect(response.status).toBe(400);
		const body = await response.text();
		expect(body).not.toContain("unknown");
		expect(JSON.parse(body)).toEqual({
			_tag: "BadRequest",
			message: error.userMessage,
			error: {
				_tag: "ConnectorOAuthStartFailed",
				userMessage: error.userMessage,
				isRetryable: false,
			},
		});
	});

	it("finishes at the callback and sends the browser back to the project", async () => {
		const calls: unknown[] = [];
		const back = await app({
			"connectors.oauthCallback": (principal, input) =>
				Effect.sync(() => {
					calls.push({ input, memberId: memberOf(principal) });
					return { kind: "done", at: ofProject } as const;
				}),
		}).request("/connectors/oauth/callback?code=the-code&state=s-1", { headers });

		expect(back.status).toBe(302);
		expect(back.headers.get("location")).toBe(
			`http://localhost:5173/connectors/oauth/return?workspace=${WORKSPACE_ID}&project=${PROJECT_ID}`,
		);
		expect(calls).toEqual([{ input: { code: "the-code", state: "s-1" }, memberId: USER_ID }]);
	});

	it("sends a failed sign-in back with a code, and nothing the authorization server wrote", async () => {
		const back = await app({
			"connectors.oauthCallback": () =>
				Effect.succeed({ kind: "failed", failure: "refused", at: ofProject } as const),
		}).request(
			"/connectors/oauth/callback?error=access_denied&error_description=Visit+evil.example&state=s-1",
			{ headers },
		);

		const location = new URL(back.headers.get("location") ?? "");
		expect(location.searchParams.get("oauth_error")).toBe("refused");
		expect(location.toString()).not.toContain("evil");
	});

	it("does not consume an OAuth callback on HEAD", async () => {
		const oauthCallback = vi.fn<Operations.Interface["connectors.oauthCallback"]>();

		const response = await app({ "connectors.oauthCallback": oauthCallback }).request(
			"/connectors/oauth/callback?code=the-code&state=s-1",
			{ method: "HEAD", headers },
		);

		expect(response.status).toBe(405);
		expect(response.headers.get("allow")).toBe("GET");
		expect(oauthCallback).not.toHaveBeenCalled();
	});
});
