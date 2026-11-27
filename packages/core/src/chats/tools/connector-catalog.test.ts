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
import { authenticators, principals } from "../../proofs/world.test-support.ts";
import { ConnectorStore } from "../../providers/connectors/connector-store.ts";
import { Egress } from "../../providers/network/egress.ts";
import { unimplemented } from "../../testing.ts";
import { ConnectorCatalog } from "./connector-catalog.ts";
import { NO_TURN } from "./testing.ts";

afterAll(closeDatabase);

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
			memberId: admin,
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
				memberId: admin,
				on: true,
				addressRevision: own.addressRevision,
			}),
		),
	);

	expect(turnedOn.filter(({ status }) => status === "rejected")).toEqual([]);
});
