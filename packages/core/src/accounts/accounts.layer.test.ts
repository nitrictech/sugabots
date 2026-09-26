import { Cause, ConfigProvider, Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { noDatabase } from "../database/testing.ts";
import { Accounts } from "./accounts.ts";

function accountsFor(env: Record<string, string>) {
	return Effect.runPromiseExit(
		Accounts.Service.pipe(
			Effect.provide(
				Accounts.layerNoDeps.pipe(
					Layer.provide(noDatabase),
					Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
				),
			),
		),
	);
}

describe("Accounts.layer", () => {
	it("leaves email verification off unless the installation asks for it", async () => {
		const off = await accountsFor({});
		const on = await accountsFor({ REQUIRE_EMAIL_VERIFICATION: "true" });

		expect(Exit.isSuccess(off) && off.value.requireEmailVerification).toBe(false);
		expect(Exit.isSuccess(on) && on.value.requireEmailVerification).toBe(true);
	});

	it.each(["ALLOW_OPEN_SIGNUP", "REQUIRE_EMAIL_VERIFICATION"])(
		"refuses to start when %s is not a boolean",
		async (name) => {
			const exit = await accountsFor({ [name]: "maybe" });

			expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toMatch(name);
		},
	);
});
