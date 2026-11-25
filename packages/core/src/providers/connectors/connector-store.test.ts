import { createHash } from "node:crypto";
import type { ConnectorTool, NewConnector } from "@sugabots/contracts";
import { and, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedConnector, seedMember } from "../../authentication/seed.test-support.ts";
import { query } from "../../database/database.ts";
import {
	bot as botTable,
	connector,
	member,
	membership,
	project,
	workspace,
} from "../../database/schema.ts";
import {
	closeDatabase,
	holdTransaction,
	onDatabase,
	type Promised,
	runOnPostgres,
	servedOnPostgres,
} from "../../database/testing.ts";
import { signedIn } from "../../operations/chats/testing.ts";
import { underWorkspaceLock } from "../../proofs/workspace-lock.ts";
import { Secrets } from "../../secrets/secrets.ts";
import { connectorIn, connectorsIn } from "./connector-reads.ts";
import { ConnectorStore } from "./connector-store.ts";
import { GITHUB_CONNECTOR_TOOLS } from "./github/github-tools.ts";
import { SignInRequired, storedOAuthProvider } from "./oauth.ts";

describe.skipIf(!process.env.DATABASE_URL)("connectors, against Postgres", () => {
	let connectors: Promised<ConnectorStore.Interface>;
	let workspaceId: string;
	let memberId: string;
	let projectId: string;
	let otherProjectId: string;

	beforeAll(async () => {
		connectors = await servedOnPostgres(ConnectorStore.Service, ConnectorStore.layer);
	});

	afterAll(async () => {
		await closeDatabase();
	});

	const create = (input: NewConnector) =>
		connectors.create(workspaceId, projectId, memberId, input);
	/** The connector as the settings page is shown it, through the project `owner`. */
	const shown = (connectorId: string, owner = projectId) =>
		runOnPostgres(
			Effect.flatMap(Secrets.Service, (cipher) =>
				connectorIn(workspaceId, owner, connectorId, cipher),
			),
		);

	beforeEach(async () => {
		const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: `Connectors ${suffix}`, slug: `connectors-${suffix}` })
				.returning(),
		);
		const [somebody] = await onDatabase((db) =>
			db
				.insert(member)
				.values({ name: "Sam", email: `connectors-${suffix}@example.com` })
				.returning(),
		);
		if (!space || !somebody) throw new Error("fixture");
		workspaceId = space.id;
		memberId = somebody.id;
		await onDatabase((db) =>
			db.insert(membership).values({ workspaceId, memberId, role: "admin" }),
		);
		const [bot, otherBot] = await onDatabase((db) =>
			db
				.insert(botTable)
				.values(
					["Support", "Sales"].map((name) => ({
						workspaceId,
						name,
						handle: name.toLowerCase(),
						color: "sky" as const,
						eyes: "pill" as const,
					})),
				)
				.returning(),
		);
		if (!bot || !otherBot) throw new Error("bot fixture");
		// Each bot's connectors are its default project's.
		const defaults = await onDatabase((db) =>
			db
				.select({ id: project.id, botId: project.defaultOfBotId })
				.from(project)
				.where(inArray(project.defaultOfBotId, [bot.id, otherBot.id])),
		);
		const defaultOf = (botId: string) => {
			const found = defaults.find((one) => one.botId === botId);
			if (!found) throw new Error("default project fixture");
			return found.id;
		};
		projectId = defaultOf(bot.id);
		otherProjectId = defaultOf(otherBot.id);
	});

	it("refuses a second connector with the same name", async () => {
		await create({
			name: "Team Wiki",
			url: "https://wiki.example.com/mcp",
		});

		await expect(
			create({
				name: "team wiki",
				url: "https://other.example/mcp",
			}),
		).rejects.toThrow(ConnectorStore.ConnectorNameTaken);
	});

	/** Records that the connector's server listed `tools`, as a test of its configuration would. */
	async function listTools(connectorId: string, tools: ConnectorTool[]) {
		const target = await connectors.target(workspaceId, projectId, connectorId);
		if (!target) throw new Error("no target");
		await connectors.recordTest(workspaceId, connectorId, target.configurationUpdatedAt, {
			tools,
		});
	}

	const lookup: ConnectorTool = {
		name: "lookup",
		description: null,
		readOnly: true,
		destructive: null,
	};
	const edit: ConnectorTool = {
		name: "edit",
		description: null,
		readOnly: false,
		destructive: false,
	};
	const wipe: ConnectorTool = {
		name: "wipe",
		description: null,
		readOnly: false,
		destructive: true,
	};

	it("hands a turn every connector it can call, with what was chosen for its tools", async () => {
		const wiki = await create({ name: "Wiki", url: "https://wiki.example.com/mcp" });
		const tracker = await create({ name: "Tracker", url: "https://tracker.example.com/mcp" });
		await create({ name: "Linear", url: "https://mcp.linear.app/mcp", auth: "oauth" });
		const notion = await create({
			name: "Notion",
			url: "https://mcp.notion.com/mcp",
			auth: "oauth",
		});
		await connectors.saveOauthRecord(
			workspaceId,
			notion.id,
			{
				clientInformation: { client_id: "client-1" },
				signInRejectedAt: "2026-10-05T21:00:08.000Z",
			},
			{ kind: "since", version: null },
		);
		await listTools(wiki.id, [lookup, edit]);
		await connectors.update(workspaceId, projectId, wiki.id, { toolAccess: { edit: "off" } });
		await listTools(tracker.id, [lookup, wipe]);
		await connectors.update(workspaceId, projectId, tracker.id, { toolAccess: { lookup: "off" } });

		const forProject = await connectors.targetsForProject(workspaceId, projectId);

		// Linear is still waiting on its first sign-in, Notion's was refused, and
		// every one of Tracker's tools is off, so none of them is reached.
		expect(forProject).toEqual({
			targets: [
				expect.objectContaining({
					connectorId: wiki.id,
					handle: "wiki",
					toolAccess: { edit: "off" },
				}),
			],
			signInExpired: [{ handle: "notion" }],
			installedUrls: [wiki.url, tracker.url, "https://mcp.linear.app/mcp", notion.url],
		});
		expect(await shown(notion.id)).toMatchObject({ signedIn: false, signInExpired: true });
	});

	it("gives a tool nobody chose for its default, and keeps a choice while its tool is not listed", async () => {
		const made = await create({ name: "Wiki", url: "https://wiki.example.com/mcp" });

		await listTools(made.id, [lookup, edit, wipe]);
		expect((await shown(made.id))?.tools).toEqual([
			expect.objectContaining({ name: "lookup", access: "allow" }),
			expect.objectContaining({ name: "edit", access: "ask" }),
			expect.objectContaining({ name: "wipe", access: "off" }),
		]);

		await connectors.update(workspaceId, projectId, made.id, { toolAccess: { lookup: "off" } });
		await listTools(made.id, [edit]);
		await listTools(made.id, [lookup, edit]);

		expect((await shown(made.id))?.tools).toEqual([
			expect.objectContaining({ name: "lookup", access: "off" }),
			expect.objectContaining({ name: "edit", access: "ask" }),
		]);
	});

	it("sets the tools named without changing the configuration, and refuses a name it does not list", async () => {
		const made = await create({ name: "Wiki", url: "https://wiki.example.com/mcp" });
		await listTools(made.id, [lookup, edit, wipe]);

		await connectors.update(workspaceId, projectId, made.id, { toolAccess: { edit: "allow" } });
		await connectors.update(workspaceId, projectId, made.id, { toolAccess: { wipe: "ask" } });

		expect((await shown(made.id))?.tools.map((tool) => tool.access)).toEqual([
			"allow",
			"allow",
			"ask",
		]);
		expect((await connectors.target(workspaceId, projectId, made.id))?.configurationRevision).toBe(
			1,
		);
		await expect(
			connectors.update(workspaceId, projectId, made.id, { toolAccess: { ghost: "allow" } }),
		).rejects.toThrow(ConnectorStore.UnknownConnectorTool);
	});

	it("sets every tool it lists at once", async () => {
		const made = await create({ name: "Wiki", url: "https://wiki.example.com/mcp" });
		await listTools(made.id, [lookup, edit, wipe]);

		await connectors.update(workspaceId, projectId, made.id, { access: "ask" });

		expect((await shown(made.id))?.tools.map((tool) => tool.access)).toEqual(["ask", "ask", "ask"]);
	});

	it("names who added a connector while they are in the workspace, and nobody once they leave it for another", async () => {
		const made = await create({ name: "Wiki", url: "https://wiki.example.com/mcp" });
		expect((await shown(made.id))?.connectedBy).toMatchObject({ id: memberId, name: "Sam" });
		const [elsewhere] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: "Elsewhere", slug: `elsewhere-${crypto.randomUUID()}` })
				.returning(),
		);
		if (!elsewhere) throw new Error("could not create the other workspace");
		await onDatabase((db) =>
			db.insert(membership).values({ workspaceId: elsewhere.id, memberId, role: "editor" }),
		);

		await onDatabase((db) =>
			db
				.delete(membership)
				.where(and(eq(membership.workspaceId, workspaceId), eq(membership.memberId, memberId))),
		);

		expect((await shown(made.id))?.connectedBy).toBeNull();
	});

	it("lists a connector's tools as counts, and gives one connector's tools without their descriptions", async () => {
		const made = await create({ name: "Wiki", url: "https://wiki.example.com/mcp" });
		const described = { ...lookup, description: "Looks a page up by its title." };
		await listTools(made.id, [described, edit, wipe]);

		const [listed] = await runOnPostgres(
			Effect.flatMap(Secrets.Service, (cipher) => connectorsIn(workspaceId, projectId, cipher)),
		);
		expect(listed?.toolCounts).toEqual({ allow: 1, ask: 1, off: 1 });
		expect(listed).not.toHaveProperty("tools");
		expect((await shown(made.id))?.tools[0]).toEqual({
			name: "lookup",
			readOnly: true,
			destructive: null,
			access: "allow",
		});
	});

	it("gives a GitHub connector this version's tools, whenever it was made", async () => {
		const made = await connectors.createGitHub(workspaceId, projectId, memberId, {
			id: crypto.randomUUID(),
			app: { appId: 42, slug: "acme-sugabots", owner: { login: "acme", type: "Organization" } },
			appCredentialEncrypted: "sealed",
		});

		await connectors.update(workspaceId, projectId, made.id, {
			toolAccess: { list_issues: "off" },
		});

		const tools = (await shown(made.id))?.tools ?? [];
		expect(tools.map((tool) => tool.name)).toEqual(GITHUB_CONNECTOR_TOOLS.map((tool) => tool.name));
		expect(tools).toContainEqual(expect.objectContaining({ name: "list_issues", access: "off" }));
		expect(tools).toContainEqual(expect.objectContaining({ name: "push_branch", access: "ask" }));
	});

	it("lists Linear's upload beside a Linear server's own tools, to choose for like them", async () => {
		const made = await create({ name: "Linear", url: "https://mcp.linear.app/mcp" });
		await listTools(made.id, [lookup]);

		expect(
			(await shown(made.id))?.tools.map(({ name, readOnly, access }) => ({
				name,
				readOnly,
				access,
			})),
		).toEqual([
			{ name: "lookup", readOnly: true, access: "allow" },
			{ name: "upload_file", readOnly: false, access: "allow" },
		]);
		await connectors.update(workspaceId, projectId, made.id, {
			toolAccess: { upload_file: "off" },
		});
		expect((await shown(made.id))?.tools).toContainEqual(
			expect.objectContaining({ name: "upload_file", access: "off" }),
		);
	});

	it("leaves Linear's upload to the server when the server lists one of its own", async () => {
		const made = await create({ name: "Linear", url: "https://mcp.linear.app/mcp" });
		await listTools(made.id, [{ ...edit, name: "upload_file" }]);

		expect((await shown(made.id))?.tools).toEqual([
			expect.objectContaining({ name: "upload_file", readOnly: false, access: "ask" }),
		]);
	});

	it("adds nothing to a server that is no built-in connector", async () => {
		const made = await create({ name: "Wiki", url: "https://wiki.example.com/mcp" });
		await listTools(made.id, [lookup]);

		expect((await shown(made.id))?.tools.map((tool) => tool.name)).toEqual(["lookup"]);
	});

	it("hands a turn an HTTP connector, with this version's method tools", async () => {
		const [made] = await onDatabase((db) =>
			db
				.insert(connector)
				.values({
					workspaceId,
					projectId,
					createdById: memberId,
					kind: "http",
					name: "Alerts",
					handle: "alerts",
					url: "https://alerts.example.com/v2",
				})
				.returning(),
		);
		if (!made) throw new Error("fixture");

		await connectors.update(workspaceId, projectId, made.id, { toolAccess: { delete: "ask" } });

		expect((await connectors.targetsForProject(workspaceId, projectId)).targets).toEqual([
			expect.objectContaining({ connectorId: made.id, kind: "http" }),
		]);
		expect((await shown(made.id))?.tools.map(({ name, access }) => [name, access])).toEqual([
			["get", "allow"],
			["post", "ask"],
			["put", "ask"],
			["patch", "ask"],
			["delete", "ask"],
		]);
	});

	it("does not expose a connector through another project", async () => {
		const made = await create({
			name: "Wiki",
			url: "https://wiki.example.com/mcp",
		});

		expect(await shown(made.id, otherProjectId)).toBeUndefined();
		expect(await connectors.target(workspaceId, otherProjectId, made.id)).toBeUndefined();
		expect(
			await connectors.update(workspaceId, otherProjectId, made.id, {
				toolAccess: { lookup: "ask" },
			}),
		).toBeUndefined();
		expect(await connectors.remove(workspaceId, otherProjectId, made.id)).toBe(false);
		expect((await shown(made.id))?.id).toEqual(made.id);
	});

	it("keeps an OAuth connector's sealed record, and finds it again by the state of a sign-in", async () => {
		const made = await create({
			name: "Linear",
			url: "https://mcp.linear.app/mcp",
			auth: "oauth",
			secret: "ignored",
		});
		expect(await shown(made.id)).toMatchObject({
			auth: "oauth",
			signedIn: false,
			hasSecret: false,
		});
		expect(await connectors.target(workspaceId, projectId, made.id)).toMatchObject({
			auth: "oauth",
			headers: {},
		});

		const session = await signedIn(memberId);
		const started = await connectors.saveOauthRecord(
			workspaceId,
			made.id,
			{
				startedByMemberId: memberId,
				startedBySessionId: session.session,
				clientInformation: { client_id: "client-1" },
				codeVerifier: "verifier",
				state: "state-1",
			},
			{ kind: "since", version: null },
		);
		const [row] = await onDatabase((db) =>
			db.select({ hash: connector.oauthState }).from(connector).where(eq(connector.id, made.id)),
		);
		expect(row?.hash).toBe(createHash("sha256").update("state-1").digest("hex"));
		expect(await connectors.byOauthState("state-1", session)).toEqual({
			workspaceId,
			projectId,
			connectorId: made.id,
		});
		expect((await shown(made.id))?.signedIn).toBe(false);

		await connectors.saveOauthRecord(
			workspaceId,
			made.id,
			{
				clientInformation: { client_id: "client-1" },
				tokens: { access_token: "token-1", token_type: "Bearer" },
				state: "",
			},
			{ kind: "since", version: started ?? null },
		);
		expect(await connectors.oauthRecord(workspaceId, made.id)).toMatchObject({
			tokens: { access_token: "token-1" },
		});
		expect(await connectors.byOauthState("state-1", session)).toBeUndefined();
		expect((await shown(made.id))?.signedIn).toBe(true);
	});

	describe("connector sign-in during membership removal", () => {
		const tokens = { tokens: { access_token: "token", token_type: "bearer" } };
		const removeSigner = (signer: Awaited<ReturnType<typeof signedIn>>) =>
			underWorkspaceLock(signer, workspaceId, () =>
				Effect.gen(function* () {
					const store = yield* ConnectorStore.Service;
					yield* query((db) =>
						db
							.delete(membership)
							.where(
								and(
									eq(membership.workspaceId, workspaceId),
									eq(membership.memberId, signer.member),
								),
							),
					);
					yield* store.signOutSignedInBy(workspaceId, signer.member);
				}),
			).pipe(Effect.provide(ConnectorStore.layer));

		it("refuses OAuth sign-in and GitHub installation once their signer was removed", async () => {
			const signer = await signedIn(memberId);
			const { id: oauth } = await create({
				name: "Linear",
				url: "https://mcp.linear.app/mcp",
				auth: "oauth",
			});
			const github = await seedConnector(workspaceId, projectId, {
				github: { appCredentialEncrypted: "sealed" },
			});
			const removing = holdTransaction(
				query((db) =>
					db
						.select({ id: workspace.id })
						.from(workspace)
						.where(eq(workspace.id, workspaceId))
						.for("no key update"),
				),
				Effect.gen(function* () {
					yield* query((db) =>
						db
							.delete(membership)
							.where(
								and(eq(membership.workspaceId, workspaceId), eq(membership.memberId, memberId)),
							),
					);
				}),
			);
			await removing.held;

			const signingIn = connectors.saveOauthRecord(workspaceId, oauth, tokens, {
				kind: "signIn",
				version: null,
				signedInById: signer.member,
			});
			const installing = connectors.installed(workspaceId, github, {
				installationId: 1,
				account: "support",
				installedById: signer.member,
			});
			await removing.waitForWaiters(2);
			await removing.release();

			expect(await signingIn).toBeUndefined();
			expect(await installing).toBe(false);
			expect(await connectors.oauthRecord(workspaceId, oauth)).toBeUndefined();
		});

		it("clears a sign-in that commits before the membership removal", async () => {
			const signer = await signedIn(memberId);
			const { id: oauth } = await create({
				name: "Linear",
				url: "https://mcp.linear.app/mcp",
				auth: "oauth",
			});
			const signingIn = holdTransaction(
				Effect.flatMap(ConnectorStore.Service, (store) =>
					store.saveOauthRecord(workspaceId, oauth, tokens, {
						kind: "signIn",
						version: null,
						signedInById: signer.member,
					}),
				).pipe(Effect.provide(ConnectorStore.layer)),
			);
			expect(await signingIn.held).toBeTypeOf("string");

			const removing = runOnPostgres(removeSigner(signer));
			await signingIn.waitForWaiters(1);
			await signingIn.release();
			await removing;

			expect(await connectors.oauthRecord(workspaceId, oauth)).toBeUndefined();
			expect(await shown(oauth)).toMatchObject({ signedIn: false, signedInAs: null });
		});

		it("refuses stale refresh callbacks after removal and a new sign-in", async () => {
			const { id: oauth } = await create({
				name: "Linear",
				url: "https://mcp.linear.app/mcp",
				auth: "oauth",
			});
			let version = await connectors.saveOauthRecord(workspaceId, oauth, tokens, {
				kind: "signIn",
				version: null,
				signedInById: memberId,
			});
			const refreshing = storedOAuthProvider(
				{
					load: () => connectors.oauthRecord(workspaceId, oauth),
					save: async (record) => {
						const saved = await connectors.saveOauthRecord(workspaceId, oauth, record, {
							kind: "since",
							version: version ?? null,
						});
						if (saved === undefined) return false;
						version = saved;
						return true;
					},
					now: async () => new Date(),
				},
				{ redirectUrl: "https://sugabots.test/callback", clientName: "Sugabots" },
			);
			expect(await refreshing.tokens()).toMatchObject({ access_token: "token" });

			await runOnPostgres(removeSigner(await signedIn(memberId)));
			const replacement = await seedMember(workspaceId, "admin");
			await connectors.saveOauthRecord(
				workspaceId,
				oauth,
				{
					tokens: { access_token: "replacement", token_type: "bearer" },
				},
				{ kind: "signIn", signedInById: replacement, version: null },
			);

			await expect(
				refreshing.saveClientInformation?.({
					client_id: "old-client",
					issuer: "https://auth.example.com",
				}),
			).rejects.toBeInstanceOf(SignInRequired);
			await expect(
				refreshing.saveTokens({
					access_token: "refreshed",
					token_type: "bearer",
				}),
			).rejects.toBeInstanceOf(SignInRequired);
			expect(await connectors.oauthRecord(workspaceId, oauth)).toMatchObject({
				tokens: { access_token: "replacement" },
			});
			expect(await shown(oauth)).toMatchObject({ signedIn: true, signedInAs: { id: replacement } });
		});
	});

	it("hands the caller the URL and the secret as a header", async () => {
		const made = await create({
			name: "Wiki",
			url: "https://wiki.example.com/mcp",
			secretHeader: "authorization",
			secret: "Bearer abc",
		});

		expect(await connectors.target(workspaceId, projectId, made.id)).toMatchObject({
			connectorId: made.id,
			handle: "wiki",
			url: "https://wiki.example.com/mcp",
			headers: { authorization: "Bearer abc" },
		});

		const open = await create({
			name: "Open",
			url: "https://open.example.com/mcp",
		});
		expect(await connectors.target(workspaceId, projectId, open.id)).toMatchObject({
			headers: {},
		});
	});

	it("records what a test found, and forgets it when the connector changes", async () => {
		const made = await create({
			name: "Wiki",
			url: "https://wiki.example.com/mcp",
		});
		const target = await connectors.target(workspaceId, projectId, made.id);
		if (!target) throw new Error("no target");
		expect(target.configurationRevision).toBe(1);

		await connectors.recordTest(workspaceId, made.id, target.configurationUpdatedAt, {
			tools: [
				{ name: "web_search_exa", description: "Search.", readOnly: true, destructive: null },
			],
		});
		expect(await shown(made.id)).toMatchObject({
			status: "connected",
			tools: [{ name: "web_search_exa" }],
		});
		expect((await connectors.target(workspaceId, projectId, made.id))?.configurationRevision).toBe(
			1,
		);

		await connectors.update(workspaceId, projectId, made.id, { secret: "exa-key" });
		expect((await connectors.target(workspaceId, projectId, made.id))?.configurationRevision).toBe(
			2,
		);
		expect(await shown(made.id)).toMatchObject({
			status: "untested",
			hasSecret: true,
			// The tools stay: they are what the server offers, not what a key unlocks.
			tools: [{ name: "web_search_exa" }],
		});
	});

	describe("moving a connector's address", () => {
		const withSecret = () =>
			create({
				name: "Wiki",
				url: "https://wiki.example.com/mcp",
				secretHeader: "authorization",
				secret: "Bearer abc",
			});
		const headersOf = async (connectorId: string) =>
			(await connectors.target(workspaceId, projectId, connectorId))?.headers;

		it("drops the stored secret, which would otherwise go to the new address", async () => {
			const made = await withSecret();

			await connectors.update(workspaceId, projectId, made.id, {
				url: "https://elsewhere.example/mcp",
			});

			expect(await headersOf(made.id)).toEqual({});
			expect((await shown(made.id))?.hasSecret).toBe(false);
		});

		it("keeps a secret given with the new address", async () => {
			const made = await withSecret();

			await connectors.update(workspaceId, projectId, made.id, {
				url: "https://elsewhere.example/mcp",
				secret: "Bearer new",
			});

			expect(await headersOf(made.id)).toEqual({ authorization: "Bearer new" });
		});

		it("keeps the secret when the address given is the one it has", async () => {
			const made = await withSecret();

			await connectors.update(workspaceId, projectId, made.id, {
				url: "https://wiki.example.com/mcp",
			});

			expect(await headersOf(made.id)).toEqual({ authorization: "Bearer abc" });
		});

		it("drops an OAuth connector's tokens and client, so it must sign in again", async () => {
			const made = await create({
				name: "Linear",
				url: "https://mcp.linear.app/mcp",
				auth: "oauth",
			});
			await connectors.saveOauthRecord(
				workspaceId,
				made.id,
				{
					clientInformation: { client_id: "client-1" },
					tokens: { access_token: "token-1", token_type: "Bearer" },
					state: "",
				},
				{ kind: "since", version: null },
			);

			await connectors.update(workspaceId, projectId, made.id, {
				url: "https://elsewhere.example/mcp",
			});

			expect(await connectors.oauthRecord(workspaceId, made.id)).toBeUndefined();
			expect((await shown(made.id))?.signedIn).toBe(false);
		});
	});
});
