import { Effect } from "effect";
import type { Database } from "../database/database.ts";
import type { Sandbox } from "../sandboxes/sandbox.ts";
import type { GithubStore } from "./store.ts";
import type { GithubTokens } from "./tokens.ts";

/**
 * The git username GitHub expects alongside a token in basic auth. Any
 * non-empty name works for a personal access token; this is the one an
 * installation token needs.
 */
const TOKEN_USERNAME = "x-access-token";

/**
 * What a pod's sandbox fetches its repositories with: a read-only token for
 * those repositories alone when the workspace uses an app, or nothing if the
 * workspace has no GitHub connection.
 */
export const gitCredentialsForPod =
	({ github, tokens }: { github: Pick<GithubStore, "listRepositories">; tokens: GithubTokens }) =>
	({
		workspaceId,
		podId,
	}: {
		workspaceId: string;
		podId: string;
	}): Effect.Effect<Sandbox.GitCredentials | undefined, never, Database> =>
		Effect.gen(function* () {
			const repositories = (yield* github.listRepositories(podId)).map(
				(repository) => repository.fullName,
			);
			if (repositories.length === 0) return undefined;
			const credentials = yield* tokens.credentialsFor(workspaceId, {
				access: "read",
				repositories,
			});
			if (!credentials) return undefined;
			return {
				host: credentials.gitHost,
				username: TOKEN_USERNAME,
				token: credentials.token,
				repositories,
			};
		});
