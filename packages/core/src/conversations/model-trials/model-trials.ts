export * as ModelTrials from "./model-trials.ts";

import type { NewModelTrial } from "@sugabots/contracts";
import { Context, Effect, Layer } from "effect";
import { serviceOperations } from "../../database/database.ts";
import type { AuthorizationDenied } from "../../workspaces/access.ts";
import { Authorization } from "../../workspaces/authorization.ts";
import type { CurrentActor } from "../../workspaces/current-actor.ts";
import { Models } from "../turns/model.ts";
import { runTrial, type TrialReport } from "./trial.ts";

/** Trying a model out on a system agent before a workspace relies on it. */
export interface Interface {
	/**
	 * Asks `model` the system agent's trial cases in a workspace named by its
	 * id or its slug. A trial spends model calls and decides what the
	 * workspace's unattended agents run on, so it takes the current actor's
	 * `workspace.providers.manage`.
	 */
	readonly run: (
		input: NewModelTrial & { workspace: string },
	) => Effect.Effect<TrialReport, AuthorizationDenied, CurrentActor.Service>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/ModelTrials") {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ModelTrials");
	const authorization = yield* Authorization.Service;
	const models = yield* Models;
	return Service.of({
		run: ({ workspace, systemAgentKey, model }) =>
			operation(
				"run",
				Effect.flatMap(
					authorization.workspace(workspace, "workspace.providers.manage"),
					({ workspaceId }) => runTrial({ systemAgentKey, model, workspaceId }, models),
				),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

/** Needs `Models`, the model client turns use. */
export const layer = layerNoDeps.pipe(Layer.provide(Authorization.layer));
