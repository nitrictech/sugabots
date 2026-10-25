import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectServer, listServerTools } from "./mcp.ts";

/**
 * The tool lister against a real MCP server in this process, so the whole
 * handshake runs: initialise, list, close. The server checks a header, which
 * is how a connection's secret reaches it.
 */

async function text(request: IncomingMessage): Promise<string> {
	let body = "";
	for await (const chunk of request) body += chunk;
	return body;
}

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

const WEATHER_APP = "ui://weather/view";

/** A server with an MCP App: a tool shown in it, and one only the app may call. */
function appServer(): McpServer {
	const mcp = new McpServer({ name: "weather", version: "1.0.0" });
	mcp.registerTool(
		"forecast",
		{ description: "Shows the forecast.", _meta: { ui: { resourceUri: WEATHER_APP } } },
		async () => ({ content: [{ type: "text", text: "sunny" }] }),
	);
	mcp.registerTool(
		"refresh",
		{ description: "Refreshes the view.", _meta: { ui: { visibility: ["app"] } } },
		async () => ({ content: [{ type: "text", text: "fresh" }] }),
	);
	mcp.registerTool(
		"radar",
		{ description: "Shows the radar.", _meta: { "ui/resourceUri": WEATHER_APP } },
		async () => ({ content: [{ type: "text", text: "clear" }] }),
	);
	mcp.registerTool(
		"tides",
		{ description: "Shows the tides.", _meta: { ui: { resourceUri: "https://tides.test/view" } } },
		async () => ({ content: [{ type: "text", text: "high" }] }),
	);
	mcp.registerResource(
		"weather view",
		WEATHER_APP,
		{ mimeType: "text/html;profile=mcp-app" },
		async () => ({
			contents: [
				{
					uri: WEATHER_APP,
					mimeType: "text/html;profile=mcp-app",
					text: "<p>weather</p>",
					_meta: { ui: { csp: { connectDomains: ["https://api.weather.test"] } } },
				},
			],
		}),
	);
	return mcp;
}
beforeAll(async () => {
	http = createServer(async (request, response) => {
		seen.push(request.headers["x-fixture-key"] as string | undefined);
		if (request.headers["x-fixture-key"] !== "open-sesame") {
			response.writeHead(401).end("who are you");
			return;
		}
		const raw = await text(request);
		const body = raw ? JSON.parse(raw) : undefined;
		// Like Parley: a server on an older protocol refusing the newest one's discovery outright.
		if (request.url === "/older-mcp" && body?.method === "server/discover") {
			response.writeHead(400, { "content-type": "application/json" }).end(
				JSON.stringify({
					jsonrpc: "2.0",
					id: body.id,
					error: { code: -32022, message: "Unsupported protocol version" },
				}),
			);
			return;
		}
		// Stateless: a transport per request, which is all a tool listing needs.
		const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
		await (request.url === "/apps-mcp" ? appServer() : fixtureServer()).connect(transport);
		await transport.handleRequest(request, response, body);
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

	it("falls back to the older handshake when a server refuses the newest protocol", async () => {
		const found = await listServerTools(
			{ url: url.replace(/\/mcp$/, "/older-mcp"), headers: { "x-fixture-key": "open-sesame" } },
			fetch,
		);

		expect(found).toMatchObject({ ok: true, tools: [{ name: "lookup" }, { name: "wipe" }] });
	});

	it("reports a refused secret as a sentence", async () => {
		const found = await listServerTools({ url, headers: { "x-fixture-key": "nope" } }, fetch);

		expect(found).toMatchObject({
			ok: false,
			reason:
				"The server didn't accept the access token or secret. Check that it hasn't expired and was copied in full (HTTP 401)",
		});
	});

	it("reports a server that is not there in its own words, keeping the network's for the logs", async () => {
		const found = await listServerTools(
			{ url: "http://127.0.0.1:9/mcp", headers: {} },
			fetch,
			2_000,
		);

		expect(found).toMatchObject({
			ok: false,
			reason:
				"The server could not be reached. Check the address and port, and that the server is running",
		});
	});
});

describe("a server's MCP App", () => {
	const appsTarget = () => ({
		url: url.replace(/\/mcp$/, "/apps-mcp"),
		headers: { "x-fixture-key": "open-sesame" },
	});

	it("names the app a tool is shown in, and which tools only the app may call", async () => {
		const session = await connectServer(appsTarget(), fetch);
		try {
			const { tools } = await session.list();

			expect(
				tools.map(({ described, appResourceUri, visibility }) => ({
					name: described.name,
					appResourceUri,
					visibility,
				})),
			).toEqual([
				{ name: "forecast", appResourceUri: WEATHER_APP, visibility: { model: true, app: true } },
				{ name: "refresh", appResourceUri: undefined, visibility: { model: false, app: true } },
				{ name: "radar", appResourceUri: WEATHER_APP, visibility: { model: true, app: true } },
				{ name: "tides", appResourceUri: undefined, visibility: { model: true, app: true } },
			]);
		} finally {
			await session.close();
		}
	});

	it("offers a tool whose app address is not a ui:// one without its app, and still runs it", async () => {
		const session = await connectServer(appsTarget(), fetch);
		try {
			const listing = await session.list();
			const ran = await session.run(
				listing,
				"tides",
				{},
				{ toolCallId: "1", messages: [], context: {} },
			);

			expect(ran).toMatchObject({ content: [{ type: "text", text: "high" }] });
		} finally {
			await session.close();
		}
	});

	it("reads the app's HTML with the origins it reaches, and runs the calls it makes", async () => {
		const session = await connectServer(appsTarget(), fetch);
		try {
			const app = await session.readApp(WEATHER_APP);
			const refreshed = await session.callForApp("refresh", {});

			expect(app).toMatchObject({
				html: "<p>weather</p>",
				meta: { csp: { connectDomains: ["https://api.weather.test"] } },
			});
			expect(refreshed).toMatchObject({ content: [{ type: "text", text: "fresh" }] });
		} finally {
			await session.close();
		}
	});
});
