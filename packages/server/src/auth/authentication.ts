export * as Authentication from "./authentication.ts";

import { type SessionUser, USER_NAME_MAX_LENGTH, userNameSchema } from "@sugabots/contracts";
import { API_BASE_PATH } from "@sugabots/contracts/http";
import { Accounts } from "@sugabots/core/accounts/accounts";
import { type Database, effectRunner } from "@sugabots/core/database/database";
import { Email } from "@sugabots/core/email/email";
import { Installation } from "@sugabots/core/installation/installation";
import { account, session, user, verification } from "@sugabots/core/workspaces/sql";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { bearer } from "better-auth/plugins/bearer";
import { drizzle } from "drizzle-orm/node-postgres";
import { Config, Context, Data, Effect, Layer, Option, Redacted, Schema } from "effect";
import { Cookies } from "effect/unstable/http";
import { Pool } from "pg";

/**
 * How the HTTP API proves who is calling: better-auth's users, credentials,
 * sessions, email verification and password resets, under its own routes at
 * `/api/auth`.
 * Everything else in the API asks `identify` who holds the request's cookie or
 * bearer token. What the caller may then do is core's to decide.
 *
 * Browsers use better-auth's HttpOnly cookie. The `bearer` plugin also makes
 * every session token usable as `Authorization: Bearer …`, for Electron, React
 * Native and scripts.
 */
export interface Interface {
	/** Answers a request to better-auth's own routes under `/api/auth`. */
	readonly handler: (request: Request) => Effect.Effect<Response>;
	/** Who holds the cookie or bearer token in `headers`, or `undefined` when nobody does. */
	readonly identify: (headers: Headers) => Effect.Effect<Identified | undefined>;
}

/** The holder of a request's credentials. */
export interface Identified {
	readonly user: SessionUser;
	/**
	 * Cookies better-auth set while checking the credentials, such as a renewed
	 * session cache. They belong on the response, or the browser never gets them.
	 */
	readonly refreshedCookies: Cookies.Cookies;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/server/Authentication",
) {}

/**
 * The most connections better-auth's pool opens. Each is one fewer of the
 * database's `max_connections` for the main pool, and the session cookie cache
 * keeps most requests off it.
 */
const AUTH_POOL_SIZE = 2;

/**
 * How long a browser's session is taken from its signed cookie before the
 * database is asked again. Signing out elsewhere or a revoked session takes
 * this long to reach requests that carry the cookie.
 */
const SESSION_COOKIE_CACHE_SECONDS = 5 * 60;

/** Sign-up attempts one address may make per window, which an office sharing an address still fits in. */
const SIGN_UP_ATTEMPTS_PER_WINDOW = 10;

const SIGN_UP_WINDOW_SECONDS = 60 * 60;

/** How long a password reset link works. The email promises an hour. */
const RESET_PASSWORD_LINK_SECONDS = 60 * 60;

/** better-auth's drizzle adapter speaks only node-postgres, so it gets a pool of its own. */
export const make = Effect.gen(function* () {
	const installation = yield* Installation.Service;
	const email = yield* Email.Service;
	const database = yield* Effect.context<Database>();
	const secret = yield* signingSecret;
	const accounts = yield* Accounts.Service;
	const sender = yield* Email.transactionalSender;
	const pool = yield* Effect.acquireRelease(
		Effect.map(
			Config.Redacted("DATABASE_URL"),
			(url) => new Pool({ connectionString: Redacted.value(url), max: AUTH_POOL_SIZE }),
		),
		(pool) => Effect.promise(() => pool.end()),
	);
	const run = effectRunner({ runPromiseExit: Effect.runPromiseExitWith(database) });
	const send = (message: Email.Message) => Effect.runPromiseWith(database)(email.send(message));

	const auth = betterAuth({
		appName: "Sugabots",
		secret: Redacted.value(secret),
		baseURL: installation.publicUrl,
		basePath: `${API_BASE_PATH}/auth`,
		trustedOrigins: [...installation.trustedOrigins],

		database: drizzleAdapter(drizzle({ client: pool }), {
			provider: "pg",
			schema: { user, session, account, verification },
		}),

		// Postgres mints the id of every row better-auth inserts, as it does
		// every other table's, so better-auth leaves the column alone.
		advanced: { database: { generateId: false } },

		user: {
			additionalFields: {
				// Set from the referral link the account signed up with, never by the caller.
				referredBy: { type: "string", required: false, input: false },
			},
		},

		// better-auth stores whatever name it is sent, at sign-up and after.
		databaseHooks: {
			user: {
				create: {
					before: async (creating, context) => {
						const name = validUserName(creating.name);
						const { referredBy } = await run(
							Effect.mapError(
								accounts.admit({
									email: creating.email,
									referralCode: referralCodeIn(context?.body),
								}),
								(refused) =>
									new APIError("FORBIDDEN", {
										code: refusalCodes[refused._tag],
										message: refused.userMessage,
									}),
							),
						);
						return { data: { ...creating, name, referredBy } };
					},
				},
				update: {
					before: async (updating) => {
						if (updating.name === undefined) return;
						return { data: { ...updating, name: validUserName(updating.name) } };
					},
				},
			},
		},

		emailAndPassword: {
			enabled: true,
			requireEmailVerification: accounts.requireEmailVerification,
			// Whoever knew the old password may still be signed in somewhere.
			revokeSessionsOnPasswordReset: true,
			resetPasswordTokenExpiresIn: RESET_PASSWORD_LINK_SECONDS,
			sendResetPassword: async ({ user, url }) => {
				await send({
					from: sender,
					to: [{ email: user.email, name: user.name }],
					subject: "Reset your Sugabots password",
					text: `Somebody asked to reset the password for ${user.email} on Sugabots. If it was you, choose a new one within the hour. If not, ignore this email and your password stays as it is.\n\nReset: ${url}`,
				});
			},
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

		session: {
			cookieCache: { enabled: true, maxAge: SESSION_COOKIE_CACHE_SECONDS },
		},

		// better-auth limits requests only in production, and keeps count in memory.
		// Its default for signing up is a few a second, which suits a mistyped
		// password but would let a script try codes all day.
		rateLimit: {
			customRules: {
				"/sign-up/email": { window: SIGN_UP_WINDOW_SECONDS, max: SIGN_UP_ATTEMPTS_PER_WINDOW },
			},
		},

		plugins: [bearer()],
	});

	return Service.of({
		handler: (request) =>
			Effect.promise(() => auth.handler(request)).pipe(Effect.withSpan("Authentication.handler")),
		identify: (headers) =>
			Effect.map(
				Effect.promise(() => auth.api.getSession({ headers, returnHeaders: true })),
				({ headers: responseHeaders, response }): Identified | undefined =>
					response
						? {
								user: {
									id: response.user.id,
									email: response.user.email,
									name: response.user.name,
									image: response.user.image ?? null,
								},
								refreshedCookies: Cookies.fromSetCookie(responseHeaders.getSetCookie()),
							}
						: undefined,
			).pipe(Effect.withSpan("Authentication.identify")),
	});
});

export const layer = Layer.effect(Service, make);

/** The codes a refused sign-up answers with, which clients tell apart. */
const refusalCodes = {
	SignUpClosed: "SIGN_UP_CLOSED",
	ReferralLinkInvalid: "REFERRAL_LINK_INVALID",
} as const;

/** `name` trimmed, or a refusal the caller is shown when it is blank or too long. */
function validUserName(name: unknown): string {
	return Option.getOrThrowWith(
		Schema.decodeUnknownOption(userNameSchema)(name),
		() =>
			new APIError("BAD_REQUEST", {
				code: "INVALID_NAME",
				message: `Your name needs 1 to ${USER_NAME_MAX_LENGTH} characters.`,
			}),
	);
}

/** `referralCode` from a sign-up's body, which better-auth passes on without looking at it. */
function referralCodeIn(body: unknown): string | undefined {
	if (typeof body !== "object" || body === null || !("referralCode" in body)) return undefined;
	return typeof body.referralCode === "string" ? body.referralCode : undefined;
}

export class InvalidConfig extends Data.TaggedError("InvalidAuthConfig")<{
	message: string;
}> {}

const MIN_PRODUCTION_SECRET_LENGTH = 32;
const PRODUCTION_SECRET_PLACEHOLDERS = new Set([
	"development-secret-not-for-production",
	"change-me",
	"changeme",
	"your-secret",
	"your-secret-key",
]);

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
