export * as GitHubSignIn from "./github-sign-in.ts";

import { Effect, Layer } from "effect";
import { ComputerSignIn } from "../../../computers/computer-sign-in.ts";
import { processLayer } from "../../../tiers.ts";
import { GitHubConnectors } from "./github-connectors.ts";

/**
 * Signs each project's computer in to read its GitHub repositories with git,
 * using a read-only token for those repositories. This includes a shared
 * computer whose GitHub sign-in the upgrade kept.
 */
export const make = Effect.gen(function* () {
	const connectors = yield* GitHubConnectors.Service;
	return ComputerSignIn.Service.of({ forProject: connectors.signInComputer });
});

export const layer = processLayer(Layer.effect(ComputerSignIn.Service, make)).pipe(
	Layer.provide(GitHubConnectors.layer),
);
