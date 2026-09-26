import { Accounts } from "@sugabots/core/accounts/accounts";
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
						Layer.succeed(
							Accounts.Service,
							Accounts.Service.of({ admit: () => Effect.void, requireEmailVerification: false }),
						),
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
});
