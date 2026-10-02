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
	connection,
	pod,
	podMember,
	user,
	workspace,
	workspaceMember,
} from "../../database/schema.ts";
import {
	closeDatabase,
	onDatabase,
	type Promised,
	servedOnPostgres,
} from "../../database/testing.ts";
import { servedOnPostgresAs } from "../../workspaces/testing.ts";
import { createEgressUrlValidator, Egress, urlValidation } from "../network/egress.ts";
import { ConnectionRepository } from "./connection-repository.ts";
import { ConnectionSetup } from "./connection-setup.ts";
import { ConnectionSignIn } from "./connection-sign-in.ts";
import { storedOAuthProvider } from "./oauth.ts";

/**
 * The setup over the real repository and Postgres, talking to a real MCP
 * server in this process. Only the OAuth exchange with an authorization server
 * is a double, since none runs here.
 */

let http: Server;
let serverUrl: string;

beforeAll(async () => {
	http = createServer(async (request, response) => {
		// `/open` takes anybody, as a server signed in to with OAuth would once
		// it has a token; `/token` wants a bearer token; `/signs-in` names an
		// OAuth server to get one from; `/mcp` wants the connection's secret.
		const allowed =
			request.url === "/open" ||
			(request.url === "/token" && request.headers.authorization === "Bearer open-sesame") ||
			request.headers["x-fixture-key"] === "open-sesame";
		if (request.url === "/signs-in") {
			response
				.writeHead(401, {
					"www-authenticate": `Bearer resource_metadata="${serverUrl}/.well-known/oauth-protected-resource/signs-in"`,
				})
				.end();
			return;
		}
		if (!allowed) {
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

describe.skipIf(!process.env.DATABASE_URL)("setting up connections, against Postgres", () => {
	let connections: Promised<ConnectionRepository.Interface>;
	let workspaceId: string;
	let adminId: string;
	let memberId: string;
	let podId: string;

	/**
	 * The setup as `as`, by default the workspace's administrator, under an
	 * egress policy allowing private addresses or not, and OAuth as `signIn`
	 * says.
	 */
	const setupWith = async (
		options: {
			allowPrivateNetwork?: boolean;
			signIn?: Partial<ConnectionSignIn.Interface>;
			as?: string;
		} = {},
	) =>
		(
			await servedOnPostgresAs(
				ConnectionSetup.Service,
				ConnectionSetup.layerNoDeps.pipe(
					Layer.provide([
						Authorization.layer,
						ConnectionRepository.layer,
						Layer.succeed(ConnectionSignIn.Service, {
							clients: Effect.succeed({
								for: () =>
									storedOAuthProvider(
										{ load: async () => undefined, save: async () => {} },
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

	const inPod = () => ({ podId });

	/**
	 * An OAuth connection to `url` waiting on the sign-in whose state is
	 * `state`, which `startedByUserId`, by default the administrator, started.
	 */
	const waitingOnSignIn = async (url: string, state: string, startedByUserId = adminId) => {
		const made = await connections.create(workspaceId, podId, adminId, {
			name: `Signs in ${state}`,
			url,
			auth: "oauth",
		});
		await connections.saveOauthRecord(workspaceId, made.id, { state, startedByUserId });
		return made;
	};

	beforeAll(async () => {
		connections = await servedOnPostgres(ConnectionRepository.Service, ConnectionRepository.layer);
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
		const [admin, member] = await onDatabase((db) =>
			db
				.insert(user)
				.values([
					{ name: "Sam", email: `sam-${stamp}@example.com` },
					{ name: "Kim", email: `kim-${stamp}@example.com` },
				])
				.returning(),
		);
		if (!space || !admin || !member) throw new Error("fixture");
		workspaceId = space.id;
		adminId = admin.id;
		memberId = member.id;
		await onDatabase((db) =>
			db.insert(workspaceMember).values([
				{ workspaceId, userId: adminId, role: "admin" },
				{ workspaceId, userId: memberId, role: "member" },
			]),
		);
		const [room] = await onDatabase((db) =>
			db
				.insert(pod)
				.values({ workspaceId, kind: "shared", name: "Support", slug: `support-${stamp}` })
				.returning(),
		);
		if (!room) throw new Error("fixture");
		podId = room.id;
		await onDatabase((db) => db.insert(podMember).values({ workspaceId, podId, userId: memberId }));
	});

	it("learns a server's tools as soon as it is added", async () => {
		const setup = await setupWith();

		const made = await setup.create({
			...inPod(),
			connection: {
				name: "Wiki",
				url: `${serverUrl}/mcp`,
				secretHeader: "x-fixture-key",
				secret: "open-sesame",
			},
		});

		expect(made).toMatchObject({ status: "connected", tools: [{ name: "lookup" }] });
	});

	it("refuses an address the network policy forbids, and stores nothing", async () => {
		const setup = await setupWith({ allowPrivateNetwork: false });

		await expect(
			setup.create({
				...inPod(),
				connection: { name: "Local", url: `${serverUrl}/mcp` },
			}),
		).rejects.toMatchObject({ _tag: "UrlNotAllowed" });
		expect(await setup.list(inPod())).toEqual([]);
	});

	it("records a server it cannot reach in its own words, keeping the network's out", async () => {
		const setup = await setupWith();
		const made = await setup.create({
			...inPod(),
			connection: { name: "Gone", url: "http://127.0.0.1:9/mcp" },
		});

		const tested = await setup.test({ ...inPod(), connectionId: made.id });

		const unreachable =
			"The server could not be reached. Check the address and port, and that the server is running";
		expect(tested).toMatchObject({ reachable: false, error: unreachable, problem: "unreachable" });
		const [stored] = await onDatabase((db) =>
			db
				.select({ error: connection.lastTestError })
				.from(connection)
				.where(eq(connection.id, made.id)),
		);
		expect(stored?.error).toBe(unreachable);
	});

	it("sends an access token as a bearer token, however it was pasted", async () => {
		const setup = await setupWith();

		const made = await setup.create({
			...inPod(),
			connection: {
				name: "Wiki",
				url: `${serverUrl}/token`,
				auth: "token",
				token: " Bearer open-sesame\n",
			},
		});

		expect(made).toMatchObject({
			status: "connected",
			bearerToken: true,
			secretHeader: "Authorization",
			tools: [{ name: "lookup" }],
		});
	});

	it("says a refused access token needs replacing, and why, and takes a new one", async () => {
		const setup = await setupWith();
		const made = await setup.create({
			...inPod(),
			connection: { name: "Wiki", url: `${serverUrl}/token`, auth: "token", token: "expired" },
		});

		expect(made).toMatchObject({
			status: "error",
			lastTestError:
				"The server didn't accept the access token. Check that it hasn't expired and was copied in full",
			problem: "unauthorized",
			problemDetail: "HTTP 401",
		});

		const replaced = await setup.update({
			...inPod(),
			connectionId: made.id,
			changes: { token: "open-sesame" },
		});
		expect(replaced).toMatchObject({ status: "connected", problem: null, problemDetail: null });
	});

	it("tells a server that offers a sign-in from one that only wants a token", async () => {
		const setup = await setupWith();

		expect(await setup.probe({ ...inPod(), url: `${serverUrl}/signs-in` })).toEqual({
			signIn: true,
		});
		expect(await setup.probe({ ...inPod(), url: `${serverUrl}/token` })).toEqual({
			signIn: false,
		});
		expect(await setup.probe({ ...inPod(), url: `${serverUrl}/open` })).toEqual({
			signIn: false,
		});
	});

	it("takes nothing back from a sign-in that could not start", async () => {
		const setup = await setupWith({
			signIn: {
				begin: () =>
					Effect.fail(
						new ConnectionSignIn.SignInFailed({
							step: "begin",
							cause: new Error("Incompatible auth server: no dynamic client registration"),
						}),
					),
			},
		});

		await expect(
			setup.connectFromCatalog({
				...inPod(),
				server: { name: "GitHub", url: "https://api.githubcopilot.com/mcp/" },
			}),
		).rejects.toMatchObject({
			_tag: "ConnectionOAuthStartFailed",
			userMessage: "Could not start signing in to that server",
		});
		expect(await setup.list(inPod())).toEqual([]);
	});

	it("keeps no connection for a catalogued server that needed no sign-in", async () => {
		const setup = await setupWith({
			signIn: { begin: () => Effect.succeed({ authorized: true as const }) },
		});

		await expect(
			setup.connectFromCatalog({
				...inPod(),
				server: { name: "Open", url: `${serverUrl}/open` },
			}),
		).rejects.toMatchObject({ _tag: "ConnectionNeededNoSignIn" });
		expect(await setup.list(inPod())).toEqual([]);
	});

	it("lets a member of the pod see its connections, and change none of them", async () => {
		const setup = await setupWith({ as: memberId });

		expect(await setup.list(inPod())).toEqual([]);
		await expect(
			setup.create({ ...inPod(), connection: { name: "Wiki", url: `${serverUrl}/mcp` } }),
		).rejects.toBeInstanceOf(ActionForbidden);
		expect(await setup.list(inPod())).toEqual([]);
	});

	describe("finishing a sign-in", () => {
		it("turns the connection on, learns its tools, and names the pod", async () => {
			const setup = await setupWith();
			const made = await waitingOnSignIn(`${serverUrl}/open`, "state-ok");

			const outcome = await setup.completeOAuth({
				callback: { code: "the-code", state: "state-ok" },
			});

			expect(outcome).toEqual({ pod: { workspaceId, podId } });
			expect(await setup.get({ ...inPod(), connectionId: made.id })).toMatchObject({
				access: "allow",
				tools: [{ name: "lookup" }],
			});
		});

		it.each([
			{ case: "without its state", callback: { code: "c" }, failure: "missing_state" },
			{
				case: "for no connection",
				callback: { code: "c", state: "nobody" },
				failure: "unknown_state",
			},
		])("gives only a code for a callback $case", async ({ callback, failure }) => {
			const setup = await setupWith();

			expect(await setup.completeOAuth({ callback })).toEqual({ failure });
		});

		it("does not finish for anybody but the person who started it", async () => {
			const setup = await setupWith();
			const made = await waitingOnSignIn(`${serverUrl}/open`, "state-other", memberId);

			expect(
				await setup.completeOAuth({ callback: { code: "the-code", state: "state-other" } }),
			).toEqual({ failure: "not_allowed" });
			expect(await setup.get({ ...inPod(), connectionId: made.id })).toMatchObject({
				access: "off",
			});
		});

		it("does not finish for somebody who may not manage the pod's connections", async () => {
			const setup = await setupWith({ as: memberId });
			await waitingOnSignIn(`${serverUrl}/open`, "state-member", memberId);

			expect(
				await setup.completeOAuth({
					callback: { code: "the-code", state: "state-member" },
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
			).toEqual({ failure: "refused", pod: { workspaceId, podId } });
		});

		it("gives a code when the code could not be exchanged for tokens", async () => {
			const setup = await setupWith({
				signIn: {
					finish: () =>
						Effect.fail(
							new ConnectionSignIn.SignInFailed({
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
			).toEqual({ failure: "not_completed", pod: { workspaceId, podId } });
		});
	});
});
