export * as Secrets from "./secrets.ts";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { type DomainError, userText } from "@sugabots/errors";
import { Config, Context, Effect, ErrorReporter, Layer, Option, Redacted, Schema } from "effect";
import { processLayer, Tier } from "../tiers.ts";

/**
 * Encrypts what Sugabots stores as secrets: credentials for model, search and
 * computer providers and connectors, GitHub app keys and tokens, webhook
 * secrets and file page links. A value encrypted for a `purpose` decrypts only
 * for that same purpose, and one encrypted without decrypts only without, so a
 * value encrypted for one use can never be passed off as another's. An empty
 * `purpose` is refused: the cipher can't tell it from none.
 */
export interface Interface {
	encrypt(value: string, purpose?: string): string;
	decrypt(value: string, purpose?: string): string;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Secrets") {
	declare readonly [Tier]: "process";
}

/** The AES-256-GCM cipher keyed by `SECRETS_ENCRYPTION_KEY`. */
export const make = Effect.gen(function* () {
	const encodedKey = yield* readEncryptionKey;
	const key = decodeKey(Redacted.value(encodedKey));
	if (!key) {
		return yield* new InvalidConfig({
			message: "SECRETS_ENCRYPTION_KEY must be a base64-encoded 32-byte key",
		});
	}
	return aes(key);
});

export const layer = processLayer(Layer.effect(Service, make));

class InvalidConfig
	extends Schema.TaggedError<InvalidConfig>()("InvalidSecretsKey", { message: Schema.String })
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Warn" as const;
	get userMessage() {
		return userText`Sugabots could not open its secret store. Ask whoever runs this server to check the encryption key.`;
	}
}

const readEncryptionKey = Effect.gen(function* () {
	const key = yield* Config.option(Config.Redacted("SECRETS_ENCRYPTION_KEY"));
	if (Option.isSome(key)) return key.value;

	const legacyKey = yield* Config.option(Config.Redacted("CREDENTIALS_ENCRYPTION_KEY"));
	if (Option.isNone(legacyKey)) {
		return yield* new InvalidConfig({
			message: "SECRETS_ENCRYPTION_KEY is required. Generate one with `openssl rand -base64 32`.",
		});
	}
	yield* Effect.logWarning(
		"CREDENTIALS_ENCRYPTION_KEY is deprecated. Rename it to SECRETS_ENCRYPTION_KEY and keep the same value.",
	);
	return legacyKey.value;
});

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

const GCM_TAG_BYTES = 16;

function aes(key: Buffer): Interface {
	return {
		encrypt(value, purpose) {
			const nonce = randomBytes(12);
			const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: GCM_TAG_BYTES });
			if (purpose !== undefined) cipher.setAAD(purposeBytes(purpose));
			const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
			return [
				"v1",
				nonce.toString("base64url"),
				cipher.getAuthTag().toString("base64url"),
				ciphertext.toString("base64url"),
			].join(".");
		},
		decrypt(value, purpose) {
			const [version, nonce, tag, ciphertext] = value.split(".");
			if (version !== "v1" || !nonce || !tag || !ciphertext)
				throw new Error("Unsupported encrypted secret");
			const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64url"), {
				authTagLength: GCM_TAG_BYTES,
			});
			decipher.setAuthTag(Buffer.from(tag, "base64url"));
			if (purpose !== undefined) decipher.setAAD(purposeBytes(purpose));
			return Buffer.concat([
				decipher.update(Buffer.from(ciphertext, "base64url")),
				decipher.final(),
			]).toString("utf8");
		},
	};
}

function purposeBytes(purpose: string) {
	if (purpose === "") throw new Error("A secret's purpose must not be empty");
	return Buffer.from(purpose, "utf8");
}
