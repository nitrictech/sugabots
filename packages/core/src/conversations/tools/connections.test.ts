import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Server as McpProtocolServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Effect, Logger, ManagedRuntime, Schema } from "effect";
import { TestClock } from "effect/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { effectRunner } from "../../database/database.ts";
import { noDatabase } from "../../database/testing.ts";
import type { ConnectionTarget } from "../../providers/connections/connection-target.ts";
import { ConnectionTools } from "./connections.ts";

/**
 * A turn's connection tools against a real MCP server in this process. What
 * matters: which of the server's tools are offered, under what key, marked
 * how; and that a server that will not answer costs the turn nothing but
 * that connection.
 */

let http: Server;
let url: string;
let requests = 0;
const run = effectRunner(ManagedRuntime.make(noDatabase));

const lookupInput = Schema.Struct({ q: Schema.String });

function fixtureServer(): McpProtocolServer {
	const server = new McpProtocolServer(
		{ name: "fixture", version: "1.0.0" },
		{ capabilities: { tools: {} }, instructions: "Look things up before wiping them." },
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
		requests += 1;
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
	toolAccess: { lookup: "allow", wipe: "allow" },
	configurationUpdatedAt: new Date("2026-09-14T00:00:00.000Z"),
	configurationRevision: 1,
	...extra,
});

function toolsFor(...targets: ConnectionTarget[]) {
	const offered = ConnectionTools.from({
		connections: { targetsForPod: () => Effect.succeed(targets) },
		httpClients: { for: () => fetch },
	});
	return offered;
}

describe("a turn's connection tools", () => {
	it("runs a tool set to allow straight away, a change included", async () => {
		const offered = toolsFor(target());

		const set = await run(offered.forPod("w", "p"));
		try {
			expect(Object.keys(set.tools).sort()).toEqual(["wiki__lookup", "wiki__wipe"]);
			expect(set.tools.wiki__lookup).toMatchObject({ mutating: false, access: "allow" });
			expect(set.tools.wiki__wipe).toMatchObject({ mutating: true, access: "allow" });
			const result = await set.tools.wiki__lookup?.tool.execute?.({ q: "it" }, {
				toolCallId: "1",
				messages: [],
			} as never);
			expect(result).toMatchObject({ content: [{ type: "text", text: "found it" }] });
		} finally {
			await set.close();
		}
	});

	it("asks before each call to a tool set to ask, a read included", async () => {
		const offered = toolsFor(target({ toolAccess: { lookup: "ask", wipe: "ask" } }));

		const set = await run(offered.forPod("w", "p"));
		try {
			expect(set.tools.wiki__lookup).toMatchObject({ mutating: false, access: "ask" });
			expect(set.tools.wiki__wipe).toMatchObject({ mutating: true, access: "ask" });
		} finally {
			await set.close();
		}
	});

	it("still offers a tool set to off, so the tools sent to the model stay the same", async () => {
		const offered = toolsFor(target({ toolAccess: { lookup: "allow", wipe: "off" } }));

		const set = await run(offered.forPod("w", "p"));
		try {
			expect(Object.keys(set.tools).sort()).toEqual(["wiki__lookup", "wiki__wipe"]);
			expect(set.tools.wiki__wipe).toMatchObject({ access: "off" });
		} finally {
			await set.close();
		}
	});

	it("treats a tool the server did not list when last asked as its default says", async () => {
		const offered = toolsFor(target({ toolAccess: {} }));

		const set = await run(offered.forPod("w", "p"));
		try {
			// `lookup` says it only reads; `wipe` says nothing, so it may change things.
			expect(set.tools.wiki__lookup).toMatchObject({ access: "allow" });
			expect(set.tools.wiki__wipe).toMatchObject({ access: "ask" });
		} finally {
			await set.close();
		}
	});

	it("leaves out a server that will not answer, and keeps the ones that do", async () => {
		const logged: unknown[] = [];
		const offered = toolsFor(
			target({
				connectionId: "0199a3a0-0000-7000-8000-0000000000f2",
				handle: "locked",
				headers: { "x-fixture-key": "nope" },
			}),
			target(),
		);

		const set = await run(
			offered
				.forPod("w", "p")
				.pipe(Effect.provide(Logger.layer([Logger.make(({ message }) => logged.push(message))]))),
		);
		try {
			expect(Object.keys(set.tools).sort()).toEqual(["wiki__lookup", "wiki__wipe"]);
			expect(logged).toContainEqual(["Connection locked left out of the turn", expect.anything()]);
		} finally {
			await set.close();
		}
	});

	describe("from one turn to the next", () => {
		const callOptions = { toolCallId: "1", messages: [] } as never;

		async function requestsDuring(turn: Promise<unknown>) {
			const before = requests;
			await turn;
			return requests - before;
		}

		const turnOn = (
			offered: ConnectionTools.Interface,
			use: (set: ConnectionTools.ConnectionToolSet) => Promise<unknown> = async () => undefined,
		) =>
			Effect.gen(function* () {
				const set = yield* offered.forPod("w", "p");
				try {
					return yield* Effect.promise(() => use(set));
				} finally {
					yield* Effect.promise(() => set.close());
				}
			});

		it("asks a server for its tools once, then reaches it only to call one", async () => {
			const offered = toolsFor(target());
			await run(turnOn(offered));

			expect(await requestsDuring(run(turnOn(offered)))).toBe(0);
			let result: unknown;
			const calling = await requestsDuring(
				run(
					turnOn(offered, async (set) => {
						result = await set.tools.wiki__lookup?.tool.execute?.({ q: "it" }, callOptions);
					}),
				),
			);
			expect(calling).toBeGreaterThan(0);
			expect(result).toMatchObject({ content: [{ type: "text", text: "found it" }] });
		});

		it("names a connection it couldn't reach, and doesn't wait on it again for a minute", async () => {
			const offered = toolsFor(target({ handle: "locked", headers: { "x-fixture-key": "nope" } }));

			expect(await run(turnOn(offered, async (set) => set.unavailable))).toEqual(["locked"]);
			expect(await requestsDuring(run(turnOn(offered)))).toBe(0);
		});

		it("keeps what a server says about using its tools, with its tool list", async () => {
			const offered = toolsFor(target());
			await run(turnOn(offered));

			expect(await run(turnOn(offered, async (set) => set.instructions))).toEqual({
				wiki: "Look things up before wiping them.",
			});
		});

		it("tells the model what a server said when it refused a call", async () => {
			const result = await run(
				turnOn(toolsFor(target()), async (set) =>
					set.tools.wiki__lookup?.tool.execute?.({}, callOptions),
				),
			);

			expect(result).toMatchObject({
				isError: true,
				content: [{ type: "text", text: expect.any(String) }],
			});
		});

		it("asks again once the connection has been edited", async () => {
			const targets = [target()];
			const offered = ConnectionTools.from({
				connections: { targetsForPod: () => Effect.succeed(targets) },
				httpClients: { for: () => fetch },
			});
			await run(turnOn(offered));
			targets[0] = target({ configurationRevision: 2 });

			expect(await requestsDuring(run(turnOn(offered)))).toBeGreaterThan(0);
		});

		it("asks again once its list is old, so a server's new tools are picked up", async () => {
			const offered = toolsFor(target());

			const later = await run(
				Effect.gen(function* () {
					yield* turnOn(offered);
					const before = requests;
					yield* TestClock.adjust("14 minutes");
					yield* turnOn(offered);
					const fresh = requests - before;
					yield* TestClock.adjust("2 minutes");
					yield* turnOn(offered);
					return { fresh, old: requests - before - fresh };
				}).pipe(Effect.provide(TestClock.layer())),
			);

			expect(later).toEqual({ fresh: 0, old: expect.any(Number) });
			expect(later.old).toBeGreaterThan(0);
		});
	});
});
