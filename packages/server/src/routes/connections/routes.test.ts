import type { Connection, ConnectionUpdate, NewConnection } from "@sugabots/contracts";
import { ConnectionsApi } from "@sugabots/contracts/http/groups/connections";
import { noDatabase } from "@sugabots/core/database/testing";
import type { listServerTools } from "@sugabots/core/providers/connections/mcp";
import type {
	beginAuthorization,
	finishAuthorization,
} from "@sugabots/core/providers/connections/oauth";
import type { ConnectionStore } from "@sugabots/core/providers/connections/store";
import { createEgressUrlValidator } from "@sugabots/core/providers/network/egress";
import { testAuthorization } from "@sugabots/core/workspaces/testing";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi";
import { describe, expect, it, vi } from "vitest";
import { sessionLayer } from "../../auth/middleware.ts";
import type { SessionResolver } from "../../auth/session.ts";
import { API_BASE_PATH } from "../../config.ts";
import { BASE_URL } from "../../http/app.test-support.ts";
import { authoriseLayer } from "../../http/authorisation.ts";
import { validateRequestLayer } from "../../http/validation.ts";
import { type ConnectionRoutesOptions, connectionRoutes } from "./routes.ts";

const WORKSPACE_ID = "0199a3a0-0000-7000-8000-000000000001";
const USER_ID = "0199a3a0-0000-7000-8000-000000000002";
const CONNECTION_ID = "0199a3a0-0000-7000-8000-000000000003";
const POD_ID = "0199a3a0-0000-7000-8000-000000000004";
const OTHER_POD_ID = "0199a3a0-0000-7000-8000-000000000005";
const MEMBER_ID = "0199a3a0-0000-7000-8000-000000000006";
const root = `/pods/${POD_ID}/connections`;
const headers = { authorization: "Bearer good-token", "content-type": "application/json" };
const memberHeaders = { ...headers, authorization: "Bearer member-token" };

const resolveSession: SessionResolver = async (requestHeaders) => {
	const token = requestHeaders.get("authorization");
	if (token === "Bearer good-token") {
		return { user: { id: USER_ID, name: "Sam", email: "sam@example.com", image: null } };
	}
	if (token === "Bearer member-token") {
		return { user: { id: MEMBER_ID, name: "Kim", email: "kim@example.com", image: null } };
	}
	return null;
};

/** Sam administers the workspace; Kim is an ordinary member of both pods. */
const authorization = testAuthorization({
	id: WORKSPACE_ID,
	roles: { [USER_ID]: "admin", [MEMBER_ID]: "member" },
	pods: [
		{ id: POD_ID, kind: "shared", members: [MEMBER_ID], name: "Support", slug: "support" },
		{ id: OTHER_POD_ID, kind: "shared", members: [MEMBER_ID], name: "Sales", slug: "sales" },
	],
});

/**
 * The connections group alone, behind the same session and authorisation
 * middleware as the process. Not `createTestApp`, because these cases replace
 * the MCP and OAuth calls, which the full route table has no seam for.
 */
function serve(options: ConnectionRoutesOptions) {
	const routes = HttpApiBuilder.layer(HttpApi.make("sugabots").add(ConnectionsApi)).pipe(
		Layer.provide(
			connectionRoutes(options).pipe(
				Layer.provide([
					sessionLayer(resolveSession),
					authoriseLayer(authorization),
					validateRequestLayer,
				]),
			),
		),
		HttpRouter.provideRequest(noDatabase),
		Layer.provide([noDatabase, HttpServer.layerServices]),
	);
	const { handler } = HttpRouter.toWebHandler(routes, { disableLogger: true });
	return {
		request: (path: string, init?: RequestInit) =>
			handler(new Request(new URL(`${API_BASE_PATH}${path}`, BASE_URL), init)),
	};
}

function stored(extra: Partial<Connection> = {}): Connection {
	return {
		id: CONNECTION_ID,
		workspaceId: WORKSPACE_ID,
		podId: POD_ID,
		name: "Wiki",
		handle: "wiki",
		url: "https://wiki.example.com/mcp",
		auth: "header",
		signedIn: true,
		secretHeader: "authorization",
		hasSecret: false,
		enabled: false,
		allowMutating: false,
		status: "untested",
		tools: [],
		lastTestedAt: null,
		lastTestError: null,
		createdAt: "2026-09-14T00:00:00.000Z",
		...extra,
	};
}

function routes(allowPrivateNetwork: boolean, current: Connection | undefined) {
	let held = current;
	const listTools = vi.fn<typeof listServerTools>(async () => ({
		ok: true,
		tools: [{ name: "search_pages", description: "Search.", readOnly: true, destructive: null }],
	}));
	const create = vi.fn(
		(_workspaceId: string, podId: string, _userId: string, input: NewConnection) =>
			Effect.sync(() => {
				held = stored({
					podId,
					name: input.name,
					url: input.url,
					auth: input.auth ?? "header",
					signedIn: input.auth !== "oauth",
				});
				return held;
			}),
	);
	const recordTest = vi.fn(
		(_w: string, _c: string, _at: Date, outcome: { tools?: unknown[]; error?: string }) =>
			Effect.sync(() => {
				if (held) {
					held = {
						...held,
						tools: (outcome.tools as Connection["tools"]) ?? held.tools,
						lastTestedAt: "2026-09-14T00:00:01.000Z",
						lastTestError: outcome.error ?? null,
						status: outcome.error ? "error" : "connected",
					};
				}
			}),
	);
	const update = vi.fn((_w: string, podId: string, connectionId: string, input: ConnectionUpdate) =>
		Effect.sync(() => {
			if (!held || held.podId !== podId || held.id !== connectionId) return undefined;
			held = { ...held, enabled: input.enabled ?? held.enabled };
			return held;
		}),
	);
	const store: ConnectionStore = {
		list: (_workspaceId, podId) => Effect.sync(() => (held?.podId === podId ? [held] : [])),
		get: (_workspaceId, podId, connectionId) =>
			Effect.sync(() => (held?.podId === podId && held.id === connectionId ? held : undefined)),
		create,
		update,
		remove: vi.fn((_workspaceId, podId, connectionId) =>
			Effect.sync(() => {
				if (!held || held.podId !== podId || held.id !== connectionId) return false;
				held = undefined;
				return true;
			}),
		),
		targetsForPod: () => Effect.succeed([]),
		oauthRecord: () => Effect.succeed(undefined),
		saveOauthRecord: () => Effect.void,
		byOauthState: () => Effect.succeed(undefined),
		target: (_workspaceId, podId, connectionId) =>
			Effect.sync(() =>
				held?.podId === podId && held.id === connectionId
					? {
							connectionId: held.id,
							handle: held.handle,
							url: held.url,
							auth: "header" as const,
							headers: {},
							allowMutating: false,
							configurationUpdatedAt: new Date("2026-09-14T00:00:00.000Z"),
							configurationRevision: 1,
						}
					: undefined,
			),
		recordTest,
	};
	const begin = vi.fn<typeof beginAuthorization>(async () => ({
		authorizationUrl: "https://auth.example/authorize?state=s-1",
	}));
	const finish = vi.fn<typeof finishAuthorization>(async () => undefined);
	const app = serve({
		authorization,
		connections: {
			...store,
			byOauthState: (state: string) =>
				Effect.sync(() =>
					held && state === "s-1"
						? { workspaceId: held.workspaceId, podId: held.podId, connectionId: held.id }
						: undefined,
				),
		},
		httpClients: { for: () => async () => new Response(null, { status: 503 }) },
		validateProviderUrl: createEgressUrlValidator({ allowPrivateNetwork }),
		listTools,
		oauth: {
			redirectUrl: "http://localhost:3000/connections/oauth/callback",
			webUrl: "http://localhost:5173",
			fetch: async () => new Response(null, { status: 503 }),
			begin,
			finish,
		},
	});
	return {
		app,
		create,
		update,
		listTools,
		recordTest,
		begin,
		finish,
		remove: store.remove,
		connection: () => held,
	};
}

describe("a pod's connections", () => {
	it("adds a server by URL and learns its tools straight away", async () => {
		const { app, create, listTools } = routes(true, undefined);

		const response = await app.request(root, {
			method: "POST",
			headers,
			body: JSON.stringify({ name: "Wiki", url: "https://wiki.example.com/mcp" }),
		});

		expect(response.status).toBe(201);
		expect(create).toHaveBeenCalledWith(WORKSPACE_ID, POD_ID, USER_ID, {
			name: "Wiki",
			url: "https://wiki.example.com/mcp",
		});
		expect(listTools).toHaveBeenCalledWith(
			{ url: "https://wiki.example.com/mcp", headers: {} },
			expect.any(Function),
		);
		expect(await response.json()).toMatchObject({
			handle: "wiki",
			status: "connected",
			tools: [{ name: "search_pages", readOnly: true }],
		});
	});

	it("refuses a server on a private address where the installation forbids them", async () => {
		const { app, create } = routes(false, undefined);

		const response = await app.request(root, {
			method: "POST",
			headers,
			body: JSON.stringify({ name: "Local", url: "http://127.0.0.1:8080/mcp" }),
		});

		expect(response.status).toBe(400);
		expect(create).not.toHaveBeenCalled();
	});

	it("lets an ordinary pod member read connections but not change them", async () => {
		const harness = routes(true, stored());

		expect((await harness.app.request(root, { headers: memberHeaders })).status).toBe(200);
		const response = await harness.app.request(root, {
			method: "POST",
			headers: memberHeaders,
			body: JSON.stringify({ name: "Docs", url: "https://docs.example.com/mcp" }),
		});

		expect(response.status).toBe(403);
		expect(harness.create).not.toHaveBeenCalled();
	});

	it("rejects a connection id from another pod", async () => {
		const { app } = routes(true, stored());

		const response = await app.request(`/pods/${OTHER_POD_ID}/connections/${CONNECTION_ID}`, {
			headers,
		});

		expect(response.status).toBe(404);
	});

	it("keeps a saved connection when the server cannot be reached, and says so on test", async () => {
		const { app, listTools } = routes(true, stored());
		listTools.mockResolvedValue({ ok: false, reason: "The server answered HTTP 502" });

		const response = await app.request(`${root}/${CONNECTION_ID}/test`, {
			method: "POST",
			headers,
		});

		expect(await response.json()).toMatchObject({
			reachable: false,
			error: "The server answered HTTP 502",
		});
		expect((await app.request(root, { headers })).status).toBe(200);
	});

	it("removes a connection, and says so when there is none", async () => {
		expect(
			(
				await routes(true, stored()).app.request(`${root}/${CONNECTION_ID}`, {
					method: "DELETE",
					headers,
				})
			).status,
		).toBe(204);
		expect(
			(
				await routes(true, undefined).app.request(`${root}/${CONNECTION_ID}`, {
					method: "DELETE",
					headers,
				})
			).status,
		).toBe(404);
	});
});

describe("signing a connection in", () => {
	async function oauthConnection(app: ReturnType<typeof routes>["app"]) {
		const made = await app.request(root, {
			method: "POST",
			headers,
			body: JSON.stringify({ name: "Linear", url: "https://mcp.linear.app/mcp", auth: "oauth" }),
		});
		expect(made.status).toBe(201);
		return (await made.json()) as Connection;
	}

	it("starts with the address the browser should go to, and asks the server nothing yet", async () => {
		const harness = routes(true, undefined);
		const made = await oauthConnection(harness.app);
		expect(harness.listTools).not.toHaveBeenCalled();

		const started = await harness.app.request(`${root}/${made.id}/oauth/start`, {
			method: "POST",
			headers,
		});

		expect(started.status).toBe(200);
		expect(await started.json()).toEqual({
			authorizationUrl: "https://auth.example/authorize?state=s-1",
		});
		expect(harness.begin).toHaveBeenCalledOnce();
	});

	it("refuses to start signing in a connection that uses a secret", async () => {
		const harness = routes(true, undefined);
		await harness.app.request(root, {
			method: "POST",
			headers,
			body: JSON.stringify({ name: "Wiki", url: "https://wiki.example.com/mcp" }),
		});

		const started = await harness.app.request(`${root}/${CONNECTION_ID}/oauth/start`, {
			method: "POST",
			headers,
		});

		expect(started.status).toBe(400);
	});

	it("refuses OAuth to an ordinary pod member", async () => {
		const harness = routes(true, stored({ auth: "oauth", signedIn: false }));

		const started = await harness.app.request(`${root}/${CONNECTION_ID}/oauth/start`, {
			method: "POST",
			headers: memberHeaders,
		});

		expect(started.status).toBe(403);
		expect(harness.begin).not.toHaveBeenCalled();
	});

	it("finishes at the callback, turns the connection on, learns its tools, and sends the browser back", async () => {
		const harness = routes(true, undefined);
		const made = await oauthConnection(harness.app);

		const back = await harness.app.request("/connections/oauth/callback?code=the-code&state=s-1", {
			headers,
		});

		expect(back.status).toBe(302);
		expect(back.headers.get("location")).toBe(
			`http://localhost:5173/connections/oauth/return?workspace=${WORKSPACE_ID}&pod=${POD_ID}`,
		);
		expect(harness.finish).toHaveBeenCalledWith(
			expect.anything(),
			"https://mcp.linear.app/mcp",
			"the-code",
			"s-1",
			expect.any(Function),
		);
		expect(harness.update).toHaveBeenCalledWith(WORKSPACE_ID, POD_ID, made.id, {
			enabled: true,
		});
		expect(harness.listTools).toHaveBeenCalledOnce();
	});

	it("does not finish an OAuth callback for somebody who may not manage connections", async () => {
		const harness = routes(true, stored({ auth: "oauth", signedIn: false }));

		const response = await harness.app.request(
			"/connections/oauth/callback?code=the-code&state=s-1",
			{ headers: memberHeaders },
		);

		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toContain("oauth_error=You+are+not+allowed");
		expect(harness.finish).not.toHaveBeenCalled();
	});

	it("does not consume an OAuth callback on HEAD", async () => {
		const harness = routes(true, undefined);
		await oauthConnection(harness.app);

		const response = await harness.app.request(
			"/connections/oauth/callback?code=the-code&state=s-1",
			{ method: "HEAD", headers },
		);

		expect(response.status).toBe(405);
		expect(response.headers.get("allow")).toBe("GET");
		expect(response.body).toBeNull();
		expect(harness.finish).not.toHaveBeenCalled();
		expect(harness.update).not.toHaveBeenCalled();
		expect(harness.listTools).not.toHaveBeenCalled();
	});

	it("sends the browser back with the reason when the sign-in was refused or does not match", async () => {
		const harness = routes(true, undefined);
		await oauthConnection(harness.app);

		const refused = await harness.app.request(
			"/connections/oauth/callback?error=access_denied&error_description=No+thanks&state=s-1",
			{ headers },
		);
		expect(refused.headers.get("location")).toBe(
			`http://localhost:5173/connections/oauth/return?workspace=${WORKSPACE_ID}&pod=${POD_ID}&oauth_error=No+thanks`,
		);

		const unknown = await harness.app.request("/connections/oauth/callback?code=x&state=nope", {
			headers,
		});
		expect(unknown.headers.get("location")).toContain("oauth_error=");
		expect(harness.finish).not.toHaveBeenCalled();
	});
});

describe("connecting from the catalog", () => {
	it("makes the connection and hands back where to sign in, in one request", async () => {
		const harness = routes(true, undefined);

		const response = await harness.app.request(`${root}/connect`, {
			method: "POST",
			headers,
			body: JSON.stringify({ name: "Notion", url: "https://mcp.notion.com/mcp" }),
		});

		expect(response.status).toBe(201);
		expect(await response.json()).toEqual({
			connectionId: CONNECTION_ID,
			authorizationUrl: "https://auth.example/authorize?state=s-1",
		});
		expect(harness.create).toHaveBeenCalledWith(
			WORKSPACE_ID,
			POD_ID,
			USER_ID,
			expect.objectContaining({ auth: "oauth" }),
		);
		expect(harness.connection()?.auth).toBe("oauth");
	});

	it("leaves nothing behind when the sign-in cannot start", async () => {
		const harness = routes(true, undefined);
		harness.begin.mockRejectedValueOnce(
			new Error("Incompatible auth server: does not support dynamic client registration"),
		);

		const response = await harness.app.request(`${root}/connect`, {
			method: "POST",
			headers,
			body: JSON.stringify({ name: "GitHub", url: "https://api.githubcopilot.com/mcp/" }),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			_tag: "BadRequest",
			message: expect.stringContaining("does not support dynamic client registration"),
		});
		expect(harness.remove).toHaveBeenCalledWith(WORKSPACE_ID, POD_ID, CONNECTION_ID);
		expect(harness.connection()).toBeUndefined();
	});
});
