import { GITHUB_DEFAULT_GIT_HOST, type PodRepository } from "@sugabots/contracts";
import { Effect } from "effect";
import type { Database } from "../database/database.ts";
import type { EgressHttpClients } from "../providers/network/egress.ts";
import { type GithubCredentials, type GithubRequestFailed, githubClient } from "./client.ts";
import type { GithubStore } from "./store.ts";
import type { GithubTokens } from "./tokens.ts";

/**
 * What a turn needs from GitHub: the pod's repositories to check out, and,
 * for pushing and opening pull requests, the workspace's token and a way to
 * call GitHub with it. The token stays on the server either way.
 */
export interface GithubForTurns {
	gitHost(workspaceId: string): Effect.Effect<string, never, Database>;
	repositories(podId: string): Effect.Effect<PodRepository[], never, Database>;
	/** Write credentials for one repository, for a push or a pull request. */
	credentials(
		workspaceId: string,
		repository: string,
	): Effect.Effect<GithubCredentials | undefined, never, Database>;
	openPullRequest(
		credentials: GithubCredentials,
		repository: string,
		pull: { title: string; body: string; head: string; base: string },
	): Effect.Effect<{ number: number; url: string }, GithubRequestFailed>;
}

export function githubForTurns({
	github,
	tokens,
	httpClients,
}: {
	github: GithubStore;
	tokens: GithubTokens;
	httpClients: EgressHttpClients;
}): GithubForTurns {
	return {
		gitHost: (workspaceId) =>
			Effect.map(
				github.get(workspaceId),
				(connection) => connection?.gitHost ?? GITHUB_DEFAULT_GIT_HOST,
			),
		repositories: (podId) => github.listRepositories(podId),
		credentials: (workspaceId, repository) =>
			tokens.credentialsFor(workspaceId, { access: "write", repositories: [repository] }),
		openPullRequest: (credentials, repository, pull) =>
			githubClient(
				httpClients.for({ baseUrl: credentials.apiBaseUrl }),
				credentials,
			).openPullRequest(repository, pull),
	};
}
