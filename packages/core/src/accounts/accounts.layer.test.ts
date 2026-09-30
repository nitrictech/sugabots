import { Cause, ConfigProvider, Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { noDatabase } from "../database/testing.ts";
import { Installation } from "../installation/installation.ts";
import { Accounts } from "./accounts.ts";

function accountsFor(env: Record<string, string>) {
	return Effect.runPromiseExit(
		Accounts.Service.pipe(
			Effect.provide(
				Accounts.layer.pipe(
					Layer.provide([noDatabase, Installation.layer]),
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

	it.each([
		{ name: "SIGNUP_MODE", value: "friends" },
		{ name: "REQUIRE_EMAIL_VERIFICATION", value: "maybe" },
	])("refuses to start when $name is $value", async ({ name, value }) => {
		const exit = await accountsFor({ [name]: value });

		expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toMatch(name);
	});

	it("refuses to start sign-up by referral without the secret its links are signed with", async () => {
		const exit = await accountsFor({ SIGNUP_MODE: "referral" });

		expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toMatch("BETTER_AUTH_SECRET");
	});
});
