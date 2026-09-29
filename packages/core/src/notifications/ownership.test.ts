import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { shippedSourceFiles } from "../shipped-source.test-support.ts";

/**
 * Each notification table has one owner: only its repository writes it. Tests
 * and their fixtures may write any table.
 */
const OWNERS: Record<string, string> = {
	notification: "core/src/notifications/repository.ts",
	notificationPreference: "core/src/notifications/preference-repository.ts",
	notificationDelivery: "core/src/notifications/delivery-repository.ts",
};

const write = new RegExp(`\\.(insert|update|delete)\\((${Object.keys(OWNERS).join("|")})\\)`, "g");

describe("notification table ownership", () => {
	it("leaves each table's writes to its owning repository", () => {
		const strayWrites = shippedSourceFiles().flatMap(({ path, absolute }) =>
			[...readFileSync(absolute, "utf8").matchAll(write)]
				.filter((found) => OWNERS[found[2] ?? ""] !== path)
				.map((found) => `${path}: ${found[0]}`),
		);

		expect(strayWrites).toEqual([]);
	});
});
