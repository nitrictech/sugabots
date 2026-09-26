/**
 * The server's settings, read from the environment once. The app and the auth
 * configuration take what they need as arguments, which is what makes them
 * testable. Core services read their own settings through Effect's `Config`.
 */

import { Email } from "@sugabots/core/email/email";
import { Installation } from "@sugabots/core/installation/installation";

export interface Config {
	port: number;
	/** Where Postgres is. The only place this is read. */
	databaseUrl: string;
	/** Signing key for sessions and tokens. */
	secret: string;
	/**
	 * Whether model providers may connect over plain HTTP or to private network
	 * addresses. On by default in development, where the model server is usually
	 * the same machine; off by default in production, where the installation
	 * may serve tenants who must not reach its network. The installation sets
	 * it, never a workspace.
	 */
	allowPrivateModelProviderNetwork: boolean;
	/**
	 * Whether the `web_fetch` tool may read pages at private network addresses.
	 * Off unless the installation says otherwise, in development too: a model
	 * server on this machine is the usual case, an agent reading this machine's
	 * other services is not.
	 */
	allowPrivateWebFetchNetwork: boolean;
	/**
	 * Whether anybody may create an account. Off unless the installation says
	 * otherwise: the first account is admitted regardless, and after that the
	 * only way in is an invitation.
	 */
	allowOpenSignUp: boolean;
	/**
	 * Whether a new account must prove its address before it gets a session.
	 * Off unless the installation says otherwise, so a self-hoster is not made
	 * to stand up a mail service before they can sign in. Requires a real
	 * email provider: there is nowhere for the link to go otherwise.
	 */
	requireEmailVerification: boolean;
	/** The sender of emails a user's own action triggers, such as verification and invitations. */
	transactionalEmailFrom: Email.Address;
}

const MIN_PRODUCTION_SECRET_LENGTH = 32;
const DEVELOPMENT_TRANSACTIONAL_EMAIL_FROM = { email: "sugabots@localhost", name: "Sugabots" };
const PRODUCTION_SECRET_PLACEHOLDERS = new Set([
	"development-secret-not-for-production",
	"change-me",
	"changeme",
	"your-secret",
	"your-secret-key",
]);

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
	const port = Number(env.PORT ?? 3000);
	const environment = Installation.environmentFrom(env.NODE_ENV ?? "development");
	if (!environment) {
		throw new Error(`NODE_ENV must be development, production or test, not "${env.NODE_ENV}"`);
	}
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error("PORT must be an integer between 1 and 65535");
	}

	const secret = env.BETTER_AUTH_SECRET;
	if (!secret) {
		throw new Error("BETTER_AUTH_SECRET is required. Generate one with `openssl rand -base64 32`.");
	}
	if (
		environment === "production" &&
		(secret.trim().length < MIN_PRODUCTION_SECRET_LENGTH ||
			PRODUCTION_SECRET_PLACEHOLDERS.has(secret.trim().toLowerCase()))
	) {
		throw new Error(
			"BETTER_AUTH_SECRET must be at least 32 characters and must not be a placeholder in production",
		);
	}
	const databaseUrl = env.DATABASE_URL;
	if (!databaseUrl) {
		throw new Error("DATABASE_URL is required. Copy .env.example to .env.");
	}
	const allowPrivateModelProviderNetwork =
		env.ALLOW_PRIVATE_MODEL_PROVIDER_NETWORK === undefined
			? environment === "development"
			: booleanFromEnv(
					env.ALLOW_PRIVATE_MODEL_PROVIDER_NETWORK,
					"ALLOW_PRIVATE_MODEL_PROVIDER_NETWORK",
				);
	const allowPrivateWebFetchNetwork =
		env.ALLOW_PRIVATE_WEB_FETCH_NETWORK === undefined
			? false
			: booleanFromEnv(env.ALLOW_PRIVATE_WEB_FETCH_NETWORK, "ALLOW_PRIVATE_WEB_FETCH_NETWORK");
	const allowOpenSignUp =
		env.ALLOW_OPEN_SIGNUP === undefined
			? false
			: booleanFromEnv(env.ALLOW_OPEN_SIGNUP, "ALLOW_OPEN_SIGNUP");
	const requireEmailVerification =
		env.REQUIRE_EMAIL_VERIFICATION === undefined
			? false
			: booleanFromEnv(env.REQUIRE_EMAIL_VERIFICATION, "REQUIRE_EMAIL_VERIFICATION");
	const transactionalEmailFrom = transactionalEmailFromEnv(env, environment);

	return {
		port,
		databaseUrl,
		secret,
		allowPrivateModelProviderNetwork,
		allowPrivateWebFetchNetwork,
		allowOpenSignUp,
		requireEmailVerification,
		transactionalEmailFrom,
	};
}

function booleanFromEnv(value: string, name: string): boolean {
	if (value === "false") return false;
	if (value === "true") return true;
	throw new Error(`${name} must be true or false`);
}

function transactionalEmailFromEnv(
	env: NodeJS.ProcessEnv,
	environment: Installation.Environment,
): Email.Address {
	const value = env.EMAIL_TRANSACTIONAL_FROM;
	if (!value) {
		// A provider sends only from addresses it has verified, so production must name one.
		if (environment === "production")
			throw new Error("EMAIL_TRANSACTIONAL_FROM is required in production.");
		return DEVELOPMENT_TRANSACTIONAL_EMAIL_FROM;
	}
	const address = Email.parseAddress(value);
	if (!address) {
		throw new Error(
			"EMAIL_TRANSACTIONAL_FROM must be an address, like `Sugabots <no-reply@example.com>`.",
		);
	}
	return address;
}

/** The path under the installation's `publicUrl` the API answers at, better-auth's routes included. */
export const API_BASE_PATH = "/api";
