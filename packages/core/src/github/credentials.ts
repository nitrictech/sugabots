import { Effect } from "effect";
import type { Database } from "../database/database.ts";
import type { Sandbox } from "../sandboxes/sandbox.ts";
import type { GithubStore } from "./store.ts";

/**
 * The git username GitHub expects alongside a token in basic auth. Any
 * non-empty name works for a personal access token; this one also works for
 * a GitHub App installation token, which is where this goes next.
 */
const TOKEN_USERNAME = "x-access-token";

/** What a pod's sandbox fetches its repositories with, or nothing if the workspace has no GitHub. */
export const gitCredentialsForPod =
	(github: Pick<GithubStore, "credentials" | "listRepositories">) =>
	({
		workspaceId,
		podId,
	}: {
		workspaceId: string;
		podId: string;
	}): Effect.Effect<Sandbox.GitCredentials | undefined, never, Database> =>
		Effect.gen(function* () {
			const credentials = yield* github.credentials(workspaceId);
			if (!credentials) return undefined;
			const repositories = yield* github.listRepositories(podId);
			return {
				host: credentials.gitHost,
				username: TOKEN_USERNAME,
				token: credentials.token,
				repositories: repositories.map((repository) => repository.fullName),
			};
		});
