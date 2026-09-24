import { describe, expect, it } from "vitest";
import { configFromEnv, parseOrigins, trustedOrigins, webAppUrl } from "./config.ts";

describe("configFromEnv", () => {
	const encryptionKey = Buffer.alloc(32).toString("base64");
	/** Present in every case: what is under test here is everything else. */
	const DATABASE_URL = "postgresql://localhost:5432/test";

	it("refuses to start without a signing key", () => {
		expect(() => configFromEnv({ DATABASE_URL })).toThrow(/BETTER_AUTH_SECRET/);
	});

	it("requires a separate key for provider credentials", () => {
		expect(() => configFromEnv({ DATABASE_URL, BETTER_AUTH_SECRET: "s" })).toThrow(
			/MODEL_PROVIDER_ENCRYPTION_KEY/,
		);
	});

	it("points the base url at its own port when none is given", () => {
		expect(
			configFromEnv({
				DATABASE_URL,
				BETTER_AUTH_SECRET: "s",
				MODEL_PROVIDER_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
				PORT: "8080",
			}).baseUrl,
		).toBe("http://localhost:8080");
	});

	it.each(["0", "65536", "3000.5", "not-a-port"])('rejects invalid PORT "%s"', (port) => {
		expect(() =>
			configFromEnv({
				DATABASE_URL,
				BETTER_AUTH_SECRET: "s",
				MODEL_PROVIDER_ENCRYPTION_KEY: encryptionKey,
				PORT: port,
			}),
		).toThrow(/PORT must be an integer between 1 and 65535/);
	});

	it("retains short signing secrets outside production", () => {
		expect(
			configFromEnv({
				DATABASE_URL,
				BETTER_AUTH_SECRET: "s",
				MODEL_PROVIDER_ENCRYPTION_KEY: encryptionKey,
				NODE_ENV: "test",
			}).secret,
		).toBe("s");
	});

	it.each(["short", "development-secret-not-for-production"])(
		"rejects an unsafe production signing secret",
		(secret) => {
			expect(() =>
				configFromEnv({
					DATABASE_URL,
					BETTER_AUTH_SECRET: secret,
					MODEL_PROVIDER_ENCRYPTION_KEY: encryptionKey,
					NODE_ENV: "production",
				}),
			).toThrow(/BETTER_AUTH_SECRET/);
		},
	);

	it("accepts a generated-length production signing secret", () => {
		expect(
			configFromEnv({
				DATABASE_URL,
				BETTER_AUTH_SECRET: "x".repeat(32),
				MODEL_PROVIDER_ENCRYPTION_KEY: encryptionKey,
				NODE_ENV: "production",
				EMAIL_WEBHOOK_URL: "https://mailer.example.com/sugabots",
			}).secret,
		).toHaveLength(32);
	});

	it("uses console email only for development", () => {
		const config = configFromEnv({
			DATABASE_URL,
			BETTER_AUTH_SECRET: "s",
			MODEL_PROVIDER_ENCRYPTION_KEY: encryptionKey,
		});

		expect(config.environment).toBe("development");
		expect(config.email).toEqual({ provider: "console" });
		// The model server is usually this machine in development.
		expect(config.allowPrivateModelProviderNetwork).toBe(true);
	});

	it("keeps model providers off the private network in production unless told otherwise", () => {
		const productionEnv = {
			NODE_ENV: "production",
			DATABASE_URL,
			BETTER_AUTH_SECRET: "x".repeat(32),
			MODEL_PROVIDER_ENCRYPTION_KEY: encryptionKey,
			EMAIL_WEBHOOK_URL: "https://mailer.example/send",
		};
		expect(configFromEnv(productionEnv).allowPrivateModelProviderNetwork).toBe(false);
		expect(
			configFromEnv({ ...productionEnv, ALLOW_PRIVATE_MODEL_PROVIDER_NETWORK: "true" })
				.allowPrivateModelProviderNetwork,
		).toBe(true);
	});

	it("requires an explicit boolean to allow private model provider networking", () => {
		const base = {
			DATABASE_URL,
			BETTER_AUTH_SECRET: "s",
			MODEL_PROVIDER_ENCRYPTION_KEY: encryptionKey,
		};
		expect(
			configFromEnv({ ...base, ALLOW_PRIVATE_MODEL_PROVIDER_NETWORK: "false" })
				.allowPrivateModelProviderNetwork,
		).toBe(false);
		expect(() => configFromEnv({ ...base, ALLOW_PRIVATE_MODEL_PROVIDER_NETWORK: "yes" })).toThrow(
			/must be true or false/,
		);
	});

	it("keeps the web_fetch tool off private networks unless told otherwise", () => {
		const base = {
			DATABASE_URL,
			BETTER_AUTH_SECRET: "s",
			MODEL_PROVIDER_ENCRYPTION_KEY: encryptionKey,
		};
		expect(configFromEnv(base).allowPrivateWebFetchNetwork).toBe(false);
		expect(
			configFromEnv({ ...base, ALLOW_PRIVATE_WEB_FETCH_NETWORK: "true" })
				.allowPrivateWebFetchNetwork,
		).toBe(true);
		expect(() => configFromEnv({ ...base, ALLOW_PRIVATE_WEB_FETCH_NETWORK: "on" })).toThrow(
			/must be true or false/,
		);
	});

	it("refuses to use console email in production", () => {
		const productionEnv = {
			DATABASE_URL,
			BETTER_AUTH_SECRET: "x".repeat(32),
			MODEL_PROVIDER_ENCRYPTION_KEY: encryptionKey,
			NODE_ENV: "production",
		};

		expect(() => configFromEnv(productionEnv)).toThrow(/other than the console/);
	});

	it("leaves email verification off unless the installation asks for it", () => {
		const config = configFromEnv({
			DATABASE_URL,
			BETTER_AUTH_SECRET: "s",
			MODEL_PROVIDER_ENCRYPTION_KEY: encryptionKey,
		});

		expect(config.requireEmailVerification).toBe(false);
	});

	it("refuses to require email verification with nowhere to send the link", () => {
		expect(() =>
			configFromEnv({
				DATABASE_URL,
				BETTER_AUTH_SECRET: "s",
				MODEL_PROVIDER_ENCRYPTION_KEY: encryptionKey,
				REQUIRE_EMAIL_VERIFICATION: "true",
			}),
		).toThrow(/REQUIRE_EMAIL_VERIFICATION needs an email provider/);
	});

	it("requires email verification when an email provider can deliver the link", () => {
		const config = configFromEnv({
			DATABASE_URL,
			BETTER_AUTH_SECRET: "s",
			MODEL_PROVIDER_ENCRYPTION_KEY: encryptionKey,
			REQUIRE_EMAIL_VERIFICATION: "true",
			EMAIL_WEBHOOK_URL: "https://mailer.example.com/hook",
		});

		expect(config.requireEmailVerification).toBe(true);
	});

	it("configures an HTTPS email webhook in production", () => {
		const config = configFromEnv({
			DATABASE_URL,
			BETTER_AUTH_SECRET: "x".repeat(32),
			MODEL_PROVIDER_ENCRYPTION_KEY: encryptionKey,
			NODE_ENV: "production",
			EMAIL_WEBHOOK_URL: "https://mailer.example.com/sugabots",
			EMAIL_WEBHOOK_TOKEN: "secret",
		});

		expect(config.email).toEqual({
			provider: "webhook",
			url: "https://mailer.example.com/sugabots",
			token: "secret",
		});
	});

	it("rejects an insecure production email webhook", () => {
		expect(() =>
			configFromEnv({
				DATABASE_URL,
				BETTER_AUTH_SECRET: "x".repeat(32),
				MODEL_PROVIDER_ENCRYPTION_KEY: encryptionKey,
				NODE_ENV: "production",
				EMAIL_WEBHOOK_URL: "http://mailer.example.com/sugabots",
			}),
		).toThrow(/must use HTTPS/);
	});
});

describe("parseOrigins", () => {
	it("splits a comma-separated list and trims it", () => {
		expect(parseOrigins("http://a.test, http://b.test")).toEqual([
			"http://a.test",
			"http://b.test",
		]);
	});

	it("is empty when unset or blank", () => {
		expect(parseOrigins(undefined)).toEqual([]);
		expect(parseOrigins("  , ")).toEqual([]);
	});
});

describe("origins", () => {
	const installation = { baseUrl: "https://sugabots.example.com/", webOrigins: [] };
	const split = { baseUrl: "https://api.example.com", webOrigins: ["https://app.example.com"] };

	it("always trusts the API's own origin, then any web origins", () => {
		expect(trustedOrigins(installation)).toEqual(["https://sugabots.example.com"]);
		expect(trustedOrigins(split)).toEqual(["https://api.example.com", "https://app.example.com"]);
	});

	it("points links at the first web origin, else at the API's own address", () => {
		expect(webAppUrl(installation)).toBe("https://sugabots.example.com");
		expect(webAppUrl(split)).toBe("https://app.example.com");
	});
});
