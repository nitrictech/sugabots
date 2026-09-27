import { Layer } from "effect";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { workspace } from "../../database/schema.ts";
import { closeDatabase, onDatabase, servedOnPostgres } from "../../database/testing.ts";
import { createEgressUrlValidator, Egress, urlValidation } from "../network/egress.ts";
import { SearchProviderSetup } from "./search-provider-setup.ts";

/**
 * Choosing and trying a workspace's search provider, over the real repository
 * and Postgres, with every search answered by a stand-in for the service.
 */
describe.skipIf(!process.env.DATABASE_URL)("setting up search, against Postgres", () => {
	let workspaceId: string;

	/** The setup under an egress policy allowing private addresses or not, every search answered by `search`. */
	const setupWith = (
		search: (url: string) => Promise<Response>,
		{ allowPrivateNetwork = true } = {},
	) =>
		servedOnPostgres(
			SearchProviderSetup.Service,
			SearchProviderSetup.layer.pipe(
				Layer.provide(
					Layer.succeed(Egress.Service, {
						providers: { for: () => (url) => search(String(url)) },
						validateProviderUrl: urlValidation(createEgressUrlValidator({ allowPrivateNetwork })),
						oauth: fetch,
						webFetch: fetch,
					}),
				),
			),
		);

	const answering = () =>
		vi.fn(async () => Response.json({ web: { results: [{ title: "t", url: "https://r" }] } }));

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: `Search ${suffix}`, slug: `search-setup-${suffix}` })
				.returning(),
		);
		if (!space) throw new Error("fixture");
		workspaceId = space.id;
	});

	it("refuses a local address where the installation forbids private ones", async () => {
		const setup = await setupWith(answering(), { allowPrivateNetwork: false });

		await expect(
			setup.replace({
				workspaceId,
				createdById: null as unknown as string,
				provider: { preset: "searxng", baseUrl: "http://127.0.0.1:8080" },
			}),
		).rejects.toMatchObject({ _tag: "UrlNotAllowed" });
		expect(await setup.get(workspaceId)).toBeUndefined();
	});

	it("tries the service with one query and records how it went", async () => {
		const search = answering();
		const setup = await setupWith(search);
		await setup.replace({
			workspaceId,
			createdById: null as unknown as string,
			provider: { preset: "brave", apiKey: "k" },
		});

		expect(await setup.test(workspaceId)).toMatchObject({ reachable: true, results: 1 });
		expect(search).toHaveBeenCalledOnce();
		expect(await setup.get(workspaceId)).toMatchObject({ status: "connected" });
	});

	it("records a refusal in its own words", async () => {
		const setup = await setupWith(
			async () => new Response("quota exceeded for key k", { status: 429 }),
		);
		await setup.replace({
			workspaceId,
			createdById: null as unknown as string,
			provider: { preset: "brave", apiKey: "k" },
		});

		expect(await setup.test(workspaceId)).toMatchObject({
			reachable: false,
			error: "Brave Search answered HTTP 429",
		});
		expect(await setup.get(workspaceId)).toMatchObject({
			status: "error",
			lastTestError: "Brave Search answered HTTP 429",
		});
	});

	it("says what to do when a test has no key to try, and asks nothing", async () => {
		const search = answering();
		const setup = await setupWith(search);
		await setup.replace({
			workspaceId,
			createdById: null as unknown as string,
			provider: { preset: "brave" },
		});

		expect(await setup.test(workspaceId)).toEqual({
			reachable: false,
			latencyMs: 0,
			error: "Add an API key before testing",
		});
		expect(search).not.toHaveBeenCalled();
	});

	it("says when there is no provider to remove", async () => {
		const setup = await setupWith(answering());

		await expect(setup.remove(workspaceId)).rejects.toBeInstanceOf(
			SearchProviderSetup.SearchProviderNotFound,
		);
	});
});
