import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	connectionToolKey,
	connectionToolMutating,
	connectionUpdateSchema,
	newConnectionSchema,
} from "./connections.ts";

const linear = { name: "Linear", url: "https://mcp.linear.app/mcp" };

const accepts = (schema: Parameters<typeof Schema.decodeUnknownResult>[0], input: unknown) =>
	Result.isSuccess(Schema.decodeUnknownResult(schema)(input));

describe("a connection's secret header", () => {
	it.each(["Authorization", "authorization", "X-API-Key"])(
		"may be the credential header %s, which is where a hosted server reads a key",
		(secretHeader) => {
			expect(
				accepts(newConnectionSchema, { ...linear, secretHeader, secret: "Bearer lin_api_x" }),
			).toBe(true);
			expect(accepts(connectionUpdateSchema, { secretHeader })).toBe(true);
		},
	);

	it.each(["Host", "Content-Length", "Cookie", "Proxy-Authorization", "Sec-Fetch-Mode"])(
		"may not be %s, which the client owns",
		(secretHeader) => {
			expect(accepts(newConnectionSchema, { ...linear, secretHeader })).toBe(false);
		},
	);

	it("must be a header name", () => {
		expect(accepts(newConnectionSchema, { ...linear, secretHeader: "Auth Token" })).toBe(false);
	});
});

describe("a connection's tools on a turn", () => {
	it("takes a tool to change things unless the server marked it read-only or not destructive", () => {
		expect(connectionToolMutating({ readOnly: true, destructive: null })).toBe(false);
		expect(connectionToolMutating({ readOnly: null, destructive: false })).toBe(false);
		expect(connectionToolMutating({ readOnly: false, destructive: true })).toBe(true);
		// The spec's default: a tool that says nothing may be destructive.
		expect(connectionToolMutating({ readOnly: null, destructive: null })).toBe(true);
	});

	it("keys a tool by the connection's handle, in characters every provider accepts", () => {
		expect(connectionToolKey("team-wiki", "search_pages")).toBe("team-wiki__search_pages");
	});
});

describe("a connection's secret", () => {
	it("is trimmed, so a pasted newline does not end up inside the header", () => {
		const decode = Schema.decodeUnknownSync(newConnectionSchema);
		expect(decode({ ...linear, secret: " Bearer lin_api_x\n" }).secret).toBe("Bearer lin_api_x");
		expect(accepts(connectionUpdateSchema, { secret: " " })).toBe(false);
	});
});
