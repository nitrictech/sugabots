import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Effect } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, runOnPostgres as run } from "../../../database/testing.ts";
import type { ConnectorTarget } from "../../../providers/connectors/connector-target.ts";
import {
	type ClosableEgressHttpClients,
	createEgressHttpClients,
} from "../../../providers/network/egress.ts";
import { ConnectorCatalog } from "../connector-catalog.ts";
import { withRecordedCall } from "../recorded-call.ts";
import { catalogReachFixture } from "../testing.ts";

/**
 * An HTTP connector's method tools against a server in this process,
 * through the egress client bound to the connector's address, as a turn
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
let reach: Awaited<ReturnType<typeof catalogReachFixture>>;
let connectorId: string;

beforeAll(async () => {
	reach = await catalogReachFixture();
	connectorId = await reach.connector();
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
	await closeDatabase();
	await clients.close();
	http.closeAllConnections();
	await new Promise<void>((resolve) => http.close(() => resolve()));
});

beforeEach(() => {
	received = [];
});

const target = (extra: Partial<ConnectorTarget> = {}): ConnectorTarget => ({
	connectorId,
	handle: "alerts",
	kind: "http",
	url: base,
	auth: "header",
	headers: { authorization: SECRET },
	toolAccess: {},
	configurationUpdatedAt: new Date("2026-10-01T00:00:00.000Z"),
	toolDefinitionsFingerprint: null,
	configurationRevision: 1,
	...extra,
});

async function toolsFor(connector: ConnectorTarget) {
	const offered = ConnectorCatalog.from({
		connectors: {
			recordListing: () => Effect.die("HTTP connectors have no MCP listing"),
			targetsForProject: () =>
				Effect.succeed({ targets: [connector], signInExpired: [], installedUrls: [connector.url] }),
		},
		httpClients: clients,
	});
	return (
		await run(
			offered.forTurn(
				reach.workspace,
				{ projectId: reach.project, ownProjectId: reach.project },
				reach.side,
			),
		)
	).tools;
}

async function call(connector: ConnectorTarget, method: string, input: unknown) {
	const tool = (await toolsFor(connector))[`alerts__${method}`];
	return tool?.tool.execute?.(input, { toolCallId: "1", messages: [] } as never);
}

/** The call's id as the turn recorded it, which it keeps each time it is sent. */
const RECORDED_CALL_ID = "0199a3a0-0000-7000-8000-0000000000c1";

/** Calls `method` as a turn's recorded call `RECORDED_CALL_ID`. */
async function callRecorded(method: string, input: unknown, connector = target()) {
	const tool = (await toolsFor(connector))[`alerts__${method}`];
	return tool?.tool.execute?.(input, {
		toolCallId: "sdk-1",
		messages: [],
		context: withRecordedCall(undefined, RECORDED_CALL_ID),
	} as never);
}

describe("an HTTP connector's tools", () => {
	it("offers a tool per method: reads run, changes ask, and deletes are off", async () => {
		const tools = await toolsFor(target());

		expect(tools).toEqual({
			alerts__get: expect.objectContaining({ writeOrDelete: false, access: "allow" }),
			alerts__post: expect.objectContaining({ writeOrDelete: true, access: "ask" }),
			alerts__put: expect.objectContaining({ writeOrDelete: true, access: "ask" }),
			alerts__patch: expect.objectContaining({ writeOrDelete: true, access: "ask" }),
			alerts__delete: expect.objectContaining({ writeOrDelete: true, access: "off" }),
		});
	});

	it("sends a request under the connector's address with its secret added, and answers with the response", async () => {
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

	it("sends no credential for a connector without one", async () => {
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
		"refuses %s, which leads outside the connector's address, without sending anything",
		async (path) => {
			const result = await call(target(), "get", { path });

			expect(result).toMatchObject({ status: "failed" });
			expect(received).toEqual([]);
		},
	);

	it("sends a change under its recorded call's id as its idempotency key, the same each time it is sent", async () => {
		await callRecorded("post", { path: "/events", body: "{}" });
		await callRecorded("post", { path: "/events", body: "{}" });
		await callRecorded("get", { path: "/events" });

		expect(received.map(({ method, headers }) => [method, headers["idempotency-key"]])).toEqual([
			["POST", RECORDED_CALL_ID],
			["POST", RECORDED_CALL_ID],
			["GET", undefined],
		]);
	});

	it("uses the recorded id even when the model gave an idempotency key", async () => {
		await callRecorded("put", {
			path: "/events/1",
			headers: { "Idempotency-Key": "mine" },
			body: "{}",
		});

		expect(received[0]?.headers["idempotency-key"]).toBe(RECORDED_CALL_ID);
	});

	it("refuses a recorded change when its credential would replace the idempotency key", async () => {
		const result = await callRecorded(
			"post",
			{ path: "/events" },
			target({ headers: { "Idempotency-Key": SECRET } }),
		);
		expect(result).toMatchObject({ status: "failed" });
		expect(received).toEqual([]);
	});

	it("answers a redirect as it is, without following it", async () => {
		const result = await call(target(), "get", { path: "/moved" });

		expect(result).toMatchObject({
			status: 302,
			headers: { location: "https://elsewhere.example/" },
		});
		expect(received).toHaveLength(1);
	});
});
