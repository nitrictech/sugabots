export * as GitHubSignIn from "./github-sign-in.ts";

import { Effect, Layer } from "effect";
import { ComputerSignIn } from "../../../computers/computer-sign-in.ts";
import { processLayer } from "../../../tiers.ts";
import { GitHubConnectors } from "./github-connectors.ts";

/**
 * Signs each project's computer in to read its GitHub app's repositories
 * with git, with a read-only token for them alone. A project with no GitHub
 * app, or whose token can't be had, is signed in to nothing; the failure is
 * logged.
 */
export const make = Effect.gen(function* () {
	const connectors = yield* GitHubConnectors.Service;
	return ComputerSignIn.Service.of({
		forProject: (project) =>
			Effect.gen(function* () {
				const connected = yield* connectors.forProject(project);
				if (!connected || connected.repositories.length === 0) {
					return ComputerSignIn.NOT_SIGNED_IN;
				}
				const signedIn = yield* connected.computerSignIn();
				return { credentials: signedIn.credentials, expiresAt: signedIn.expiresAt };
			}).pipe(
				Effect.catch((failure) =>
					Effect.as(
						Effect.logWarning("Couldn't get a read token for a project's GitHub app", failure),
						ComputerSignIn.NOT_SIGNED_IN,
					),
				),
			),
	});
});

export const layer = processLayer(Layer.effect(ComputerSignIn.Service, make)).pipe(
	Layer.provide(GitHubConnectors.layer),
);
