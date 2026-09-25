import { Effect } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { TurnModel } from "../../conversations/turns/model.ts";
import { Credentials } from "../../credentials/credentials.ts";
import { user, workspace } from "../../database/schema.ts";
import { closeDatabase, onDatabase, onPostgres, runOnPostgres } from "../../database/testing.ts";
import type { EgressHttpClients } from "../network/egress.ts";
import { withChatgptAccess } from "./chatgpt.ts";
import { modelProviderOperations } from "./operations.ts";
import { modelProviderStore } from "./store.ts";

/**
 * Signing a provider in with ChatGPT and keeping its token alive, against real
 * SQL and a stand-in for OpenAI's sign-in service and the Codex backend.
 */
describe.skipIf(!process.env.DATABASE_URL)("a ChatGPT subscription provider", () => {
	const cipher = Credentials.fromKey(Buffer.alloc(32, 7).toString("base64"));
	const providers = modelProviderStore(cipher);
	const store = onPostgres(providers);
	let workspaceId: string;
	let providerId: string;
	let openai: ReturnType<typeof fakeOpenAI>;

	const operations = () =>
		onPostgres(
			modelProviderOperations({
				providers,
				httpClients: openai.clients,
				validateProviderUrl: async () => {},
				model: {} as TurnModel,
				cipher,
			}),
		);

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		openai = fakeOpenAI();
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
		const seeded = (await store.list(workspaceId)).find(({ preset }) => preset === "chatgpt");
		if (!seeded) throw new Error("ChatGPT is not seeded");
		providerId = seeded.id;
	});

	it("waits for the code to be entered, then signs in and lists the plan's models", async () => {
		expect(await store.get(workspaceId, providerId)).toMatchObject({
			status: "signed_out",
			signedIn: false,
		});

		const started = await operations().startChatgptSignIn(workspaceId, providerId);
		expect(started).toMatchObject({
			userCode: "ABCD-1234",
			verificationUrl: "https://auth.openai.com/codex/device",
		});
		expect(started.attempt).not.toContain("device-auth-id");

		const waiting = await operations().completeChatgptSignIn(
			workspaceId,
			providerId,
			started.attempt,
		);
		expect(waiting).toEqual({ status: "pending" });

		openai.enterCode();
		const outcome = await operations().completeChatgptSignIn(
			workspaceId,
			providerId,
			started.attempt,
		);

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
		const started = await operations().startChatgptSignIn(workspaceId, providerId);
		const other = await store.create(workspaceId, (await someUser()).id, {
			name: "Gateway",
			baseUrl: "https://models.example/v1",
			apiFormat: "openai",
			apiKey: "secret",
			customHeaders: [],
		});

		await expect(
			operations().completeChatgptSignIn(workspaceId, other.id, started.attempt),
		).rejects.toMatchObject({ _tag: "ChatgptSignInNotOffered" });
	});

	it("spends a lapsing refresh token once, however many turns start together", async () => {
		await store.saveChatgptSignIn(workspaceId, providerId, {
			access: "lapsing-token",
			refresh: "refresh-0",
			expiresAt: Date.now() + 60_000,
			accountId: "account-1",
		});
		const connection = await store.connection(workspaceId, providerId);
		if (!connection) throw new Error("fixture");

		const ready = await Promise.all(
			[1, 2, 3].map(() =>
				runOnPostgres(withChatgptAccess(providers, openai.clients, workspaceId, connection)),
			),
		);

		expect(openai.refreshesSpent).toEqual(["refresh-0"]);
		const renewed = openai.issued[0];
		expect(ready.map(({ apiKey }) => apiKey)).toEqual([renewed, renewed, renewed]);
		expect(await store.get(workspaceId, providerId)).toMatchObject({ signedIn: true });
	});

	it("leaves a token with time to run alone", async () => {
		await store.saveChatgptSignIn(workspaceId, providerId, {
			access: "fresh-token",
			refresh: "refresh-0",
			expiresAt: Date.now() + 60 * 60_000,
			accountId: "account-1",
		});
		const connection = await store.connection(workspaceId, providerId);
		if (!connection) throw new Error("fixture");

		const ready = await runOnPostgres(
			withChatgptAccess(providers, openai.clients, workspaceId, connection),
		);

		expect(ready.apiKey).toBe("fresh-token");
		expect(ready.headers["ChatGPT-Account-Id"]).toBe("account-1");
		expect(openai.refreshesSpent).toEqual([]);
	});

	async function someUser() {
		const [person] = await onDatabase((db) =>
			db
				.insert(user)
				.values({ name: "Bea", email: `bea-${Date.now()}-${Math.random()}@example.com` })
				.returning(),
		);
		if (!person) throw new Error("fixture");
		return person;
	}
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
