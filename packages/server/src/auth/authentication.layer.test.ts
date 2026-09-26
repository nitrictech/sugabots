import { noDatabase } from "@sugabots/core/database/testing";
import { Email } from "@sugabots/core/email/email";
import { Installation } from "@sugabots/core/installation/installation";
import { Cause, ConfigProvider, Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { Authentication } from "./authentication.ts";

/** Present in every case that expects to start: what is under test here is everything else. */
const REQUIRED = {
	DATABASE_URL: "postgres://localhost/never-connected",
	BETTER_AUTH_SECRET: "s",
};
const PRODUCTION = {
	...REQUIRED,
	NODE_ENV: "production",
	BETTER_AUTH_SECRET: "x".repeat(32),
	EMAIL_TRANSACTIONAL_FROM: "sugabots@example.com",
};

/** Whether `Authentication` starts under `env`, and if not, why. */
async function startup(env: Record<string, string>) {
	const exit = await Effect.runPromiseExit(
		Effect.scoped(
			Layer.build(
				Authentication.layerNoDeps.pipe(
					Layer.provide([
						noDatabase,
						Installation.layer,
						Layer.succeed(Email.Service, Email.Service.of({ send: () => Effect.void })),
					]),
					Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
				),
			),
		),
	);
	return Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "started";
}

describe("Authentication.layer", () => {
	it("refuses to start without a signing key", async () => {
		const { BETTER_AUTH_SECRET: _, ...withoutSecret } = REQUIRED;

		expect(await startup(withoutSecret)).toMatch(/BETTER_AUTH_SECRET is required/);
	});

	it("accepts a short signing secret outside production", async () => {
		expect(await startup({ ...REQUIRED, NODE_ENV: "test" })).toBe("started");
	});

	it.each(["short", "development-secret-not-for-production"])(
		"refuses an unsafe production signing secret",
		async (secret) => {
			expect(await startup({ ...PRODUCTION, BETTER_AUTH_SECRET: secret })).toMatch(
				/BETTER_AUTH_SECRET must be at least 32 characters/,
			);
		},
	);

	it("accepts a generated-length production signing secret", async () => {
		expect(await startup(PRODUCTION)).toBe("started");
	});

	it("requires a transactional sender in production", async () => {
		const { EMAIL_TRANSACTIONAL_FROM: _, ...withoutSender } = PRODUCTION;

		expect(await startup(withoutSender)).toMatch(
			/EMAIL_TRANSACTIONAL_FROM is required in production/,
		);
	});

	it("accepts a named transactional sender", async () => {
		expect(
			await startup({ ...REQUIRED, EMAIL_TRANSACTIONAL_FROM: "Sugabots <no-reply@example.com>" }),
		).toBe("started");
	});

	it("refuses a transactional sender that is not an address", async () => {
		expect(await startup({ ...REQUIRED, EMAIL_TRANSACTIONAL_FROM: "Sugabots" })).toMatch(
			/EMAIL_TRANSACTIONAL_FROM must be an address/,
		);
	});

	it.each(["ALLOW_OPEN_SIGNUP", "REQUIRE_EMAIL_VERIFICATION"])(
		"refuses to start when %s is not a boolean",
		async (name) => {
			expect(await startup({ ...REQUIRED, [name]: "maybe" })).toMatch(name);
		},
	);
});
