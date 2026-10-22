export * as GitHubSignIn from "./github-sign-in.ts";

import { Effect, Layer } from "effect";
import { SandboxCredentials } from "../../../sandboxes/sandbox-credentials.ts";
import { GitHubConnections } from "./github-connections.ts";

/**
 * Signs each pod's sandbox in to read its GitHub connection's repositories
 * with git, with a read-only token for them alone. A pod with no GitHub
 * connection, or whose token can't be had, is signed in to nothing; the
 * failure is logged.
 */
export const make = Effect.gen(function* () {
	const connections = yield* GitHubConnections.Service;
	return SandboxCredentials.Service.of({
		forPod: (pod) =>
			Effect.gen(function* () {
				const connected = yield* connections.forPod(pod);
				if (!connected || connected.repositories.length === 0) {
					return SandboxCredentials.NOT_SIGNED_IN;
				}
				const signedIn = yield* connected.sandboxSignIn();
				return {
					credentials: signedIn.credentials,
					environment: {},
					expiresAt: signedIn.expiresAt,
				};
			}).pipe(
				Effect.catch((failure) =>
					Effect.as(
						Effect.logWarning("Couldn't get a read token for a pod's GitHub connection", failure),
						SandboxCredentials.NOT_SIGNED_IN,
					),
				),
			),
	});
});

export const layer = Layer.effect(SandboxCredentials.Service, make).pipe(
	Layer.provide(GitHubConnections.layer),
);
