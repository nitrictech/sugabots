import { isWorkspaceRole, WORKSPACE_ROLES, type WorkspaceRole } from "@sugabots/contracts";
import { query, type RunEffect, transaction } from "@sugabots/core/database/database";
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
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Effect } from "effect";
import { API_BASE_PATH, trustedOrigins, webUrl } from "../config.ts";
import type { Mailer } from "../email/mailer.ts";
import { admitSignUp } from "./sign-up.ts";

/**
 * better-auth owns identity: users, credentials, sessions, workspaces,
 * memberships and invitations. It mounts its own routes under `/api/auth`;
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

export interface AuthOptions {
	/**
	 * The database better-auth owns its tables in, as node-postgres drizzle:
	 * its adapter speaks nothing else.
	 *
	 * Passed rather than reached for, so the one service sitting under identity
	 * can be built without a live pool.
	 */
	db: NodePgDatabase;
	/** Runs the application's own writes, which its hooks make on the main pool. */
	run: RunEffect;
	/** Signing key for sessions and tokens. */
	secret: string;
	/** Where a browser reaches the API, without `API_BASE_PATH`. */
	baseUrl: string;
	/** Browser origins besides `baseUrl`'s allowed to sign in. The first is where invite links point. */
	webOrigins: string[];
	/** How verification and invitation emails go out. */
	mailer: Mailer;
	/** Whether anybody may create an account, or only the first person and invitees. */
	allowOpenSignUp: boolean;
	/** Whether a new account must prove its address before it gets a session. */
	requireEmailVerification: boolean;
}

export type Auth = ReturnType<typeof createAuth>;

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

export function createAuth({
	db,
	run,
	secret,
	baseUrl,
	webOrigins,
	mailer,
	allowOpenSignUp,
	requireEmailVerification,
}: AuthOptions) {
	const links = webUrl({ baseUrl, webOrigins });

	return betterAuth({
		appName: "Sugabots",
		secret,
		baseURL: baseUrl,
		basePath: `${API_BASE_PATH}/auth`,
		trustedOrigins: trustedOrigins({ baseUrl, webOrigins }),

		database: drizzleAdapter(db, { provider: "pg", schema }),

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
						await run(admitSignUp(allowOpenSignUp, creating.email));
					},
				},
			},
		},

		emailAndPassword: { enabled: true, requireEmailVerification },
		emailVerification: {
			sendOnSignUp: true,
			// A second attempt to sign in resends the link, so losing the first
			// email is not a dead end.
			sendOnSignIn: true,
			// The link proves the address, and the password was already given, so
			// it lands in the app rather than back at a login form.
			autoSignInAfterVerification: true,
			sendVerificationEmail: async ({ user, url }) => {
				await mailer({
					to: user.email,
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
				requireEmailVerificationOnInvitation: requireEmailVerification,
				organizationHooks: {
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
					// The web app's invite route.
					const link = `${links}/invite/${encodeURIComponent(id)}`;
					await mailer({
						to: email,
						subject: `${inviter.user.name} invited you to ${workspace.name} on Sugabots`,
						text: `${inviter.user.name} (${inviter.user.email}) invited you to join the ${workspace.name} workspace.\n\nAccept: ${link}`,
					});
				},
			}),
		],
	});
}
