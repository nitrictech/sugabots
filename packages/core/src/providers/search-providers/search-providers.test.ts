import { ActionForbidden } from "@sugabots/contracts/errors/proofs";
import { SearchProviderNotFound } from "@sugabots/contracts/errors/providers";
import type { InputOf, RequestOperationName } from "@sugabots/contracts/operations";
import { Layer } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { member, membership, workspace } from "../../database/schema.ts";
import { closeDatabase, onDatabase } from "../../database/testing.ts";
import { servedOperations } from "../../operations/testing.ts";
import { authenticators, principals } from "../../proofs/world.test-support.ts";
import { createEgressUrlValidator, Egress, urlValidation } from "../network/egress.ts";

/**
 * Choosing and trying a workspace's search provider, through its operations
 * over the real store and Postgres, with every search answered by a stand-in
 * for the service.
 */
describe.skipIf(!process.env.DATABASE_URL)("setting up search, against Postgres", () => {
	let workspaceId: string;
	let adminId: string;
	let editorId: string;
	let signIn: ReturnType<typeof principals>["member"];

	beforeAll(async () => {
		signIn = principals(await authenticators()).member;
	});

	/**
	 * The search providers operations, called for the workspace's
	 * administrator signed in, by the names these cases use, under an egress
	 * policy allowing private addresses or not, every search answered by
	 * `search`.
	 */
	const setupWith = async (
		search: (url: string) => Promise<Response>,
		{ allowPrivateNetwork = true, as = adminId } = {},
	) => {
		const call = await servedOperations({
			egress: Layer.succeed(Egress.Service, {
				providers: { for: () => (url) => search(String(url)) },
				validateProviderUrl: urlValidation(createEgressUrlValidator({ allowPrivateNetwork })),
				oauth: fetch,
				webFetch: fetch,
			}),
		});
		const principal = await signIn(as);
		const operation =
			<Name extends RequestOperationName>(name: Name) =>
			(input: InputOf<Name>) =>
				call(principal, name, input);
		return {
			get: operation("searchProviders.get"),
			webAccess: operation("searchProviders.webAccess"),
			replace: operation("searchProviders.replace"),
			remove: operation("searchProviders.remove"),
			test: operation("searchProviders.test"),
		};
	};

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
		const [admin, editor] = await onDatabase((db) =>
			db
				.insert(member)
				.values([
					{ name: "Ada", email: `ada-${suffix}@example.com` },
					{ name: "Sam", email: `sam-${suffix}@example.com` },
				])
				.returning(),
		);
		if (!space || !admin || !editor) throw new Error("fixture");
		workspaceId = space.id;
		adminId = admin.id;
		editorId = editor.id;
		await onDatabase((db) =>
			db.insert(membership).values([
				{ workspaceId, memberId: adminId, role: "admin" },
				{ workspaceId, memberId: editorId, role: "editor" },
			]),
		);
	});

	it("refuses a local address where the server forbids private ones", async () => {
		const setup = await setupWith(answering(), { allowPrivateNetwork: false });

		await expect(
			setup.replace({
				workspace: workspaceId,
				builtIn: "searxng",
				baseUrl: "http://127.0.0.1:8080",
			}),
		).rejects.toMatchObject({ _tag: "UrlNotAllowed" });
		expect(await setup.get({ workspace: workspaceId })).toEqual({ provider: null });
	});

	it("tries the service with one query and records how it went", async () => {
		const search = answering();
		const setup = await setupWith(search);
		await setup.replace({ workspace: workspaceId, builtIn: "brave", apiKey: "k" });

		expect(await setup.test({ workspace: workspaceId })).toMatchObject({
			reachable: true,
			results: 1,
		});
		expect(search).toHaveBeenCalledOnce();
		expect(await setup.get({ workspace: workspaceId })).toMatchObject({
			provider: { status: "connected" },
		});
	});

	it("records a refusal in its own words", async () => {
		const setup = await setupWith(
			async () => new Response("quota exceeded for key k", { status: 429 }),
		);
		await setup.replace({ workspace: workspaceId, builtIn: "brave", apiKey: "k" });

		expect(await setup.test({ workspace: workspaceId })).toMatchObject({
			reachable: false,
			error: "Brave Search answered HTTP 429",
		});
		expect(await setup.get({ workspace: workspaceId })).toMatchObject({
			provider: { status: "error", lastTestError: "Brave Search answered HTTP 429" },
		});
	});

	it("says what to do when a test has no key to try, and asks nothing", async () => {
		const search = answering();
		const setup = await setupWith(search);
		await setup.replace({ workspace: workspaceId, builtIn: "brave" });

		expect(await setup.test({ workspace: workspaceId })).toEqual({
			reachable: false,
			latencyMs: 0,
			error: "Add an API key before testing",
		});
		expect(search).not.toHaveBeenCalled();
	});

	it("says when there is no provider to remove", async () => {
		const setup = await setupWith(answering());

		await expect(setup.remove({ workspace: workspaceId })).rejects.toBeInstanceOf(
			SearchProviderNotFound,
		);
	});

	it("lets an editor ask whether the web tools are on, and change nothing", async () => {
		const setup = await setupWith(answering(), { as: editorId });

		expect(await setup.webAccess({ workspace: workspaceId })).toEqual({ enabled: false });
		await expect(setup.get({ workspace: workspaceId })).rejects.toBeInstanceOf(ActionForbidden);
		await expect(setup.remove({ workspace: workspaceId })).rejects.toBeInstanceOf(ActionForbidden);
	});
});
