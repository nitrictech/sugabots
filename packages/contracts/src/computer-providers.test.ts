import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	computerHostSchema,
	computerProviderSchema,
	computerProviderSettingsSchema,
} from "./computer-providers.ts";

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

	it("refuses what people paste by mistake: a command, or a web address", () => {
		for (const image of [
			"docker pull ghcr.io/nitrictech/sugabots-sandbox:edge",
			"https://ghcr.io/nitrictech/sugabots-sandbox",
			"HTTP://ghcr.io/nitrictech/sugabots-sandbox",
		]) {
			expect(saves(image), image).toBe(false);
		}
	});

	it("still reads back an image saved before names were checked, so it can be corrected", () => {
		const provider = {
			id: "01a1709a-9298-750b-9eec-df53b093ab7f",
			workspaceId: "01a0fa75-37a6-75ce-a519-efca01103746",
			builtIn: "opensandbox",
			name: "OpenSandbox",
			settings: {
				builtIn: "opensandbox",
				image: "docker pull ghcr.io/nitrictech/sugabots-sandbox:edge",
			},
			enabled: true,
			status: "connected",
			hasApiKey: true,
			lastTestedAt: null,
			lastTestError: null,
			createdAt: "2026-10-25T08:00:00.000Z",
		};
		expect(Result.isSuccess(Schema.decodeUnknownResult(computerProviderSchema)(provider))).toBe(
			true,
		);
	});
});
