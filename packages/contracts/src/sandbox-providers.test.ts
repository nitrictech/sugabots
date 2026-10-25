import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	sandboxHostSchema,
	sandboxProviderSchema,
	sandboxProviderSettingsSchema,
} from "./sandbox-providers.ts";

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

describe("sandbox images", () => {
	const saves = (image: string) =>
		Result.isSuccess(
			Schema.decodeResult(sandboxProviderSettingsSchema)({ preset: "opensandbox", image }),
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

	it("refuses what isn't an image's name, such as a command to pull one", () => {
		for (const image of [
			"docker pull ghcr.io/nitrictech/sugabots-sandbox:edge",
			"https://ghcr.io/nitrictech/sugabots-sandbox",
			"GHCR.io/Nitric/Sandbox",
		]) {
			expect(saves(image), image).toBe(false);
		}
	});

	it("still reads back an image saved before names were checked, so it can be corrected", () => {
		const provider = {
			id: "01a1709a-9298-750b-9eec-df53b093ab7f",
			workspaceId: "01a0fa75-37a6-75ce-a519-efca01103746",
			preset: "opensandbox",
			name: "OpenSandbox",
			settings: {
				preset: "opensandbox",
				image: "docker pull ghcr.io/nitrictech/sugabots-sandbox:edge",
			},
			enabled: true,
			status: "connected",
			hasApiKey: true,
			lastTestedAt: null,
			lastTestError: null,
			createdAt: "2026-10-25T08:00:00.000Z",
		};
		expect(Result.isSuccess(Schema.decodeUnknownResult(sandboxProviderSchema)(provider))).toBe(
			true,
		);
	});
});
