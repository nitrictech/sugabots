import { Cause, ConfigProvider, Effect, Exit, Layer, Redacted } from "effect";
import { describe, expect, it } from "vitest";
import { ServerConfig } from "./config.ts";

/** Present in every case that expects to start: what is under test here is everything else. */
const SECRET = { BETTER_AUTH_SECRET: "s" };
const PRODUCTION = {
	NODE_ENV: "production",
	BETTER_AUTH_SECRET: "x".repeat(32),
	EMAIL_TRANSACTIONAL_FROM: "sugabots@example.com",
};

function configFor(env: Record<string, string>) {
	return Effect.runPromiseExit(
		ServerConfig.Service.pipe(
			Effect.provide(
				ServerConfig.layer.pipe(
					Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
				),
			),
		),
	);
}

async function started(env: Record<string, string>) {
	const exit = await configFor(env);
	if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause));
	return exit.value;
}

async function refusal(env: Record<string, string>) {
	const exit = await configFor(env);
	return Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "started";
}

describe("ServerConfig.layer", () => {
	it("refuses to start without a signing key", async () => {
		expect(await refusal({})).toMatch(/BETTER_AUTH_SECRET is required/);
	});

	it("refuses an unknown NODE_ENV", async () => {
		expect(await refusal({ ...SECRET, NODE_ENV: "prod" })).toMatch(/NODE_ENV/);
	});

	it.each(["0", "65536", "3000.5", "not-a-port"])('refuses PORT "%s"', async (port) => {
		expect(await refusal({ ...SECRET, PORT: port })).toMatch(/PORT/);
	});

	it("retains short signing secrets outside production", async () => {
		const config = await started({ ...SECRET, NODE_ENV: "test" });

		expect(Redacted.value(config.secret)).toBe("s");
	});

	it.each(["short", "development-secret-not-for-production"])(
		"refuses an unsafe production signing secret",
		async (secret) => {
			expect(await refusal({ ...PRODUCTION, BETTER_AUTH_SECRET: secret })).toMatch(
				/BETTER_AUTH_SECRET must be at least 32 characters/,
			);
		},
	);

	it("accepts a generated-length production signing secret", async () => {
		const config = await started(PRODUCTION);

		expect(Redacted.value(config.secret)).toHaveLength(32);
	});

	it("sends transactional email from a local sender in development", async () => {
		const config = await started(SECRET);

		expect(config.transactionalSender).toEqual({
			email: "sugabots@localhost",
			name: "Sugabots",
		});
	});

	it("requires a transactional sender in production", async () => {
		const { EMAIL_TRANSACTIONAL_FROM: _, ...withoutSender } = PRODUCTION;

		expect(await refusal(withoutSender)).toMatch(
			/EMAIL_TRANSACTIONAL_FROM is required in production/,
		);
	});

	it("reads a named transactional sender", async () => {
		const config = await started({
			...SECRET,
			EMAIL_TRANSACTIONAL_FROM: "Sugabots <no-reply@example.com>",
		});

		expect(config.transactionalSender).toEqual({
			email: "no-reply@example.com",
			name: "Sugabots",
		});
	});

	it("refuses a transactional sender that is not an address", async () => {
		expect(await refusal({ ...SECRET, EMAIL_TRANSACTIONAL_FROM: "Sugabots" })).toMatch(
			/EMAIL_TRANSACTIONAL_FROM must be an address/,
		);
	});

	it("leaves open sign-up and email verification off unless the installation asks for them", async () => {
		expect(await started(SECRET)).toMatchObject({
			allowOpenSignUp: false,
			requireEmailVerification: false,
		});
		expect(
			await started({ ...SECRET, ALLOW_OPEN_SIGNUP: "true", REQUIRE_EMAIL_VERIFICATION: "true" }),
		).toMatchObject({ allowOpenSignUp: true, requireEmailVerification: true });
	});

	it.each(["ALLOW_OPEN_SIGNUP", "REQUIRE_EMAIL_VERIFICATION"])(
		"refuses to start when %s is not a boolean",
		async (name) => {
			expect(await refusal({ ...SECRET, [name]: "maybe" })).toMatch(name);
		},
	);
});
