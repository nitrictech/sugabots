import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Server as McpProtocolServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Effect, ManagedRuntime, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { effectRunner } from "../../database/database.ts";
import { noDatabase } from "../../database/testing.ts";
import type { ConnectionTarget } from "../../providers/connections/store.ts";
import { connectionTools } from "./connections.ts";

/**
 * A turn's connection tools against a real MCP server in this process. What
 * matters: which of the server's tools are offered, under what key, marked
 * how; and that a server that will not answer costs the turn nothing but
 * that connection.
 */

let http: Server;
let url: string;
const run = effectRunner(ManagedRuntime.make(noDatabase));

const lookupInput = Schema.Struct({ q: Schema.String });

function fixtureServer(): McpProtocolServer {
	const server = new McpProtocolServer(
		{ name: "fixture", version: "1.0.0" },
		{ capabilities: { tools: {} } },
	);
	server.setRequestHandler(ListToolsRequestSchema, () => ({
		tools: [
			{
				name: "lookup",
				description: "Looks a thing up.",
				inputSchema: Schema.toJsonSchemaDocument(lookupInput).schema,
				annotations: { readOnlyHint: true, destructiveHint: false },
			},
			{
				name: "wipe",
				description: "Wipes everything.",
				inputSchema: { type: "object" },
			},
		],
	}));
	server.setRequestHandler(CallToolRequestSchema, (request) => {
		if (request.params.name === "lookup") {
			const { q } = Schema.decodeUnknownSync(lookupInput)(request.params.arguments);
			return { content: [{ type: "text", text: `found ${q}` }] };
		}
		return { content: [{ type: "text", text: "gone" }] };
	});
	return server;
}

beforeAll(async () => {
	http = createServer(async (request, response) => {
		if (request.headers["x-fixture-key"] !== "open-sesame") {
			response.writeHead(401).end("who are you");
			return;
		}
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

const target = (extra: Partial<ConnectionTarget> = {}): ConnectionTarget => ({
	connectionId: "0199a3a0-0000-7000-8000-0000000000f1",
	handle: "wiki",
	url,
	auth: "header",
	headers: { "x-fixture-key": "open-sesame" },
	allowMutating: false,
	configurationUpdatedAt: new Date("2026-09-14T00:00:00.000Z"),
	configurationRevision: 1,
	...extra,
});

function toolsFor(...targets: ConnectionTarget[]) {
	const offered = connectionTools({
		connections: { targetsForPod: () => Effect.succeed(targets) },
		httpClients: { for: () => fetch },
	});
	return offered;
}

describe("a turn's connection tools", () => {
	it("offers the read-only tools under the connection's handle, and holds back the rest", async () => {
		const offered = toolsFor(target());

		const set = await run(offered.forPod("w", "p"));
		try {
			expect(Object.keys(set.tools)).toEqual(["wiki__lookup"]);
			expect(set.tools.wiki__lookup?.mutating).toBe(false);
			const result = await set.tools.wiki__lookup?.tool.execute?.({ q: "it" }, {
				toolCallId: "1",
				messages: [],
			} as never);
			expect(result).toMatchObject({ content: [{ type: "text", text: "found it" }] });
		} finally {
			await set.close();
		}
	});

	it("offers a tool that changes things once the admin allowed it, marked as such", async () => {
		const offered = toolsFor(target({ allowMutating: true }));

		const set = await run(offered.forPod("w", "p"));
		try {
			expect(Object.keys(set.tools).sort()).toEqual(["wiki__lookup", "wiki__wipe"]);
			// No hints at all is taken to change things, as the spec has it.
			expect(set.tools.wiki__wipe?.mutating).toBe(true);
		} finally {
			await set.close();
		}
	});

	it("leaves out a server that will not answer, and keeps the ones that do", async () => {
		const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const offered = toolsFor(
			target({ handle: "locked", headers: { "x-fixture-key": "nope" } }),
			target(),
		);

		const set = await run(offered.forPod("w", "p"));
		try {
			expect(Object.keys(set.tools)).toEqual(["wiki__lookup"]);
			expect(quiet).toHaveBeenCalledWith(
				"Connection locked left out of the turn",
				expect.anything(),
			);
		} finally {
			await set.close();
			quiet.mockRestore();
		}
	});
});
