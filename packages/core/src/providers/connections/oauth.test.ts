import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listServerTools } from "./mcp.ts";
import {
	beginAuthorization,
	finishAuthorization,
	type OAuthRecord,
	storedOAuthProvider,
} from "./oauth.ts";

/**
 * The whole sign-in against a server in this process that is both the MCP
 * server and its authorization server: discovery, registration, the URL the
 * browser is sent to, the code exchange, and then a tool listing that carries
 * the token. Nothing is mocked inside the SDK; only the browser's trip is.
 */

let http: Server;
let origin: string;
let serverUrl: string;
const tokenRequests: URLSearchParams[] = [];

beforeAll(async () => {
	http = createServer(async (request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		const json = (body: unknown, status = 200) => {
			response.writeHead(status, { "content-type": "application/json" });
			response.end(JSON.stringify(body));
		};
		if (url.pathname.includes("oauth-protected-resource")) {
			return json({ resource: serverUrl, authorization_servers: [origin] });
		}
		if (url.pathname.includes(".well-known/")) {
			return json({
				issuer: origin,
				authorization_endpoint: `${origin}/authorize`,
				token_endpoint: `${origin}/token`,
				registration_endpoint: `${origin}/register`,
				response_types_supported: ["code"],
				grant_types_supported: ["authorization_code", "refresh_token"],
				code_challenge_methods_supported: ["S256"],
				token_endpoint_auth_methods_supported: ["none"],
			});
		}
		if (url.pathname === "/register") {
			const body = JSON.parse(await text(request));
			return json(
				{
					client_id: "client-1",
					redirect_uris: body.redirect_uris,
					token_endpoint_auth_method: "none",
				},
				201,
			);
		}
		if (url.pathname === "/token") {
			const form = new URLSearchParams(await text(request));
			tokenRequests.push(form);
			const grant = form.get("grant_type");
			if (grant === "refresh_token" && form.get("refresh_token") === "refresh-1") {
				return json({ access_token: "token-1", token_type: "Bearer", expires_in: 3600 });
			}
			if (grant !== "authorization_code" || form.get("code") !== "the-code") {
				return json({ error: "invalid_grant" }, 400);
			}
			return json({
				access_token: "token-1",
				token_type: "Bearer",
				expires_in: 3600,
				refresh_token: "refresh-1",
			});
		}
		if (url.pathname === "/mcp") {
			if (request.headers.authorization !== "Bearer token-1") {
				response.writeHead(401, {
					"www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
				});
				response.end();
				return;
			}
			const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
			const mcp = new McpServer({ name: "fixture", version: "1.0.0" });
			mcp.registerTool("lookup", { description: "Looks a thing up." }, async () => ({
				content: [{ type: "text", text: "found" }],
			}));
			await mcp.connect(transport);
			await transport.handleRequest(request, response);
			response.on("close", () => void transport.close());
			return;
		}
		response.writeHead(404).end();
	});
	await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
	origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
	serverUrl = `${origin}/mcp`;
});

afterAll(async () => {
	http.closeAllConnections();
	await new Promise<void>((resolve) => http.close(() => resolve()));
});

function text(request: import("node:http").IncomingMessage): Promise<string> {
	return new Promise((resolve) => {
		let body = "";
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => resolve(body));
	});
}

function memoryStorage() {
	let record: OAuthRecord | undefined;
	return {
		load: async () => record,
		save: async (next: OAuthRecord) => {
			record = next;
		},
		record: () => record,
	};
}

describe("signing a connection in", () => {
	it("registers, sends the browser to sign in, exchanges the code, and then lists tools with the token", async () => {
		const storage = memoryStorage();
		const provider = (startedByUserId?: string) =>
			storedOAuthProvider(storage, {
				redirectUrl: "http://localhost:3000/connections/oauth/callback",
				clientName: "Sugabots",
				startedByUserId,
			});

		const started = await beginAuthorization(provider("person-1"), serverUrl, fetch);
		if (!("authorizationUrl" in started)) throw new Error("expected a URL to sign in at");
		const sendTo = new URL(started.authorizationUrl);
		expect(sendTo.origin + sendTo.pathname).toBe(`${origin}/authorize`);
		expect(sendTo.searchParams.get("client_id")).toBe("client-1");
		expect(sendTo.searchParams.get("redirect_uri")).toBe(
			"http://localhost:3000/connections/oauth/callback",
		);
		expect(sendTo.searchParams.get("code_challenge_method")).toBe("S256");
		const state = sendTo.searchParams.get("state");
		expect(state).toBeTruthy();
		expect(storage.record()).toMatchObject({
			clientInformation: { client_id: "client-1" },
			state,
			startedByUserId: "person-1",
		});
		expect(storage.record()?.codeVerifier).toBeTruthy();

		await finishAuthorization(provider(), serverUrl, "the-code", state ?? "", fetch);

		expect(storage.record()?.tokens).toMatchObject({ access_token: "token-1" });
		expect(storage.record()?.state).toBe("");
		expect(storage.record()?.startedByUserId).toBeUndefined();
		expect(tokenRequests.at(-1)?.get("code_verifier")).toBeTruthy();

		const listed = await listServerTools(
			{ url: serverUrl, headers: {}, authProvider: provider() },
			fetch,
		);
		expect(listed).toMatchObject({ ok: true, tools: [{ name: "lookup" }] });

		expect(await beginAuthorization(provider(), serverUrl, fetch)).toEqual({ authorized: true });
	});

	it("says a server that wants a sign-in needs one, in the words the settings page shows", async () => {
		const listed = await listServerTools({ url: serverUrl, headers: {} }, fetch);
		expect(listed.ok).toBe(false);
		expect(listed).toMatchObject({ ok: false, reason: "The server answered HTTP 401" });
	});
});
