import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { githubConnection, pod, user, workspace } from "../database/schema.ts";
import { closeDatabase, onDatabase, onPostgres, runOnPostgres } from "../database/testing.ts";
import { aesCredentialCipher } from "../providers/model-providers/credentials.ts";
import { gitCredentialsForPod } from "./credentials.ts";
import { githubStore } from "./store.ts";
import { githubTokens } from "./tokens.ts";

/**
 * The GitHub store against Postgres: one connection per workspace with its
 * token sealed, a pod's repositories, and what a pod's sandbox is given.
 */
describe.skipIf(!process.env.DATABASE_URL)("GitHub, against Postgres", () => {
	const cipher = aesCredentialCipher(Buffer.alloc(32, 7).toString("base64"));
	const store = githubStore(cipher);
	// A token connection never calls GitHub for its credentials.
	const tokens = githubTokens({
		github: store,
		httpClients: { for: () => () => Promise.reject(new Error("no network in tests")) },
	});
	const forPod = gitCredentialsForPod({ github: store, tokens });
	const github = onPostgres(store);
	let workspaceId: string;
	let podId: string;
	let userId: string;

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: `GitHub ${suffix}`, slug: `github-${suffix}` })
				.returning(),
		);
		const [member] = await onDatabase((db) =>
			db
				.insert(user)
				.values({ name: "Sam", email: `github-${suffix}@example.com` })
				.returning(),
		);
		if (!space || !member) throw new Error("fixture");
		workspaceId = space.id;
		userId = member.id;
		const [room] = await onDatabase((db) =>
			db
				.insert(pod)
				.values({
					workspaceId,
					kind: "shared",
					name: "Room",
					slug: `room-${suffix}`,
					createdById: userId,
				})
				.returning(),
		);
		if (!room) throw new Error("fixture");
		podId = room.id;
	});

	it("keeps the token sealed and says only that there is one", async () => {
		const connection = await github.replace(workspaceId, userId, {
			method: "token",
			token: "github_pat_secret",
		});

		expect(connection).toMatchObject({
			apiBaseUrl: "https://api.github.com",
			gitHost: "github.com",
			hasToken: true,
			status: "untested",
		});
		expect(JSON.stringify(connection)).not.toContain("github_pat_secret");
		const rows = await onDatabase((db) => db.select().from(githubConnection));
		expect(JSON.stringify(rows)).not.toContain("github_pat_secret");
		expect(await github.secrets(workspaceId)).toMatchObject({
			method: "token",
			token: "github_pat_secret",
		});
	});

	it("adds a repository to a pod once", async () => {
		const repository = { fullName: "acme/app", defaultBranch: "main", private: true };

		expect(await github.addRepository({ workspaceId, podId }, userId, repository)).toMatchObject({
			fullName: "acme/app",
			defaultBranch: "main",
			private: true,
		});
		expect(await github.addRepository({ workspaceId, podId }, userId, repository)).toBeUndefined();
		expect(await github.listRepositories(podId)).toHaveLength(1);
	});

	it("gives a pod's sandbox the token for the pod's repositories only", async () => {
		await github.replace(workspaceId, userId, { method: "token", token: "github_pat_secret" });
		await github.addRepository({ workspaceId, podId }, userId, {
			fullName: "acme/app",
			defaultBranch: "main",
			private: true,
		});

		expect(await runOnPostgres(forPod({ workspaceId, podId }))).toEqual({
			host: "github.com",
			username: "x-access-token",
			token: "github_pat_secret",
			repositories: ["acme/app"],
		});
	});

	it("gives nothing where the workspace has no GitHub connection", async () => {
		expect(await runOnPostgres(forPod({ workspaceId, podId }))).toBeUndefined();
	});
});
