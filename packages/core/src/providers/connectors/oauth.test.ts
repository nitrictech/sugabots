import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	seedBot,
	seedMember,
	seedProject,
	seedWorkspace,
} from "../../authentication/seed.test-support.ts";
import { closeDatabase, runOnPostgres, servedOnPostgres } from "../../database/testing.ts";
import { unimplemented } from "../../testing.ts";
import { Egress, type EgressHttpClient } from "../network/egress.ts";
import { ConnectorSignIn } from "./connector-sign-in.ts";
import { ConnectorStore } from "./connector-store.ts";
import { connectServer, listServerTools } from "./mcp.ts";
import {
	beginAuthorization,
	finishAuthorization,
	needsSignIn,
	type OAuthRecord,
	oauthClient,
	refreshAuthorization,
	storedOAuthProvider,
} from "./oauth.ts";
import { startOAuthServer } from "./oauth-server.test-support.ts";

/**
 * The whole sign-in against a server in this process that is both the MCP
 * server and its authorization server: discovery, registration, the URL the
 * browser is sent to, the code exchange, and then a tool listing that carries
 * the token. Nothing is mocked inside the SDK; only the browser's trip is.
 */

let origin: string;
let serverUrl: string;
let tokenRequests: URLSearchParams[];
let closeServer: () => Promise<void>;

beforeAll(async () => {
	const server = await startOAuthServer();
	({ origin, serverUrl, tokenRequests } = server);
	closeServer = server.close;
});

afterAll(() => closeServer());

function memoryStorage() {
	let record: OAuthRecord | undefined;
	let signedInBy: string | undefined;
	let saves = 0;
	return {
		load: async () => record,
		save: async (next: OAuthRecord, signedInById?: string) => {
			record = next;
			signedInBy = signedInById ?? signedInBy;
			saves += 1;
			return true;
		},
		now: async () => new Date("2026-10-05T21:00:08.000Z"),
		record: () => record,
		/** Who the last save that said so had signed in. */
		signedInBy: () => signedInBy,
		/** How many saves were made. */
		saves: () => saves,
	};
}

async function signedInConnector(accessToken: string) {
	const workspaceId = await seedWorkspace();
	const memberId = await seedMember(workspaceId, "owner");
	const bot = await seedBot(workspaceId, { createdById: memberId });
	const projectId = await seedProject(workspaceId, { leadBotId: bot.id, members: [memberId] });
	const store = await servedOnPostgres(ConnectorStore.Service, ConnectorStore.layer);
	const connector = await store.create(workspaceId, projectId, memberId, {
		name: "OAuth connector",
		url: serverUrl,
		auth: "oauth",
	});
	const record: OAuthRecord = {
		clientInformation: { client_id: "client-1" },
		authorizationServer: {
			issuer: origin,
			authorizationServerUrl: origin,
			tokenEndpoint: `${origin}/token`,
		},
		tokens: { access_token: accessToken, refresh_token: "refresh-1", token_type: "Bearer" },
	};
	await store.saveOauthRecord(workspaceId, connector.id, record, {
		kind: "signIn",
		signedInById: memberId,
		version: null,
	});
	return { workspaceId, memberId, connector, store, record };
}

function clientsThrough(upstream: EgressHttpClient) {
	return runOnPostgres(
		Effect.flatMap(ConnectorSignIn.Service, (signIn) => signIn.clients).pipe(
			Effect.provide(
				ConnectorSignIn.layer.pipe(
					Layer.provide(unimplemented(Egress.Service, { oauth: upstream })),
				),
			),
		),
	);
}

describe.skipIf(!process.env.DATABASE_URL)("refreshing a stored connector", () => {
	afterAll(closeDatabase);

	it("uses the retained client's registered callback when consent is needed again", async () => {
		const registeredRedirect = "http://sugabots.test/api/connections/oauth/callback";
		const { workspaceId, memberId, connector, record } = await signedInConnector("revoked");
		const upstream: EgressHttpClient = (input, init) => {
			if (
				init?.body instanceof URLSearchParams &&
				init.body.get("grant_type") === "refresh_token"
			) {
				return Promise.resolve(Response.json({ error: "invalid_grant" }, { status: 400 }));
			}
			return fetch(input, init);
		};
		const signIn = ConnectorSignIn.layer.pipe(
			Layer.provide(unimplemented(Egress.Service, { oauth: upstream })),
		);
		await runOnPostgres(
			Effect.gen(function* () {
				const service = yield* ConnectorSignIn.Service;
				const result = yield* service.begin({
					workspaceId,
					connectorId: connector.id,
					serverUrl,
					startedByMemberId: memberId,
					startedBySessionId: "member-session",
				});
				if (!("authorizationUrl" in result)) throw new Error("The connector needs fresh consent");
				const parameters = new URL(result.authorizationUrl).searchParams;
				expect(parameters.get("client_id")).toBe(record.clientInformation?.client_id);
				expect(parameters.get("redirect_uri")).toBe(registeredRedirect);
				const state = parameters.get("state");
				if (!state) throw new Error("The authorization request is missing its state");
				yield* service.finish(
					workspaceId,
					connector.id,
					serverUrl,
					{
						code: "the-code",
						state,
					},
					memberId,
				);
				expect(tokenRequests.at(-1)?.get("redirect_uri")).toBe(registeredRedirect);
			}).pipe(Effect.provide(signIn)),
		);
	});

	it.each([
		["AbortError", () => Promise.reject(new DOMException("Stopped", "AbortError"))],
		["network error", () => Promise.reject(new TypeError("fetch failed"))],
		["HTTP 503", () => Promise.resolve(new Response(null, { status: 503 }))],
	] as const)("keeps the stored sign-in after a refresh %s", async (message, exchange) => {
		const { workspaceId, connector, store, record } = await signedInConnector("expired");
		const tokenEndpoint = vi.fn(exchange);
		const upstream: EgressHttpClient = (input, init) => {
			const request = new Request(input, init);
			return request.url === `${origin}/token` ? tokenEndpoint() : fetch(request);
		};
		const clients = await clientsThrough(upstream);
		const outcome = clients.for(workspaceId, connector.id, serverUrl).fetch(serverUrl);
		await expect(outcome).rejects.toThrow(
			message === "AbortError" ? "Stopped" : message === "network error" ? "fetch failed" : message,
		);
		expect(tokenEndpoint).toHaveBeenCalledOnce();
		expect(await store.oauthRecord(workspaceId, connector.id)).toEqual(record);
	});

	it("uses credentials refreshed by another turn while an MCP session waits for approval", async () => {
		const { workspaceId, connector } = await signedInConnector("before-wait");
		let expired = false;
		const requests: (string | null)[] = [];
		const tokenEndpoint = vi.fn(() =>
			Response.json({
				access_token: "token-1",
				refresh_token: "rotated",
				token_type: "Bearer",
			}),
		);
		const upstream: EgressHttpClient = async (input, init) => {
			const request = new Request(input, init);
			if (request.url === `${origin}/token`) return tokenEndpoint();
			if (request.url === serverUrl) {
				const authorization = request.headers.get("authorization");
				requests.push(authorization);
				if (!expired && authorization === "Bearer before-wait")
					request.headers.set("authorization", "Bearer token-1");
			}
			return fetch(request);
		};
		const clients = await clientsThrough(upstream);
		const target = () => ({
			url: serverUrl,
			headers: {},
			oauth: clients.for(workspaceId, connector.id, serverUrl),
		});
		const waiting = await connectServer(target(), upstream);
		try {
			const listing = await waiting.list();
			expect(requests.at(-1)).toBe("Bearer before-wait");
			expired = true;
			expect(await listServerTools(target(), upstream)).toMatchObject({ ok: true });
			requests.length = 0;
			expect(
				await waiting.run(
					listing,
					"lookup",
					{},
					{ toolCallId: "lookup", messages: [], context: undefined },
				),
			).toMatchObject({ content: [{ type: "text", text: "found" }] });
			expect(requests).toEqual(["Bearer token-1"]);
			expect(tokenEndpoint).toHaveBeenCalledOnce();
		} finally {
			await waiting.close();
		}
	});

	it("coalesces refresh exchanges from concurrent callers before the provider rotates the token", async () => {
		const { workspaceId, connector, store } = await signedInConnector("expired");
		const rotating = Promise.withResolvers<void>();
		const rotated = Promise.withResolvers<void>();
		const bothRejected = Promise.withResolvers<void>();
		let exchanges = 0;
		let rejected = 0;
		const upstream: EgressHttpClient = async (input, init) => {
			const request = new Request(input, init);
			if (request.url === serverUrl && request.headers.get("authorization") === "Bearer expired") {
				rejected += 1;
				if (rejected === 2) bothRejected.resolve();
			}
			if (request.url === `${origin}/token`) {
				exchanges += 1;
				if (exchanges > 1) return Response.json({ error: "invalid_grant" }, { status: 400 });
				rotating.resolve();
				await rotated.promise;
				return Response.json({
					access_token: "token-1",
					refresh_token: "rotated",
					token_type: "Bearer",
				});
			}
			return fetch(request);
		};
		const [first, second] = await Promise.all([clientsThrough(upstream), clientsThrough(upstream)]);
		const list = (clients: typeof first) =>
			listServerTools(
				{
					url: serverUrl,
					headers: {},
					oauth: clients.for(workspaceId, connector.id, serverUrl),
				},
				upstream,
			);
		const one = list(first);
		try {
			await rotating.promise;
			const two = list(second);
			await bothRejected.promise;
			rotated.resolve();
			expect(await one).toMatchObject({ ok: true });
			expect(await two).toMatchObject({ ok: true });
			expect(exchanges).toBe(1);
			await vi.waitFor(async () =>
				expect(await store.oauthRecord(workspaceId, connector.id)).toMatchObject({
					tokens: { access_token: "token-1", refresh_token: "rotated" },
				}),
			);
		} finally {
			rotated.resolve();
		}
	});
});

describe("signing a connector in", () => {
	it("registers, sends the browser to sign in, exchanges the code, and then lists tools with the token", async () => {
		const storage = memoryStorage();
		const provider = (
			signIn?:
				| { startedByMemberId: string; startedBySessionId: string }
				| { finishedByMemberId: string },
		) =>
			storedOAuthProvider(storage, {
				redirectUrl: "http://localhost:3000/connectors/oauth/callback",
				clientName: "Sugabots",
				...signIn,
			});

		const started = await beginAuthorization(
			provider({ startedByMemberId: "member-1", startedBySessionId: "session-1" }),
			serverUrl,
			fetch,
		);
		if (!("authorizationUrl" in started)) throw new Error("expected a URL to sign in at");
		const sendTo = new URL(started.authorizationUrl);
		expect(sendTo.origin + sendTo.pathname).toBe(`${origin}/authorize`);
		expect(sendTo.searchParams.get("client_id")).toBe("client-1");
		expect(sendTo.searchParams.get("redirect_uri")).toBe(
			"http://localhost:3000/connectors/oauth/callback",
		);
		expect(sendTo.searchParams.get("code_challenge_method")).toBe("S256");
		const state = sendTo.searchParams.get("state");
		expect(state).toBeTruthy();
		expect(storage.record()).toMatchObject({
			clientInformation: { client_id: "client-1" },
			state,
			startedByMemberId: "member-1",
			startedBySessionId: "session-1",
		});
		expect(storage.record()?.codeVerifier).toBeTruthy();
		expect(storage.signedInBy()).toBeUndefined();
		const savedBeforeFinishing = storage.saves();

		await finishAuthorization(
			provider({ finishedByMemberId: "member-1" }),
			serverUrl,
			"the-code",
			state ?? "",
			fetch,
		);

		expect(storage.record()?.tokens).toMatchObject({ access_token: "token-1" });
		expect(storage.signedInBy()).toBe("member-1");
		expect(storage.record()?.state).toBe("");
		expect(storage.record()?.startedByMemberId).toBeUndefined();
		expect(storage.record()?.startedBySessionId).toBeUndefined();
		expect(storage.record()?.codeVerifier).toBeUndefined();
		// The tokens and the cleared state went in one save, the one its member's removal is ordered with.
		expect(storage.saves() - savedBeforeFinishing).toBe(1);
		expect(tokenRequests.at(-1)?.get("code_verifier")).toBeTruthy();

		const tokens = async () => storage.record()?.tokens;
		const oauth = oauthClient(fetch, serverUrl, tokens, (_signal, challenge) =>
			refreshAuthorization(provider(), serverUrl, challenge, fetch),
		);
		const listed = await listServerTools({ url: serverUrl, headers: {}, oauth }, fetch);
		expect(listed).toMatchObject({ ok: true, tools: [{ name: "lookup" }] });

		expect(await beginAuthorization(provider(), serverUrl, fetch)).toEqual({ authorized: true });
	});

	it.each(["access-only tokens", "unbound tokens"] as const)(
		"flags the connector as needing sign-in when it holds %s",
		async (kind) => {
			const storage = memoryStorage();
			await storage.save({
				clientInformation: { client_id: "client-1" },
				authorizationServer:
					kind === "access-only tokens"
						? { issuer: origin, authorizationServerUrl: origin, tokenEndpoint: `${origin}/token` }
						: undefined,
				tokens: {
					access_token: "expired",
					token_type: "Bearer",
					...(kind === "unbound tokens" ? { refresh_token: "refresh-1" } : {}),
				},
			});
			const provider = storedOAuthProvider(storage, {
				redirectUrl: "http://localhost:3000/connectors/oauth/callback",
				clientName: "Sugabots",
			});
			const upstream = vi.fn<EgressHttpClient>((input, init) => fetch(input, init));
			const client = oauthClient(
				upstream,
				serverUrl,
				async () => provider.tokens(),
				(_signal, challenge) => refreshAuthorization(provider, serverUrl, challenge, upstream),
			);

			await expect(client.fetch(serverUrl)).rejects.toMatchObject({ name: "SignInRequired" });
			expect(upstream.mock.calls.some(([url]) => String(url) === `${origin}/token`)).toBe(false);
			expect(storage.record()?.tokens).toBeUndefined();
			expect(storage.record()?.signInRejectedAt).toBe("2026-10-05T21:00:08.000Z");
		},
	);

	it.each(["invalid_grant", "invalid_client", "unauthorized_client"])(
		"records a refresh refused with %s without disturbing a member's sign-in under way",
		async (error) => {
			const storage = memoryStorage();
			const provider = (startedByMemberId?: string) =>
				storedOAuthProvider(storage, {
					redirectUrl: "http://localhost:3000/connectors/oauth/callback",
					clientName: "Sugabots",
					startedByMemberId,
					startedBySessionId: startedByMemberId ? "session-1" : undefined,
				});
			const signIn = async () => {
				const started = await beginAuthorization(provider("member-1"), serverUrl, fetch);
				if (!("authorizationUrl" in started)) throw new Error("expected a URL to sign in at");
				const state = new URL(started.authorizationUrl).searchParams.get("state") ?? "";
				await finishAuthorization(provider(), serverUrl, "the-code", state, fetch);
			};
			await signIn();
			const signedIn = storage.record();
			if (!signedIn?.tokens) throw new Error("expected tokens");
			await storage.save({
				...signedIn,
				tokens: { ...signedIn.tokens, access_token: "expired", refresh_token: "revoked" },
				state: "member-state",
				codeVerifier: "member-verifier",
				startedByMemberId: "member-2",
			});

			const upstream: EgressHttpClient = (input, init) => {
				if (String(input) === `${origin}/token`) {
					const body = init?.body;
					if (!(body instanceof URLSearchParams)) throw new Error("Expected a token request");
					expect(body.get("grant_type")).toBe("refresh_token");
					return Promise.resolve(Response.json({ error }, { status: 400 }));
				}
				return fetch(input, init);
			};
			const tokens = async () => storage.record()?.tokens;
			const oauth = oauthClient(upstream, serverUrl, tokens, (_signal, challenge) =>
				refreshAuthorization(provider(), serverUrl, challenge, upstream),
			);
			const listed = await listServerTools({ url: serverUrl, headers: {}, oauth }, upstream);

			if (listed.ok) throw new Error("expected the listing to fail");
			expect(listed.reason).toBe("Sign in again to reconnect");
			expect(needsSignIn(listed.cause)).toBe(true);
			expect(storage.record()?.tokens).toBeUndefined();
			expect(storage.record()?.signInRejectedAt).toBeTruthy();
			expect(storage.record()).toMatchObject({
				state: "member-state",
				codeVerifier: "member-verifier",
				startedByMemberId: "member-2",
			});

			await signIn();

			expect(storage.record()?.tokens).toMatchObject({ access_token: "token-1" });
			expect(storage.record()?.signInRejectedAt).toBeUndefined();
		},
	);

	it("says a server that wants a sign-in needs one, in the words the settings page shows", async () => {
		const listed = await listServerTools({ url: serverUrl, headers: {} }, fetch);
		expect(listed.ok).toBe(false);
		expect(listed).toMatchObject({
			ok: false,
			reason: "The server needs an access token or a sign-in (HTTP 401)",
		});
	});
});
