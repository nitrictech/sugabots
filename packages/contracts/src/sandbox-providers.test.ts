import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	newSandboxHostsSchema,
	sandboxAddedHostSchema,
	sandboxHostSchema,
	sandboxHostToAllowSchema,
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

describe("hosts being allowed", () => {
	const allows = (host: string) =>
		Result.isSuccess(Schema.decodeResult(sandboxHostToAllowSchema)(host));

	it("refuses a wildcard over a name anyone can make sites under", () => {
		for (const host of ["*.co.uk", "*.com.au", "*.github.io", "*.pages.dev"]) {
			expect(allows(host), host).toBe(false);
		}
	});

	it("takes a site's own wildcard, and a suffix's name on its own", () => {
		for (const host of ["*.woolworths.com.au", "*.example.com", "co.uk", "yourname.github.io"]) {
			expect(allows(host), host).toBe(true);
		}
	});

	it("still reads back a wildcard allowed before it was checked, so it can be removed", () => {
		const added = { host: "*.github.io", addedByName: "Ada", addedAt: "2026-10-25T08:00:00.000Z" };
		expect(Result.isSuccess(Schema.decodeResult(sandboxAddedHostSchema)(added))).toBe(true);
	});

	it("takes between one and fifty at once", () => {
		const hostsOf = (count: number) => ({
			hosts: Array.from({ length: count }, (_, index) => `site${index}.example.com`),
		});
		const decodes = (value: unknown) =>
			Result.isSuccess(Schema.decodeUnknownResult(newSandboxHostsSchema)(value));
		expect(decodes(hostsOf(1))).toBe(true);
		expect(decodes(hostsOf(50))).toBe(true);
		expect(decodes(hostsOf(0))).toBe(false);
		expect(decodes(hostsOf(51))).toBe(false);
	});
});
