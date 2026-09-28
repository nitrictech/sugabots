export * as Authentication from "./authentication.ts";

import type { SessionUser } from "@sugabots/contracts";
import { Accounts } from "@sugabots/core/accounts/accounts";
import {
	type Database,
	layer as databaseLayer,
	effectRunner,
} from "@sugabots/core/database/database";
import { Email } from "@sugabots/core/email/email";
import { Installation } from "@sugabots/core/installation/installation";
import { account, session, user, verification } from "@sugabots/core/workspaces/sql";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { bearer } from "better-auth/plugins/bearer";
import { drizzle } from "drizzle-orm/node-postgres";
import { Config, Context, Data, Effect, Layer, Option, Redacted } from "effect";
import { Pool } from "pg";
import { API_BASE_PATH } from "../http/api.ts";

/**
 * How the HTTP API proves who is calling: better-auth's users, credentials,
 * sessions and email verification, under its own routes at `/api/auth`.
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
	readonly identify: (headers: Headers) => Effect.Effect<SessionUser | undefined>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/server/Authentication",
) {}

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
			(url) => new Pool({ connectionString: Redacted.value(url) }),
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

		// Postgres column defaults fill every `id` with a UUIDv7, so better-auth
		// leaves the column alone.
		advanced: { database: { generateId: false } },

		databaseHooks: {
			user: {
				create: {
					before: async (creating) => {
						await run(
							Effect.mapError(
								accounts.admit(creating.email),
								(closed) =>
									new APIError("FORBIDDEN", {
										code: "SIGN_UP_CLOSED",
										message: closed.userMessage,
									}),
							),
						);
					},
				},
			},
		},

		emailAndPassword: {
			enabled: true,
			requireEmailVerification: accounts.requireEmailVerification,
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

		plugins: [bearer()],
	});

	return Service.of({
		handler: (request) =>
			Effect.promise(() => auth.handler(request)).pipe(Effect.withSpan("Authentication.handler")),
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
			).pipe(Effect.withSpan("Authentication.identify")),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([databaseLayer, Installation.layer, Email.layer, Accounts.layer]),
);

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
