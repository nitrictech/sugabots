import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedBot, seedMember, seedWorkspace } from "../../authentication/seed.test-support.ts";
import { ProjectComputers } from "../../computers/project-computers.ts";
import type { Database } from "../../database/database.ts";
import { connector } from "../../database/schema.ts";
import {
	closeDatabase,
	onDatabase,
	type Promised,
	runOnPostgres,
	servedOnPostgres,
} from "../../database/testing.ts";
import type { MemberSession } from "../../principal.ts";
import {
	type CanManageProject,
	type CanReadConnectors,
	proveCanManageProject,
	proveCanReadConnectors,
} from "../../proofs/project-permissions.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesConnector } from "../../proofs/reaches-connector.ts";
import { proveReachesProject } from "../../proofs/reaches-project.ts";
import { authenticators, principals } from "../../proofs/world.test-support.ts";
import { unimplemented } from "../../testing.ts";
import { createEgressUrlValidator, Egress, urlValidation } from "../network/egress.ts";
import { ConnectorSignIn } from "./connector-sign-in.ts";
import { ConnectorStore } from "./connector-store.ts";
import { Connectors } from "./connectors.ts";
import { listServerTools } from "./mcp.ts";
import { startOAuthServer } from "./oauth-server.test-support.ts";

/**
 * The connectors service over the real store and Postgres, talking to a real
 * MCP server in this process, given proofs by the real provers for an admin
 * who manages a public bot's connectors, and a second server in this process
 * that signs in with OAuth. Who may do what is the operations' tests'.
 */

let http: Server;
let serverUrl: string;
let requestsReceived = 0;
let oauthServer: Awaited<ReturnType<typeof startOAuthServer>>;

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
	oauthServer = await startOAuthServer();
});

afterAll(async () => {
	http.closeAllConnections();
	await new Promise<void>((resolve) => http.close(() => resolve()));
	await oauthServer.close();
});

describe.skipIf(!process.env.DATABASE_URL)("connecting a project, against Postgres", () => {
	let connectors: Promised<ConnectorStore.Interface>;
	let member: (memberId: string) => Promise<MemberSession>;
	let administrator: MemberSession;
	let workspaceId: string;
	let adminId: string;
	let editorId: string;
	/** A public bot's default project, which holds its connectors. */
	let projectId: string;

	/**
	 * Runs `use` on the connectors service, under an egress policy allowing
	 * private addresses or not and OAuth as `signIn` says, with the proofs that
	 * the workspace's admin reads and manages the project's connectors.
	 */
	const managing = async <A, E>(
		use: <P, J>(
			service: Connectors.Interface,
			proofs: { canManage: CanManageProject<P, J>; canRead: CanReadConnectors<P, J> },
		) => Effect.Effect<A, E, Database>,
		options: ConnectorsOptions = {},
	): Promise<A> => {
		const principal = administrator;
		const service = await runOnPostgres(
			Effect.provide(Connectors.Service, connectorsLayer(options)),
		);
		return runOnPostgres(
			named(principal, projectId, (principal, project) =>
				Effect.gen(function* () {
					const reach = yield* proveReachesProject(principal, project);
					const canManage = yield* proveCanManageProject(reach);
					const canRead = yield* proveCanReadConnectors(reach);
					return yield* use(service, { canManage, canRead });
				}),
			),
		);
	};

	/**
	 * How the connectors service is built: whether egress allows private
	 * addresses, what the servers' requests go through (the network by
	 * default), and OAuth either as the real sign-in over the real store or as
	 * the double these cases stand in with, which `signIn` overrides in part.
	 */
	interface ConnectorsOptions {
		allowPrivateNetwork?: boolean;
		egressFetch?: typeof fetch;
		signIn?: Partial<ConnectorSignIn.Interface> | "real";
	}

	const connectorsLayer = ({
		allowPrivateNetwork = true,
		egressFetch = fetch,
		signIn,
	}: ConnectorsOptions) => {
		const egress = unimplemented(Egress.Service, {
			providers: { for: () => egressFetch },
			validateProviderUrl: urlValidation(createEgressUrlValidator({ allowPrivateNetwork })),
			oauth: egressFetch,
			webFetch: egressFetch,
		});
		return Connectors.layerNoDeps.pipe(
			Layer.provide([
				ConnectorStore.layer,
				unimplemented(ProjectComputers.Service, {}),
				signIn === "real"
					? ConnectorSignIn.layerNoDeps.pipe(Layer.provide([ConnectorStore.layer, egress]))
					: Layer.succeed(ConnectorSignIn.Service, {
							clients: Effect.succeed({
								for: () => ({ sentTokens: () => new Set<string>(), fetch }),
							}),
							begin: () => Effect.succeed({ authorizationUrl: "https://auth.example/authorize" }),
							finish: () => Effect.void,
							...signIn,
						}),
				egress,
			]),
		);
	};

	/**
	 * An OAuth connector to `url` waiting on the sign-in whose state is
	 * `state`, which `startedByMemberId`, by default the administrator, started.
	 */
	const waitingOnSignIn = async (url: string, state: string, startedByMemberId = adminId) => {
		const made = await connectors.create(workspaceId, projectId, adminId, {
			name: `Signs in ${state}`,
			url,
			auth: "oauth",
		});
		const session = startedByMemberId === adminId ? administrator : await member(startedByMemberId);
		await connectors.saveOauthRecord(
			workspaceId,
			made.id,
			{
				state,
				startedByMemberId,
				startedBySessionId: session.session,
			},
			{ kind: "since", version: null },
		);
		return made;
	};

	/** The sign-in `state` belongs to, finished with `callback` by the admin. */
	const finishing = (
		state: string,
		callback: { code?: string; error?: string; errorDescription?: string },
		signIn?: ConnectorsOptions["signIn"],
		wrongSessionConnectorId?: string,
		options: Omit<ConnectorsOptions, "signIn"> = {},
	) =>
		managing(
			(service, { canManage }) =>
				Effect.gen(function* () {
					const record = yield* service.signInWaitingOn(state, administrator);
					const connectorId = record?.connectorId ?? wrongSessionConnectorId;
					if (!connectorId) throw new Error("Expected a connector");
					return yield* named(connectorId, (connector) =>
						Effect.gen(function* () {
							const { reach } = canManage;
							const { target } = yield* proveReachesConnector(
								reach.principal,
								reach.project,
								connector,
							);
							return yield* service.finishSignIn(canManage, connector, target, {
								...callback,
								state,
							});
						}),
					);
				}),
			{ ...options, signIn },
		);

	beforeAll(async () => {
		connectors = await servedOnPostgres(ConnectorStore.Service, ConnectorStore.layer);
		member = principals(await authenticators()).member;
	});

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		workspaceId = await seedWorkspace();
		adminId = await seedMember(workspaceId, "admin");
		administrator = await member(adminId);
		editorId = await seedMember(workspaceId, "editor");
		projectId = (await seedBot(workspaceId)).defaultProject;
	});

	const listed = () => managing((service, { canRead }) => service.list(canRead));

	/** The connector `connectorId` of the project, with its tools. */
	const shown = (connectorId: string, options?: ConnectorsOptions) =>
		managing(
			(service, { canRead }) =>
				named(connectorId, (connector) =>
					Effect.gen(function* () {
						const { reach } = canRead;
						const { target } = yield* proveReachesConnector(
							reach.principal,
							reach.project,
							connector,
						);
						return yield* service.get(canRead, connector, target);
					}),
				),
			options,
		);

	const testing = (connectorId: string, options?: ConnectorsOptions) =>
		managing(
			(service, { canManage }) =>
				named(connectorId, (connector) =>
					Effect.gen(function* () {
						const { reach } = canManage;
						const { target } = yield* proveReachesConnector(
							reach.principal,
							reach.project,
							connector,
						);
						return yield* service.test(canManage, connector, target);
					}),
				),
			options,
		);

	it("learns a server's tools as soon as it is added", async () => {
		const made = await managing((service, { canManage }) =>
			service.create(canManage, {
				name: "Wiki",
				url: `${serverUrl}/mcp`,
				secretHeader: "x-fixture-key",
				secret: "open-sesame",
			}),
		);

		expect(made).toMatchObject({ status: "connected", tools: [{ name: "lookup" }] });
	});

	it("tests an address and secret before a connector is made, saving nothing", async () => {
		const tested = await managing((service, { canManage }) =>
			service.testUnsaved(canManage, {
				url: `${serverUrl}/mcp`,
				secretHeader: "x-fixture-key",
				secret: "open-sesame",
			}),
		);

		expect(tested).toMatchObject({ reachable: true, tools: 1 });
		expect(await listed()).toEqual([]);
	});

	it("refuses an address the network policy forbids, and stores nothing", async () => {
		await expect(
			managing(
				(service, { canManage }) =>
					service.create(canManage, { name: "Local", url: `${serverUrl}/mcp` }),
				{ allowPrivateNetwork: false },
			),
		).rejects.toMatchObject({ _tag: "UrlNotAllowed" });
		expect(await listed()).toEqual([]);
	});

	it("records on a connected connector what the protocol says once its server can't be reached, keeping the network's words out", async () => {
		const networkDetail = "connect ECONNREFUSED 10.9.8.7:1234";
		const refusing: typeof fetch = async () => {
			throw new TypeError("fetch failed", { cause: new Error(networkDetail) });
		};
		const server = { url: `${serverUrl}/mcp`, headers: { "x-fixture-key": "open-sesame" } };
		const made = await managing((service, { canManage }) =>
			service.create(canManage, {
				name: "Wiki",
				url: server.url,
				secretHeader: "x-fixture-key",
				secret: "open-sesame",
			}),
		);
		const said = await listServerTools(server, refusing);
		if (said.ok) throw new Error("The refusing transport reached the server");

		const tested = await testing(made.id, { egressFetch: refusing });

		expect(made).toMatchObject({ status: "connected", lastTestError: null });
		expect(tested).toMatchObject({ reachable: false, error: said.reason });
		expect(JSON.stringify(tested)).not.toContain(networkDetail);
		expect(await shown(made.id)).toMatchObject({ status: "error", lastTestError: said.reason });
	});

	it("adds an HTTP endpoint without sending it a request", async () => {
		const before = requestsReceived;

		const made = await managing((service, { canManage }) =>
			service.create(canManage, {
				kind: "http",
				name: "Alerts",
				url: `${serverUrl}/v2`,
				secretHeader: "authorization",
				secret: "Bearer alerts-key",
			}),
		);

		expect(made).toMatchObject({ kind: "http", status: "connected", hasSecret: true });
		expect((await shown(made.id)).tools.map((tool) => tool.access)).toEqual([
			"allow",
			"ask",
			"ask",
			"ask",
			"off",
		]);
		expect(requestsReceived).toBe(before);
	});

	it("records an HTTP endpoint's address the network policy no longer allows", async () => {
		const made = await managing((service, { canManage }) =>
			service.create(canManage, { kind: "http", name: "Local", url: `${serverUrl}/v2` }),
		);

		const tested = await testing(made.id, {
			allowPrivateNetwork: false,
		});

		expect(tested).toMatchObject({ reachable: false, error: expect.any(String) });
		expect(await shown(made.id)).toMatchObject({ status: "error" });
	});

	it("takes nothing back from a sign-in that could not start", async () => {
		const begin = () =>
			Effect.fail(
				new ConnectorSignIn.SignInFailed({
					step: "begin",
					cause: new Error(
						"Incompatible auth server: does not support dynamic client registration",
					),
				}),
			);

		await expect(
			managing(
				(service, { canManage }) =>
					service.connectBuiltIn(canManage, {
						name: "GitHub",
						url: "https://api.githubcopilot.com/mcp/",
					}),
				{ signIn: { begin } },
			),
		).rejects.toMatchObject({
			_tag: "ConnectorOAuthStartFailed",
			userMessage:
				"Sugabots can't use this server's sign-in, because the server doesn't let new apps register themselves. Connect it with an access token from the server instead.",
		});
		expect(await listed()).toEqual([]);
	});

	it("keeps no connector for a built-in connector that needed no sign-in", async () => {
		await expect(
			managing(
				(service, { canManage }) =>
					service.connectBuiltIn(canManage, { name: "Open", url: `${serverUrl}/open` }),
				{ signIn: { begin: () => Effect.succeed({ authorized: true as const }) } },
			),
		).rejects.toMatchObject({ _tag: "ConnectorNeededNoSignIn" });
		expect(await listed()).toEqual([]);
	});

	describe("finishing a sign-in", () => {
		it("signs in as the member who finished it, with the token it exchanged, learns the connector's tools and names the project", async () => {
			const started = await managing(
				(service, { canManage }) =>
					service.connectBuiltIn(canManage, { name: "Wiki", url: oauthServer.serverUrl }),
				{ signIn: "real" },
			);
			const state = new URL(started.authorizationUrl).searchParams.get("state");
			if (!state) throw new Error("The authorization URL carried no state");
			// Somebody else added it, so whose sign-in it is shows apart from who added it.
			await onDatabase((db) =>
				db
					.update(connector)
					.set({ installedById: editorId })
					.where(eq(connector.id, started.connectorId)),
			);
			const before = await shown(started.connectorId, { signIn: "real" });

			const outcome = await finishing(state, { code: "the-code" }, "real");

			expect(before).toMatchObject({ signedIn: false, tools: [] });
			expect(outcome).toEqual({ kind: "done", at: { workspaceId, projectId } });
			expect(await shown(started.connectorId, { signIn: "real" })).toMatchObject({
				signedIn: true,
				signedInAs: { id: adminId },
				tools: [{ name: "lookup" }],
			});
			expect(oauthServer.tokenRequests.at(-1)?.get("code")).toBe("the-code");
		});

		it("exchanges the code under the connector's claim, so nothing saves over the sign-in meanwhile", async () => {
			const started = await managing(
				(service, { canManage }) =>
					service.connectBuiltIn(canManage, { name: "Notes", url: oauthServer.serverUrl }),
				{ signIn: "real" },
			);
			const state = new URL(started.authorizationUrl).searchParams.get("state");
			if (!state) throw new Error("The authorization URL carried no state");
			const exchanging = Promise.withResolvers<void>();
			const answered = Promise.withResolvers<void>();
			const egressFetch: typeof fetch = async (input, init) => {
				if (new Request(input, init).url === `${oauthServer.origin}/token`) {
					exchanging.resolve();
					await answered.promise;
				}
				return fetch(input, init);
			};

			const finished = finishing(state, { code: "the-code" }, "real", undefined, { egressFetch });
			await exchanging.promise;
			const meanwhile = await connectors.claimOauthExchange(
				workspaceId,
				started.connectorId,
				oauthServer.serverUrl,
			);
			if (meanwhile !== undefined && meanwhile !== "busy") {
				await connectors.releaseOauthExchange(workspaceId, started.connectorId, meanwhile);
			}
			answered.resolve();

			expect(meanwhile).toBe("busy");
			expect(await finished).toEqual({ kind: "done", at: { workspaceId, projectId } });
			expect(await shown(started.connectorId, { signIn: "real" })).toMatchObject({
				signedIn: true,
			});
		});

		it("does not finish for anybody but the member who started it", async () => {
			const made = await waitingOnSignIn(`${serverUrl}/open`, "state-other", editorId);

			expect(await finishing("state-other", { code: "the-code" }, undefined, made.id)).toEqual({
				kind: "failed",
				failure: "unknown_state",
				at: undefined,
			});
			expect(await shown(made.id)).toMatchObject({ signedIn: false, tools: [] });
		});

		it("gives a code, not the authorization server's words, when it refused", async () => {
			await waitingOnSignIn(`${serverUrl}/open`, "state-refused");

			expect(
				await finishing("state-refused", {
					error: "access_denied",
					errorDescription: "Visit evil.example to continue",
				}),
			).toEqual({ kind: "failed", failure: "refused", at: { workspaceId, projectId } });
		});

		it("gives a code when the code could not be exchanged for tokens", async () => {
			await waitingOnSignIn(`${serverUrl}/open`, "state-bad-code");
			const finish = () =>
				Effect.fail(
					new ConnectorSignIn.SignInFailed({ step: "finish", cause: new Error("invalid_grant") }),
				);

			expect(await finishing("state-bad-code", { code: "stale" }, { finish })).toEqual({
				kind: "failed",
				failure: "not_completed",
				at: { workspaceId, projectId },
			});
		});
	});
});
