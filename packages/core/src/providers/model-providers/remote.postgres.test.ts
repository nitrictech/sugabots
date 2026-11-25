import { Effect } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { member, membership, workspace } from "../../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../../database/testing.ts";
import { emptyRegistry } from "../models/testing.ts";
import type { EgressHttpClients } from "../network/egress.ts";
import { providerIn } from "./model-provider-reads.ts";
import { ModelProviderStore } from "./model-provider-store.ts";
import { fetchProviderModels, testProvider } from "./remote.ts";

const UNREACHABLE =
	"We can't reach the provider. Check its address, and that the server is running if it's your own. Then try again.";

/** What discovery and testing leave in the database, read back through the real store. */
describe.skipIf(!process.env.DATABASE_URL)("provider discovery, against Postgres", () => {
	let workspaceId: string;
	let providerId: string;
	let adminId: string;

	afterAll(closeDatabase);

	beforeEach(async () => {
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const [made] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: `Test ${stamp}`, slug: `remote-${stamp}` })
				.returning(),
		);
		const [somebody] = await onDatabase((db) =>
			db
				.insert(member)
				.values({ name: "Ada", email: `ada-${stamp}@example.com` })
				.returning(),
		);
		if (!made || !somebody) throw new Error("could not create the fixtures");
		workspaceId = made.id;
		adminId = somebody.id;
		await onDatabase((db) =>
			db.insert(membership).values({ workspaceId, memberId: somebody.id, role: "admin" }),
		);
		const provider = await runOnPostgres(
			Effect.flatMap(ModelProviderStore.Service, (store) =>
				store.create(workspaceId, {
					createdById: somebody.id,
					provider: {
						name: `Gateway ${stamp}`,
						baseUrl: "https://models.example/v1",
						apiFormat: "openai",
						apiKey: "secret",
						customHeaders: [],
					},
				}),
			).pipe(Effect.provide(ModelProviderStore.layer)),
		);
		providerId = provider.id;
	});

	const clientAnswering = (answer: () => Promise<Response>): EgressHttpClients => ({
		for: () => () => answer(),
	});
	const withStore = <A, E>(
		use: (store: ModelProviderStore.Interface) => Effect.Effect<A, E, never>,
	) =>
		runOnPostgres(
			Effect.flatMap(ModelProviderStore.Service, use).pipe(
				Effect.provide(ModelProviderStore.layer),
			),
		);
	const view = () => runOnPostgres(providerIn(workspaceId, providerId));

	it("records a fixed sentence for an unreachable provider, and keeps the network's words out of it", async () => {
		const httpClients = clientAnswering(async () => {
			throw new Error("getaddrinfo ENOTFOUND models.internal.example 10.0.0.7");
		});

		const result = await withStore((store) =>
			testProvider(store, workspaceId, providerId, httpClients),
		);

		expect(result).toMatchObject({ reachable: false, error: UNREACHABLE });
		expect(await view()).toMatchObject({ status: "error", lastTestError: UNREACHABLE });
	});

	it("records a model a listing names twice once", async () => {
		const httpClients = clientAnswering(async () =>
			Response.json({ data: [{ id: "twice" }, { id: "twice" }] }),
		);

		const result = await withStore((store) =>
			fetchProviderModels(store, workspaceId, providerId, httpClients, { registry: emptyRegistry }),
		);

		expect(result).toEqual({ added: 1, updated: 0, unchanged: 0 });
		expect((await view())?.models.map(({ modelId }) => modelId)).toEqual(["twice"]);
	});

	it("records nothing a slow listing found once the provider has been given another key meanwhile", async () => {
		const asked = Promise.withResolvers<void>();
		const answer = Promise.withResolvers<Response>();
		const httpClients = clientAnswering(() => {
			asked.resolve();
			return answer.promise;
		});

		const discovering = withStore((store) =>
			fetchProviderModels(store, workspaceId, providerId, httpClients, { registry: emptyRegistry }),
		);
		await asked.promise;
		await withStore((store) =>
			store.update(workspaceId, providerId, { apiKey: "another" }, adminId),
		);
		answer.resolve(Response.json({ data: [{ id: "from-the-old-key" }] }));
		await discovering;

		expect(await view()).toMatchObject({ models: [], status: "untested", active: false });
	});
});
