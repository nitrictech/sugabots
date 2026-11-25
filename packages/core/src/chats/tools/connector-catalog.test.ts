import { Effect, Layer } from "effect";
import { afterAll, expect, it } from "vitest";
import {
	seedBot,
	seedMember,
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
