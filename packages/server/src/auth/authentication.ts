export * as Authentication from "./authentication.ts";

import {
	isWorkspaceRole,
	type SessionUser,
	WORKSPACE_ROLES,
	type WorkspaceRole,
} from "@sugabots/contracts";
import {
	type Database,
	layer as databaseLayer,
	effectRunner,
	query,
	transaction,
} from "@sugabots/core/database/database";
import { isUuid } from "@sugabots/core/database/ids";
import { Email } from "@sugabots/core/email/email";
import { Installation } from "@sugabots/core/installation/installation";
import { provisionDefaultSearchProvider } from "@sugabots/core/providers/search-providers/store";
import { ensureSystemAgents } from "@sugabots/core/workspaces/agents/system-agents";
import { provisionPersonalPod } from "@sugabots/core/workspaces/pods/store";
import * as schema from "@sugabots/core/workspaces/sql";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { bearer } from "better-auth/plugins/bearer";
import { organization } from "better-auth/plugins/organization";
import { defaultAc, defaultRoles } from "better-auth/plugins/organization/access";
import { drizzle } from "drizzle-orm/node-postgres";
import { Config, Context, Data, Effect, Layer, Option, Redacted } from "effect";
import { Pool } from "pg";
import { API_BASE_PATH } from "../config.ts";
import { admitSignUp } from "./sign-up.ts";

/**
 * How the HTTP API proves who is calling: better-auth's users, credentials and
 * sessions. Deciding what the caller may do is core's `Authorization`.
 *
 * better-auth also still owns workspaces, memberships and invitations, through
 * its organization plugin and the hooks below. Those are core domain, needed by
 * every entry point, and are here only until they move there. It mounts its own routes under `/api/auth`;
 * everything else in the API goes through `requireSession`, which asks it who
 * the cookie or bearer token belongs to.
 *
 * Two choices are worth knowing about.
 *
 * - **Cookies and bearer tokens.** Browsers use Better Auth's HttpOnly cookie.
 *   The `bearer` plugin also makes every session token usable as
 *   `Authorization: Bearer …` for Electron, React Native and scripts.
 * - **The organisation plugin is our workspace.** It already models a tenant,
 *   its members and its invitations, with roles and an accept flow. We keep the
 *   behaviour and rename the tables, because the rest of the schema hangs off
 *   `workspace_id`. The renaming is the `schema` block below; its endpoints are
 *   still `/api/auth/organization/*`, and `packages/sdk` gives them our
 *   names.
 *
 * Roles need watching. better-auth stores a role as text and reads it as a
 * comma-separated list, so `admin,member` and a role from some future release
 * are both things its endpoints will accept and write. The application
 * recognises the roles in `WORKSPACE_ROLES` and grants nothing for anything
 * else, which would leave somebody a member of a workspace who can do nothing
 * in it and no screen to explain why. `requireSupportedRole` below refuses the
 * write instead, on every path that sets one — including a direct request to
 * `/api/auth/organization/*`, since the hooks run inside those endpoints.
 */
export interface Interface {
	/** Answers a request to better-auth's own routes under `/api/auth`. */
	readonly handler: (request: Request) => Effect.Effect<Response>;
	/** Who holds the cookie or bearer token in `headers`, or `undefined` when nobody does. */
	readonly identify: (headers: Headers) => Effect.Effect<SessionUser | undefined>;
	/**
	 * Creates a verified account whatever the installation's sign-up policy, for
	 * bootstrapping an installation such as the development seed does.
	 */
	readonly createAccount: (account: {
		name: string;
		email: string;
		password: string;
	}) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/server/Authentication",
) {}

/**
 * better-auth over its own node-postgres pool at `DATABASE_URL`: its drizzle
 * adapter speaks nothing else. Its hooks write through the main database, and
 * its emails go through `Email`.
 */
export const make = Effect.gen(function* () {
	const installation = yield* Installation.Service;
	const email = yield* Email.Service;
	const database = yield* Effect.context<Database>();
	const secret = yield* signingSecret;
	const sender = yield* transactionalSender;
	const policy = {
		allowOpenSignUp: yield* Config.Boolean("ALLOW_OPEN_SIGNUP").pipe(Config.withDefault(false)),
		requireEmailVerification: yield* Config.Boolean("REQUIRE_EMAIL_VERIFICATION").pipe(
			Config.withDefault(false),
		),
	};
	const pool = yield* Effect.acquireRelease(
		Effect.map(
			Config.Redacted("DATABASE_URL"),
			(url) => new Pool({ connectionString: Redacted.value(url) }),
		),
		(pool) => Effect.promise(() => pool.end()),
	);
	const run = effectRunner({ runPromiseExit: Effect.runPromiseExitWith(database) });
	const send = (message: Email.Message) => Effect.runPromiseWith(database)(email.send(message));

	const instance = (policy: SignUpPolicy) => {
		return betterAuth({
			appName: "Sugabots",
			secret: Redacted.value(secret),
			baseURL: installation.publicUrl,
			basePath: `${API_BASE_PATH}/auth`,
			trustedOrigins: [...installation.trustedOrigins],

			database: drizzleAdapter(drizzle({ client: pool }), { provider: "pg", schema }),

			advanced: {
				database: {
					// Postgres column defaults fill every `id` with a UUIDv7, so
					// better-auth leaves the column alone — except for an invitation,
					// whose id is the invite link and therefore a secret. A UUIDv7
					// leads with a timestamp and would be partly guessable; v4 is 122
					// random bits. `false` means "let the database do it".
					// `model` is better-auth's own name for the table, not ours.
					generateId: ({ model }) => (model === "invitation" ? crypto.randomUUID() : false),
				},
			},

			databaseHooks: {
				user: {
					create: {
						// By address, not by session: an invitee has no account yet.
						before: async (creating) => {
							await run(admitSignUp(policy.allowOpenSignUp, creating.email));
						},
					},
				},
			},

			emailAndPassword: {
				enabled: true,
				requireEmailVerification: policy.requireEmailVerification,
			},
			emailVerification: {
				sendOnSignUp: true,
				// A second attempt to sign in resends the link, so losing the first
				// email is not a dead end.
				sendOnSignIn: true,
				// The link proves the address, and the password was already given, so
				// it lands in the app rather than back at a login form.
				autoSignInAfterVerification: true,
				sendVerificationEmail: async ({ user, url }) => {
					await send({
						from: sender,
						to: [{ email: user.email, name: user.name }],
						subject: "Verify your email for Sugabots",
						text: `Verify your email address to finish setting up Sugabots.\n\nVerify: ${url}`,
					});
				},
			},

			plugins: [
				bearer(),
				organization({
					// The person who creates a workspace administers it. `admin` is also
					// what better-auth calls the creator role, which is what makes it
					// protect the last one: the only admin can be neither removed nor
					// demoted. better-auth's own `owner` is never assigned.
					creatorRole: "admin",
					roles: WORKSPACE_ROLE_DEFINITIONS,
					disableOrganizationDeletion: true,

					// better-auth demands a proved address here by default whenever
					// the app supplies its own `generateId`, having no way to see
					// whether the ids it produces are guessable. Ours are random v4
					// UUIDs, so the link is the secret it was meant to be, which leaves
					// the installation's own policy to decide. An installation that does
					// not require verification may have no mailer to prove an address
					// with, and demanding it anyway would make every invitation a dead
					// end.
					requireEmailVerificationOnInvitation: policy.requireEmailVerification,
					organizationHooks: {
						beforeCreateOrganization: async ({ organization }) => {
							requireSlugUnlikeUuid(organization.slug);
						},
						beforeUpdateOrganization: async ({ organization }) => {
							requireSlugUnlikeUuid(organization.slug);
						},
						afterCreateOrganization: async ({ organization, user }) => {
							await run(
								transaction(
									query((db) =>
										Effect.gen(function* () {
											// All orgs start with websearch enabled using Exa's free tier
											yield* provisionDefaultSearchProvider(db, organization.id, user.id);
											// The Scribe and the Facilitator belong to the workspace, so this
											// is where they arrive, with no model until an admin chooses one.
											yield* ensureSystemAgents(db, {
												workspaceId: organization.id,
												createdById: user.id,
											});
										}),
									),
								),
							);
						},
						beforeCreateInvitation: async ({ invitation }) => {
							requireSupportedRole(invitation.role);
						},
						beforeAcceptInvitation: async ({ invitation }) => {
							// An invitation sent before this rule existed could name a role
							// that grants nothing. Refusing here is what keeps somebody from
							// joining into an account that cannot do anything.
							requireSupportedRole(invitation.role);
						},
						beforeAddMember: async ({ member }) => {
							requireSupportedRole(member.role);
						},
						beforeUpdateMemberRole: async ({ newRole }) => {
							requireSupportedRole(newRole);
						},
						afterAddMember: async ({ member }) => {
							await run(
								transaction(
									query((db) => provisionPersonalPod(db, member.organizationId, member.userId)),
								),
							);
						},
						afterAcceptInvitation: async ({ member }) => {
							await run(
								transaction(
									query((db) => provisionPersonalPod(db, member.organizationId, member.userId)),
								),
							);
						},
					},

					schema: {
						organization: { modelName: "workspace" },
						member: { modelName: "workspaceMember", fields: { organizationId: "workspaceId" } },
						invitation: {
							modelName: "workspaceInvite",
							fields: { organizationId: "workspaceId" },
						},
						session: { fields: { activeOrganizationId: "activeOrganizationId" } },
					},

					sendInvitationEmail: async ({ id, email, organization: workspace, inviter }) => {
						// The web app's invite route. It also redirects the older
						// `/?invite=<id>` shape, so links already sent keep working.
						const link = `${installation.webAppUrl}/invite/${encodeURIComponent(id)}`;
						await send({
							from: sender,
							to: [{ email }],
							replyTo: { email: inviter.user.email, name: inviter.user.name },
							subject: `${inviter.user.name} invited you to ${workspace.name} on Sugabots`,
							text: `${inviter.user.name} (${inviter.user.email}) invited you to join the ${workspace.name} workspace.\n\nAccept: ${link}`,
						});
					},
				}),
			],
		});
	};
	const auth = instance(policy);
	const bootstrap = instance({ allowOpenSignUp: true, requireEmailVerification: false });

	return Service.of({
		handler: (request) => Effect.promise(() => auth.handler(request)),
		identify: (headers) =>
			Effect.map(
				Effect.promise(() => auth.api.getSession({ headers })),
				(result) =>
					result
						? {
								id: result.user.id,
								email: result.user.email,
								name: result.user.name,
								image: result.user.image ?? null,
							}
						: undefined,
			),
		createAccount: (account) =>
			Effect.asVoid(Effect.promise(() => bootstrap.api.signUpEmail({ body: account }))),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([databaseLayer, Installation.layer, Email.layer]),
);

export class InvalidConfig extends Data.TaggedError("InvalidAuthConfig")<{
	message: string;
}> {}

/** Who may create an account, and whether they must prove their address first. */
interface SignUpPolicy {
	allowOpenSignUp: boolean;
	requireEmailVerification: boolean;
}

const MIN_PRODUCTION_SECRET_LENGTH = 32;
const PRODUCTION_SECRET_PLACEHOLDERS = new Set([
	"development-secret-not-for-production",
	"change-me",
	"changeme",
	"your-secret",
	"your-secret-key",
]);
const DEVELOPMENT_TRANSACTIONAL_SENDER = { email: "sugabots@localhost", name: "Sugabots" };

/** `BETTER_AUTH_SECRET`, which production refuses when it is short or a placeholder. */
const signingSecret = Effect.gen(function* () {
	const installation = yield* Installation.Service;
	const secret = yield* Config.option(Config.Redacted("BETTER_AUTH_SECRET"));
	if (Option.isNone(secret)) {
		return yield* new InvalidConfig({
			message: "BETTER_AUTH_SECRET is required. Generate one with `openssl rand -base64 32`.",
		});
	}
	const value = Redacted.value(secret.value).trim();
	if (
		installation.isProduction &&
		(value.length < MIN_PRODUCTION_SECRET_LENGTH ||
			PRODUCTION_SECRET_PLACEHOLDERS.has(value.toLowerCase()))
	) {
		return yield* new InvalidConfig({
			message:
				"BETTER_AUTH_SECRET must be at least 32 characters and must not be a placeholder in production",
		});
	}
	return secret.value;
});

/** `EMAIL_TRANSACTIONAL_FROM`, which production requires. */
const transactionalSender = Effect.gen(function* () {
	const installation = yield* Installation.Service;
	const value = yield* Config.option(Config.String("EMAIL_TRANSACTIONAL_FROM"));
	if (Option.isNone(value)) {
		// A provider sends only from addresses it has verified, so production must name one.
		if (installation.isProduction) {
			return yield* new InvalidConfig({
				message: "EMAIL_TRANSACTIONAL_FROM is required in production.",
			});
		}
		return DEVELOPMENT_TRANSACTIONAL_SENDER;
	}
	const address = Email.parseAddress(value.value);
	if (!address) {
		return yield* new InvalidConfig({
			message:
				"EMAIL_TRANSACTIONAL_FROM must be an address, like `Sugabots <no-reply@example.com>`.",
		});
	}
	return address;
});

/**
 * The roles better-auth is told about: its own two, plus `viewer` with no
 * statements at all.
 *
 * Registering `viewer` rather than leaving better-auth to meet a string it has
 * never seen makes the denial deliberate — it may invite nobody, remove nobody
 * and change nobody's role — instead of falling out of a lookup that happens to
 * miss. `admin` and `member` keep better-auth's own definitions, so a statement
 * added in a later release still reaches them.
 *
 * `satisfies Record<WorkspaceRole, unknown>` is what ties this to
 * `WORKSPACE_ROLES`: a role added there stops this file compiling until it is
 * registered here, rather than reaching better-auth as a string it refuses in
 * its own way. `packages/sdk/src/auth.ts` makes the same bargain for the
 * client, which cannot share this one — neither package depends on the other.
 */
const WORKSPACE_ROLE_DEFINITIONS = {
	admin: defaultRoles.admin,
	member: defaultRoles.member,
	viewer: defaultAc.newRole({}),
} satisfies Record<WorkspaceRole, unknown>;

/**
 * Refuses a role this product does not implement, including a compound one
 * such as `admin,member` that better-auth would otherwise store.
 */
function requireSupportedRole(role: string | undefined): void {
	if (isWorkspaceRole(role)) return;
	throw new APIError("BAD_REQUEST", {
		code: "UNSUPPORTED_WORKSPACE_ROLE",
		message: `A workspace role must be one of: ${WORKSPACE_ROLES.join(", ")}`,
	});
}

/**
 * Refuses a workspace slug shaped like a UUID. The API reads a UUID-shaped
 * workspace reference as an id, so a workspace with such a slug could never be
 * reached by it.
 */
function requireSlugUnlikeUuid(slug: string | undefined): void {
	if (slug === undefined || !isUuid(slug)) return;
	throw new APIError("BAD_REQUEST", {
		code: "WORKSPACE_SLUG_SHAPED_LIKE_UUID",
		message: "A workspace slug cannot be shaped like a UUID",
	});
}
