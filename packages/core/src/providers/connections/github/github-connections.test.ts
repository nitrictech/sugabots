import { Effect, Layer, Redacted } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase, runOnPostgres } from "../../../database/testing.ts";
import { onPostgresAs } from "../../../workspaces/testing.ts";
import {
	INSTALLATION_ID,
	installedConnection,
	json,
	listsRepositories,
	madeConnection,
	mintsTokens,
	type Route,
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
	// Once set, GitHub has renamed `acme/web` to `acme/website`, keeping its id.
	let renamed = false;
	const listsRenamed: Route = ({ path }) =>
		renamed && path === "/installation/repositories"
			? json({
					total_count: 2,
					repositories: [
						{ id: 101, full_name: "acme/website", private: true },
						{ id: 102, full_name: "acme/infra", private: false },
					],
				})
			: undefined;
	// #5 is from a bot's branch, #6 from someone's, and #7 from a bot-like branch of a fork.
	const pullRequests: Route = ({ method, path }) => {
		const pull = /^\/repos\/acme\/web\/pulls\/(\d+)$/.exec(path);
		const head = {
			5: ["sugabots/fix-login", "acme/web"],
			6: ["fix-login", "acme/web"],
			7: ["sugabots/fix-login", "mallory/web"],
		}[Number(pull?.[1])];
		if (path === "/graphql") return json({ data: {} });
		if (!pull || !head) return undefined;
		const [ref, fullName] = head;
		const url = `https://github.com/acme/web/pull/${pull[1]}`;
		return method === "PATCH"
			? json({ number: Number(pull[1]), html_url: url })
			: json({
					node_id: `PR_${pull[1]}`,
					draft: true,
					head: { ref, repo: { full_name: fullName } },
				});
	};
	const github = standInGitHub(mintsTokens, listsRenamed, listsRepositories, pullRequests);
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
	const pod = () => ({ workspaceId: fixture.workspaceId, podId: fixture.podId });

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

	it("signs the sandbox in to read only the connection's repositories, with git, as its account", async () => {
		const connected = await runOnPostgres(connections.forPod(pod()));
		if (!connected) throw new Error("Not connected");
		github.asked.length = 0;

		const signedIn = await runOnPostgres(connected.sandboxSignIn());

		expect(signedIn.credentials.map(({ host, pathPrefix }) => ({ host, pathPrefix }))).toEqual([
			{ host: "github.com", pathPrefix: "/acme/" },
		]);
		const [git] = signedIn.credentials;
		const token = Buffer.from(
			(git ? Redacted.value(git.value) : "").replace("Basic ", ""),
			"base64",
		).toString();
		expect(token).toMatch(new RegExp(`^x-access-token:token-${INSTALLATION_ID}-\\d+$`));
		const asked = github.asked.find((request) => request.path.endsWith("/access_tokens"));
		expect(asked?.body).toEqual({
			repository_ids: [101],
			permissions: { contents: "read", metadata: "read" },
		});
	});

	it("changes a pull request from a bot's own branch, and no one else's", async () => {
		const connected = await runOnPostgres(connections.forPod(pod()));
		if (!connected) throw new Error("Not connected");
		github.asked.length = 0;
		const change = {
			repository: "acme/web",
			title: "Fix the login",
			body: undefined,
			base: undefined,
			state: undefined,
			draft: false,
		};

		const updated = await runOnPostgres(connected.updatePullRequest({ ...change, number: 5 }));
		for (const number of [6, 7]) {
			await expect(
				runOnPostgres(connected.updatePullRequest({ ...change, number })),
			).rejects.toMatchObject({ _tag: "NotBotPullRequest" });
		}

		expect(updated).toEqual({ number: 5, url: "https://github.com/acme/web/pull/5" });
		const changed = github.asked.filter((request) => request.method !== "GET");
		expect(changed.filter((request) => !request.path.endsWith("/access_tokens"))).toEqual([
			expect.objectContaining({
				path: "/graphql",
				body: expect.objectContaining({ variables: { id: "PR_5" } }),
			}),
			expect.objectContaining({
				method: "PATCH",
				path: "/repos/acme/web/pulls/5",
				body: { title: "Fix the login" },
			}),
		]);
	});

	it("adds a repository and removes one, each a change of the connection's configuration", async () => {
		const { podId, adminId } = fixture;
		const connected = await runOnPostgres(connections.forPod(pod()));

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
		const after = await runOnPostgres(connections.forPod(pod()));

		expect(added.repositories.map((one) => one.repository)).toEqual(["acme/infra", "acme/web"]);
		expect(left.repositories.map((one) => one.repository)).toEqual(["acme/infra"]);
		expect(after?.connection.configurationRevision).toBe(
			(connected?.connection.configurationRevision ?? 0) + 2,
		);
	});

	it("keeps a repository GitHub renames, by its id", async () => {
		const renaming = await workspaceWithPod("Renaming");
		const { podId, adminId } = renaming;
		const renamedId = await installedConnection(gitHubApps, renaming);
		await as(adminId).addRepository({ podId, connectionId: renamedId, repository: "acme/web" });
		renamed = true;
		try {
			const listed = await as(adminId).addRepository({
				podId,
				connectionId: renamedId,
				repository: "acme/infra",
			});
			const connected = await runOnPostgres(
				connections.forPod({ workspaceId: renaming.workspaceId, podId }),
			);
			github.asked.length = 0;
			await runOnPostgres(connected?.readToken() ?? Effect.void);

			expect(listed.repositories.map((one) => one.repository)).toEqual([
				"acme/infra",
				"acme/website",
			]);
			const asked = github.asked.find((request) => request.path.endsWith("/access_tokens"));
			expect(asked?.body).toMatchObject({ repository_ids: [101, 102] });
		} finally {
			renamed = false;
		}
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
