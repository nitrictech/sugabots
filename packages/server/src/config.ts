/**
 * Everything the process reads from the environment, read once, in one place.
 * Nothing below this file touches `process.env`; the app and the auth
 * configuration take what they need as arguments, which is what makes them
 * testable.
 */

import type { EmailAddress } from "@sugabots/core/email/email";
import type { EmailConfig } from "@sugabots/core/email/layer";

export type Environment = "development" | "production";

export interface Config {
	environment: Environment;
	port: number;
	/** Where Postgres is. The only place this is read. */
	databaseUrl: string;
	/** Where a browser reaches the API, without `API_BASE_PATH`. Links in emails start here. */
	baseUrl: string;
	/** Browser origins besides `baseUrl`'s that may call the API with a cookie. The first is where invite links point. */
	webOrigins: string[];
	/** Signing key for sessions and tokens. */
	secret: string;
	/** Dedicated AES-256 key for provider credentials. */
	modelProviderEncryptionKey: string;
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
	/** The provider that sends verification and invitation emails. */
	email: EmailConfig;
	/** The sender of those emails. */
	emailFrom: EmailAddress;
}

const MIN_PRODUCTION_SECRET_LENGTH = 32;
const DEVELOPMENT_EMAIL_FROM = "sugabots@localhost";
const PRODUCTION_SECRET_PLACEHOLDERS = new Set([
	"development-secret-not-for-production",
	"change-me",
	"changeme",
	"your-secret",
	"your-secret-key",
]);

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
	const port = Number(env.PORT ?? 3000);
	const environment = env.NODE_ENV === "production" ? "production" : "development";
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error("PORT must be an integer between 1 and 65535");
	}

	const secret = env.BETTER_AUTH_SECRET;
	if (!secret) {
		throw new Error("BETTER_AUTH_SECRET is required. Generate one with `openssl rand -base64 32`.");
	}
	if (
		env.NODE_ENV === "production" &&
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
	const modelProviderEncryptionKey = env.MODEL_PROVIDER_ENCRYPTION_KEY;
	if (!modelProviderEncryptionKey) {
		throw new Error(
			"MODEL_PROVIDER_ENCRYPTION_KEY is required. Generate one with `openssl rand -base64 32`.",
		);
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
	const email = emailFromEnv(env, environment);
	if (environment === "production" && email.provider === "console") {
		throw new Error("Production requires an email provider other than the console.");
	}
	if (requireEmailVerification && email.provider === "console") {
		throw new Error(
			"REQUIRE_EMAIL_VERIFICATION needs an email provider. Set EMAIL_WEBHOOK_URL, or turn it off.",
		);
	}
	// The console sends nothing, so it has no sender for a provider to verify.
	if (email.provider !== "console" && !env.EMAIL_FROM) {
		throw new Error("EMAIL_FROM is required with an email provider.");
	}

	return {
		environment,
		port,
		databaseUrl,
		baseUrl: env.BETTER_AUTH_URL ?? `http://localhost:${port}`,
		webOrigins: parseOrigins(env.WEB_ORIGIN),
		secret,
		modelProviderEncryptionKey,
		allowPrivateModelProviderNetwork,
		allowPrivateWebFetchNetwork,
		allowOpenSignUp,
		requireEmailVerification,
		email,
		emailFrom: { email: env.EMAIL_FROM ?? DEVELOPMENT_EMAIL_FROM, name: "Sugabots" },
	};
}

function booleanFromEnv(value: string, name: string): boolean {
	if (value === "false") return false;
	if (value === "true") return true;
	throw new Error(`${name} must be true or false`);
}

function emailFromEnv(env: NodeJS.ProcessEnv, environment: Environment): EmailConfig {
	const url = env.EMAIL_WEBHOOK_URL;
	if (!url) return { provider: "console" };
	const parsed = new URL(url);
	if (environment === "production" && parsed.protocol !== "https:") {
		throw new Error("EMAIL_WEBHOOK_URL must use HTTPS in production");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("EMAIL_WEBHOOK_URL must use HTTP or HTTPS");
	}
	return { provider: "webhook", url: parsed.href, token: env.EMAIL_WEBHOOK_TOKEN };
}

/** The path under `baseUrl` the API answers at, better-auth's routes included. */
export const API_BASE_PATH = "/api";

export function parseOrigins(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((origin) => origin.trim())
		.filter(Boolean);
}

/** The origins allowed to send the API a cookie: `baseUrl`'s own plus `webOrigins`. */
export function trustedOrigins({ baseUrl, webOrigins }: Pick<Config, "baseUrl" | "webOrigins">) {
	return [new URL(baseUrl).origin, ...webOrigins];
}

/**
 * Where the web app is served, for links that must open in it rather than at
 * the API: invitation emails and the return from a connection sign-in. It is
 * the first of `webOrigins`, else `baseUrl`, because an installation that
 * names no web origin serves the web app from the API's own address. No
 * trailing slash.
 */
export function webAppUrl({ baseUrl, webOrigins }: Pick<Config, "baseUrl" | "webOrigins">) {
	return (webOrigins[0] ?? baseUrl).replace(/\/$/, "");
}
