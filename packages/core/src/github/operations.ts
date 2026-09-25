import type {
	GithubConnectionTestResult,
	GithubConnectionUpdate,
	NewGithubConnection,
	NewPodRepository,
} from "@sugabots/contracts";
import { Data, Effect } from "effect";
import type { Database } from "../database/database.ts";
import type { EgressHttpClients, EgressUrlValidator } from "../providers/network/egress.ts";
import { githubClient } from "./client.ts";
import type { GithubStore } from "./store.ts";

export class GithubConnectionNotFound extends Data.TaggedError("GithubConnectionNotFound") {
	override get message() {
		return "This workspace isn't connected to GitHub";
	}
}

export class GithubUrlNotAllowed extends Data.TaggedError("GithubUrlNotAllowed") {
	override get message() {
		return "The GitHub API address is not allowed by the network policy";
	}
}

/** GitHub couldn't tell us about the repository, for the reason in `message`. */
export class RepositoryNotReadable extends Data.TaggedError("RepositoryNotReadable")<{
	message: string;
}> {}

export class RepositoryAlreadyAdded extends Data.TaggedError("RepositoryAlreadyAdded") {
	override get message() {
		return "This pod already has that repository";
	}
}

export interface GithubOperationsOptions {
	github: GithubStore;
	httpClients: EgressHttpClients;
	validateUrl: EgressUrlValidator;
}

export function githubOperations({ github, httpClients, validateUrl }: GithubOperationsOptions) {
	const requireAllowedUrl = (url: string) =>
		Effect.tryPromise({ try: () => validateUrl(url), catch: () => new GithubUrlNotAllowed() });

	const requireCredentials = (workspaceId: string) =>
		Effect.filterOrFail(
			github.credentials(workspaceId),
			(credentials) => credentials !== undefined,
			() => new GithubConnectionNotFound(),
		);

	const clientFor = (credentials: { apiBaseUrl: string; gitHost: string; token: string }) =>
		githubClient(httpClients.for({ baseUrl: credentials.apiBaseUrl }), credentials);

	return {
		get: (workspaceId: string) =>
			Effect.map(github.get(workspaceId), (connection) => ({ connection: connection ?? null })),

		replace: (workspaceId: string, userId: string, input: NewGithubConnection) =>
			Effect.andThen(
				input.apiBaseUrl ? requireAllowedUrl(input.apiBaseUrl) : Effect.void,
				github.replace(workspaceId, userId, input),
			),

		update: (workspaceId: string, input: GithubConnectionUpdate) =>
			Effect.gen(function* () {
				if (input.apiBaseUrl) yield* requireAllowedUrl(input.apiBaseUrl);
				const updated = yield* github.update(workspaceId, input);
				if (!updated) return yield* new GithubConnectionNotFound();
				return updated;
			}),

		remove: (workspaceId: string) =>
			Effect.filterOrFail(
				github.remove(workspaceId),
				(removed) => removed,
				() => new GithubConnectionNotFound(),
			).pipe(Effect.asVoid),

		test: (
			workspaceId: string,
		): Effect.Effect<GithubConnectionTestResult, GithubConnectionNotFound, Database> =>
			Effect.gen(function* () {
				const credentials = yield* requireCredentials(workspaceId);
				const outcome = yield* clientFor(credentials).viewer.pipe(
					Effect.map((login) => ({ login })),
					Effect.catchTag("GithubRequestFailed", (failure) =>
						Effect.succeed({ error: failure.message }),
					),
				);
				yield* github.recordTest(workspaceId, outcome);
				return "login" in outcome
					? { reachable: true, login: outcome.login }
					: { reachable: false, error: outcome.error };
			}),

		listRepositories: (podId: string) => github.listRepositories(podId),

		addRepository: (
			pod: { workspaceId: string; podId: string },
			userId: string,
			input: NewPodRepository,
		) =>
			Effect.gen(function* () {
				const credentials = yield* requireCredentials(pod.workspaceId);
				const repository = yield* clientFor(credentials)
					.repository(input.fullName)
					.pipe(
						Effect.mapError((failure) => new RepositoryNotReadable({ message: failure.message })),
					);
				const added = yield* github.addRepository(pod, userId, repository);
				if (!added) return yield* new RepositoryAlreadyAdded();
				return added;
			}),

		removeRepository: (podId: string, repositoryId: string) =>
			Effect.asVoid(github.removeRepository(podId, repositoryId)),
	};
}
