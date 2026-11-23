import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ActionForbidden } from "../../authorization/access.ts";
import { Authorization } from "../../authorization/authorization.ts";
import {
	bot as botTable,
	connector,
	membership,
	person,
	project,
	workspace,
} from "../../database/schema.ts";
import {
	closeDatabase,
	onDatabase,
	type Promised,
	servedOnPostgres,
} from "../../database/testing.ts";
import { servedOnPostgresAs } from "../../workspaces/testing.ts";
import { createEgressUrlValidator, Egress, urlValidation } from "../network/egress.ts";
import { ConnectorSetup } from "./connector-setup.ts";
import { ConnectorSignIn } from "./connector-sign-in.ts";
import { ConnectorStore } from "./connector-store.ts";
import { storedOAuthProvider } from "./oauth.ts";

/**
 * The setup over the real store and Postgres, talking to a real MCP
 * server in this process. Only the OAuth exchange with an authorization server
 * is a double, since none runs here.
 */

let http: Server;
let serverUrl: string;
let requestsReceived = 0;

beforeAll(async () => {
	http = createServer(async (request, response) => {
		requestsReceived += 1;
		// `/open` takes anybody, as a server signed in to with OAuth would once
		// it has a token; `/mcp` wants the connector's secret.
		if (request.url !== "/open" && request.headers["x-fixture-key"] !== "open-sesame") {
			response.writeHead(401).end("who are you");
			return;
		}
		const mcp = new McpServer({ name: "fixture", version: "1.0.0" });
		mcp.registerTool("lookup", { description: "Looks a thing up." }, async () => ({
			content: [{ type: "text", text: "found" }],
		}));
		const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
		await mcp.connect(transport);
		await transport.handleRequest(request, response);
		response.on("close", () => void transport.close());
	});
	await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
	serverUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterAll(async () => {
	http.closeAllConnections();
	await new Promise<void>((resolve) => http.close(() => resolve()));
});

describe.skipIf(!process.env.DATABASE_URL)("setting up connectors, against Postgres", () => {
	let connectors: Promised<ConnectorStore.Interface>;
	let workspaceId: string;
	let adminId: string;
	let editorId: string;
	let projectId: string;

	/**
	 * The setup as `as`, by default the workspace's administrator, under an
	 * egress policy allowing private addresses or not, and OAuth as `signIn`
	 * says.
	 */
	const setupWith = async (
		options: {
			allowPrivateNetwork?: boolean;
			signIn?: Partial<ConnectorSignIn.Interface>;
			as?: string;
		} = {},
	) =>
		(
			await servedOnPostgresAs(
				ConnectorSetup.Service,
				ConnectorSetup.layerNoDeps.pipe(
					Layer.provide([
						Authorization.layer,
						ConnectorStore.layer,
						Layer.succeed(ConnectorSignIn.Service, {
							clients: Effect.succeed({
								for: () =>
									storedOAuthProvider(
										{
											load: async () => undefined,
											save: async () => {},
											now: async () => new Date("2026-10-05T21:00:08.000Z"),
										},
										{ redirectUrl: "http://localhost:3000/callback", clientName: "Test" },
									),
							}),
							begin: () => Effect.succeed({ authorizationUrl: "https://auth.example/authorize" }),
							finish: () => Effect.void,
							...options.signIn,
						}),
						Layer.succeed(Egress.Service, {
							providers: { for: () => fetch },
							validateProviderUrl: urlValidation(
								createEgressUrlValidator({
									allowPrivateNetwork: options.allowPrivateNetwork ?? true,
								}),
							),
							oauth: fetch,
							webFetch: fetch,
						}),
					]),
				),
			)
		)(options.as ?? adminId);

	const ofProject = () => ({ projectId });

	/**
	 * An OAuth connector to `url` waiting on the sign-in whose state is
	 * `state`, which `startedByPersonId`, by default the administrator, started.
	 */
	const waitingOnSignIn = async (url: string, state: string, startedByPersonId = adminId) => {
		const made = await connectors.create(workspaceId, projectId, adminId, {
			name: `Signs in ${state}`,
			url,
			auth: "oauth",
		});
		await connectors.saveOauthRecord(workspaceId, made.id, { state, startedByPersonId });
		return made;
	};

	beforeAll(async () => {
		connectors = await servedOnPostgres(ConnectorStore.Service, ConnectorStore.layer);
	});

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: `Setup ${stamp}`, slug: `setup-${stamp}` })
				.returning(),
		);
		const [admin, editor] = await onDatabase((db) =>
			db
				.insert(person)
				.values([
					{ name: "Sam", email: `sam-${stamp}@example.com` },
					{ name: "Kim", email: `kim-${stamp}@example.com` },
				])
				.returning(),
		);
		if (!space || !admin || !editor) throw new Error("fixture");
		workspaceId = space.id;
		adminId = admin.id;
		editorId = editor.id;
		await onDatabase((db) =>
			db.insert(membership).values([
				{ workspaceId, personId: adminId, role: "admin" },
				{ workspaceId, personId: editorId, role: "editor" },
			]),
		);
		const [bot] = await onDatabase((db) =>
			db
				.insert(botTable)
				.values({
					workspaceId,
					name: "Helper",
					handle: "helper",
					color: "sky",
					eyes: "pill",
				})
				.returning(),
		);
		if (!bot) throw new Error("fixture");
		// A bot's connectors are its default project's.
		const [own] = await onDatabase((db) =>
			db.select({ id: project.id }).from(project).where(eq(project.defaultOfBotId, bot.id)),
		);
		if (!own) throw new Error("default project fixture");
		projectId = own.id;
	});

	it("learns a server's tools as soon as it is added", async () => {
		const setup = await setupWith();

		const made = await setup.create({
			...ofProject(),
			connector: {
				name: "Wiki",
				url: `${serverUrl}/mcp`,
				secretHeader: "x-fixture-key",
				secret: "open-sesame",
			},
		});

		expect(made).toMatchObject({ status: "connected", tools: [{ name: "lookup" }] });
	});

	it("tests an address and secret before a connector is made, saving nothing", async () => {
		const setup = await setupWith();

		const tested = await setup.testUnsaved({
			...ofProject(),
			server: { url: `${serverUrl}/mcp`, secretHeader: "x-fixture-key", secret: "open-sesame" },
		});

		expect(tested).toMatchObject({ reachable: true, tools: 1 });
		expect(await setup.list(ofProject())).toEqual([]);
	});

	it("refuses an address the network policy forbids, and stores nothing", async () => {
		const setup = await setupWith({ allowPrivateNetwork: false });

		await expect(
			setup.create({
				...ofProject(),
				connector: { name: "Local", url: `${serverUrl}/mcp` },
			}),
		).rejects.toMatchObject({ _tag: "UrlNotAllowed" });
		expect(await setup.list(ofProject())).toEqual([]);
	});

	it("records a server it cannot reach in its own words, keeping the network's out", async () => {
		const setup = await setupWith();
		const made = await setup.create({
			...ofProject(),
			connector: { name: "Gone", url: "http://127.0.0.1:9/mcp" },
		});

		const tested = await setup.test({ ...ofProject(), connectorId: made.id });

		expect(tested).toMatchObject({
			reachable: false,
			error:
				"The server could not be reached. Check the address and port, and that the server is running",
		});
		const [stored] = await onDatabase((db) =>
			db
				.select({ error: connector.lastTestError })
				.from(connector)
				.where(eq(connector.id, made.id)),
		);
		expect(stored?.error).toBe(
			"The server could not be reached. Check the address and port, and that the server is running",
		);
	});

	it("adds an HTTP endpoint without sending it a request", async () => {
		const setup = await setupWith();
		const before = requestsReceived;

		const made = await setup.create({
			...ofProject(),
			connector: {
				kind: "http",
				name: "Alerts",
				url: `${serverUrl}/v2`,
				secretHeader: "authorization",
				secret: "Bearer alerts-key",
			},
		});

		expect(made).toMatchObject({ kind: "http", status: "connected", hasSecret: true });
		expect(
			(await setup.get({ ...ofProject(), connectorId: made.id })).tools.map((tool) => tool.access),
		).toEqual(["allow", "ask", "ask", "ask", "off"]);
		expect(requestsReceived).toBe(before);
	});

	it("records an HTTP endpoint's address the network policy no longer allows", async () => {
		const made = await (await setupWith()).create({
			...ofProject(),
			connector: { kind: "http", name: "Local", url: `${serverUrl}/v2` },
		});
		const setup = await setupWith({ allowPrivateNetwork: false });

		const tested = await setup.test({ ...ofProject(), connectorId: made.id });

		expect(tested).toMatchObject({ reachable: false, error: expect.any(String) });
		expect(await setup.get({ ...ofProject(), connectorId: made.id })).toMatchObject({
			status: "error",
		});
	});

	it("takes nothing back from a sign-in that could not start", async () => {
		const setup = await setupWith({
			signIn: {
				begin: () =>
					Effect.fail(
						new ConnectorSignIn.SignInFailed({
							step: "begin",
							cause: new Error(
								"Incompatible auth server: does not support dynamic client registration",
							),
						}),
					),
			},
		});

		await expect(
			setup.connectBuiltIn({
				...ofProject(),
				server: { name: "GitHub", url: "https://api.githubcopilot.com/mcp/" },
			}),
		).rejects.toMatchObject({
			_tag: "ConnectorOAuthStartFailed",
			userMessage:
				"Sugabots can't use this server's sign-in, because the server doesn't let new apps register themselves. Connect it with an access token from the server instead.",
		});
		expect(await setup.list(ofProject())).toEqual([]);
	});

	it("keeps no connector for a built-in connector that needed no sign-in", async () => {
		const setup = await setupWith({
			signIn: { begin: () => Effect.succeed({ authorized: true as const }) },
		});

		await expect(
			setup.connectBuiltIn({
				...ofProject(),
				server: { name: "Open", url: `${serverUrl}/open` },
			}),
		).rejects.toMatchObject({ _tag: "ConnectorNeededNoSignIn" });
		expect(await setup.list(ofProject())).toEqual([]);
	});

	it("lets an editor who reaches the bot see its connectors, and change none of them", async () => {
		const setup = await setupWith({ as: editorId });

		expect(await setup.list(ofProject())).toEqual([]);
		await expect(
			setup.create({ ...ofProject(), connector: { name: "Wiki", url: `${serverUrl}/mcp` } }),
		).rejects.toBeInstanceOf(ActionForbidden);
		expect(await setup.list(ofProject())).toEqual([]);
	});

	describe("finishing a sign-in", () => {
		it("learns the connector's tools and names the bot", async () => {
			const setup = await setupWith();
			const made = await waitingOnSignIn(`${serverUrl}/open`, "state-ok");

			const outcome = await setup.completeOAuth({
				callback: { code: "the-code", state: "state-ok" },
			});

			expect(outcome).toEqual({ at: { workspaceId, projectId } });
			expect(await setup.get({ ...ofProject(), connectorId: made.id })).toMatchObject({
				tools: [{ name: "lookup" }],
			});
		});

		it.each([
			{ case: "without its state", callback: { code: "c" }, failure: "missing_state" },
			{
				case: "for no connector",
				callback: { code: "c", state: "nobody" },
				failure: "unknown_state",
			},
		])("gives only a code for a callback $case", async ({ callback, failure }) => {
			const setup = await setupWith();

			expect(await setup.completeOAuth({ callback })).toEqual({ failure });
		});

		it("does not finish for anybody but the person who started it", async () => {
			const setup = await setupWith();
			const made = await waitingOnSignIn(`${serverUrl}/open`, "state-other", editorId);

			expect(
				await setup.completeOAuth({ callback: { code: "the-code", state: "state-other" } }),
			).toEqual({ failure: "not_allowed" });
			expect(await setup.get({ ...ofProject(), connectorId: made.id })).toMatchObject({
				signedIn: false,
				tools: [],
			});
		});

		it("does not finish for somebody who may not manage the bot's connectors", async () => {
			const setup = await setupWith({ as: editorId });
			await waitingOnSignIn(`${serverUrl}/open`, "state-editor", editorId);

			expect(
				await setup.completeOAuth({
					callback: { code: "the-code", state: "state-editor" },
				}),
			).toEqual({ failure: "not_allowed" });
		});

		it("gives a code, not the authorization server's words, when it refused", async () => {
			const setup = await setupWith();
			await waitingOnSignIn(`${serverUrl}/open`, "state-refused");

			expect(
				await setup.completeOAuth({
					callback: {
						state: "state-refused",
						error: "access_denied",
						errorDescription: "Visit evil.example to continue",
					},
				}),
			).toEqual({ failure: "refused", at: { workspaceId, projectId } });
		});

		it("gives a code when the code could not be exchanged for tokens", async () => {
			const setup = await setupWith({
				signIn: {
					finish: () =>
						Effect.fail(
							new ConnectorSignIn.SignInFailed({
								step: "finish",
								cause: new Error("invalid_grant"),
							}),
						),
				},
			});
			await waitingOnSignIn(`${serverUrl}/open`, "state-bad-code");

			expect(
				await setup.completeOAuth({
					callback: { code: "stale", state: "state-bad-code" },
				}),
			).toEqual({ failure: "not_completed", at: { workspaceId, projectId } });
		});
	});
});
