import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

/**
 * A server in this process that is both an MCP server and its authorization
 * server: discovery, registration, the code exchange (the code is
 * `the-code`), and a `/mcp` endpoint that answers 401 to anything without the
 * token it issued, `token-1`, and lists one tool, `lookup`, to anything with it.
 */
export async function startOAuthServer() {
	const tokenRequests: URLSearchParams[] = [];
	let origin = "";
	let serverUrl = "";
	const http: Server = createServer(async (request, response) => {
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
	return {
		/** The authorization server's address; the MCP server is at {@link serverUrl}. */
		origin,
		serverUrl,
		/** Every form posted to the token endpoint, oldest first. */
		tokenRequests,
		close: async () => {
			http.closeAllConnections();
			await new Promise<void>((resolve) => http.close(() => resolve()));
		},
	};
}

function text(request: IncomingMessage): Promise<string> {
	return new Promise((resolve) => {
		let body = "";
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => resolve(body));
	});
}
