import { Effect, Layer } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { user, workspace, workspaceMember } from "../../../database/schema.ts";
import {
	closeDatabase,
	onDatabase,
	type Promised,
	runOnPostgres,
	servedOnPostgres,
} from "../../../database/testing.ts";
import { servedOnPostgresAs } from "../../../workspaces/testing.ts";
import { Egress, type EgressHttpClients } from "../../network/egress.ts";
import { providerIn, providersIn } from "../model-provider-reads.ts";
import { ModelProviderRepository } from "../model-provider-repository.ts";
import { ModelProviderSetup } from "../model-provider-setup.ts";
import { withSignInAccess } from "./sign-in.ts";

/**
 * Signing a provider in with a subscription and keeping its token alive,
 * against real SQL and stand-ins for each sign-in service and model API.
 */
describe.skipIf(!process.env.DATABASE_URL)("a subscription provider", () => {
	let store: Promised<ModelProviderRepository.Interface>;
	let workspaceId: string;
	let userId: string;
	let providerId: string;
	let service: { clients: EgressHttpClients };

	/** The setup as the workspace's administrator. */
	const setup = async () =>
		(
			await servedOnPostgresAs(
				ModelProviderSetup.Service,
				ModelProviderSetup.layer.pipe(
					Layer.provide([
						Layer.succeed(Egress.Service, {
							providers: service.clients,
							validateProviderUrl: () => Effect.void,
							oauth: async () => new Response(null, { status: 503 }),
							webFetch: async () => new Response(null, { status: 503 }),
						}),
					]),
				),
			)
		)(userId);

	const view = () => runOnPostgres(providerIn(workspaceId, providerId));

	/** The endpoint ready to send, as a turn would get it. */
	const withAccess = (endpoint: ModelProviderRepository.ProviderEndpoint) =>
		runOnPostgres(
			Effect.gen(function* () {
				const repository = yield* ModelProviderRepository.Service;
				return yield* withSignInAccess(repository, service.clients, workspaceId, endpoint);
			}).pipe(Effect.provide(ModelProviderRepository.layer)),
		);

	const storedEndpoint = async () => {
		const endpoint = await store.endpoint(workspaceId, providerId);
		if (!endpoint) throw new Error("fixture");
		return endpoint;
	};

	beforeAll(async () => {
		store = await servedOnPostgres(ModelProviderRepository.Service, ModelProviderRepository.layer);
	});

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const [made] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: `Test ${stamp}`, slug: `test-${stamp}` })
				.returning(),
		);
		const [person] = await onDatabase((db) =>
			db
				.insert(user)
				.values({ name: "Ada", email: `ada-${stamp}@example.com` })
				.returning(),
		);
		if (!made || !person) throw new Error("could not create the test workspace");
		workspaceId = made.id;
		userId = person.id;
		await onDatabase((db) =>
			db.insert(workspaceMember).values({ workspaceId, userId, role: "admin" }),
		);
		await store.seedPresets(workspaceId);
	});

	describe("with ChatGPT", () => {
		let openai: ReturnType<typeof fakeOpenAI>;

		beforeEach(async () => {
			openai = fakeOpenAI();
			service = openai;
			const seeded = (await runOnPostgres(providersIn(workspaceId))).find(
				({ preset }) => preset === "chatgpt",
			);
			if (!seeded) throw new Error("ChatGPT is not seeded");
			providerId = seeded.id;
		});

		it("waits for the code to be entered, then signs in and lists the plan's models", async () => {
			expect(await view()).toMatchObject({ status: "signed_out", signedIn: false });

			const signIn = await setup();
			const started = await signIn.startSignIn({ workspace: workspaceId, providerId });
			expect(started).toMatchObject({
				userCode: "ABCD-1234",
				verificationUrl: "https://auth.openai.com/codex/device",
			});
			expect(started.attempt).not.toContain("device-auth-id");

			const waiting = await signIn.completeSignIn({
				workspace: workspaceId,
				providerId,
				attempt: started.attempt,
			});
			expect(waiting).toEqual({ status: "pending" });

			openai.enterCode();
			const outcome = await signIn.completeSignIn({
				workspace: workspaceId,
				providerId,
				attempt: started.attempt,
			});

			expect(outcome).toMatchObject({
				status: "signed_in",
				provider: { signedIn: true, active: true, status: "connected" },
			});
			if (outcome.status !== "signed_in") throw new Error("unreachable");
			expect(outcome.provider.models.map(({ modelId }) => modelId)).toEqual(["gpt-5.5"]);
			expect(openai.listingHeaders).toMatchObject({
				authorization: `Bearer ${openai.issued[0]}`,
				"chatgpt-account-id": "account-1",
				originator: "sugabots",
			});
		});

		it("refuses a sign-in attempt made for another provider", async () => {
			const signIn = await setup();
			const started = await signIn.startSignIn({ workspace: workspaceId, providerId });
			const other = await store.create(workspaceId, {
				createdById: userId,
				provider: {
					name: "Gateway",
					baseUrl: "https://models.example/v1",
					apiFormat: "openai",
					apiKey: "secret",
					customHeaders: [],
				},
			});

			await expect(
				signIn.completeSignIn({
					workspace: workspaceId,
					providerId: other.id,
					attempt: started.attempt,
				}),
			).rejects.toMatchObject({ _tag: "ProviderSignInNotOffered" });
		});

		it("spends a lapsing refresh token once, however many turns start together", async () => {
			await store.saveOAuthTokens(workspaceId, providerId, {
				access: "lapsing-token",
				refresh: "refresh-0",
				expiresAt: Date.now() + 60_000,
				accountId: "account-1",
			});
			const endpoint = await storedEndpoint();

			const ready = await Promise.all([1, 2, 3].map(() => withAccess(endpoint)));

			expect(openai.refreshesSpent).toEqual(["refresh-0"]);
			const renewed = openai.issued[0];
			expect(ready.map(({ apiKey }) => apiKey)).toEqual([renewed, renewed, renewed]);
			expect(await view()).toMatchObject({ signedIn: true });
		});

		it("leaves a token with time to run alone", async () => {
			await store.saveOAuthTokens(workspaceId, providerId, {
				access: "fresh-token",
				refresh: "refresh-0",
				expiresAt: Date.now() + 60 * 60_000,
				accountId: "account-1",
			});

			const ready = await withAccess(await storedEndpoint());

			expect(ready.apiKey).toBe("fresh-token");
			expect(ready.headers["ChatGPT-Account-Id"]).toBe("account-1");
			expect(openai.refreshesSpent).toEqual([]);
		});
	});

	describe("with SuperGrok", () => {
		let xai: ReturnType<typeof fakeXai>;

		beforeEach(async () => {
			xai = fakeXai();
			service = xai;
			const added = await store.create(workspaceId, {
				createdById: userId,
				provider: { preset: "supergrok" },
			});
			providerId = added.id;
		});

		it("waits for the code to be entered, then signs in and lists Grok's models", async () => {
			expect(await view()).toMatchObject({ status: "signed_out", signedIn: false });

			const signIn = await setup();
			const started = await signIn.startSignIn({ workspace: workspaceId, providerId });
			expect(started).toMatchObject({
				userCode: "GWJA-VZAE",
				verificationUrl: "https://accounts.x.ai/oauth2/device?user_code=GWJA-VZAE",
				pollIntervalMs: 5000,
			});
			expect(started.attempt).not.toContain("xai-device-code");

			expect(
				await signIn.completeSignIn({
					workspace: workspaceId,
					providerId,
					attempt: started.attempt,
				}),
			).toEqual({ status: "pending" });

			xai.enterCode();
			const outcome = await signIn.completeSignIn({
				workspace: workspaceId,
				providerId,
				attempt: started.attempt,
			});

			expect(outcome).toMatchObject({
				status: "signed_in",
				provider: { signedIn: true, active: true, status: "connected" },
			});
			if (outcome.status !== "signed_in") throw new Error("unreachable");
			expect(outcome.provider.models.map(({ modelId }) => modelId)).toEqual(["grok-4.3"]);
			expect(xai.listingAuthorization).toBe("Bearer xai-access-1");
		});

		it("says so when the person declines the sign-in", async () => {
			const signIn = await setup();
			const started = await signIn.startSignIn({ workspace: workspaceId, providerId });

			xai.declineCode();

			await expect(
				signIn.completeSignIn({ workspace: workspaceId, providerId, attempt: started.attempt }),
			).rejects.toMatchObject({
				_tag: "ProviderSignInFailed",
				userMessage: "The xAI sign-in was declined",
			});
		});

		it("keeps the refresh token when a refresh does not replace it", async () => {
			await store.saveOAuthTokens(workspaceId, providerId, {
				access: "lapsing-token",
				refresh: "xai-refresh-0",
				expiresAt: Date.now() + 60_000,
				accountId: null,
			});

			const ready = await withAccess(await storedEndpoint());
			const again = await withAccess(await storedEndpoint());

			expect(ready.apiKey).toBe("xai-access-1");
			expect(again.apiKey).toBe("xai-access-1");
			expect(xai.refreshesSpent).toEqual(["xai-refresh-0"]);
			expect((await storedEndpoint()).oauthTokens?.refresh).toBe("xai-refresh-0");
		});
	});
});

/** A JWT with `claims`, unsigned: the code under test reads tokens but never verifies them. */
function jwt(claims: object) {
	const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${part({ alg: "none" })}.${part(claims)}.signature`;
}

/**
 * OpenAI's sign-in service and the Codex model listing, answering as the real
 * ones do, and recording what was spent and sent.
 */
function fakeOpenAI() {
	let codeEntered = false;
	const issued: string[] = [];
	const refreshesSpent: string[] = [];
	const state = { listingHeaders: {} as Record<string, string> };

	const respond = async (url: string, init?: RequestInit): Promise<Response> => {
		const { pathname } = new URL(url);
		if (pathname === "/api/accounts/deviceauth/usercode") {
			return Response.json({
				device_auth_id: "device-auth-id",
				user_code: "ABCD-1234",
				interval: "5",
			});
		}
		if (pathname === "/api/accounts/deviceauth/token") {
			if (!codeEntered) return new Response(null, { status: 403 });
			return Response.json({ authorization_code: "auth-code", code_verifier: "verifier" });
		}
		if (pathname === "/oauth/token") {
			const form = new URLSearchParams(String(init?.body));
			const spent = form.get("refresh_token");
			if (spent) {
				if (refreshesSpent.includes(spent)) return new Response(null, { status: 401 });
				refreshesSpent.push(spent);
				// Slow enough that concurrent callers would overlap without the lock.
				await Effect.runPromise(Effect.sleep("50 millis"));
			}
			const access = jwt({ n: issued.length, chatgpt_account_id: "account-1" });
			issued.push(access);
			return Response.json({
				id_token: jwt({ chatgpt_account_id: "account-1" }),
				access_token: access,
				refresh_token: `refresh-${issued.length}`,
				expires_in: 3600,
			});
		}
		if (pathname === "/backend-api/codex/models") {
			state.listingHeaders = Object.fromEntries(new Headers(init?.headers).entries());
			return Response.json({
				models: [
					{ slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list", context_window: 272_000 },
					{ slug: "codex-auto-review", display_name: "Auto review", visibility: "hide" },
				],
			});
		}
		return new Response(null, { status: 404 });
	};

	const clients: EgressHttpClients = {
		for: () =>
			((input: string | URL | Request, init?: RequestInit) =>
				respond(input instanceof Request ? input.url : input.toString(), init)) as typeof fetch,
	};

	return {
		clients,
		issued,
		refreshesSpent,
		get listingHeaders() {
			return state.listingHeaders;
		},
		enterCode: () => {
			codeEntered = true;
		},
	};
}

/**
 * xAI's sign-in service, answering the device flow as RFC 8628 says and a
 * refresh without rotating the refresh token, and its model listing.
 */
function fakeXai() {
	let code: "waiting" | "entered" | "declined" = "waiting";
	let issued = 0;
	const refreshesSpent: string[] = [];
	const state = { listingAuthorization: "" };

	const tokens = () => {
		issued += 1;
		return { access_token: `xai-access-${issued}`, expires_in: 3600, token_type: "Bearer" };
	};

	const respond = async (url: string, init?: RequestInit): Promise<Response> => {
		const { pathname } = new URL(url);
		if (pathname === "/oauth2/device/code") {
			return Response.json({
				device_code: "xai-device-code",
				user_code: "GWJA-VZAE",
				verification_uri: "https://accounts.x.ai/oauth2/device",
				verification_uri_complete: "https://accounts.x.ai/oauth2/device?user_code=GWJA-VZAE",
				expires_in: 1800,
				interval: 5,
			});
		}
		if (pathname === "/oauth2/token") {
			const form = new URLSearchParams(String(init?.body));
			const spent = form.get("refresh_token");
			if (spent) {
				refreshesSpent.push(spent);
				return Response.json(tokens());
			}
			if (code === "waiting") {
				return Response.json({ error: "authorization_pending" }, { status: 400 });
			}
			if (code === "declined") return Response.json({ error: "access_denied" }, { status: 400 });
			return Response.json({ ...tokens(), refresh_token: "xai-refresh-1" });
		}
		if (pathname === "/v1/models") {
			state.listingAuthorization = new Headers(init?.headers).get("authorization") ?? "";
			return Response.json({ object: "list", data: [{ id: "grok-4.3", object: "model" }] });
		}
		return new Response(null, { status: 404 });
	};

	const clients: EgressHttpClients = {
		for: () =>
			((input: string | URL | Request, init?: RequestInit) =>
				respond(input instanceof Request ? input.url : input.toString(), init)) as typeof fetch,
	};

	return {
		clients,
		refreshesSpent,
		get listingAuthorization() {
			return state.listingAuthorization;
		},
		enterCode: () => {
			code = "entered";
		},
		declineCode: () => {
			code = "declined";
		},
	};
}
