import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { sandboxHostSchema } from "./sandbox-providers.ts";

describe("sandbox hosts", () => {
	const accepts = (host: string) => Result.isSuccess(Schema.decodeResult(sandboxHostSchema)(host));

	it("takes domain names and leading wildcards", () => {
		expect(accepts("api.github.com")).toBe(true);
		expect(accepts("*.example.com")).toBe(true);
		expect(accepts("internal.example.com")).toBe(true);
	});

	it("refuses names for local networks, and ones that resolve to an address written in them", () => {
		for (const host of [
			"metadata.google.internal",
			"host.docker.internal",
			"printer.local",
			"169-254-169-254.nip.io",
			"*.sslip.io",
		]) {
			expect(accepts(host), host).toBe(false);
		}
	});
});
