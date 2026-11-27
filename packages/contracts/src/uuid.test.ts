import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { uuidOrStringSchema, uuidSchema } from "./uuid.ts";

const lowercase = "0199a3a0-0000-7000-8000-abcdef123456";
const uppercase = lowercase.toUpperCase();

describe("UUID contracts", () => {
	it("decodes both spellings to the same lowercase UUID", () => {
		const decode = Schema.decodeUnknownSync(uuidSchema);
		expect(decode(uppercase)).toBe(lowercase);
		expect(decode(lowercase)).toBe(lowercase);
		expect(() => decode("not-an-id")).toThrow();
	});

	it("canonicalizes UUID references while preserving other strings", () => {
		const decode = Schema.decodeUnknownSync(uuidOrStringSchema);
		expect(decode(uppercase)).toBe(lowercase);
		expect(decode("Workspace-Slug")).toBe("Workspace-Slug");
	});
});
