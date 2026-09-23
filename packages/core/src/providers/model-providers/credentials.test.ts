import { describe, expect, it } from "vitest";
import { aesCredentialCipher } from "./credentials.ts";

describe("provider credential encryption", () => {
	it("round trips without storing the plaintext", () => {
		const cipher = aesCredentialCipher(Buffer.alloc(32, 7).toString("base64"));
		const encrypted = cipher.encrypt("sk-secret");

		expect(encrypted).not.toContain("sk-secret");
		expect(cipher.decrypt(encrypted)).toBe("sk-secret");
	});

	it("requires an independent 256-bit key", () => {
		expect(() => aesCredentialCipher("not-a-key")).toThrow(/32-byte key/);
	});
});
