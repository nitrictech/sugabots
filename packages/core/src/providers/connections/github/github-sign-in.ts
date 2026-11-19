export * as GitHubSignIn from "./github-sign-in.ts";

import { Effect, Layer } from "effect";
import { ComputerCredentials } from "../../../computers/computer-credentials.ts";
import { GitHubConnections } from "./github-connections.ts";

/**
 * Signs each project's computer in to read its GitHub app's repositories
 * with git, with a read-only token for them alone. A project with no GitHub
 * app, or whose token can't be had, is signed in to nothing; the failure is
 * logged.
 */
export const make = Effect.gen(function* () {
	const connections = yield* GitHubConnections.Service;
	return ComputerCredentials.Service.of({
		forProject: (project) =>
			Effect.gen(function* () {
				const connected = yield* connections.forProject(project);
				if (!connected || connected.repositories.length === 0) {
					return ComputerCredentials.NOT_SIGNED_IN;
				}
				const signedIn = yield* connected.computerSignIn();
				return {
					credentials: signedIn.credentials,
					environment: {},
					expiresAt: signedIn.expiresAt,
				};
			}).pipe(
				Effect.catch((failure) =>
					Effect.as(
						Effect.logWarning("Couldn't get a read token for a project's GitHub app", failure),
						ComputerCredentials.NOT_SIGNED_IN,
					),
				),
			),
	});
});

export const layer = Layer.effect(ComputerCredentials.Service, make).pipe(
	Layer.provide(GitHubConnections.layer),
);
