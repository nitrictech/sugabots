export * as ServerConfig from "./config.ts";

import { Email } from "@sugabots/core/email/email";
import { Installation } from "@sugabots/core/installation/installation";
import { Config, Context, Data, Effect, Layer, Option, Redacted } from "effect";

/** The settings the server itself still reads. Core services read their own. */
export interface Interface {
	readonly port: number;
	/** Signing key for sessions and tokens. */
	readonly secret: Redacted.Redacted;
	/**
	 * Whether anybody may create an account. Off unless the installation says
	 * otherwise: the first account is admitted regardless, and after that the
	 * only way in is an invitation.
	 */
	readonly allowOpenSignUp: boolean;
	/**
	 * Whether a new account must prove its address before it gets a session.
	 * Off unless the installation says otherwise, so a self-hoster is not made
	 * to stand up a mail service before they can sign in.
	 */
	readonly requireEmailVerification: boolean;
	/** The sender of emails a user's own action triggers, such as verification and invitations. */
	readonly transactionalSender: Email.Address;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/server/ServerConfig",
) {}

export const make = Effect.gen(function* () {
	return {
		port: yield* Config.Port("PORT").pipe(Config.withDefault(3000)),
		secret: yield* signingSecret,
		allowOpenSignUp: yield* Config.Boolean("ALLOW_OPEN_SIGNUP").pipe(Config.withDefault(false)),
		requireEmailVerification: yield* Config.Boolean("REQUIRE_EMAIL_VERIFICATION").pipe(
			Config.withDefault(false),
		),
		transactionalSender: yield* transactionalSender,
	} satisfies Interface;
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide(Installation.layer));

export class InvalidConfig extends Data.TaggedError("InvalidServerConfig")<{
	message: string;
}> {}

/** The path under the installation's `publicUrl` the API answers at, better-auth's routes included. */
export const API_BASE_PATH = "/api";

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
