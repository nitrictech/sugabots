import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listServerTools } from "./mcp.ts";

/**
 * The tool lister against a real MCP server in this process, so the whole
 * handshake runs: initialise, list, close. The server checks a header, which
 * is how a connection's secret reaches it.
 */

let http: Server;
let url: string;
const seen: Array<string | undefined> = [];

/** A server instance per request: the SDK's server holds one transport at a time. */
function fixtureServer(): McpServer {
	const mcp = new McpServer({ name: "fixture", version: "1.0.0" });
	mcp.registerTool(
		"lookup",
		{
			description: "Looks a thing up.",
			annotations: { readOnlyHint: true, destructiveHint: false },
		},
		async () => ({ content: [{ type: "text", text: "found" }] }),
	);
	mcp.registerTool("wipe", { description: "Wipes everything." }, async () => ({
		content: [{ type: "text", text: "gone" }],
	}));
	return mcp;
}

beforeAll(async () => {
	http = createServer(async (request, response) => {
		seen.push(request.headers["x-fixture-key"] as string | undefined);
		if (request.headers["x-fixture-key"] !== "open-sesame") {
			response.writeHead(401).end("who are you");
			return;
		}
		// Stateless: a transport per request, which is all a tool listing needs.
		const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
		await fixtureServer().connect(transport);
		await transport.handleRequest(request, response);
		response.on("close", () => void transport.close());
	});
	await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
	url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
});

afterAll(async () => {
	http.closeAllConnections();
	await new Promise<void>((resolve) => http.close(() => resolve()));
});

describe("listing a server's tools", () => {
	it("sends the secret header and reads back each tool as the server described it", async () => {
		const found = await listServerTools(
			{ url, headers: { "x-fixture-key": "open-sesame" } },
			fetch,
		);

		expect(found).toEqual({
			ok: true,
			tools: [
				{ name: "lookup", description: "Looks a thing up.", readOnly: true, destructive: false },
				{ name: "wipe", description: "Wipes everything.", readOnly: null, destructive: null },
			],
		});
		expect(seen).toContain("open-sesame");
	});

	it("reports a refused secret as a sentence", async () => {
		const found = await listServerTools({ url, headers: { "x-fixture-key": "nope" } }, fetch);

		expect(found).toMatchObject({ ok: false, reason: "The server answered HTTP 401" });
	});

	it("reports a server that is not there in its own words, keeping the network's for the logs", async () => {
		const found = await listServerTools(
			{ url: "http://127.0.0.1:9/mcp", headers: {} },
			fetch,
			2_000,
		);

		expect(found).toMatchObject({ ok: false, reason: "The server could not be reached" });
	});
});
