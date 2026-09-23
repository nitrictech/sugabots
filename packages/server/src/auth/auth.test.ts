import { sessionUserSchema } from "@sugabots/contracts";
import {
	pod,
	podMember,
	searchProvider,
	user,
	workspaceMember,
} from "@sugabots/core/database/schema";
import { closeDatabase, onDatabase, runOnPostgres } from "@sugabots/core/database/testing";
import { podStore } from "@sugabots/core/workspaces/pods/store";
import { and, eq, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Schema } from "effect";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { API_BASE_PATH } from "../config.ts";
import type { Email } from "../email/mailer.ts";
import { BASE_URL, createTestApp, type TestApp } from "../http/app.test-support.ts";
import { createAuth } from "./auth.ts";

/** The test app addressed as the process serves it, so better-auth answers where its own client looks. */
function atServerRoot(app: TestApp) {
	return {
		request: (path: string, init?: RequestInit) =>
			app.fetch(new Request(new URL(path, BASE_URL), init)),
	};
}

/**
 * The whole of NIT-1758, end to end, against a real database: somebody signs
 * up, makes a workspace, invites a second person, and both hold tokens `/me`
 * accepts. It is also the only check that our hand-written Drizzle schema
 * matches the one better-auth expects — every table it needs is written to
 * here.
 *
 * Needs a migrated database, like the schema tests, and skips without one.
 */

const ORIGIN = "http://localhost:5173";

// better-auth's adapter only speaks node-postgres, so it gets a pool of its own.
const authPool = new Pool({ connectionString: process.env.DATABASE_URL });
const authDb = drizzle({ client: authPool });

afterAll(async () => {
	await authPool.end();
	await closeDatabase();
});

describe.skipIf(!process.env.DATABASE_URL)("accounts", () => {
	const sent: Email[] = [];
	const auth = createAuth({
		db: authDb,
		run: runOnPostgres,
		secret: "test-secret-not-used-anywhere-else",
		baseUrl: "http://localhost:3000",
		webOrigins: [ORIGIN],
		mailer: async (email) => {
			sent.push(email);
		},
		allowOpenSignUp: true,
		requireEmailVerification: false,
	});
	// Mounted as the process mounts it, so better-auth answers where its own
	// links point.
	const app = atServerRoot(createTestApp({ auth, webOrigins: [ORIGIN] }));

	/** Signs somebody up and returns the bearer token they were given. */
	async function signUp(name: string, email: string): Promise<string> {
		const response = await call("/auth/sign-up/email", {
			name,
			email,
			password: "correct-horse-battery",
		});

		expect(response.status).toBe(200);
		const token = response.headers.get("set-auth-token");
		expect(token, "sign-up should issue a bearer token").toBeTruthy();
		return token as string;
	}

	function call(path: string, body: unknown, token?: string) {
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

	function me(token: string) {
		return app.request(`${API_BASE_PATH}/me`, { headers: { authorization: `Bearer ${token}` } });
	}

	async function verifyEmail(email: string): Promise<void> {
		const verification = sent.findLast(
			(message) => message.to === email && message.subject === "Verify your email for Sugabots",
		);
		const link = verification?.text.match(/https?:\/\/\S+/)?.[0];
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

		// 1. Sign up, and the token works on our own routes, not just on
		//    better-auth's.
		const ada = await signUp("Ada", adaEmail);
		const identified = Schema.decodeUnknownSync(sessionUserSchema)(await (await me(ada)).json());
		expect(identified.email).toBe(adaEmail);

		// 2. Create a workspace. Its creator administers it.
		const created = await call(
			"/auth/organization/create",
			{ name: "Nitric", slug: `nitric-${unique}` },
			ada,
		);
		expect(created.status).toBe(200);
		const workspace = (await created.json()) as { id: string };

		//    It can search from the start, on Exa's free tier.
		const [search] = await onDatabase((db) =>
			db
				.select({ preset: searchProvider.preset, enabled: searchProvider.enabled })
				.from(searchProvider)
				.where(eq(searchProvider.workspaceId, workspace.id)),
		);
		expect(search).toEqual({ preset: "exa", enabled: true });

		// 3. Invite somebody. The invitation goes out by email, and its id is a
		//    random UUID rather than the time-ordered v7 the other tables use,
		//    because the link is a secret.
		const invited = await call(
			"/auth/organization/invite-member",
			{ email: bobEmail, role: "member", organizationId: workspace.id },
			ada,
		);
		expect(invited.status).toBe(200);
		const invitation = (await invited.json()) as { id: string };
		expect(invitation.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/);

		expect(sent.at(-1)?.to).toBe(bobEmail);
		expect(sent.at(-1)?.text).toContain(`${ORIGIN}/invite/${invitation.id}`);

		// 4. The invited person signs up and accepts.
		const bob = await signUp("Bob", bobEmail);
		await verifyEmail(bobEmail);
		const accepted = await call(
			"/auth/organization/accept-invitation",
			{ invitationId: invitation.id },
			bob,
		);
		expect(accepted.status).toBe(200);

		// 5. Both hold tokens the API accepts, and both are in the workspace.
		expect((await me(ada)).status).toBe(200);
		expect((await me(bob)).status).toBe(200);

		const members = await app.request(
			`${API_BASE_PATH}/auth/organization/get-full-organization?organizationId=${workspace.id}`,
			{ headers: { authorization: `Bearer ${bob}`, origin: ORIGIN } },
		);
		const full = (await members.json()) as { members: { role: string; user: { email: string } }[] };
		expect(full.members.map((member) => [member.user.email, member.role]).sort()).toEqual([
			[adaEmail, "admin"],
			[bobEmail, "member"],
		]);
		const people = await onDatabase((db) =>
			db
				.select({ userId: user.id })
				.from(user)
				.where(or(eq(user.email, adaEmail), eq(user.email, bobEmail))),
		);
		const personalPods = await onDatabase((db) =>
			db
				.select({ ownerId: pod.ownerId })
				.from(pod)
				.where(and(eq(pod.workspaceId, workspace.id), eq(pod.kind, "personal"))),
		);
		expect(personalPods.map(({ ownerId }) => ownerId).sort()).toEqual(
			people.map(({ userId }) => userId).sort(),
		);
	});

	it("accepts the HttpOnly cookie issued at sign-up on application routes", async () => {
		const unique = crypto.randomUUID().slice(0, 8);
		const response = await call("/auth/sign-up/email", {
			name: "Cookie User",
			email: `cookie-${unique}@example.com`,
			password: "correct-horse-battery",
		});
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

	it("refuses an invitation addressed to somebody else", async () => {
		const unique = crypto.randomUUID().slice(0, 8);
		const ada = await signUp("Ada", `ada-${unique}@example.com`);

		const created = await call(
			"/auth/organization/create",
			{ name: "Nitric", slug: `nitric-${unique}` },
			ada,
		);
		const workspace = (await created.json()) as { id: string };

		const invited = await call(
			"/auth/organization/invite-member",
			{ email: `bob-${unique}@example.com`, role: "member", organizationId: workspace.id },
			ada,
		);
		const invitation = (await invited.json()) as { id: string };

		const interloper = await signUp("Eve", `eve-${unique}@example.com`);
		const accepted = await call(
			"/auth/organization/accept-invitation",
			{ invitationId: invitation.id },
			interloper,
		);

		expect(accepted.status).toBe(403);
	});

	// An installation that does not require a proved address to sign in must not
	// require one to accept an invitation either: it may have no mailer to prove
	// an address with, which would leave every invitee holding a dead link.
	it("lets an unverified account accept its own invitation where verification is off", async () => {
		const unique = crypto.randomUUID().slice(0, 8);
		const ada = await signUp("Ada", `ada-${unique}@example.com`);
		const bobEmail = `bob-${unique}@example.com`;

		const created = await call(
			"/auth/organization/create",
			{ name: "Nitric", slug: `nitric-unverified-${unique}` },
			ada,
		);
		const workspace = (await created.json()) as { id: string };
		const invited = await call(
			"/auth/organization/invite-member",
			{ email: bobEmail, role: "member", organizationId: workspace.id },
			ada,
		);
		const invitation = (await invited.json()) as { id: string };

		const bob = await signUp("Bob", bobEmail);
		const read = await app.request(
			`${API_BASE_PATH}/auth/organization/get-invitation?id=${invitation.id}`,
			{ headers: { authorization: `Bearer ${bob}`, origin: ORIGIN } },
		);
		expect(read.status).toBe(200);

		const accepted = await call(
			"/auth/organization/accept-invitation",
			{ invitationId: invitation.id },
			bob,
		);

		expect(accepted.status).toBe(200);
		expect((await me(bob)).status).toBe(200);
	});

	it("does not restore pod grants when a removed workspace member rejoins", async () => {
		const unique = crypto.randomUUID().slice(0, 8);
		const adaEmail = `ada-membership-${unique}@example.com`;
		const ada = await signUp("Ada", adaEmail);
		const bobEmail = `bob-membership-${unique}@example.com`;
		const bob = await signUp("Bob", bobEmail);
		await verifyEmail(bobEmail);

		const created = await call(
			"/auth/organization/create",
			{ name: "Membership lifecycle", slug: `membership-${unique}` },
			ada,
		);
		const workspace = (await created.json()) as { id: string };
		const invite = async () => {
			const response = await call(
				"/auth/organization/invite-member",
				{ email: bobEmail, role: "member", organizationId: workspace.id },
				ada,
			);
			expect(response.status).toBe(200);
			return (await response.json()) as { id: string };
		};
		const firstInvitation = await invite();
		expect(
			(
				await call(
					"/auth/organization/accept-invitation",
					{ invitationId: firstInvitation.id },
					bob,
				)
			).status,
		).toBe(200);

		const [adaRow, bobRow] = await Promise.all([
			onDatabase((db) =>
				db.select({ id: user.id }).from(user).where(eq(user.email, adaEmail)),
			).then(([row]) => row),
			onDatabase((db) =>
				db.select({ id: user.id }).from(user).where(eq(user.email, bobEmail)),
			).then(([row]) => row),
		]);
		if (!adaRow) {
			throw new Error("Could not find the workspace owner");
		}
		if (!bobRow) {
			throw new Error("Could not find the invited member");
		}
		const [bobPersonalPod] = await onDatabase((db) =>
			db
				.select({ id: pod.id })
				.from(pod)
				.where(
					and(
						eq(pod.workspaceId, workspace.id),
						eq(pod.ownerId, bobRow.id),
						eq(pod.kind, "personal"),
					),
				),
		);
		if (!bobPersonalPod) throw new Error("Invited member has no Personal pod");
		const [madePod] = await onDatabase((db) =>
			db
				.insert(pod)
				.values({
					workspaceId: workspace.id,
					kind: "shared",
					name: "Private",
					slug: `private-${unique}`,
				})
				.returning(),
		);
		if (!madePod) {
			throw new Error("Could not create the member's pod");
		}
		await onDatabase((db) =>
			db
				.insert(podMember)
				.values({ workspaceId: workspace.id, podId: madePod.id, userId: bobRow.id }),
		);

		const removed = await call(
			"/auth/organization/remove-member",
			{ memberIdOrEmail: bobEmail, organizationId: workspace.id },
			ada,
		);
		expect(removed.status).toBe(200);
		const secondInvitation = await invite();
		expect(
			(
				await call(
					"/auth/organization/accept-invitation",
					{ invitationId: secondInvitation.id },
					bob,
				)
			).status,
		).toBe(200);

		expect(
			await onDatabase((db) =>
				db
					.select()
					.from(podMember)
					.where(and(eq(podMember.podId, madePod.id), eq(podMember.userId, bobRow.id))),
			),
		).toEqual([]);
		expect(
			await onDatabase((db) =>
				db
					.select()
					.from(workspaceMember)
					.where(
						and(
							eq(workspaceMember.workspaceId, workspace.id),
							eq(workspaceMember.userId, bobRow.id),
						),
					),
			),
		).toHaveLength(1);
		expect(
			await onDatabase((db) => db.select().from(pod).where(eq(pod.id, bobPersonalPod.id))),
		).toEqual([]);
	});

	it("rejects a token it never issued", async () => {
		expect((await me("not-a-real-token")).status).toBe(401);
	});

	/**
	 * better-auth will store any string as a role, and reads one as a
	 * comma-separated list. The application recognises `admin` and `member` and
	 * grants nothing for anything else, so anything else is refused where it is
	 * written rather than stored and silently inert.
	 */
	describe("workspace roles", () => {
		async function membershipId(workspaceId: string, email: string) {
			const [row] = await onDatabase((db) =>
				db
					.select({ id: workspaceMember.id })
					.from(workspaceMember)
					.innerJoin(user, eq(user.id, workspaceMember.userId))
					.where(and(eq(workspaceMember.workspaceId, workspaceId), eq(user.email, email))),
			);
			if (!row) throw new Error(`${email} is not in the workspace`);
			return row.id;
		}

		async function workspaceWithTwo(unique: string) {
			const adaEmail = `ada-roles-${unique}@example.com`;
			const bobEmail = `bob-roles-${unique}@example.com`;
			const ada = await signUp("Ada", adaEmail);
			const bob = await signUp("Bob", bobEmail);
			await verifyEmail(bobEmail);
			const created = await call(
				"/auth/organization/create",
				{ name: "Roles", slug: `roles-${unique}` },
				ada,
			);
			const workspace = (await created.json()) as { id: string };
			const invited = await call(
				"/auth/organization/invite-member",
				{ email: bobEmail, role: "member", organizationId: workspace.id },
				ada,
			);
			const invitation = (await invited.json()) as { id: string };
			expect(
				(await call("/auth/organization/accept-invitation", { invitationId: invitation.id }, bob))
					.status,
			).toBe(200);
			return { ada, bob, adaEmail, bobEmail, workspace };
		}

		it("refuses an invitation to a role the product does not implement", async () => {
			const unique = crypto.randomUUID().slice(0, 8);
			const { ada, workspace } = await workspaceWithTwo(unique);

			const invited = await call(
				"/auth/organization/invite-member",
				{
					email: `kim-${unique}@example.com`,
					role: "owner",
					organizationId: workspace.id,
				},
				ada,
			);

			expect(invited.status).toBe(400);
		});

		it("refuses a compound role", async () => {
			const unique = crypto.randomUUID().slice(0, 8);
			const { ada, bobEmail, workspace } = await workspaceWithTwo(unique);

			const updated = await call(
				"/auth/organization/update-member-role",
				{
					memberId: await membershipId(workspace.id, bobEmail),
					role: "admin,member",
					organizationId: workspace.id,
				},
				ada,
			);

			expect(updated.status).toBe(400);
			const [membership] = await onDatabase((db) =>
				db
					.select({ role: workspaceMember.role })
					.from(workspaceMember)
					.innerJoin(user, eq(user.id, workspaceMember.userId))
					.where(and(eq(workspaceMember.workspaceId, workspace.id), eq(user.email, bobEmail))),
			);
			expect(membership?.role).toBe("member");
		});

		it("promotes and demotes between the two supported roles", async () => {
			const unique = crypto.randomUUID().slice(0, 8);
			const { ada, bobEmail, workspace } = await workspaceWithTwo(unique);
			const roleOf = async () => {
				const [row] = await onDatabase((db) =>
					db
						.select({ role: workspaceMember.role })
						.from(workspaceMember)
						.innerJoin(user, eq(user.id, workspaceMember.userId))
						.where(and(eq(workspaceMember.workspaceId, workspace.id), eq(user.email, bobEmail))),
				);
				return row?.role;
			};

			const memberId = await membershipId(workspace.id, bobEmail);
			const promoted = await call(
				"/auth/organization/update-member-role",
				{ memberId, role: "admin", organizationId: workspace.id },
				ada,
			);
			expect(promoted.status).toBe(200);
			expect(await roleOf()).toBe("admin");

			const demoted = await call(
				"/auth/organization/update-member-role",
				{ memberId, role: "member", organizationId: workspace.id },
				ada,
			);
			expect(demoted.status).toBe(200);
			expect(await roleOf()).toBe("member");
		});

		it("invites somebody as a viewer, and lets them in", async () => {
			const unique = crypto.randomUUID().slice(0, 8);
			const { ada, workspace } = await workspaceWithTwo(unique);
			const kimEmail = `kim-viewer-${unique}@example.com`;
			const kim = await signUp("Kim", kimEmail);
			await verifyEmail(kimEmail);

			const invited = await call(
				"/auth/organization/invite-member",
				{ email: kimEmail, role: "viewer", organizationId: workspace.id },
				ada,
			);
			expect(invited.status).toBe(200);
			const invitation = (await invited.json()) as { id: string };
			expect(
				(await call("/auth/organization/accept-invitation", { invitationId: invitation.id }, kim))
					.status,
			).toBe(200);

			const [membership] = await onDatabase((db) =>
				db
					.select({ role: workspaceMember.role })
					.from(workspaceMember)
					.innerJoin(user, eq(user.id, workspaceMember.userId))
					.where(and(eq(workspaceMember.workspaceId, workspace.id), eq(user.email, kimEmail))),
			);
			expect(membership?.role).toBe("viewer");
			expect((await me(kim)).status).toBe(200);
		});

		/**
		 * `viewer` is registered with better-auth carrying no statements at all,
		 * so its own endpoints refuse every write. This is the check that holds
		 * that: the application's permission catalog does not reach these routes.
		 */
		it("lets a viewer read the roster and administer nobody", async () => {
			const unique = crypto.randomUUID().slice(0, 8);
			const { ada, bobEmail, workspace } = await workspaceWithTwo(unique);
			const kimEmail = `kim-powers-${unique}@example.com`;
			const kim = await signUp("Kim", kimEmail);
			await verifyEmail(kimEmail);
			const invited = await call(
				"/auth/organization/invite-member",
				{ email: kimEmail, role: "viewer", organizationId: workspace.id },
				ada,
			);
			const invitation = (await invited.json()) as { id: string };
			await call("/auth/organization/accept-invitation", { invitationId: invitation.id }, kim);

			const roster = await app.request(
				`${API_BASE_PATH}/auth/organization/get-full-organization?organizationId=${workspace.id}`,
				{ headers: { authorization: `Bearer ${kim}`, origin: ORIGIN } },
			);
			const invites = await call(
				"/auth/organization/invite-member",
				{ email: `nope-${unique}@example.com`, role: "member", organizationId: workspace.id },
				kim,
			);
			const removes = await call(
				"/auth/organization/remove-member",
				{ memberIdOrEmail: bobEmail, organizationId: workspace.id },
				kim,
			);
			const promotes = await call(
				"/auth/organization/update-member-role",
				{
					memberId: await membershipId(workspace.id, bobEmail),
					role: "admin",
					organizationId: workspace.id,
				},
				kim,
			);

			expect(roster.status).toBe(200);
			expect(invites.status).not.toBe(200);
			expect(removes.status).not.toBe(200);
			expect(promotes.status).not.toBe(200);
		});

		it("keeps the last administrator", async () => {
			const unique = crypto.randomUUID().slice(0, 8);
			const { ada, adaEmail, workspace } = await workspaceWithTwo(unique);

			const removed = await call(
				"/auth/organization/remove-member",
				{ memberIdOrEmail: adaEmail, organizationId: workspace.id },
				ada,
			);
			const left = await call("/auth/organization/leave", { organizationId: workspace.id }, ada);

			expect(removed.status).toBe(400);
			expect(left.status).toBe(400);
		});

		it("lets somebody who created a shared pod leave the workspace", async () => {
			const unique = crypto.randomUUID().slice(0, 8);
			const { bob, bobEmail, workspace } = await workspaceWithTwo(unique);
			const [bobRow] = await onDatabase((db) =>
				db.select({ id: user.id }).from(user).where(eq(user.email, bobEmail)),
			);
			if (!bobRow) throw new Error("the invited member is missing");

			const made = await runOnPostgres(
				podStore.create(
					workspace.id,
					{ userId: bobRow.id, workspaceRole: "member" },
					{ name: "Launch", slug: `launch-${unique}` },
				),
			);
			expect(made.ownerId).toBeNull();

			const left = await call("/auth/organization/leave", { organizationId: workspace.id }, bob);

			expect(left.status).toBe(200);
			expect(
				await onDatabase((db) => db.select().from(pod).where(eq(pod.id, made.id))),
			).toHaveLength(1);
		});
	});
});

describe.skipIf(!process.env.DATABASE_URL)("an invite-only installation", () => {
	const sent: Email[] = [];
	const mailer = async (email: Email) => {
		sent.push(email);
	};
	const options = {
		db: authDb,
		run: runOnPostgres,
		secret: "test-secret-not-used-anywhere-else",
		baseUrl: "http://localhost:3000",
		webOrigins: [ORIGIN],
		mailer,
		requireEmailVerification: false,
	};
	// The same database seen under both policies: a member invites from the
	// open one, and the invitee arrives at the closed one.
	const open = atServerRoot(
		createTestApp({
			auth: createAuth({ ...options, allowOpenSignUp: true }),
			webOrigins: [ORIGIN],
		}),
	);
	const closed = atServerRoot(
		createTestApp({
			auth: createAuth({ ...options, allowOpenSignUp: false }),
			webOrigins: [ORIGIN],
		}),
	);

	function signUpAt(app: typeof open, name: string, email: string) {
		return app.request(`${API_BASE_PATH}/auth/sign-up/email`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: ORIGIN },
			body: JSON.stringify({ name, email, password: "correct-horse-battery" }),
		});
	}

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
		// The refusal is the only thing that tells somebody why, so it reaches
		// them rather than better-auth's generic wording.
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

		const created = await open.request(`${API_BASE_PATH}/auth/organization/create`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: ORIGIN,
				authorization: `Bearer ${ada}`,
			},
			body: JSON.stringify({ name: "Nitric", slug: `nitric-${unique}` }),
		});
		const workspace = (await created.json()) as { id: string };
		const invited = await open.request(`${API_BASE_PATH}/auth/organization/invite-member`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: ORIGIN,
				authorization: `Bearer ${ada}`,
			},
			body: JSON.stringify({ email: bobEmail, role: "member", organizationId: workspace.id }),
		});
		expect(invited.status).toBe(200);

		expect((await signUpAt(closed, "Bob", bobEmail)).status).toBe(200);
	});
});

describe.skipIf(!process.env.DATABASE_URL)(
	"an installation that requires email verification",
	() => {
		const sent: Email[] = [];
		const auth = createAuth({
			db: authDb,
			run: runOnPostgres,
			secret: "test-secret-not-used-anywhere-else",
			baseUrl: "http://localhost:3000",
			webOrigins: [ORIGIN],
			mailer: async (email) => {
				sent.push(email);
			},
			allowOpenSignUp: true,
			requireEmailVerification: true,
		});
		const app = atServerRoot(createTestApp({ auth, webOrigins: [ORIGIN] }));

		function post(path: string, body: unknown) {
			return app.request(`${API_BASE_PATH}${path}`, {
				method: "POST",
				headers: { "content-type": "application/json", origin: ORIGIN },
				body: JSON.stringify(body),
			});
		}

		it("withholds a session until the address is proven, then admits", async () => {
			const email = `verify-${crypto.randomUUID().slice(0, 8)}@example.com`;
			const password = "correct-horse-battery";

			const signedUp = await post("/auth/sign-up/email", { name: "Vera", email, password });
			expect(signedUp.status).toBe(200);
			expect(signedUp.headers.get("set-auth-token")).toBeNull();

			const tooEarly = await post("/auth/sign-in/email", { email, password });
			expect(tooEarly.status).toBe(403);

			const link = sent
				.findLast((message) => message.to === email)
				?.text.match(/https?:\/\/\S+/)?.[0];
			expect(link, "a verification link should have been sent").toBeTruthy();
			const url = new URL(link as string);
			url.searchParams.delete("callbackURL");
			expect(
				(await app.request(`${url.pathname}${url.search}`, { headers: { origin: ORIGIN } })).status,
			).toBe(200);

			const signedIn = await post("/auth/sign-in/email", { email, password });
			expect(signedIn.status).toBe(200);
			expect(signedIn.headers.get("set-auth-token")).toBeTruthy();
		});
	},
);
