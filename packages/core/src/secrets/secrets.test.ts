import { Cause, ConfigProvider, Effect, Exit, Layer, Logger } from "effect";
import { describe, expect, it } from "vitest";
import { Secrets } from "./secrets.ts";

const key = Buffer.alloc(32, 7).toString("base64");

async function withEnv<A, E>(
	effect: Effect.Effect<A, E, Secrets.Service>,
	env: Record<string, string>,
) {
	const warnings: string[] = [];
	const logger = Logger.make(({ logLevel, message }) => {
		if (logLevel === "Warn") warnings.push(String(message));
	});
	const dependencies = Layer.mergeAll(
		ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
		Logger.layer([logger]),
	);
	const exit = await Effect.runPromiseExit(
		effect.pipe(Effect.provide(Secrets.layer.pipe(Layer.provide(dependencies)))),
	);
	return { exit, warnings };
}

describe("Secrets.layer", () => {
	it("round trips without storing the plaintext", async () => {
		const { exit } = await withEnv(
			Effect.map(Secrets.Service, (cipher) => {
				const encrypted = cipher.encrypt("sk-secret");
				return { encrypted, decrypted: cipher.decrypt(encrypted) };
			}),
			{ SECRETS_ENCRYPTION_KEY: key },
		);

		expect(exit).toMatchObject({ _tag: "Success", value: { decrypted: "sk-secret" } });
		expect(Exit.isSuccess(exit) && exit.value.encrypted).not.toContain("sk-secret");
	});

	it("opens existing secrets with the old key and warns once", async () => {
		const encrypted = Secrets.fromKey(key).encrypt("sk-secret");
		const { exit, warnings } = await withEnv(
			Effect.map(Secrets.Service, (cipher) => cipher.decrypt(encrypted)),
			{ CREDENTIALS_ENCRYPTION_KEY: key },
		);

		expect(exit).toMatchObject({ _tag: "Success", value: "sk-secret" });
		expect(warnings).toEqual([
			expect.stringMatching(/CREDENTIALS_ENCRYPTION_KEY is deprecated.*SECRETS_ENCRYPTION_KEY/),
		]);
	});

	it("uses the new key without a warning when both keys are set", async () => {
		const encrypted = Secrets.fromKey(key).encrypt("sk-secret");
		const { exit, warnings } = await withEnv(
			Effect.map(Secrets.Service, (cipher) => cipher.decrypt(encrypted)),
			{
				SECRETS_ENCRYPTION_KEY: key,
				CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString("base64"),
			},
		);

		expect(exit).toMatchObject({ _tag: "Success", value: "sk-secret" });
		expect(warnings).toEqual([]);
	});

	it("opens a value sealed for a purpose only for that purpose", () => {
		const cipher = Secrets.fromKey(key);
		const forPages = cipher.encrypt("page", "pages");
		const stored = cipher.encrypt("sk-secret");

		expect(cipher.decrypt(forPages, "pages")).toBe("page");
		expect(() => cipher.decrypt(forPages)).toThrow();
		expect(() => cipher.decrypt(forPages, "other")).toThrow();
		expect(() => cipher.decrypt(stored, "pages")).toThrow();
		expect(() => cipher.encrypt("page", "")).toThrow();
	});

	it("refuses an encrypted secret with a short authentication tag", () => {
		const cipher = Secrets.fromKey(key);
		const fields = cipher.encrypt("test secret").split(".");
		const tag = Buffer.from(fields[2] ?? "", "base64url");
		expect(tag).toHaveLength(16);
		fields[2] = tag.subarray(0, 12).toString("base64url");
		expect(() => cipher.decrypt(fields.join("."))).toThrow();
	});

	it.each([
		["without either key", {}, /SECRETS_ENCRYPTION_KEY is required/],
		["with a key that is not 32 bytes", { SECRETS_ENCRYPTION_KEY: "not-a-key" }, /32-byte key/],
	])("refuses to start %s", async (_, env, message) => {
		const { exit } = await withEnv(Secrets.Service, env);

		expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toMatch(message);
	});
});
