import { Layer } from "effect";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { user, workspace, workspaceMember } from "../../database/schema.ts";
import { closeDatabase, onDatabase } from "../../database/testing.ts";
import { ActionForbidden } from "../../workspaces/access.ts";
import { servedOnPostgresAs } from "../../workspaces/testing.ts";
import { createEgressUrlValidator, Egress, urlValidation } from "../network/egress.ts";
import { SearchProviderSetup } from "./search-provider-setup.ts";

/**
 * Choosing and trying a workspace's search provider, over the real repository
 * and Postgres, with every search answered by a stand-in for the service.
 */
describe.skipIf(!process.env.DATABASE_URL)("setting up search, against Postgres", () => {
	let workspaceId: string;
	let adminId: string;
	let memberId: string;

	/**
	 * The setup as the workspace's administrator, under an egress policy
	 * allowing private addresses or not, every search answered by `search`.
	 */
	const setupWith = async (
		search: (url: string) => Promise<Response>,
		{ allowPrivateNetwork = true, as = adminId } = {},
	) =>
		(
			await servedOnPostgresAs(
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
			)
		)(as);

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
		const [admin, member] = await onDatabase((db) =>
			db
				.insert(user)
				.values([
					{ name: "Ada", email: `ada-${suffix}@example.com` },
					{ name: "Sam", email: `sam-${suffix}@example.com` },
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
	});

	it("refuses a local address where the installation forbids private ones", async () => {
		const setup = await setupWith(answering(), { allowPrivateNetwork: false });

		await expect(
			setup.replace({
				workspace: workspaceId,
				provider: { preset: "searxng", baseUrl: "http://127.0.0.1:8080" },
			}),
		).rejects.toMatchObject({ _tag: "UrlNotAllowed" });
		expect(await setup.get(workspaceId)).toBeUndefined();
	});

	it("tries the service with one query and records how it went", async () => {
		const search = answering();
		const setup = await setupWith(search);
		await setup.replace({
			workspace: workspaceId,
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
			workspace: workspaceId,
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
			workspace: workspaceId,
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

	it("lets a member ask whether the web tools are on, and change nothing", async () => {
		const setup = await setupWith(answering(), { as: memberId });

		expect(await setup.webAccess(workspaceId)).toBe(false);
		await expect(setup.get(workspaceId)).rejects.toBeInstanceOf(ActionForbidden);
		await expect(setup.remove(workspaceId)).rejects.toBeInstanceOf(ActionForbidden);
	});
});
