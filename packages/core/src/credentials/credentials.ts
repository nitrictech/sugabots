export * as Credentials from "./credentials.ts";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Config, Context, Data, Effect, Layer, Option, Redacted } from "effect";

/** Seals stored credentials: provider API keys, connection secrets and OAuth tokens. */
export interface Interface {
	encrypt(value: string): string;
	decrypt(value: string): string;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Credentials") {}

/** The AES-256-GCM cipher keyed by `CREDENTIALS_ENCRYPTION_KEY`. */
export const make = Effect.gen(function* () {
	const encodedKey = yield* Config.option(Config.Redacted("CREDENTIALS_ENCRYPTION_KEY"));
	if (Option.isNone(encodedKey)) {
		return yield* new InvalidConfig({
			message:
				"CREDENTIALS_ENCRYPTION_KEY is required. Generate one with `openssl rand -base64 32`.",
		});
	}
	const key = decodeKey(Redacted.value(encodedKey.value));
	if (!key) {
		return yield* new InvalidConfig({
			message: "CREDENTIALS_ENCRYPTION_KEY must be a base64-encoded 32-byte key",
		});
	}
	return aes(key);
});

export const layer = Layer.effect(Service, make);

export class InvalidConfig extends Data.TaggedError("InvalidCredentialsConfig")<{
	message: string;
}> {}

/** The cipher for `encodedKey`, a base64-encoded 32-byte key. Throws for any other key. */
export function fromKey(encodedKey: string): Interface {
	const key = decodeKey(encodedKey);
	if (!key) throw new Error("A credential key must be a base64-encoded 32-byte key");
	return aes(key);
}

function decodeKey(encodedKey: string) {
	const key = Buffer.from(encodedKey, "base64");
	return key.length === 32 ? key : undefined;
}

function aes(key: Buffer): Interface {
	return {
		encrypt(value) {
			const nonce = randomBytes(12);
			const cipher = createCipheriv("aes-256-gcm", key, nonce);
			const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
			return [
				"v1",
				nonce.toString("base64url"),
				cipher.getAuthTag().toString("base64url"),
				ciphertext.toString("base64url"),
			].join(".");
		},
		decrypt(value) {
			const [version, nonce, tag, ciphertext] = value.split(".");
			if (version !== "v1" || !nonce || !tag || !ciphertext)
				throw new Error("Unsupported encrypted provider credential");
			const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64url"));
			decipher.setAuthTag(Buffer.from(tag, "base64url"));
			return Buffer.concat([
				decipher.update(Buffer.from(ciphertext, "base64url")),
				decipher.final(),
			]).toString("utf8");
		},
	};
}
