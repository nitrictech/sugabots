import { uuidSchema } from "@sugabots/contracts/uuid";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { randomUuid } from "./random-uuid.ts";

describe("randomUuid", () => {
	it("makes ids the API accepts as a message id", () => {
		const ids = Array.from({ length: 100 }, randomUuid);

		expect(ids.every(Schema.is(uuidSchema))).toBe(true);
		expect(new Set(ids).size).toBe(ids.length);
	});
});
