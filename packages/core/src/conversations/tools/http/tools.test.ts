import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Effect, ManagedRuntime } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { effectRunner } from "../../../database/database.ts";
import { noDatabase } from "../../../database/testing.ts";
import type { ConnectionTarget } from "../../../providers/connections/connection-target.ts";
import {
	type ClosableEgressHttpClients,
	createEgressHttpClients,
} from "../../../providers/network/egress.ts";
import { ConnectionTools } from "../connections.ts";

/**
 * An HTTP connection's method tools against a server in this process,
 * through the egress client bound to the connection's address, as a turn
 * gets them.
 */

const SECRET = "Bearer s3cret-token";

interface Received {
	method: string | undefined;
	url: string | undefined;
	headers: IncomingHttpHeaders;
	body: string;
}

let http: Server;
let base: string;
let clients: ClosableEgressHttpClients;
let received: Received[] = [];
const run = effectRunner(ManagedRuntime.make(noDatabase));

beforeAll(async () => {
	http = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk;
		received.push({ method: request.method, url: request.url, headers: request.headers, body });
		if (request.url === "/api/moved") {
			response.writeHead(302, { location: "https://elsewhere.example/" }).end();
			return;
		}
		if (request.url === "/api/whoami") {
			const token = SECRET.split(" ")[1];
			response
				.writeHead(200, { "content-type": "text/plain", location: `/api/me?token=${token}` })
				.end(`you sent ${request.headers.authorization}; token ${token}`);
			return;
		}
		response
			.writeHead(200, { "content-type": "application/json", "x-internal": "1" })
			.end('{"ok":true}');
	});
	await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(http.address() as AddressInfo).port}/api`;
	clients = createEgressHttpClients({ allowPrivateNetwork: true });
});

afterAll(async () => {
	await clients.close();
	http.closeAllConnections();
	await new Promise<void>((resolve) => http.close(() => resolve()));
});

beforeEach(() => {
	received = [];
});

const target = (extra: Partial<ConnectionTarget> = {}): ConnectionTarget => ({
	connectionId: "0199a3a0-0000-7000-8000-0000000000f3",
	handle: "alerts",
	kind: "http",
	url: base,
	auth: "header",
	headers: { authorization: SECRET },
	toolAccess: {},
	configurationUpdatedAt: new Date("2026-10-01T00:00:00.000Z"),
	configurationRevision: 1,
	...extra,
});

async function toolsFor(connection: ConnectionTarget) {
	const offered = ConnectionTools.from({
		connections: { targetsForPod: () => Effect.succeed([connection]) },
		httpClients: clients,
	});
	return (await run(offered.forPod("w", "p", NO_TURN))).tools;
}

async function call(connection: ConnectionTarget, method: string, input: unknown) {
	const tool = (await toolsFor(connection))[`alerts__${method}`];
	return tool?.tool.execute?.(input, { toolCallId: "1", messages: [] } as never);
}

describe("an HTTP connection's tools", () => {
	it("offers a tool per method: reads run, changes ask, and deletes are off", async () => {
		const tools = await toolsFor(target());

		expect(tools).toEqual({
			alerts__get: expect.objectContaining({ mutating: false, access: "allow" }),
			alerts__post: expect.objectContaining({ mutating: true, access: "ask" }),
			alerts__put: expect.objectContaining({ mutating: true, access: "ask" }),
			alerts__patch: expect.objectContaining({ mutating: true, access: "ask" }),
			alerts__delete: expect.objectContaining({ mutating: true, access: "off" }),
		});
	});

	it("sends a request under the connection's address with its secret added, and answers with the response", async () => {
		const result = await call(target(), "post", {
			path: "/events",
			query: { dedupe: "a b" },
			body: '{"title":"Down"}',
		});

		expect(result).toEqual({
			status: 200,
			headers: { "content-type": "application/json" },
			body: '{"ok":true}',
		});
		expect(received).toEqual([
			expect.objectContaining({
				method: "POST",
				url: "/api/events?dedupe=a+b",
				headers: expect.objectContaining({
					authorization: SECRET,
					"content-type": "application/json",
				}),
				body: '{"title":"Down"}',
			}),
		]);
	});

	it("sends no credential for a connection without one", async () => {
		const result = await call(target({ headers: {} }), "get", { path: "/status" });

		expect(result).toMatchObject({ status: 200 });
		expect(received[0]?.headers).not.toHaveProperty("authorization");
	});

	it("replaces the secret wherever the server echoes it", async () => {
		const result = await call(target(), "get", { path: "/whoami" });

		expect(JSON.stringify(result)).not.toContain("s3cret-token");
		expect(result).toEqual({
			status: 200,
			headers: { "content-type": "text/plain", location: "/api/me?token=[credential]" },
			body: "you sent [credential]; token [credential]",
		});
	});

	it("refuses the secret's header from the model, whatever its case, without sending anything", async () => {
		const result = await call(target(), "get", {
			path: "/status",
			headers: { Authorization: "Bearer mine" },
		});

		expect(result).toMatchObject({ status: "failed" });
		expect(received).toEqual([]);
	});

	it.each(["/../admin", "/%2e%2e/admin"])(
		"refuses %s, which leads outside the connection's address, without sending anything",
		async (path) => {
			const result = await call(target(), "get", { path });

			expect(result).toMatchObject({ status: "failed" });
			expect(received).toEqual([]);
		},
	);

	it("answers a redirect as it is, without following it", async () => {
		const result = await call(target(), "get", { path: "/moved" });

		expect(result).toMatchObject({
			status: 302,
			headers: { location: "https://elsewhere.example/" },
		});
		expect(received).toHaveLength(1);
	});
});

const NO_TURN = { turnId: "t", agentId: "a", workspace: undefined, sandboxSignsIn: false };
