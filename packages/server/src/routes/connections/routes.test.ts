import type { Connection } from "@sugabots/contracts";
import { ConnectionSetup } from "@sugabots/core/providers/connections/connection-setup";
import { unimplemented } from "@sugabots/core/testing";
import { testAuthorization } from "@sugabots/core/workspaces/testing";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { UserResolver } from "../../http/app.test-support.ts";
import { createTestApp } from "../../http/app.test-support.ts";

/**
 * The connection routes over doubles of `ConnectionSetup`: who may reach
 * them, what each request asks of it, and where a sign-in sends the browser.
 * The setup itself runs against Postgres and a real MCP server in
 * `connections/connection-setup.test.ts`.
 */

const WORKSPACE_ID = "0199a3a0-0000-7000-8000-000000000001";
const USER_ID = "0199a3a0-0000-7000-8000-000000000002";
const CONNECTION_ID = "0199a3a0-0000-7000-8000-000000000003";
const POD_ID = "0199a3a0-0000-7000-8000-000000000004";
const MEMBER_ID = "0199a3a0-0000-7000-8000-000000000006";
const root = `/pods/${POD_ID}/connections`;
const headers = { authorization: "Bearer good-token", "content-type": "application/json" };
const memberHeaders = { ...headers, authorization: "Bearer member-token" };
const inPod = { workspaceId: WORKSPACE_ID, podId: POD_ID };

const resolveUser: UserResolver = async (requestHeaders) => {
	const token = requestHeaders.get("authorization");
	if (token === "Bearer good-token") {
		return { id: USER_ID, name: "Sam", email: "sam@example.com", image: null };
	}
	if (token === "Bearer member-token") {
		return { id: MEMBER_ID, name: "Kim", email: "kim@example.com", image: null };
	}
	return null;
};

/** Sam administers the workspace; Kim is an ordinary member of the pod. */
const authorization = testAuthorization({
	id: WORKSPACE_ID,
	roles: { [USER_ID]: "admin", [MEMBER_ID]: "member" },
	pods: [{ id: POD_ID, kind: "shared", members: [MEMBER_ID], name: "Support", slug: "support" }],
});

const wiki: Connection = {
	id: CONNECTION_ID,
	workspaceId: WORKSPACE_ID,
	podId: POD_ID,
	name: "Wiki",
	handle: "wiki",
	url: "https://wiki.example.com/mcp",
	auth: "header",
	signedIn: true,
	secretHeader: null,
	hasSecret: false,
	access: "allow",
	status: "connected",
	tools: [],
	lastTestedAt: null,
	lastTestError: null,
	createdAt: "2026-09-14T00:00:00.000Z",
};

const app = (connections: Partial<ConnectionSetup.Interface>) =>
	createTestApp({
		resolveUser,
		authorization,
		services: unimplemented(ConnectionSetup.Service, connections),
	});

describe("a pod's connections", () => {
	it("adds a server as the person asking, in the pod it is posted to", async () => {
		const create = vi.fn<ConnectionSetup.Interface["create"]>(() => Effect.succeed(wiki));

		const response = await app({ create }).request(root, {
			method: "POST",
			headers,
			body: JSON.stringify({ name: "Wiki", url: "https://wiki.example.com/mcp" }),
		});

		expect(response.status).toBe(201);
		expect(create).toHaveBeenCalledWith({
			...inPod,
			createdById: USER_ID,
			connection: { name: "Wiki", url: "https://wiki.example.com/mcp" },
		});
	});

	it("lets an ordinary pod member read connections but not change them", async () => {
		const connections = app({ list: () => Effect.succeed([wiki]) });

		expect((await connections.request(root, { headers: memberHeaders })).status).toBe(200);
		const response = await connections.request(root, {
			method: "POST",
			headers: memberHeaders,
			body: JSON.stringify({ name: "Docs", url: "https://docs.example.com/mcp" }),
		});

		expect(response.status).toBe(403);
	});

	it("says when there is no such connection to remove", async () => {
		const response = await app({
			remove: () => Effect.fail(new ConnectionSetup.ConnectionNotFound()),
		}).request(`${root}/${CONNECTION_ID}`, { method: "DELETE", headers });

		expect(response.status).toBe(404);
	});
});

describe("signing a connection in", () => {
	it("hands back the address the browser should go to", async () => {
		const response = await app({
			startOAuth: () =>
				Effect.succeed({ authorizationUrl: "https://auth.example/authorize?state=s-1" }),
		}).request(`${root}/${CONNECTION_ID}/oauth/start`, { method: "POST", headers });

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			authorizationUrl: "https://auth.example/authorize?state=s-1",
		});
	});

	it("refuses OAuth to an ordinary pod member", async () => {
		const response = await app({}).request(`${root}/${CONNECTION_ID}/oauth/start`, {
			method: "POST",
			headers: memberHeaders,
		});

		expect(response.status).toBe(403);
	});

	it("keeps why a sign-in could not start out of the response", async () => {
		const response = await app({
			connectFromCatalog: () => Effect.fail(new ConnectionSetup.ConnectionOAuthStartFailed()),
		}).request(`${root}/connect`, {
			method: "POST",
			headers,
			body: JSON.stringify({ name: "GitHub", url: "https://api.githubcopilot.com/mcp/" }),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			_tag: "BadRequest",
			message: "Could not start signing in to that server",
		});
	});

	it("finishes at the callback and sends the browser back to the pod", async () => {
		const completeOAuth = vi.fn<ConnectionSetup.Interface["completeOAuth"]>(() =>
			Effect.succeed({ pod: inPod }),
		);

		const back = await app({ completeOAuth }).request(
			"/connections/oauth/callback?code=the-code&state=s-1",
			{ headers },
		);

		expect(back.status).toBe(302);
		expect(back.headers.get("location")).toBe(
			`http://localhost:5173/connections/oauth/return?workspace=${WORKSPACE_ID}&pod=${POD_ID}`,
		);
		expect(completeOAuth).toHaveBeenCalledWith({
			userId: USER_ID,
			callback: { code: "the-code", state: "s-1" },
		});
	});

	it("sends a failed sign-in back with a code, and nothing the authorization server wrote", async () => {
		const back = await app({
			completeOAuth: () => Effect.succeed({ failure: "refused", pod: inPod }),
		}).request(
			"/connections/oauth/callback?error=access_denied&error_description=Visit+evil.example&state=s-1",
			{ headers },
		);

		const location = new URL(back.headers.get("location") ?? "");
		expect(location.searchParams.get("oauth_error")).toBe("refused");
		expect(location.toString()).not.toContain("evil");
	});

	it("does not consume an OAuth callback on HEAD", async () => {
		const completeOAuth = vi.fn<ConnectionSetup.Interface["completeOAuth"]>();

		const response = await app({ completeOAuth }).request(
			"/connections/oauth/callback?code=the-code&state=s-1",
			{ method: "HEAD", headers },
		);

		expect(response.status).toBe(405);
		expect(response.headers.get("allow")).toBe("GET");
		expect(completeOAuth).not.toHaveBeenCalled();
	});
});
