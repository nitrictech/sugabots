export * as Authentication from "./authentication.ts";

import {
	type CurrentUser,
	httpUrlSchema,
	MEMBER_NAME_MAX_LENGTH,
	memberNameSchema,
} from "@sugabots/contracts";
import { API_BASE_PATH } from "@sugabots/contracts/http";
import { Accounts } from "@sugabots/core/accounts/accounts";
import { type Database, effectRunner } from "@sugabots/core/database/database";
import type { EventOutbox } from "@sugabots/core/database/events/outbox";
import { Email } from "@sugabots/core/email/email";
import { ServerSettings } from "@sugabots/core/server-settings/server-settings";
import { processLayer, Tier } from "@sugabots/core/tiers";
import { account, member, session, verification } from "@sugabots/core/workspaces/sql";
import { type DomainError, userText } from "@sugabots/errors";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { drizzle } from "drizzle-orm/node-postgres";
import { Config, Context, Effect, ErrorReporter, Layer, Option, Redacted, Schema } from "effect";
import { Cookies } from "effect/unstable/http";
import { Pool } from "pg";

/**
 * How the HTTP API proves who is calling: better-auth's accounts (the members
 * it calls users, kept in `member`), credentials, sessions, email verification and password resets, under its own routes at
 * `/api/auth`.
 * Everything else in the API asks `identify` whose session the request's
 * HttpOnly cookie holds. What the caller may then do is core's to decide.
 */
export interface Interface {
	/** Answers a request to better-auth's own routes under `/api/auth`. */
	readonly handler: (request: Request) => Effect.Effect<Response>;
	/** Whose session the cookie in `headers` holds, or `undefined` when nobody's does. */
	readonly identify: (headers: Headers) => Effect.Effect<Identified | undefined>;
	/**
	 * The cookies that renew the session cache of the cookie in `headers` from
	 * the database, for a response to a change of who the member is, such as
	 * their name, which the cache would otherwise show as it was for minutes.
	 * None for a request with no session cookie.
	 */
	readonly refreshedCookies: (headers: Headers) => Effect.Effect<Cookies.Cookies>;
	/**
	 * The member `memberId` as the API names them, for a request whose session
	 * came as a bearer token, with no cookie to read them from; `undefined` when
	 * there is no such member.
	 */
	readonly member: (memberId: string) => Effect.Effect<CurrentUser | undefined>;
}

/** The holder of a request's credentials. */
interface Identified {
	readonly member: CurrentUser;
	/** The session's id. */
	readonly session: string;
	/**
	 * Cookies better-auth set while checking the credentials, such as a renewed
	 * session cache. They belong on the response, or the browser never gets them.
	 */
	readonly refreshedCookies: Cookies.Cookies;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/server/Authentication",
) {
	declare readonly [Tier]: "process";
}

/** Bounds the connections better-auth uses alongside the main pool. */
const AUTH_POOL_SIZE = 2;
const SESSION_COOKIE_CACHE_SECONDS = 5 * 60;

/** Sign-up attempts one address may make per window, which an office sharing an address still fits in. */
const SIGN_UP_ATTEMPTS_PER_WINDOW = 10;

const SIGN_UP_WINDOW_SECONDS = 60 * 60;

/** How long a password reset link works. The email promises an hour. */
const RESET_PASSWORD_LINK_SECONDS = 60 * 60;

/** better-auth's drizzle adapter speaks only node-postgres, so it gets a pool of its own. */
export const make = Effect.gen(function* () {
	const serverSettings = yield* ServerSettings.Service;
	const email = yield* Email.Service;
	const database = yield* Effect.context<Database | EventOutbox.Service>();
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
		baseURL: serverSettings.publicUrl,
		basePath: `${API_BASE_PATH}/auth`,
		trustedOrigins: [...serverSettings.trustedOrigins],

		database: drizzleAdapter(drizzle({ client: pool }), {
			provider: "pg",
			schema: { member, session, account, verification },
		}),

		// Postgres mints the id of every row better-auth inserts, as it does
		// every other table's, so better-auth leaves the column alone.
		advanced: { database: { generateId: false } },

		// better-auth calls a member a user; ours are kept in `member`, and
		// sessions and accounts name theirs by `memberId`.
		user: {
			modelName: "member",
			additionalFields: {
				// Set from the referral link the account signed up with, never by the caller.
				referredBy: { type: "string", required: false, input: false },
			},
		},

		// A member's name, which others see, changes through an operation that tells them.
		disabledPaths: ["/update-user"],

		// better-auth stores whatever name it is sent, at sign-up and after.
		databaseHooks: {
			user: {
				create: {
					before: async (creating, context) => {
						const name = validMemberName(creating.name);
						const image = validMemberImage(creating.image);
						const { referredBy } = await run(
							Effect.mapError(
								accounts.admit({
									email: creating.email,
									referralCode: referralCodeIn(context?.body),
								}),
								(refused) => new APIError("FORBIDDEN", { message: refused.userMessage }),
							),
						);
						return { data: { ...creating, name, image, referredBy } };
					},
				},
				update: {
					before: async (updating) => {
						return {
							data: {
								...updating,
								...(updating.name !== undefined && { name: validMemberName(updating.name) }),
								...(updating.image !== undefined && { image: validMemberImage(updating.image) }),
							},
						};
					},
				},
			},
		},

		account: { fields: { userId: "memberId" } },

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
			// it lands in the app rather than back at the sign-in form.
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
			fields: { userId: "memberId" },
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
								member: currentUserOf(response.user),
								session: response.session.id,
								refreshedCookies: Cookies.fromSetCookie(responseHeaders.getSetCookie()),
							}
						: undefined,
			).pipe(Effect.withSpan("Authentication.identify")),
		refreshedCookies: (headers) =>
			Effect.map(
				Effect.promise(() =>
					auth.api.getSession({
						headers,
						query: { disableCookieCache: true },
						returnHeaders: true,
					}),
				),
				({ headers: responseHeaders }) => Cookies.fromSetCookie(responseHeaders.getSetCookie()),
			).pipe(Effect.withSpan("Authentication.refreshedCookies")),
		member: (memberId) =>
			Effect.promise(async () => {
				const context = await auth.$context;
				const found = await context.internalAdapter.findUserById(memberId);
				return found ? currentUserOf(found) : undefined;
			}).pipe(Effect.withSpan("Authentication.member")),
	});
});

export const layer = processLayer(Layer.effect(Service, make));

/** better-auth's user, which it keeps in `member`, as the API names a member. */
function currentUserOf(user: {
	readonly id: string;
	readonly email: string;
	readonly name: string;
	readonly image?: string | null | undefined;
}): CurrentUser {
	return { id: user.id, email: user.email, name: user.name, image: user.image ?? null };
}

/** `name` trimmed, or a refusal the caller is shown when it is blank or too long. */
function validMemberName(name: unknown): string {
	return Option.getOrThrowWith(
		Schema.decodeUnknownOption(memberNameSchema)(name),
		() =>
			new APIError("BAD_REQUEST", {
				message: `Your name needs 1 to ${MEMBER_NAME_MAX_LENGTH} characters.`,
			}),
	);
}

/** `image` as an HTTP address, or a refusal the caller is shown. Null, or none, is no picture. */
function validMemberImage(image: unknown): string | null | undefined {
	if (image === null || image === undefined) return image;
	return Option.getOrThrowWith(
		Schema.decodeUnknownOption(httpUrlSchema)(image),
		() => new APIError("BAD_REQUEST", { message: "Your picture needs to be an HTTP address." }),
	);
}

/** What better-auth passes on from a sign-up's body without looking at it. */
const signUpExtrasSchema = Schema.Struct({
	referralCode: Schema.String,
});

/** `referralCode` from a sign-up's body. */
function referralCodeIn(body: unknown): string | undefined {
	return Option.getOrUndefined(
		Option.map(
			Schema.decodeUnknownOption(signUpExtrasSchema)(body),
			(extras) => extras.referralCode,
		),
	);
}

class InvalidConfig
	extends Schema.TaggedError<InvalidConfig>()("InvalidAuthConfig", { message: Schema.String })
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Warn" as const;
	get userMessage() {
		return userText`Sign-in is unavailable. Ask whoever runs Sugabots to check its sign-in settings.`;
	}
}

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
	const serverSettings = yield* ServerSettings.Service;
	const secret = yield* Config.option(Config.Redacted("BETTER_AUTH_SECRET"));
	if (Option.isNone(secret)) {
		return yield* new InvalidConfig({
			message: "BETTER_AUTH_SECRET is required. Generate one with `openssl rand -base64 32`.",
		});
	}
	const value = Redacted.value(secret.value).trim();
	if (
		serverSettings.isProduction &&
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
