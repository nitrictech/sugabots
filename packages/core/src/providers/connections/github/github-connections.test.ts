import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase, runOnPostgres } from "../../../database/testing.ts";
import { onPostgresAs } from "../../../workspaces/testing.ts";
import {
	installedConnection,
	listsRepositories,
	madeConnection,
	mintsTokens,
	reachingGitHub,
	standInGitHub,
	workspaceWithPod,
} from "./github.test-support.ts";
import { GitHubApps } from "./github-app.ts";
import { GitHubConnections } from "./github-connections.ts";

/**
 * A pod's GitHub connection, its own app installed on `acme`, which reaches
 * `acme/web` and `acme/infra`, against Postgres.
 */
describe.skipIf(!process.env.DATABASE_URL)("GitHub connections, against Postgres", () => {
	const github = standInGitHub(mintsTokens, listsRepositories);
	let connections: GitHubConnections.Interface;
	let gitHubApps: GitHubApps.Interface;
	let fixture: Awaited<ReturnType<typeof workspaceWithPod>>;
	let connectionId: string;

	beforeAll(async () => {
		[gitHubApps, connections] = await runOnPostgres(
			Effect.all([GitHubApps.Service, GitHubConnections.Service]).pipe(
				Effect.provide(Layer.mergeAll(GitHubApps.layer, GitHubConnections.layer)),
				Effect.provide(reachingGitHub(github.fetch, "https://sugabots.example.com")),
			),
		);
		fixture = await workspaceWithPod("Connections");
		connectionId = await installedConnection(gitHubApps, fixture);
	});

	afterAll(closeDatabase);

	const as = (userId: string) => onPostgresAs(userId)(connections);

	it("lists what the app reaches, for someone who manages the pod's connections", async () => {
		const { podId, adminId, memberId } = fixture;

		await expect(as(memberId).reachableRepositories({ podId, connectionId })).rejects.toMatchObject(
			{ _tag: "ActionForbidden" },
		);
		expect(await as(adminId).reachableRepositories({ podId, connectionId })).toEqual([
			{ repository: "acme/web", private: true },
			{ repository: "acme/infra", private: false },
		]);
	});

	it("adds a repository the app reaches, as GitHub writes it, for someone who manages the pod's connections", async () => {
		const { podId, adminId, memberId } = fixture;

		await expect(
			as(memberId).addRepository({ podId, connectionId, repository: "acme/web" }),
		).rejects.toMatchObject({ _tag: "ActionForbidden" });
		await expect(
			as(adminId).addRepository({ podId, connectionId, repository: "acme-labs/lab" }),
		).rejects.toMatchObject({ _tag: "RepositoryUnreachable" });
		await as(adminId).addRepository({ podId, connectionId, repository: "ACME/Web" });

		expect(await as(memberId).repositories({ podId, connectionId })).toMatchObject({
			account: "acme",
			repositories: [{ repository: "acme/web", addedByName: "Ada" }],
		});
	});

	it("adds a repository the app reaches, and removes one", async () => {
		const { podId, adminId } = fixture;

		const added = await as(adminId).addRepository({
			podId,
			connectionId,
			repository: "acme/infra",
		});
		const left = await as(adminId).removeRepository({
			podId,
			connectionId,
			repository: "acme/web",
		});

		expect(added.repositories.map((one) => one.repository)).toEqual(["acme/infra", "acme/web"]);
		expect(left.repositories.map((one) => one.repository)).toEqual(["acme/infra"]);
	});

	it("refuses to choose repositories before the connection's app is installed", async () => {
		const pending = await workspaceWithPod("Pending");
		const { connectionId: pendingId } = await madeConnection(gitHubApps, pending);
		const asAdmin = as(pending.adminId);
		const which = { podId: pending.podId, connectionId: pendingId };

		await expect(asAdmin.reachableRepositories(which)).rejects.toMatchObject({
			_tag: "GitHubAppNotInstalled",
		});
		await expect(asAdmin.addRepository({ ...which, repository: "acme/web" })).rejects.toMatchObject(
			{ _tag: "GitHubAppNotInstalled" },
		);
		expect(await asAdmin.repositories(which)).toEqual({
			account: null,
			repositories: [],
		});
	});

	it("refuses another pod's connection", async () => {
		const other = await workspaceWithPod("Other");

		await expect(
			as(other.adminId).repositories({ podId: other.podId, connectionId }),
		).rejects.toMatchObject({ _tag: "NotGitHubConnection" });
	});
});
