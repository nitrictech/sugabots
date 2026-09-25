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
	const call = <A>(path: string, schema: Schema.Decoder<A>, body?: unknown) =>
		Effect.tryPromise({
			try: async () => {
				const response = await fetch(new URL(path, withSlash(credentials.apiBaseUrl)), {
					method: body === undefined ? "GET" : "POST",
					headers: {
						authorization: `Bearer ${credentials.token}`,
						accept: "application/vnd.github+json",
						"x-github-api-version": "2022-11-28",
						...(body === undefined ? {} : { "content-type": "application/json" }),
					},
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
					signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				});
				if (!response.ok) {
					throw new GithubRequestFailed({
						status: response.status,
						message: failureMessage(response.status, path, await detail(response)),
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
		viewer: call("user", userSchema).pipe(Effect.map(({ login }) => login)),
		repository: (fullName: string) =>
			call(`repos/${fullName}`, repositorySchema).pipe(
				Effect.map(
					(repository): GithubRepository => ({
						fullName: repository.full_name,
						defaultBranch: repository.default_branch,
						private: repository.private,
					}),
				),
			),
		/**
		 * The repositories this credential reaches: an installation token's
		 * installed repositories, or a personal token's own. Sorted by name.
		 */
		accessibleRepositories: (kind: "installation" | "personal") =>
			Effect.gen(function* () {
				const found: GithubRepository[] = [];
				for (let page = 1; page <= MAX_REPOSITORY_PAGES; page++) {
					const batch =
						kind === "installation"
							? (yield* call(
									`installation/repositories?per_page=100&page=${page}`,
									installationRepositoriesSchema,
								)).repositories
							: yield* call(
									`user/repos?per_page=100&page=${page}&sort=full_name`,
									Schema.Array(repositorySchema),
								);
					found.push(
						...batch.map((repository) => ({
							fullName: repository.full_name,
							defaultBranch: repository.default_branch,
							private: repository.private,
						})),
					);
					if (batch.length < 100) break;
				}
				return found.sort((a, b) => a.fullName.localeCompare(b.fullName));
			}),
		/** Opens a draft pull request from `head` into `base`, for a person to review and mark ready. */
		openPullRequest: (
			fullName: string,
			pull: { title: string; body: string; head: string; base: string },
		) =>
			call(`repos/${fullName}/pulls`, pullRequestSchema, { ...pull, draft: true }).pipe(
				Effect.map((opened) => ({ number: opened.number, url: opened.html_url })),
			),
	};
}

const pullRequestSchema = Schema.Struct({ number: Schema.Number, html_url: Schema.String });
const installationRepositoriesSchema = Schema.Struct({
	repositories: Schema.Array(repositorySchema),
});

/** Pages of 100, and no more than this many: enough for any pod picker. */
const MAX_REPOSITORY_PAGES = 10;

/** GitHub's own explanation, which for a 422 is the only useful part. */
async function detail(response: Response): Promise<string | undefined> {
	const body = (await response.json().catch(() => undefined)) as
		| { message?: string; errors?: Array<{ message?: string }> }
		| undefined;
	const errors = body?.errors?.map((error) => error.message).filter(Boolean) ?? [];
	return [body?.message, ...errors].filter(Boolean).join(" ") || undefined;
}

const REQUEST_TIMEOUT_MS = 15_000;

function withSlash(url: string) {
	return url.endsWith("/") ? url : `${url}/`;
}

function failureMessage(status: number, path: string, said?: string): string {
	if (status === 401) return "GitHub did not accept the token.";
	if (status === 403)
		return "GitHub refused the request. The token may lack permission, or be rate limited.";
	// GitHub answers 404 for a private repository the token can't see, as well as one that doesn't exist.
	if (status === 404 && path.startsWith("repos/")) {
		return "GitHub has no such repository that this token can read.";
	}
	return said ? `GitHub answered ${status}: ${said}` : `GitHub answered ${status}.`;
}
