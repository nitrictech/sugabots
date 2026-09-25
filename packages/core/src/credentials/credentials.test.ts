import { Cause, ConfigProvider, Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { Credentials } from "./credentials.ts";

const key = Buffer.alloc(32, 7).toString("base64");

function withEnv<A, E>(
	effect: Effect.Effect<A, E, Credentials.Service>,
	env: Record<string, string>,
) {
	return Effect.runPromiseExit(
		effect.pipe(
			Effect.provide(
				Credentials.layer.pipe(
					Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
				),
			),
		),
	);
}

describe("Credentials.layer", () => {
	it("round trips without storing the plaintext", async () => {
		const exit = await withEnv(
			Effect.map(Credentials.Service, (cipher) => {
				const encrypted = cipher.encrypt("sk-secret");
				return { encrypted, decrypted: cipher.decrypt(encrypted) };
			}),
			{ MODEL_PROVIDER_ENCRYPTION_KEY: key },
		);

		expect(exit).toMatchObject({ _tag: "Success", value: { decrypted: "sk-secret" } });
		expect(Exit.isSuccess(exit) && exit.value.encrypted).not.toContain("sk-secret");
	});

	it.each([
		["without a key", {}, /is required/],
		[
			"with a key that is not 32 bytes",
			{ MODEL_PROVIDER_ENCRYPTION_KEY: "not-a-key" },
			/32-byte key/,
		],
	])("refuses to start %s", async (_, env, message) => {
		const exit = await withEnv(Credentials.Service, env);

		expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toMatch(message);
	});
});
