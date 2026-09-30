import { sessionUserSchema, type WorkspaceMember } from "@sugabots/contracts";
import { API_BASE_PATH } from "@sugabots/contracts/http";
import { Accounts } from "@sugabots/core/accounts/accounts";
import { user } from "@sugabots/core/database/schema";
import { closeDatabase, onDatabase, testInfrastructure } from "@sugabots/core/database/testing";
import { Email } from "@sugabots/core/email/email";
import { Installation } from "@sugabots/core/installation/installation";
import { Membership } from "@sugabots/core/workspaces/membership/membership";
import { eq } from "drizzle-orm";
import { ConfigProvider, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	BASE_URL,
	createTestApp,
	installationWithWebAppAt,
	type TestApp,
} from "../http/app.test-support.ts";
import { Authentication } from "./authentication.ts";

/** The test app at the server root, where better-auth's own links point. */
function atServerRoot(app: TestApp) {
	return {
		request: (path: string, init?: RequestInit) =>
			app.fetch(new Request(new URL(path, BASE_URL), init)),
	};
}

/**
 * Signing up and into a workspace, end to end against a migrated database. Also
 * the only check that our Drizzle schema matches the one better-auth expects.
 */

const ORIGIN = "http://localhost:5173";
const closers: Array<() => Promise<void>> = [];

afterAll(async () => {
	await Promise.all(closers.map((close) => close()));
	await closeDatabase();
});

/** The real `Authentication`, `Membership` and `Accounts` behind the test app, keeping sent emails in `sent`. */
async function appWith(
	policy: { SIGNUP_MODE: Accounts.SignUpMode; REQUIRE_EMAIL_VERIFICATION: "true" | "false" },
	sent: Email.Message[],
) {
	const runtime = ManagedRuntime.make(
		Layer.mergeAll(Authentication.layer, Membership.layer).pipe(
			Layer.provideMerge(Accounts.layer),
			Layer.provide([
				Layer.succeed(
					Email.Service,
					Email.Service.of({
						send: (message) =>
							Effect.sync(() => {
								sent.push(message);
							}),
					}),
				),
			]),
			Layer.provide(Installation.layer),
			Layer.provide(testInfrastructure),
			Layer.provide(
				ConfigProvider.layer(
					ConfigProvider.fromEnv({
						env: {
							DATABASE_URL: process.env.DATABASE_URL ?? "",
							PUBLIC_URL: "http://localhost:3000",
							WEB_APP_URL: ORIGIN,
							BETTER_AUTH_SECRET: "test-secret-not-used-anywhere-else",
							EMAIL_TRANSACTIONAL_FROM: "sugabots@example.com",
							...policy,
						},
					}),
				),
			),
		),
	);
	closers.push(() => runtime.dispose());
	const services = await runtime.runPromise(
		Effect.all({
			authentication: Authentication.Service,
			membership: Membership.Service,
			accounts: Accounts.Service,
		}),
	);
	return atServerRoot(
		createTestApp(
			Layer.mergeAll(
				Layer.succeed(Authentication.Service, services.authentication),
				Layer.succeed(Membership.Service, services.membership),
				Layer.succeed(Accounts.Service, services.accounts),
				installationWithWebAppAt(ORIGIN),
			),
		),
	);
}

type App = Awaited<ReturnType<typeof appWith>>;

function post(app: App, path: string, body: unknown, token?: string) {
	return app.request(`${API_BASE_PATH}${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			origin: ORIGIN,
			...(token ? { authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify(body),
	});
}

function signUpAt(app: App, name: string, email: string, extra: Record<string, unknown> = {}) {
	return post(app, "/auth/sign-up/email", {
		name,
		email,
		password: "correct-horse-battery",
		...extra,
	});
}

/** A workspace made by the holder of `token`. */
async function workspaceMadeBy(app: App, token: string, slug: string) {
	const created = await post(app, "/workspaces", { name: "Nitric", slug }, token);
	expect(created.status).toBe(201);
	return (await created.json()) as { id: string };
}

function invite(app: App, token: string, workspaceId: string, email: string) {
	return post(app, `/workspaces/${workspaceId}/invitations`, { email, role: "member" }, token);
}

describe.skipIf(!process.env.DATABASE_URL)("accounts", () => {
	const sent: Email.Message[] = [];
	let app: App;
	beforeAll(async () => {
		app = await appWith({ SIGNUP_MODE: "open", REQUIRE_EMAIL_VERIFICATION: "false" }, sent);
	});

	/** Signs somebody up and returns the bearer token they were given. */
	async function signUp(name: string, email: string): Promise<string> {
		const response = await signUpAt(app, name, email);

		expect(response.status).toBe(200);
		const token = response.headers.get("set-auth-token");
		expect(token, "sign-up should issue a bearer token").toBeTruthy();
		return token as string;
	}

	function me(token: string) {
		return app.request(`${API_BASE_PATH}/me`, { headers: { authorization: `Bearer ${token}` } });
	}

	async function verifyEmail(email: string): Promise<void> {
		const verification = sent.findLast(
			(message) =>
				message.to[0].email === email && message.subject === "Verify your email for Sugabots",
		);
		const link = verification?.text?.match(/https?:\/\/\S+/)?.[0];
		expect(link, `sign-up should send verification to ${email}`).toBeTruthy();

		const url = new URL(link as string);
		url.searchParams.delete("callbackURL");
		const response = await app.request(`${url.pathname}${url.search}`, {
			headers: { origin: ORIGIN },
		});
		expect(response.status).toBe(200);
	}

	it("takes a person from sign-up to a shared workspace", async () => {
		const unique = crypto.randomUUID().slice(0, 8);
		const adaEmail = `ada-${unique}@example.com`;
		const bobEmail = `bob-${unique}@example.com`;

		const ada = await signUp("Ada", adaEmail);
		const identified = Schema.decodeUnknownSync(sessionUserSchema)(await (await me(ada)).json());
		expect(identified.email).toBe(adaEmail);

		const workspace = await workspaceMadeBy(app, ada, `nitric-${unique}`);
		const invited = await invite(app, ada, workspace.id, bobEmail);
		expect(invited.status).toBe(201);
		const invitation = (await invited.json()) as { id: string };
		expect(sent.at(-1)?.text).toContain(`${ORIGIN}/invite/${invitation.id}`);

		const bob = await signUp("Bob", bobEmail);
		await verifyEmail(bobEmail);
		expect((await post(app, `/invitations/${invitation.id}/accept`, {}, bob)).status).toBe(200);

		expect((await me(bob)).status).toBe(200);
		const roster = await app.request(`${API_BASE_PATH}/workspaces/${workspace.id}/members`, {
			headers: { authorization: `Bearer ${bob}` },
		});
		const members = (await roster.json()) as WorkspaceMember[];
		expect(members.map((member) => [member.user.email, member.role]).sort()).toEqual([
			[adaEmail, "owner"],
			[bobEmail, "member"],
		]);
	});

	it("accepts the HttpOnly cookie issued at sign-up on application routes", async () => {
		const unique = crypto.randomUUID().slice(0, 8);
		const response = await signUpAt(app, "Cookie User", `cookie-${unique}@example.com`);
		const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
		expect(cookie).toBeTruthy();

		const identified = await app.request(`${API_BASE_PATH}/me`, {
			headers: { cookie: cookie as string },
		});

		expect(identified.status).toBe(200);
		expect(Schema.decodeUnknownSync(sessionUserSchema)(await identified.json()).email).toBe(
			`cookie-${unique}@example.com`,
		);
	});

	it("refuses an invitation to a role the product does not implement", async () => {
		const unique = crypto.randomUUID().slice(0, 8);
		const ada = await signUp("Ada", `ada-${unique}@example.com`);
		const workspace = await workspaceMadeBy(app, ada, `roles-${unique}`);

		const invited = await post(
			app,
			`/workspaces/${workspace.id}/invitations`,
			{ email: `kim-${unique}@example.com`, role: "owner" },
			ada,
		);

		expect(invited.status).toBe(400);
	});

	it("resets a forgotten password from the emailed link, ending every session", async () => {
		const email = `reset-${crypto.randomUUID().slice(0, 8)}@example.com`;
		const before = await signUp("Rosa", email);
		const redirectTo = `${ORIGIN}/reset-password`;

		expect((await post(app, "/auth/request-password-reset", { email, redirectTo })).status).toBe(
			200,
		);
		const link = sent
			.findLast(
				(message) =>
					message.to[0].email === email && message.subject === "Reset your Sugabots password",
			)
			?.text?.match(/https?:\/\/\S+/)?.[0];
		expect(link, "a reset link should have been sent").toBeTruthy();

		const url = new URL(link as string);
		const opened = await app.request(`${url.pathname}${url.search}`, {
			headers: { origin: ORIGIN },
		});
		const landing = new URL(opened.headers.get("location") ?? "");
		expect(`${landing.origin}${landing.pathname}`).toBe(redirectTo);
		const token = landing.searchParams.get("token");
		expect(token).toBeTruthy();

		const newPassword = "a-new-horse-battery";
		expect((await post(app, "/auth/reset-password", { token, newPassword })).status).toBe(200);

		const signIn = (password: string) => post(app, "/auth/sign-in/email", { email, password });
		expect((await me(before)).status).toBe(401);
		expect((await signIn("correct-horse-battery")).status).toBe(401);
		expect((await signIn(newPassword)).status).toBe(200);
		expect((await post(app, "/auth/reset-password", { token, newPassword })).status).toBe(400);
	});

	it("answers a reset request for an unknown address as it does for a known one", async () => {
		const sentBefore = sent.length;
		const response = await post(app, "/auth/request-password-reset", {
			email: `nobody-${crypto.randomUUID().slice(0, 8)}@example.com`,
			redirectTo: `${ORIGIN}/reset-password`,
		});

		expect(response.status).toBe(200);
		expect(sent.length).toBe(sentBefore);
	});

	it("rejects a token it never issued", async () => {
		expect((await me("not-a-real-token")).status).toBe(401);
	});
});

describe.skipIf(!process.env.DATABASE_URL)("an invite-only installation", () => {
	const sent: Email.Message[] = [];
	// The same database seen under both policies: a member invites from the
	// open one, and the invitee arrives at the closed one.
	let open: App;
	let closed: App;
	beforeAll(async () => {
		[open, closed] = await Promise.all([
			appWith({ SIGNUP_MODE: "open", REQUIRE_EMAIL_VERIFICATION: "false" }, sent),
			appWith({ SIGNUP_MODE: "closed", REQUIRE_EMAIL_VERIFICATION: "false" }, sent),
		]);
	});

	/** An unrelated account, so the installation is never empty. */
	async function anIncumbent(unique: string): Promise<string> {
		const response = await signUpAt(open, "Ada", `ada-${unique}@example.com`);
		expect(response.status).toBe(200);
		return response.headers.get("set-auth-token") as string;
	}

	it("refuses an address nobody invited", async () => {
		const unique = crypto.randomUUID().slice(0, 8);
		await anIncumbent(unique);

		const refused = await signUpAt(closed, "Eve", `eve-${unique}@example.com`);

		expect(refused.status).toBe(403);
		expect(await refused.json()).toMatchObject({ code: "SIGN_UP_CLOSED" });
		expect(
			await onDatabase((db) =>
				db
					.select()
					.from(user)
					.where(eq(user.email, `eve-${unique}@example.com`)),
			),
		).toEqual([]);
	});

	it("admits an address a member invited", async () => {
		const unique = crypto.randomUUID().slice(0, 8);
		const ada = await anIncumbent(unique);
		const bobEmail = `bob-${unique}@example.com`;
		const workspace = await workspaceMadeBy(open, ada, `nitric-${unique}`);

		expect((await invite(open, ada, workspace.id, bobEmail)).status).toBe(201);

		expect((await signUpAt(closed, "Bob", bobEmail)).status).toBe(200);
	});
});

describe.skipIf(!process.env.DATABASE_URL)(
	"an installation that signs people up by referral",
	() => {
		const sent: Email.Message[] = [];
		// The same database under both policies, so there is always somebody to
		// refer from and the installation is never empty.
		let open: App;
		let referral: App;
		beforeAll(async () => {
			[open, referral] = await Promise.all([
				appWith({ SIGNUP_MODE: "open", REQUIRE_EMAIL_VERIFICATION: "false" }, sent),
				appWith({ SIGNUP_MODE: "referral", REQUIRE_EMAIL_VERIFICATION: "false" }, sent),
			]);
		});

		/** A member of the referral installation, and the bearer token they were given. */
		async function aMember(unique: string): Promise<{ id: string; token: string }> {
			const response = await signUpAt(open, "Ada", `ada-${unique}@example.com`);
			expect(response.status).toBe(200);
			const { user } = (await response.json()) as { user: { id: string } };
			return { id: user.id, token: response.headers.get("set-auth-token") as string };
		}

		async function referralLinkOf(app: App, token: string): Promise<string | null> {
			const response = await app.request(`${API_BASE_PATH}/referral-link`, {
				headers: { authorization: `Bearer ${token}` },
			});
			expect(response.status).toBe(200);
			return ((await response.json()) as { url: string | null }).url;
		}

		function codeIn(link: string | null): string {
			const code = link === null ? null : new URL(link).pathname.split("/join/")[1];
			expect(code, "the link should carry a code").toBeTruthy();
			return code as string;
		}

		function referrerOf(email: string) {
			return onDatabase((db) =>
				db.select({ referredBy: user.referredBy }).from(user).where(eq(user.email, email)),
			);
		}

		it("admits somebody holding a member's link, and records who sent it", async () => {
			const unique = crypto.randomUUID().slice(0, 8);
			const ada = await aMember(unique);
			const link = await referralLinkOf(referral, ada.token);
			const bobEmail = `bob-${unique}@example.com`;

			expect(link).toMatch(new RegExp(`^${ORIGIN}/join/[0-9a-z]{13}$`));
			expect(
				(await signUpAt(referral, "Bob", bobEmail, { referralCode: codeIn(link) })).status,
			).toBe(200);
			expect(await referrerOf(bobEmail)).toEqual([{ referredBy: ada.id }]);
		});

		it("refuses somebody with no link, or a code nobody holds", async () => {
			const unique = crypto.randomUUID().slice(0, 8);
			await aMember(unique);

			const withoutLink = await signUpAt(referral, "Eve", `eve-${unique}@example.com`);
			const forged = await signUpAt(referral, "Eve", `eve-${unique}@example.com`, {
				referralCode: "0000000000000",
			});

			expect(withoutLink.status).toBe(403);
			expect(await withoutLink.json()).toMatchObject({ code: "SIGN_UP_CLOSED" });
			expect(forged.status).toBe(403);
			expect(await forged.json()).toMatchObject({ code: "REFERRAL_LINK_INVALID" });
			expect(await referrerOf(`eve-${unique}@example.com`)).toEqual([]);
		});

		it("stops a link working once its member resets it, and admits with the new one", async () => {
			const unique = crypto.randomUUID().slice(0, 8);
			const ada = await aMember(unique);
			const oldCode = codeIn(await referralLinkOf(referral, ada.token));

			const reset = await post(referral, "/referral-link/reset", {}, ada.token);
			const newCode = codeIn(((await reset.json()) as { url: string }).url);

			expect(reset.status).toBe(200);
			expect(codeIn(await referralLinkOf(referral, ada.token))).toBe(newCode);
			const stale = await signUpAt(referral, "Bob", `bob-${unique}@example.com`, {
				referralCode: oldCode,
			});
			expect(stale.status).toBe(403);
			expect(await stale.json()).toMatchObject({ code: "REFERRAL_LINK_INVALID" });
			expect(
				(await signUpAt(referral, "Bob", `bob-${unique}@example.com`, { referralCode: newCode }))
					.status,
			).toBe(200);
		});

		it("does not let somebody signing up say who referred them", async () => {
			const unique = crypto.randomUUID().slice(0, 8);
			const ada = await aMember(unique);

			const response = await signUpAt(open, "Eve", `eve-${unique}@example.com`, {
				referredBy: ada.id,
			});

			expect(response.status).toBe(400);
			expect(await referrerOf(`eve-${unique}@example.com`)).toEqual([]);
		});

		it("offers no link where sign-up is not by referral", async () => {
			const ada = await aMember(crypto.randomUUID().slice(0, 8));

			expect(await referralLinkOf(open, ada.token)).toBeNull();
			expect((await post(open, "/referral-link/reset", {}, ada.token)).status).toBe(404);
		});
	},
);

describe.skipIf(!process.env.DATABASE_URL)(
	"an installation that requires email verification",
	() => {
		const sent: Email.Message[] = [];
		let app: App;
		beforeAll(async () => {
			app = await appWith({ SIGNUP_MODE: "open", REQUIRE_EMAIL_VERIFICATION: "true" }, sent);
		});

		it("withholds a session until the address is proven, then admits", async () => {
			const email = `verify-${crypto.randomUUID().slice(0, 8)}@example.com`;
			const password = "correct-horse-battery";

			const signedUp = await post(app, "/auth/sign-up/email", { name: "Vera", email, password });
			expect(signedUp.status).toBe(200);
			expect(signedUp.headers.get("set-auth-token")).toBeNull();

			const tooEarly = await post(app, "/auth/sign-in/email", { email, password });
			expect(tooEarly.status).toBe(403);

			const link = sent
				.findLast((message) => message.to[0].email === email)
				?.text?.match(/https?:\/\/\S+/)?.[0];
			expect(link, "a verification link should have been sent").toBeTruthy();
			const url = new URL(link as string);
			url.searchParams.delete("callbackURL");
			expect(
				(await app.request(`${url.pathname}${url.search}`, { headers: { origin: ORIGIN } })).status,
			).toBe(200);

			const signedIn = await post(app, "/auth/sign-in/email", { email, password });
			expect(signedIn.status).toBe(200);
			expect(signedIn.headers.get("set-auth-token")).toBeTruthy();
		});
	},
);
