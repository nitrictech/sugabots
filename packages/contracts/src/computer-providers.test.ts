import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { computerHostSchema, computerProviderSettingsSchema } from "./computer-providers.ts";

describe("computer hosts", () => {
	const accepts = (host: string) => Result.isSuccess(Schema.decodeResult(computerHostSchema)(host));

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

describe("computer images", () => {
	const saves = (image: string) =>
		Result.isSuccess(
			Schema.decodeResult(computerProviderSettingsSchema)({ builtIn: "opensandbox", image }),
		);

	it("takes images as Docker names them", () => {
		for (const image of [
			"ghcr.io/nitrictech/sugabots-sandbox:edge",
			"ubuntu",
			"localhost:5000/team/image:v1.2",
			`ghcr.io/nitrictech/sugabots-sandbox@sha256:${"a".repeat(64)}`,
		]) {
			expect(saves(image), image).toBe(true);
		}
	});

	it("refuses what members paste by mistake: a command, or a web address", () => {
		for (const image of [
			"docker pull ghcr.io/nitrictech/sugabots-sandbox:edge",
			"https://ghcr.io/nitrictech/sugabots-sandbox",
			"HTTP://ghcr.io/nitrictech/sugabots-sandbox",
		]) {
			expect(saves(image), image).toBe(false);
		}
	});
});
