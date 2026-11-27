import { MAX_IDEMPOTENCY_KEY_CHARACTERS } from "@sugabots/contracts";
import { GitHubDeliveryIdInvalid } from "@sugabots/contracts/errors/connectors";
import { connectorsContracts } from "@sugabots/contracts/operations/connectors";
import { Effect } from "effect";
import { Automations } from "../../../chats/automations/automations.ts";
import { named } from "../../../proofs/proof.ts";
import { proveSignedByGitHubApp } from "../../../proofs/signed-by-github-app.ts";
import { GitHubConnectors } from "../../../providers/connectors/github/github-connectors.ts";
import { defineOperation } from "../../operation.ts";

export const delivery = defineOperation(
	connectorsContracts["gitHubWebhooks.delivery"],
	(principal, input) =>
		Effect.gen(function* () {
			const gitHubConnectors = yield* GitHubConnectors.Service;
			const connectorEvents = yield* Automations.ConnectorEvents;
			const { connectorId, ...delivered } = input;
			return yield* named(principal, connectorId, (principal, connector) =>
				Effect.gen(function* () {
					const signed = yield* proveSignedByGitHubApp(principal, connector);
					const delivery = yield* gitHubConnectors.readDelivery(signed, delivered);
					const { activity, deliveryId } = delivery;
					if (!activity) return delivery;
					if (!deliveryId || deliveryId.length > MAX_IDEMPOTENCY_KEY_CHARACTERS) {
						return yield* new GitHubDeliveryIdInvalid();
					}
					yield* connectorEvents.accept(signed, { deliveryId, activity });
					return delivery;
				}),
			);
		}),
);
