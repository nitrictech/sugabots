import { Data, Effect, Schema } from "effect";
import type { EgressHttpClient } from "../providers/network/egress.ts";

/** What a workspace's GitHub connection needs to call GitHub. */
export interface GithubCredentials {
	apiBaseUrl: string;
	gitHost: string;
	token: string;
}

/** GitHub answered with a failure, or couldn't be reached. `status` is absent for the latter. */
export class GithubRequestFailed extends Data.TaggedError("GithubRequestFailed")<{
	status?: number;
	message: string;
}> {}

const userSchema = Schema.Struct({ login: Schema.String });
const repositorySchema = Schema.Struct({
	full_name: Schema.String,
	default_branch: Schema.String,
	private: Schema.Boolean,
});

export interface GithubRepository {
	fullName: string;
	defaultBranch: string;
	private: boolean;
}

/** The two GitHub questions Sugabots asks: whose token this is, and what a repository is. */
export function githubClient(fetch: EgressHttpClient, credentials: GithubCredentials) {
	const get = <A>(path: string, schema: Schema.Decoder<A>) =>
		Effect.tryPromise({
			try: async () => {
				const response = await fetch(new URL(path, withSlash(credentials.apiBaseUrl)), {
					headers: {
						authorization: `Bearer ${credentials.token}`,
						accept: "application/vnd.github+json",
						"x-github-api-version": "2022-11-28",
					},
					signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				});
				if (!response.ok) {
					throw new GithubRequestFailed({
						status: response.status,
						message: failureMessage(response.status, path),
					});
				}
				return Schema.decodeUnknownSync(schema)(await response.json());
			},
			catch: (cause) =>
				cause instanceof GithubRequestFailed
					? cause
					: new GithubRequestFailed({
							message: `Could not reach GitHub: ${cause instanceof Error ? cause.message : String(cause)}`,
						}),
		});

	return {
		viewer: get("user", userSchema).pipe(Effect.map(({ login }) => login)),
		repository: (fullName: string) =>
			get(`repos/${fullName}`, repositorySchema).pipe(
				Effect.map(
					(repository): GithubRepository => ({
						fullName: repository.full_name,
						defaultBranch: repository.default_branch,
						private: repository.private,
					}),
				),
			),
	};
}

const REQUEST_TIMEOUT_MS = 15_000;

function withSlash(url: string) {
	return url.endsWith("/") ? url : `${url}/`;
}

function failureMessage(status: number, path: string): string {
	if (status === 401) return "GitHub did not accept the token.";
	if (status === 403)
		return "GitHub refused the request. The token may lack permission, or be rate limited.";
	// GitHub answers 404 for a private repository the token can't see, as well as one that doesn't exist.
	if (status === 404 && path.startsWith("repos/")) {
		return "GitHub has no such repository that this token can read.";
	}
	return `GitHub answered ${status}.`;
}
