import { Effect, Layer } from "effect";
import { afterAll, expect, it } from "vitest";
import {
	seedBot,
	seedMember,
	seedProject,
	seedProjectChat,
	seedWorkspace,
} from "../../authentication/seed.test-support.ts";
import { closeDatabase, runOnPostgres, servedOnPostgres } from "../../database/testing.ts";
import { proveCanReachConnector } from "../../proofs/can-use-connector.ts";
import { named } from "../../proofs/proof.ts";
import { authenticators, principals } from "../../proofs/world.test-support.ts";
import { ConnectorStore } from "../../providers/connectors/connector-store.ts";
import { Egress } from "../../providers/network/egress.ts";
import { unimplemented } from "../../testing.ts";
import { ConnectorCatalog } from "./connector-catalog.ts";
import { NO_TURN } from "./testing.ts";

afterAll(closeDatabase);

it("offers tools on later MCP pages and invalidates approval when a later page changes", async () => {
	const workspaceId = await seedWorkspace();
	const admin = await seedMember(workspaceId, "admin");
	const bot = await seedBot(workspaceId, { createdById: admin });
	const projectId = bot.defaultProject;
	const chatId = await seedProjectChat(workspaceId, projectId, admin);
	const principal = await principals(await authenticators()).botFor(admin, bot.id, chatId);
	const store = await runOnPostgres(
		ConnectorStore.Service.pipe(Effect.provide(ConnectorStore.layer)),
	);
	const connector = await runOnPostgres(
		store.create(workspaceId, projectId, admin, {
			name: "Wiki",
			url: "https://wiki.example.com/mcp",
			kind: "mcp",
		}),
	);
	let publishDescription = "Publishes a draft.";
	const fetchMcp: typeof fetch = async (input, init) => {
		const request = new Request(input, init);
		if (request.method === "GET") return new Response(null, { status: 405 });
		const { id, method, params } = (await request.json()) as {
			id?: number;
			method: string;
			params?: { cursor?: string };
		};
		const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
		if (method === "initialize") {
			return reply({
				protocolVersion: "2025-11-25",
				serverInfo: { name: "Wiki", version: "1" },
				capabilities: { tools: {} },
			});
		}
		if (method === "tools/list") {
			const inputSchema = { type: "object" };
			return params?.cursor === "drafts"
				? reply({ tools: [{ name: "publish", description: publishDescription, inputSchema }] })
				: reply({ tools: [{ name: "lookup", inputSchema }], nextCursor: "drafts" });
		}
		if (id === undefined) return new Response(null, { status: 202 });
		return Response.json({
			jsonrpc: "2.0",
			id,
			error: { code: -32601, message: "Method not found" },
		});
	};
	const catalog = ConnectorCatalog.from({
		connectors: store,
		httpClients: { for: () => fetchMcp },
	});
	const offered = await runOnPostgres(
		catalog.forTurn(workspaceId, { projectId, ownProjectId: null }, { ...NO_TURN, principal }),
	);
	try {
		expect(Object.keys(offered.tools)).toEqual(["wiki__lookup", "wiki__publish"]);
		const canStillApprove = () =>
			runOnPostgres(
				named(principal, connector.id, (acting, id) =>
					proveCanReachConnector(acting, id).pipe(
						Effect.flatMap((reach) => catalog.checkApproval(reach, "lookup", {}, null)),
					),
				),
			);
		await expect(canStillApprove()).resolves.toBe(true);
		publishDescription = "Publishes a draft and notifies its readers.";
		await expect(canStillApprove()).resolves.toBe(false);
	} finally {
		await offered.close();
	}
});

it("excludes a switched-off built-in connector from a turn’s tools and addable connectors", async () => {
	const workspaceId = await seedWorkspace();
	const admin = await seedMember(workspaceId, "admin");
	const bot = await seedBot(workspaceId, { createdById: admin });
	const projectId = bot.defaultProject;
	const chatId = await seedProjectChat(workspaceId, projectId, admin);
	const principal = await principals(await authenticators()).botFor(admin, bot.id, chatId);
	const store = await servedOnPostgres(ConnectorStore.Service, ConnectorStore.layer);
	const catalog = await runOnPostgres(
		Effect.provide(
			ConnectorCatalog.Service,
			ConnectorCatalog.layer.pipe(
				Layer.provide(
					unimplemented(Egress.Service, {
						providers: {
							for: () => () => {
								throw new Error("Catalog contacted a connector while listing tools");
							},
						},
					}),
				),
			),
		),
	);
	const offer = () =>
		runOnPostgres(
			catalog.forTurn(
				workspaceId,
				{ projectId, ownProjectId: null },
				{
					...NO_TURN,
					principal,
				},
			),
		);

	const before = await offer();
	try {
		expect(before.addable.map(({ id }) => id)).toContain("linear");
	} finally {
		await before.close();
	}

	const connector = await store.create(workspaceId, projectId, admin, {
		name: "Linear",
		url: "https://mcp.linear.app/mcp",
		kind: "http",
	});
	const enabled = await offer();
	try {
		expect(Object.values(enabled.tools).map(({ connectorId }) => connectorId)).toContain(
			connector.id,
		);
	} finally {
		await enabled.close();
	}

	await store.update(workspaceId, projectId, connector.id, { enabled: false });

	const after = await offer();
	try {
		expect(after.tools).toEqual({});
		expect(after.unavailable).toEqual([]);
		expect(after.addable.map(({ id }) => id)).not.toContain("linear");
	} finally {
		await after.close();
	}
});

it("offers a bot's own connector in another project only once it is turned on there, for the address its manager saw", async () => {
	const workspaceId = await seedWorkspace();
	const admin = await seedMember(workspaceId, "admin");
	const bot = await seedBot(workspaceId, { createdById: admin });
	const projectId = await seedProject(workspaceId, { leadBotId: bot.id, members: [admin] });
	const chatId = await seedProjectChat(workspaceId, projectId, admin);
	const principal = await principals(await authenticators()).botFor(admin, bot.id, chatId);
	const store = await servedOnPostgres(ConnectorStore.Service, ConnectorStore.layer);
	const catalog = await runOnPostgres(
		Effect.provide(
			ConnectorCatalog.Service,
			ConnectorCatalog.layer.pipe(
				Layer.provide(
					unimplemented(Egress.Service, {
						providers: {
							for: () => () => {
								throw new Error("Catalog contacted a connector while listing tools");
							},
						},
					}),
				),
			),
		),
	);
	const offered = async () => {
		const offer = await runOnPostgres(
			catalog.forTurn(
				workspaceId,
				{ projectId, ownProjectId: bot.defaultProject },
				{ ...NO_TURN, principal },
			),
		);
		try {
			return Object.values(offer.tools).map(({ connectorId }) => connectorId);
		} finally {
			await offer.close();
		}
	};
	const own = await store.create(workspaceId, bot.defaultProject, admin, {
		name: "Tracker",
		url: "https://tracker.example.com/api",
		kind: "http",
	});

	const reports = await store.create(workspaceId, bot.defaultProject, admin, {
		name: "Reports",
		url: "https://reports.example.com/api",
		kind: "http",
	});
	const turnOn = (addressRevision: number, connectorId = own.id) =>
		store.setOnInProject({
			workspaceId,
			projectId,
			botId: bot.id,
			connectorId,
			on: true,
			addressRevision,
		});
	const moveTo = (url: string) => store.update(workspaceId, bot.defaultProject, own.id, { url });

	await turnOn(reports.addressRevision, reports.id);
	expect(await offered()).toEqual(expect.arrayContaining([reports.id]));
	expect(await offered()).not.toContain(own.id);

	await turnOn(own.addressRevision);
	expect(await offered()).toContain(own.id);

	await moveTo("https://other-tracker.example.com/api");
	const stillOffered = await offered();
	expect(stillOffered).not.toContain(own.id);
	expect(stillOffered).toContain(reports.id);
	// Moved back, it is still off: it was turned on for the address as it was then.
	const movedBack = await moveTo("https://tracker.example.com/api");
	expect(await offered()).not.toContain(own.id);

	// Turning it on for the address its manager saw is refused once it has moved since.
	await expect(turnOn(own.addressRevision)).rejects.toMatchObject({
		_tag: "ConnectorAddressChanged",
	});
	expect(await offered()).not.toContain(own.id);
	await turnOn(movedBack?.addressRevision ?? 0);
	expect(await offered()).toContain(own.id);
});

it("only shows an expired sign-in for a bot's own connector when it is turned on in the project", async () => {
	const workspaceId = await seedWorkspace();
	const admin = await seedMember(workspaceId, "admin");
	const editor = await seedMember(workspaceId, "editor");
	const bot = await seedBot(workspaceId, { createdById: admin, visibility: "private" });
	const projectId = await seedProject(workspaceId, { leadBotId: bot.id, members: [editor] });
	const chatId = await seedProjectChat(workspaceId, projectId, editor);
	const principal = await principals(await authenticators()).botFor(editor, bot.id, chatId);
	const store = await servedOnPostgres(ConnectorStore.Service, ConnectorStore.layer);
	const catalog = await runOnPostgres(
		Effect.provide(
			ConnectorCatalog.Service,
			ConnectorCatalog.layer.pipe(Layer.provide(unimplemented(Egress.Service))),
		),
	);
	const own = await store.create(workspaceId, bot.defaultProject, admin, {
		name: "Tracker",
		url: "https://tracker.example.com/mcp",
		auth: "oauth",
	});
	await store.saveOauthRecord(
		workspaceId,
		own.id,
		{ clientInformation: { client_id: "client-1" }, signInRejectedAt: "2026-10-05T21:00:08.000Z" },
		{ kind: "since", version: null },
	);
	const notices = async () => {
		const offer = await runOnPostgres(
			catalog.forTurn(
				workspaceId,
				{ projectId, ownProjectId: bot.defaultProject },
				{ ...NO_TURN, principal },
			),
		);
		try {
			return offer.signInExpired;
		} finally {
			await offer.close();
		}
	};
	expect(await notices()).toEqual([]);

	await store.setOnInProject({
		workspaceId,
		projectId,
		botId: bot.id,
		connectorId: own.id,
		on: true,
		addressRevision: own.addressRevision,
	});

	expect(await notices()).toEqual([{ handle: own.handle, projectId: bot.defaultProject }]);
});

it("turns a bot's own connector on from several managers at once", async () => {
	const workspaceId = await seedWorkspace();
	const admin = await seedMember(workspaceId, "admin");
	const bot = await seedBot(workspaceId, { createdById: admin });
	const projectId = await seedProject(workspaceId, { leadBotId: bot.id, members: [admin] });
	const store = await servedOnPostgres(ConnectorStore.Service, ConnectorStore.layer);
	const own = await store.create(workspaceId, bot.defaultProject, admin, {
		name: "Tracker",
		url: "https://tracker.example.com/api",
		kind: "http",
	});

	const turnedOn = await Promise.allSettled(
		Array.from({ length: 8 }, () =>
			store.setOnInProject({
				workspaceId,
				projectId,
				botId: bot.id,
				connectorId: own.id,
				on: true,
				addressRevision: own.addressRevision,
			}),
		),
	);

	expect(turnedOn.filter(({ status }) => status === "rejected")).toEqual([]);
});
