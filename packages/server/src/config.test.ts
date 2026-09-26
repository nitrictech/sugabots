import { describe, expect, it } from "vitest";
import { configFromEnv } from "./config.ts";

describe("configFromEnv", () => {
	/** Present in every case: what is under test here is everything else. */
	const DATABASE_URL = "postgresql://localhost:5432/test";

	it("refuses to start without a signing key", () => {
		expect(() => configFromEnv({ DATABASE_URL })).toThrow(/BETTER_AUTH_SECRET/);
	});

	it("refuses an unknown NODE_ENV", () => {
		expect(() =>
			configFromEnv({ DATABASE_URL, BETTER_AUTH_SECRET: "s", NODE_ENV: "prod" }),
		).toThrow(/NODE_ENV must be development, production or test/);
	});

	it.each(["0", "65536", "3000.5", "not-a-port"])('rejects invalid PORT "%s"', (port) => {
		expect(() =>
			configFromEnv({
				DATABASE_URL,
				BETTER_AUTH_SECRET: "s",
				PORT: port,
			}),
		).toThrow(/PORT must be an integer between 1 and 65535/);
	});

	it("retains short signing secrets outside production", () => {
		expect(
			configFromEnv({
				DATABASE_URL,
				BETTER_AUTH_SECRET: "s",
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
				NODE_ENV: "production",
				EMAIL_TRANSACTIONAL_FROM: "sugabots@example.com",
			}).secret,
		).toHaveLength(32);
	});

	it("sends transactional email from a local sender in development", () => {
		const config = configFromEnv({
			DATABASE_URL,
			BETTER_AUTH_SECRET: "s",
		});

		expect(config.transactionalEmailFrom).toEqual({
			email: "sugabots@localhost",
			name: "Sugabots",
		});
	});

	it("requires a transactional sender in production", () => {
		expect(() =>
			configFromEnv({
				DATABASE_URL,
				BETTER_AUTH_SECRET: "x".repeat(32),
				NODE_ENV: "production",
			}),
		).toThrow(/EMAIL_TRANSACTIONAL_FROM is required in production/);
	});

	it("reads a named transactional sender", () => {
		const config = configFromEnv({
			DATABASE_URL,
			BETTER_AUTH_SECRET: "s",
			EMAIL_TRANSACTIONAL_FROM: "Sugabots <no-reply@example.com>",
		});

		expect(config.transactionalEmailFrom).toEqual({
			email: "no-reply@example.com",
			name: "Sugabots",
		});
	});

	it("rejects a transactional sender that is not an address", () => {
		expect(() =>
			configFromEnv({
				DATABASE_URL,
				BETTER_AUTH_SECRET: "s",
				EMAIL_TRANSACTIONAL_FROM: "Sugabots",
			}),
		).toThrow(/EMAIL_TRANSACTIONAL_FROM must be an address/);
	});

	it("leaves email verification off unless the installation asks for it", () => {
		const config = configFromEnv({
			DATABASE_URL,
			BETTER_AUTH_SECRET: "s",
		});

		expect(config.requireEmailVerification).toBe(false);
	});

	it("requires email verification when the installation asks for it", () => {
		const config = configFromEnv({
			DATABASE_URL,
			BETTER_AUTH_SECRET: "s",
			REQUIRE_EMAIL_VERIFICATION: "true",
		});

		expect(config.requireEmailVerification).toBe(true);
	});
});
