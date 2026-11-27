import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Server as McpProtocolServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { eq } from "drizzle-orm";
import { Duration, Effect, Logger, Schema } from "effect";
import { TestClock } from "effect/testing";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { connector as connectorTable } from "../../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres as run } from "../../database/testing.ts";
import type { ConnectorTarget } from "../../providers/connectors/connector-target.ts";
import { connectServer } from "../../providers/connectors/mcp.ts";
import { oauthClient, SignInRequired } from "../../providers/connectors/oauth.ts";
import { ConnectorCatalog, LISTING_LIFETIME } from "./connector-catalog.ts";
import { catalogReachFixture } from "./testing.ts";

/**
 * A turn's connector tools against a real MCP server in this process. What
 * matters: which of the server's tools are offered, under what key, marked
 * how; and that a server that will not answer costs the turn nothing but
 * that connector.
 */

let http: Server;
let url: string;
const postsByPath = new Map<string, number>();
let reach: Awaited<ReturnType<typeof catalogReachFixture>>;
let wikiId: string;
let lockedId: string;
let linearId: string;
let otherWikiId: string;
let notesId: string;
let revisedId: string;
const ownProject = () => ({ projectId: reach.project, ownProjectId: reach.project });

const LOOKUP_REFUSAL = "No entry for that query.";
const lookupInput = Schema.Struct({ q: Schema.String });

/** What a connector signed in with OAuth holds, which the SDK sends as a bearer header. */
const ACCESS_TOKEN = "oauth-access-token-0123456789";

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
			if (q === "missing")
				return { isError: true, content: [{ type: "text", text: LOOKUP_REFUSAL }] };
			return { content: [{ type: "text", text: `found ${q}` }] };
		}
		return { content: [{ type: "text", text: "gone" }] };
	});
	return server;
}

async function jsonBody(request: IncomingMessage): Promise<{ method?: string } | undefined> {
	let raw = "";
	for await (const chunk of request) raw += chunk;
	return raw ? JSON.parse(raw) : undefined;
}

beforeAll(async () => {
	reach = await catalogReachFixture();
	[wikiId, lockedId, linearId, otherWikiId, notesId, revisedId] = await Promise.all([
		reach.connector(),
		reach.connector(),
		reach.connector(),
		reach.connector(reach.otherProject),
		reach.connector(reach.otherProject),
		reach.connector(),
	]);
	http = createServer(async (request, response) => {
		if (request.method === "POST" && request.url) {
			postsByPath.set(request.url, (postsByPath.get(request.url) ?? 0) + 1);
		}
		const key = request.headers["x-fixture-key"];
		const bearer = request.headers.authorization;
		if (key !== "open-sesame" && bearer !== `Bearer ${ACCESS_TOKEN}`) {
			response.writeHead(401).end("who are you");
			return;
		}
		const body = await jsonBody(request);
		// A server over its rate limit, quoting the credential it was sent.
		if (request.url === "/limited" && body?.method === "tools/call") {
			response
				.writeHead(429)
				.end(
					`Rate limit reached for key ${key ?? bearer}. Try again in an hour, or upgrade your plan.`,
				);
			return;
		}
		const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
		await fixtureServer().connect(transport);
		await transport.handleRequest(request, response, body);
		response.on("close", () => void transport.close());
	});
	await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
	url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
});

afterAll(async () => {
	await closeDatabase();
	http.closeAllConnections();
	await new Promise<void>((resolve) => http.close(() => resolve()));
});

const target = (extra: Partial<ConnectorTarget> = {}): ConnectorTarget => ({
	connectorId: wikiId,
	handle: "wiki",
	kind: "mcp",
	url,
	auth: "header",
	headers: { "x-fixture-key": "open-sesame" },
	toolAccess: { lookup: "allow", wipe: "allow" },
	configurationUpdatedAt: new Date("2026-09-14T00:00:00.000Z"),
	toolDefinitionsFingerprint: null,
	configurationRevision: 1,
	...extra,
});

const recordListing: ConnectorCatalog.Parts["connectors"]["recordListing"] = (
	_workspaceId,
	{ configurationRevision },
) => Effect.succeed(configurationRevision);

const targetForTurn = () => Effect.die("This case does not look up a single connector");

function toolsFor(...targets: ConnectorTarget[]) {
	const offered = ConnectorCatalog.from({
		connectors: {
			recordListing,
			targetForTurn,
			targetsForProject: () =>
				Effect.succeed({
					targets,
					signInExpired: [],
					installedUrls: targets.map(({ url }) => url),
				}),
		},
		httpClients: { for: () => fetch },
	});
	return offered;
}

function closeToolsAfterTest(set: ConnectorCatalog.ConnectorToolSet) {
	onTestFinished(() => set.close());
	return set;
}

describe("a turn's connector tools", () => {
	it("offers only reached connectors at the listed revision", async () => {
		const offered = toolsFor(
			target(),
			target({ connectorId: linearId, handle: "stale", configurationRevision: 2 }),
			target({ connectorId: otherWikiId, handle: "other_project" }),
			target({ connectorId: "0199a3a0-0000-7000-8000-0000000000ff", handle: "missing" }),
		);

		const set = closeToolsAfterTest(
			await run(offered.forTurn(reach.workspace, ownProject(), reach.side)),
		);
		expect(Object.keys(set.tools).sort()).toEqual(["wiki__lookup", "wiki__wipe"]);
	});

	it("runs a tool set to allow straight away, a change included", async () => {
		const offered = toolsFor(target());

		const set = closeToolsAfterTest(
			await run(offered.forTurn(reach.workspace, ownProject(), reach.side)),
		);
		expect(Object.keys(set.tools).sort()).toEqual(["wiki__lookup", "wiki__wipe"]);
		expect(set.tools.wiki__lookup).toMatchObject({ writeOrDelete: false, access: "allow" });
		expect(set.tools.wiki__wipe).toMatchObject({ writeOrDelete: true, access: "allow" });
		const result = await set.tools.wiki__lookup?.tool.execute?.({ q: "it" }, {
			toolCallId: "1",
			messages: [],
		} as never);
		expect(result).toMatchObject({ content: [{ type: "text", text: "found it" }] });
	});

	it("asks before each call to a tool set to ask, a read included", async () => {
		const offered = toolsFor(target({ toolAccess: { lookup: "ask", wipe: "ask" } }));

		const set = closeToolsAfterTest(
			await run(offered.forTurn(reach.workspace, ownProject(), reach.side)),
		);
		expect(set.tools.wiki__lookup).toMatchObject({ writeOrDelete: false, access: "ask" });
		expect(set.tools.wiki__wipe).toMatchObject({ writeOrDelete: true, access: "ask" });
	});

	it("still offers a tool set to off, so the tools sent to the model stay the same", async () => {
		const offered = toolsFor(target({ toolAccess: { lookup: "allow", wipe: "off" } }));

		const set = closeToolsAfterTest(
			await run(offered.forTurn(reach.workspace, ownProject(), reach.side)),
		);
		expect(Object.keys(set.tools).sort()).toEqual(["wiki__lookup", "wiki__wipe"]);
		expect(set.tools.wiki__wipe).toMatchObject({ access: "off" });
	});

	it("treats a tool the server did not list when last asked as its default says", async () => {
		const offered = toolsFor(target({ toolAccess: {} }));

		const set = closeToolsAfterTest(
			await run(offered.forTurn(reach.workspace, ownProject(), reach.side)),
		);
		// `lookup` says it only reads; `wipe` says nothing, so it may change things.
		expect(set.tools.wiki__lookup).toMatchObject({ access: "allow" });
		expect(set.tools.wiki__wipe).toMatchObject({ access: "ask" });
	});

	it("leaves out a server that will not answer, and keeps the ones that do", async () => {
		const logged: unknown[] = [];
		const offered = toolsFor(
			target({
				connectorId: lockedId,
				handle: "locked",
				headers: { "x-fixture-key": "nope" },
			}),
			target(),
		);

		const set = closeToolsAfterTest(
			await run(
				offered
					.forTurn(reach.workspace, ownProject(), reach.side)
					.pipe(Effect.provide(Logger.layer([Logger.make(({ message }) => logged.push(message))]))),
			),
		);
		expect(Object.keys(set.tools).sort()).toEqual(["wiki__lookup", "wiki__wipe"]);
		expect(logged).toContainEqual(["Connector locked left out of the turn", expect.anything()]);
	});

	it("adds Linear's upload to a Linear connector, running without asking, and to no other", async () => {
		const linear = target({
			connectorId: linearId,
			handle: "linear",
			url: "https://mcp.linear.app/mcp",
			toolAccess: {},
		});
		const offered = ConnectorCatalog.from({
			connectors: {
				recordListing,
				targetForTurn,
				targetsForProject: () =>
					Effect.succeed({
						targets: [linear, target()],
						signInExpired: [],
						installedUrls: [linear.url, url],
					}),
			},
			httpClients: { for: () => fetch },
			// Linear's address, answered by the fixture server.
			connect: (server, client) => connectServer({ ...server, url }, client),
		});

		const set = closeToolsAfterTest(
			await run(offered.forTurn(reach.workspace, ownProject(), reach.side)),
		);
		expect(Object.keys(set.tools).sort()).toEqual([
			"linear__lookup",
			"linear__upload_file",
			"linear__wipe",
			"wiki__lookup",
			"wiki__wipe",
		]);
		expect(set.tools.linear__upload_file).toMatchObject({
			handle: "linear",
			access: "allow",
			writeOrDelete: true,
			remoteToolName: "upload_file",
		});
		expect(set.tools.linear__upload_file?.description).toContain(
			"linear__prepare_attachment_upload",
		);
	});

	it("names a connector whose sign-in was refused apart from one that will not answer, and does not offer it to be added", async () => {
		const linear = target({
			connectorId: linearId,
			handle: "linear",
			url: "https://mcp.linear.app/mcp",
			auth: "oauth",
		});
		const offered = ConnectorCatalog.from({
			connectors: {
				recordListing,
				targetForTurn,
				targetsForProject: () =>
					Effect.succeed({
						targets: [linear, target({ handle: "locked", headers: { "x-fixture-key": "nope" } })],
						signInExpired: [target({ handle: "notion", connectorId: lockedId })],
						installedUrls: [linear.url, url, "https://mcp.notion.com/mcp"],
					}),
			},
			httpClients: { for: () => fetch },
			connect: (server, client) =>
				server.url === linear.url
					? Promise.reject(new SignInRequired())
					: connectServer(server, client),
		});

		const set = closeToolsAfterTest(
			await run(offered.forTurn(reach.workspace, ownProject(), reach.side)),
		);
		expect(set.signInExpired).toEqual([
			{ handle: "notion", projectId: reach.project },
			{ handle: "linear", projectId: reach.project },
		]);
		// Notion is still the bot's, so the model isn't told to add it.
		expect(set.addable.map((builtIn) => builtIn.id)).not.toContain("notion");
		expect(set.unavailable).toEqual(["locked"]);
	});

	it("offers a project's connectors and the bot's own, the project's where both have a handle", async () => {
		const projects: Record<string, ConnectorTarget[]> = {
			[reach.project]: [target()],
			[reach.otherProject]: [
				target({ connectorId: otherWikiId }),
				target({ connectorId: notesId, handle: "notes" }),
			],
		};
		const offered = ConnectorCatalog.from({
			connectors: {
				recordListing,
				targetForTurn,
				targetsForProject: (_workspaceId, projectId) => {
					const targets = projects[projectId] ?? [];
					return Effect.succeed({
						targets,
						signInExpired: [],
						installedUrls: targets.map(({ url }) => url),
					});
				},
			},
			httpClients: { for: () => fetch },
		});

		const set = closeToolsAfterTest(
			await run(
				offered.forTurn(
					reach.workspace,
					{ projectId: reach.project, ownProjectId: reach.otherProject },
					reach.side,
				),
			),
		);
		expect(Object.keys(set.tools).sort()).toEqual([
			"notes__lookup",
			"notes__wipe",
			"wiki__lookup",
			"wiki__wipe",
		]);
		expect(set.tools.wiki__lookup?.connectorId).toBe(target().connectorId);
		expect(set.fromProjectAndBot).toBe(true);
	});

	it("names each connector whose sign-in expired with the project it is signed in again from", async () => {
		const expired: Record<string, ConnectorTarget[]> = {
			[reach.project]: [target({ handle: "notion" })],
			[reach.otherProject]: [
				target({ handle: "notion", connectorId: otherWikiId }),
				target({ handle: "linear", connectorId: notesId }),
			],
		};
		const offered = ConnectorCatalog.from({
			connectors: {
				recordListing,
				targetForTurn,
				targetsForProject: (_workspaceId, projectId) =>
					Effect.succeed({
						targets: [],
						signInExpired: expired[projectId] ?? [],
						installedUrls: ["https://mcp.notion.com/mcp", "https://mcp.linear.app/mcp"],
					}),
			},
			httpClients: { for: () => fetch },
		});

		const set = await run(
			offered.forTurn(
				reach.workspace,
				{ projectId: reach.project, ownProjectId: reach.otherProject },
				reach.side,
			),
		);

		expect(set.signInExpired).toEqual([
			{ handle: "notion", projectId: reach.project },
			{ handle: "linear", projectId: reach.otherProject },
		]);
	});

	describe("from one turn to the next", () => {
		const callOptions = { toolCallId: "1", messages: [] } as never;

		function countedServer(path: string, extra: Partial<ConnectorTarget> = {}) {
			const connector = target({ ...extra, url: new URL(path, url).href });
			const requests = () => postsByPath.get(path) ?? 0;
			return { connector, requests };
		}

		async function requestsDuring(requests: () => number, turn: () => Promise<unknown>) {
			const before = requests();
			await turn();
			return requests() - before;
		}

		const turnOn = (
			offered: ConnectorCatalog.Interface,
			use: (set: ConnectorCatalog.ConnectorToolSet) => Promise<unknown> = async () => undefined,
		) =>
			Effect.gen(function* () {
				const set = yield* offered.forTurn(reach.workspace, ownProject(), reach.side);
				try {
					return yield* Effect.promise(() => use(set));
				} finally {
					yield* Effect.promise(() => set.close());
				}
			});

		it("asks a server for its tools once, then reaches it only to call one", async () => {
			const { connector, requests } = countedServer("/cached-listing");
			const offered = toolsFor(connector);
			await run(turnOn(offered));

			expect(await requestsDuring(requests, () => run(turnOn(offered)))).toBe(0);
			let result: unknown;
			const calling = await requestsDuring(requests, () =>
				run(
					turnOn(offered, async (set) => {
						result = await set.tools.wiki__lookup?.tool.execute?.({ q: "it" }, callOptions);
					}),
				),
			);
			expect(calling).toBeGreaterThan(0);
			expect(result).toMatchObject({ content: [{ type: "text", text: "found it" }] });
		});

		it("names a connector it couldn't reach, and doesn't wait on it again for a minute", async () => {
			const { connector, requests } = countedServer("/cached-refusal", {
				handle: "locked",
				headers: { "x-fixture-key": "nope" },
			});
			const offered = toolsFor(connector);

			const checked = await run(
				Effect.gen(function* () {
					const unavailable = yield* turnOn(offered, async (set) => set.unavailable);
					const afterFirstAttempt = requests();
					yield* TestClock.adjust("59 seconds");
					yield* turnOn(offered);
					const beforeExpiry = requests() - afterFirstAttempt;
					yield* TestClock.adjust("1 second");
					yield* turnOn(offered);
					return {
						unavailable,
						beforeExpiry,
						afterExpiry: requests() - afterFirstAttempt - beforeExpiry,
					};
				}).pipe(Effect.provide(TestClock.layer())),
			);

			expect(checked.unavailable).toEqual(["locked"]);
			expect(checked.beforeExpiry).toBe(0);
			expect(checked.afterExpiry).toBeGreaterThan(0);
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
					set.tools.wiki__lookup?.tool.execute?.({ q: "missing" }, callOptions),
				),
			);

			expect(result).toMatchObject({
				isError: true,
				content: [{ type: "text", text: LOOKUP_REFUSAL }],
			});
		});

		it("tells the model what a server said when it turned a call away with an HTTP error, without the key it was sent", async () => {
			const limited = target({ url: url.replace(/\/mcp$/, "/limited") });

			const result = await run(
				turnOn(toolsFor(limited), async (set) =>
					set.tools.wiki__lookup?.tool.execute?.({ q: "it" }, callOptions),
				),
			);

			expect(result).toMatchObject({
				isError: true,
				content: [
					{
						type: "text",
						text: expect.stringMatching(
							/^The call failed with HTTP 429\. The server said: Rate limit reached for key …\. Try again in an hour/,
						),
					},
				],
			});
			expect(JSON.stringify(result)).not.toContain("open-sesame");
		});

		it("leaves out the access token of a connector signed in with OAuth when a server quotes it", async () => {
			const signedIn = target({
				url: url.replace(/\/mcp$/, "/limited"),
				auth: "oauth",
				headers: {},
			});
			const tokens = async () => ({ access_token: ACCESS_TOKEN, token_type: "Bearer" });
			const provider = oauthClient(fetch, signedIn.url, tokens, async () => undefined);
			const offered = ConnectorCatalog.from({
				connectors: {
					recordListing,
					targetForTurn,
					targetsForProject: () =>
						Effect.succeed({
							targets: [signedIn],
							signInExpired: [],
							installedUrls: [signedIn.url],
						}),
				},
				httpClients: { for: () => fetch },
				oauth: { clients: Effect.succeed({ for: () => provider }), fetch },
			});

			const result = await run(
				turnOn(offered, async (set) =>
					set.tools.wiki__lookup?.tool.execute?.({ q: "it" }, callOptions),
				),
			);

			expect(result).toMatchObject({
				isError: true,
				content: [
					{
						type: "text",
						text: expect.stringMatching(
							/^The call failed with HTTP 429\. The server said: Rate limit reached for key Bearer …\./,
						),
					},
				],
			});
			expect(JSON.stringify(result)).not.toContain(ACCESS_TOKEN);
		});

		it("asks again once the connector has been edited", async () => {
			const { connector, requests } = countedServer("/revised-connector", {
				connectorId: revisedId,
			});
			const targets = [connector];
			const offered = ConnectorCatalog.from({
				connectors: {
					recordListing,
					targetForTurn,
					targetsForProject: () =>
						Effect.succeed({
							targets,
							signInExpired: [],
							installedUrls: targets.map(({ url }) => url),
						}),
				},
				httpClients: { for: () => fetch },
			});
			await run(turnOn(offered));
			await onDatabase((db) =>
				db
					.update(connectorTable)
					.set({ configurationRevision: 2 })
					.where(eq(connectorTable.id, revisedId)),
			);
			targets[0] = { ...connector, configurationRevision: 2 };

			expect(await requestsDuring(requests, () => run(turnOn(offered)))).toBeGreaterThan(0);
		});

		it("asks again once its list is old, so a server's new tools are picked up", async () => {
			const { connector, requests } = countedServer("/expired-listing");
			const offered = toolsFor(connector);

			const lifetimeMs = Duration.toMillis(LISTING_LIFETIME);
			expect(lifetimeMs).toBe(Duration.toMillis(Duration.minutes(15)));

			const later = await run(
				Effect.gen(function* () {
					yield* turnOn(offered);
					const before = requests();
					yield* TestClock.adjust(Duration.millis(lifetimeMs - 1));
					yield* turnOn(offered);
					const fresh = requests() - before;
					yield* TestClock.adjust(Duration.millis(1));
					yield* turnOn(offered);
					return { fresh, old: requests() - before - fresh };
				}).pipe(Effect.provide(TestClock.layer())),
			);

			expect(later.fresh).toBe(0);
			expect(later.old).toBeGreaterThan(0);
		});
	});
});

/** A turn in the bot's own default project, so its connectors are that project's alone. */
