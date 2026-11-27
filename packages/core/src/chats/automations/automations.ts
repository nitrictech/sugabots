export * as Automations from "./automations.ts";

import type { AcceptedRun } from "@sugabots/contracts";
import { Context, type Effect, Layer } from "effect";
import type { SignedByGitHubApp } from "../../proofs/signed-by-github-app.ts";
import type { RepositoryActivity } from "../../providers/connectors/github/github-events.ts";
import { processLayer, Tier } from "../../tiers.ts";
import { ChatStore } from "../store/store.ts";
import { makeConnectorEvents } from "./connector-events.ts";
import { AutomationStore } from "./store.ts";

/**
 * Runs connector automations for what happened at their connectors' services.
 */
export interface ConnectorEventsInterface {
	/**
	 * Accepts a run of each enabled automation `activity` runs through
	 * the connector `signed` names, while the connector has the repository. A delivery
	 * GitHub sends again starts no new runs.
	 */
	readonly accept: <P, K>(
		signed: SignedByGitHubApp<P, K>,
		input: { deliveryId: string; activity: RepositoryActivity },
	) => Effect.Effect<AcceptedRun[]>;
}

export class ConnectorEvents extends Context.Service<ConnectorEvents, ConnectorEventsInterface>()(
	"@sugabots/core/Automations/ConnectorEvents",
) {
	declare readonly [Tier]: "process";
}

export const connectorEventsLayer = processLayer(
	Layer.effect(ConnectorEvents, makeConnectorEvents),
).pipe(Layer.provide([AutomationStore.layer, ChatStore.layer]));

/** The automation workflow's steps. */
export { automationStepsLayer as stepsLayer } from "./steps.ts";
