import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface CredentialCipher {
	encrypt(value: string): string;
	decrypt(value: string): string;
}

export function aesCredentialCipher(encodedKey: string): CredentialCipher {
	const key = Buffer.from(encodedKey, "base64");
	if (key.length !== 32) {
		throw new Error("MODEL_PROVIDER_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
	}

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
